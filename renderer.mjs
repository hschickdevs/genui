import { query } from '@anthropic-ai/claude-agent-sdk';
import { RENDERER_SYSTEM } from './prompts.mjs';

const RECYCLE_AFTER = 6; // bounds context growth; prior panels in context keep styling consistent

// Async queue so one long-lived CLI process serves many renders (no spawn per render).
function inbox() {
  const items = [];
  let wake = null;
  return {
    push(item) { items.push(item); wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (!items.length) await new Promise(r => (wake = r));
        yield items.shift();
      }
    },
  };
}

// 'default' leaves effort to the model.
const effortOption = effort => (effort && effort !== 'default' ? { effort } : {});

class Worker {
  constructor(model, effort) {
    this.model = model;
    this.effort = effort;
    this.uses = 0;
    this.input = inbox();
    this.q = query({
      prompt: this.input,
      options: {
        model,
        systemPrompt: RENDERER_SYSTEM,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settingSources: [],
        thinking: { type: 'disabled' },
        ...effortOption(effort),
        includePartialMessages: true,
        persistSession: false,
        env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
      },
    });
    this.messages = this.q[Symbol.asyncIterator]();
    // First turn pays process init + prompt-cache write (~2.4s vs ~0.8s TTFT); pay it at boot instead.
    this.ready = this.turn('Warm-up. Reply with only: <div></div>', () => {}).catch(() => {});
  }

  async render(brief, onDelta) {
    await this.ready;
    this.uses++;
    return this.turn(`BRIEF:\n${brief}`, onDelta);
  }

  async turn(content, onDelta) {
    this.input.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
    for (;;) {
      const { value: m, done } = await this.messages.next();
      if (done) throw new Error('renderer session ended');
      if (m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') {
        onDelta(m.event.delta.text);
      }
      if (m.type === 'result') {
        if (m.is_error) throw new Error(`render failed: ${m.subtype}`);
        return;
      }
    }
  }

  close() { this.q.close?.(); }
}

export class RendererPool {
  constructor(model = 'claude-haiku-5-5', effort = 'default', size = Number(process.env.GENUI_RENDER_WORKERS || 3)) {
    Object.assign(this, { model, effort });
    this.idle = Array.from({ length: size }, () => new Worker(model, effort));
    this.waiting = [];
  }

  close() {
    this.closed = true; // busy workers close on release instead of being replaced
    for (const w of this.idle) w.close();
  }

  // Idle workers switch now (and warm up again); busy ones switch when released.
  configure(model, effort) {
    if (model === this.model && effort === this.effort) return;
    Object.assign(this, { model, effort });
    this.idle = this.idle.map(w => { w.close(); return new Worker(model, effort); });
  }

  async acquire() {
    return this.idle.pop() ?? new Promise(r => this.waiting.push(r));
  }

  release(worker, healthy) {
    if (this.closed) return worker.close();
    if (!healthy || worker.uses >= RECYCLE_AFTER || worker.model !== this.model || worker.effort !== this.effort) {
      worker.close();
      worker = new Worker(this.model, this.effort);
    }
    const next = this.waiting.shift();
    next ? next(worker) : this.idle.push(worker);
  }

  async render(brief, onDelta) {
    const worker = await this.acquire();
    let healthy = true;
    try {
      await worker.render(brief, onDelta);
    } catch (e) {
      healthy = false;
      throw e;
    } finally {
      this.release(worker, healthy);
    }
  }
}

// Post-processor (paper A.6): models sometimes wrap output in fences despite instructions.
export function stripFences(html) {
  return html.replace(/^\s*```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
}
