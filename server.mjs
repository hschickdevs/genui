import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PLANNER_APPEND } from './prompts.mjs';
import { RendererPool, stripFences } from './renderer.mjs';

const PORT = Number(process.env.PORT || 4317);
const ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const CWD = process.env.GENUI_CWD || process.cwd();

// ---------- state + SSE ----------
const clients = new Set();
const panels = new Map(); // id -> { id, title, width, seq, html, done, ms, ttft }
const asks = new Map(); // askId -> { question, options, resolve }
const approvals = new Map(); // reqId -> { tool, input, resolve }
let busy = false;
let status = '';
let renderedThisTurn = false;

function send(ev) {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}

function replay(res) {
  const w = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  w({ t: 'busy', on: busy });
  if (status) w({ t: 'status', text: status });
  for (const p of panels.values()) {
    w({ t: 'panel', id: p.id, title: p.title, width: p.width, seq: p.seq });
    w(p.done ? { t: 'done', id: p.id, seq: p.seq, html: p.html, ms: p.ms, ttft: p.ttft } : { t: 'chunk', id: p.id, seq: p.seq, d: p.html });
  }
  for (const [askId, a] of asks) w({ t: 'ask', askId, question: a.question, options: a.options });
  for (const [reqId, a] of approvals) w({ t: 'approve', reqId, tool: a.tool, input: a.input });
}

// ---------- rendering ----------
const pool = new RendererPool();

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fallbackHtml = brief => `<pre class="whitespace-pre-wrap text-sm text-slate-700">${escapeHtml(brief)}</pre>`;

function showPanel({ id, title, brief, width = 'full' }) {
  const p = { id, title, width, seq: (panels.get(id)?.seq ?? 0) + 1, html: '', done: false };
  panels.set(id, p);
  send({ t: 'panel', id, title, width, seq: p.seq });
  const start = Date.now();
  const live = () => panels.get(id) === p; // a newer ui_show for this id supersedes this render
  pool
    .render(brief, d => {
      if (!live()) return;
      p.ttft ??= Date.now() - start;
      p.html += d;
      send({ t: 'chunk', id, seq: p.seq, d });
    })
    .then(() => { p.html = stripFences(p.html); })
    .catch(e => {
      console.error(`render ${id}:`, e.message);
      p.html = fallbackHtml(brief); // never leave the user with a blank panel
    })
    .finally(() => {
      if (!live()) return;
      p.done = true;
      p.ms = Date.now() - start;
      send({ t: 'done', id, seq: p.seq, html: p.html, ms: p.ms, ttft: p.ttft });
    });
}

// ---------- UI tools (the planner's only output channel) ----------
const text = t => ({ content: [{ type: 'text', text: t }] });

const ui = createSdkMcpServer({
  name: 'ui',
  version: '0.1.0',
  tools: [
    tool(
      'ui_show',
      'Create or replace a panel on the user canvas. Non-blocking: a designer model renders your brief while you keep working.',
      {
        id: z.string().describe('Stable panel id; reuse it to update a panel in place'),
        title: z.string().describe('Short panel title'),
        brief: z.string().describe('Everything the user needs to know, with all data verbatim, plus a suggested visual form and optional ACTIONS'),
        width: z.enum(['full', 'half']).optional(),
      },
      async args => {
        renderedThisTurn = true;
        showPanel(args);
        return text(`Panel "${args.id}" is rendering. Continue working; do not repeat its content as text.`);
      },
    ),
    tool(
      'ui_ask',
      'Ask the user a multiple-choice question and wait for the answer.',
      { question: z.string(), options: z.array(z.string()).min(1).max(6) },
      async ({ question, options }) => {
        renderedThisTurn = true;
        const askId = randomUUID();
        const answer = await new Promise(resolve => {
          asks.set(askId, { question, options, resolve });
          send({ t: 'ask', askId, question, options });
        });
        return text(`User answered: ${answer}`);
      },
    ),
    tool('ui_remove', 'Remove a panel that is no longer relevant.', { id: z.string() }, async ({ id }) => {
      panels.delete(id);
      send({ t: 'remove', id });
      return text(`Removed "${id}".`);
    }),
  ],
});

// ---------- planner ----------
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

const plannerInput = inbox();

// Approval cards are drawn by the harness, never by a model: the requester must not draw its own consent screen.
async function canUseTool(toolName, input, { signal }) {
  const reqId = randomUUID();
  setStatus(`Waiting for your approval: ${toolName}`);
  const allow = await new Promise(resolve => {
    approvals.set(reqId, { tool: toolName, input, resolve });
    send({ t: 'approve', reqId, tool: toolName, input });
    signal.addEventListener('abort', () => resolve(false));
  });
  approvals.delete(reqId);
  send({ t: 'resolved', id: reqId });
  return allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The user denied this action.' };
}

// Text output is invisible, so a turn may not end without touching the canvas.
async function stopHook(input) {
  if (renderedThisTurn) return {};
  if (!input.stop_hook_active) {
    return { decision: 'block', reason: 'The user cannot see text output. Communicate your result with ui_show (or ui_ask) before stopping.' };
  }
  if (input.last_assistant_message) showPanel({ id: 'reply', title: 'Reply', brief: input.last_assistant_message });
  return {};
}

const planner = query({
  prompt: plannerInput,
  options: {
    model: process.env.GENUI_PLANNER_MODEL || 'claude-opus-5-5',
    cwd: CWD,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: PLANNER_APPEND },
    settingSources: ['project'],
    mcpServers: { ui },
    strictMcpConfig: true,
    allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'mcp__ui__ui_show', 'mcp__ui__ui_ask', 'mcp__ui__ui_remove'],
    disallowedTools: ['AskUserQuestion'],
    canUseTool,
    hooks: { Stop: [{ hooks: [stopHook] }] },
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
  },
});

function setStatus(t) {
  status = t;
  send({ t: 'status', text: t });
}

function setBusy(on) {
  busy = on;
  send({ t: 'busy', on });
}

function describeTool(b) {
  const i = b.input ?? {};
  const arg = i.file_path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? i.description ?? '';
  return `${b.name} ${String(arg)}`.slice(0, 140);
}

(async () => {
  for await (const m of planner) {
    if (m.type === 'system' && m.subtype === 'init') {
      console.log(`planner: ${m.model}, cwd ${m.cwd}, mcp: ${m.mcp_servers.map(s => `${s.name}:${s.status}`).join(', ')}`);
    }
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'tool_use' && !b.name.startsWith('mcp__ui__')) setStatus(describeTool(b));
      }
    }
    if (m.type === 'result') {
      setBusy(false);
      setStatus(m.is_error ? `Error: ${m.subtype}` : '');
    }
  }
  console.error('planner session ended');
  process.exit(1);
})();

function toPlanner(content) {
  renderedThisTurn = false;
  setBusy(true);
  plannerInput.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
}

// ---------- HTTP ----------
const HTML = 'text/html; charset=utf-8';
const FILES = {
  '/': ['index.html', HTML],
  '/panel.html': ['panel.html', HTML],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

async function readJson(req) {
  let body = '';
  for await (const c of req) body += c;
  return JSON.parse(body);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      res.writeHead(200, { 'content-type': type });
      return res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      replay(res);
      return req.on('close', () => clients.delete(res));
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      // This endpoint approves tool calls on this machine: reject cross-site requests.
      if (!ORIGINS.includes(req.headers.origin)) return res.writeHead(403).end();
      const msg = await readJson(req);
      if (msg.t === 'prompt' && msg.text?.trim()) toPlanner(msg.text);
      if (msg.t === 'event') toPlanner(`[UI event] panel "${msg.panel}": ${JSON.stringify(msg.payload)}`);
      if (msg.t === 'answer' && asks.has(msg.askId)) {
        asks.get(msg.askId).resolve(msg.value);
        asks.delete(msg.askId);
        send({ t: 'resolved', id: msg.askId });
      }
      if (msg.t === 'approval') approvals.get(msg.reqId)?.resolve(Boolean(msg.allow));
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  })
  .listen(PORT, '127.0.0.1', () => console.log(`genui on http://127.0.0.1:${PORT}  (agent cwd: ${CWD})`));
