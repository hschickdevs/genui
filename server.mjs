import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { query, tool, createSdkMcpServer, getSessionInfo, renameSession } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PLANNER_APPEND } from './prompts.mjs';
import { RendererPool, stripFences } from './renderer.mjs';
import { HOME, addInput, archiveSession, loadSessions, newSession, resolveDir, saveSession } from './sessions.mjs';
import { prepareAttachments } from './attachments.mjs';
import { OPTIONS, loadSettings, saveSettings, validate } from './settings.mjs';

const PORT = Number(process.env.PORT || 4317);
const FILE_MANAGER = { darwin: 'open', win32: 'explorer' }[process.platform] ?? 'xdg-open';
const IDLE_MS = 15 * 60_000; // idle sessions free their Opus process; the next prompt resumes them
const HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
const ORIGINS = HOSTS.map(h => `http://${h}`);
const { version } = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// ---------- shared ----------
let settings = await loadSettings(); // global: permissions + models, edited from the ⚙ menu
const pool = new RendererPool(settings.renderModel, settings.renderEffort);
const allClients = new Set(); // every SSE connection, whatever its session: all of them get the session list
const sessions = new Map(); // id -> session unit

const sse = (res, ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
const listEvent = () => ({ t: 'sessions', list: [...sessions.values()].map(x => x.summary()) });
const broadcastSessions = () => { const ev = listEvent(); for (const res of allClients) sse(res, ev); };
const settingsEvent = () => ({ t: 'settings', value: settings, options: OPTIONS });

const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fallbackHtml = brief => `<pre class="whitespace-pre-wrap text-sm text-slate-700">${escapeHtml(brief)}</pre>`;
const text = t => ({ content: [{ type: 'text', text: t }] });

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

function describeTool(b) {
  const i = b.input ?? {};
  // Names stream in before inputs, so the bare form shows first.
  if (b.name === 'mcp__ui__ui_show') return i.title ? `Rendering panel "${i.title}"` : 'Rendering panel…';
  if (b.name === 'mcp__ui__ui_ask') return i.question ? `Asking: ${i.question}`.slice(0, 140) : 'Asking you…';
  if (b.name === 'mcp__ui__ui_remove') return i.id ? `Removing panel "${i.id}"` : 'Removing panel…';
  const arg = i.file_path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? i.description ?? '';
  return `${b.name} ${String(arg)}`.slice(0, 140);
}

// Latest sentence of streaming thinking/text, so the activity tip shows what the planner is doing right now.
function latestLine(s) {
  const parts = s.trim().split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  const last = parts.at(-1) ?? '';
  return last.length > 140 ? `…${last.slice(-139)}` : last;
}

// ---------- session: one Claude Code session (same id) + its canvas ----------
function createSession(rec) {
  const clients = new Set();
  const panels = new Map(rec.panels.map(p => [p.id, { ...p, seq: 1, done: true }])); // id -> { id, title, width, seq, html, done, ms, ttft }
  const asks = new Map(); // askId -> { question, options, resolve }
  const approvals = new Map(); // reqId -> { tool, input, resolve }
  let busy = false;
  let status = '';
  let steps = []; // recent activity lines, newest last
  let block = { type: '', text: '' }; // content block the planner is streaming
  let lastStatusAt = 0;
  let statusTimer = null;
  let renderedThisTurn = false;
  let stopping = false;
  let planner = null; // started lazily (and again after idle shutdown): N sessions must not hold N Opus processes
  let plannerInput = null;
  let idleTimer = null;
  let saveTimer = null;

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      rec.panels = [...panels.values()].filter(p => p.done).map(({ id, title, width, html, ms, ttft }) => ({ id, title, width, html, ms, ttft }));
      saveSession(rec).catch(e => console.error(`[${rec.id}] save:`, e.message));
    }, 300);
  }

  // Claude Code titles sessions itself (same as in `claude --resume`); a user rename wins.
  async function refreshInfo() {
    const s = await getSessionInfo(rec.id, { dir: rec.cwd }).catch(() => null);
    if (!s) return;
    const title = rec.userTitled ? rec.title : s.customTitle || s.summary || rec.title;
    const branch = s.gitBranch === 'HEAD' ? '' : s.gitBranch ?? ''; // detached or not a repo
    if (title === rec.title && branch === rec.branch) return;
    Object.assign(rec, { title, branch });
    save();
    broadcastSessions();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (busy || asks.size || approvals.size || !planner) return;
      const q = planner;
      planner = null; // marks the close as intentional for the message loop
      q.close();
      broadcastSessions();
    }, IDLE_MS);
  }

  function send(ev) {
    for (const res of clients) sse(res, ev);
  }

  function replay(res) {
    const w = ev => sse(res, ev);
    w({ t: 'inputs', list: rec.inputs ?? [] });
    w({ t: 'busy', on: busy });
    if (status) w({ t: 'status', text: status, steps });
    for (const p of panels.values()) {
      w({ t: 'panel', id: p.id, title: p.title, width: p.width, seq: p.seq });
      w(p.done ? { t: 'done', id: p.id, seq: p.seq, html: p.html, ms: p.ms, ttft: p.ttft } : { t: 'chunk', id: p.id, seq: p.seq, d: p.html });
    }
    for (const [askId, a] of asks) w({ t: 'ask', askId, question: a.question, options: a.options });
    for (const [reqId, a] of approvals) w({ t: 'approve', reqId, tool: a.tool, input: a.input });
  }

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
        console.error(`[${rec.id}] render ${id}:`, e.message);
        p.html = fallbackHtml(brief); // never leave the user with a blank panel
      })
      .finally(() => {
        if (!live()) return;
        p.done = true;
        p.ms = Date.now() - start;
        send({ t: 'done', id, seq: p.seq, html: p.html, ms: p.ms, ttft: p.ttft });
        save();
      });
  }

  function resolveAsk(askId, value) {
    asks.get(askId)?.resolve(value);
    asks.delete(askId);
    send({ t: 'resolved', id: askId });
    broadcastSessions();
  }

  // UI tools (the planner's only output channel). Built per session: an MCP server instance serves one transport.
  const uiServer = () =>
    createSdkMcpServer({
      name: 'ui',
      version: '0.1.0',
      alwaysLoad: true, // the only output channel: never make the planner ToolSearch for it
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
              broadcastSessions();
            });
            return text(`User answered: ${answer}`);
          },
        ),
        tool('ui_remove', 'Remove a panel that is no longer relevant.', { id: z.string() }, async ({ id }) => {
          panels.delete(id);
          send({ t: 'remove', id });
          save();
          return text(`Removed "${id}".`);
        }),
      ],
    });

  // Approval cards are drawn by the harness, never by a model: the requester must not draw its own consent screen.
  async function canUseTool(toolName, input, { signal }) {
    const reqId = randomUUID();
    setStatus(`Waiting for your approval: ${toolName}`);
    const allow = await new Promise(resolve => {
      approvals.set(reqId, { tool: toolName, input, resolve });
      send({ t: 'approve', reqId, tool: toolName, input });
      broadcastSessions();
      signal.addEventListener('abort', () => resolve(false));
    });
    approvals.delete(reqId);
    send({ t: 'resolved', id: reqId });
    broadcastSessions();
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

  // append: a new step; otherwise the current step is refined (streaming), which is throttled.
  function setStatus(t, append = true) {
    if (append || !steps.length) steps.push(t);
    else steps[steps.length - 1] = t;
    steps = steps.slice(-6);
    status = t;
    if (!append && Date.now() - lastStatusAt < 150) {
      statusTimer ??= setTimeout(() => { statusTimer = null; flushStatus(); }, 150);
      return;
    }
    flushStatus();
  }

  function flushStatus() {
    lastStatusAt = Date.now();
    send({ t: 'status', text: status, steps });
    broadcastSessions(); // the sidebar shows each running session's current step
  }

  function clearStatus() {
    status = '';
    steps = [];
    flushStatus();
  }

  const describe = b => describeTool(b).replaceAll(`${rec.cwd}/`, ''); // folder-relative paths read shorter

  function onStream(ev) {
    if (ev.type === 'content_block_start') {
      block = { type: ev.content_block.type, text: '' };
      if (block.type === 'thinking') setStatus('Thinking…');
      if (block.type === 'tool_use') setStatus(describe({ name: ev.content_block.name }));
    }
    if (ev.type === 'content_block_delta') {
      const chunk = ev.delta.thinking ?? ev.delta.text;
      if (!chunk) return;
      const fresh = !block.text;
      block.text += chunk;
      const line = latestLine(block.text);
      if (line) setStatus(block.type === 'thinking' ? `Thinking: ${line}` : line, fresh && block.type !== 'thinking');
    }
  }

  function setBusy(on) {
    busy = on;
    send({ t: 'busy', on });
    broadcastSessions();
  }

  function start() {
    plannerInput = inbox();
    const q = (planner = query({
      prompt: plannerInput,
      options: {
        model: settings.plannerModel,
        ...(settings.plannerEffort !== 'default' && { effort: settings.plannerEffort }),
        permissionMode: settings.permissionMode,
        allowDangerouslySkipPermissions: true, // required to switch into "Allow all" from the ⚙ menu later
        cwd: rec.cwd,
        ...(rec.started ? { resume: rec.id } : { sessionId: rec.id }), // genui session id === Claude session id
        systemPrompt: { type: 'preset', preset: 'claude_code', append: PLANNER_APPEND },
        // User settings bring the user's MCP servers (user scope, plugins, claude.ai connectors), as in their own
        // Claude Code. Their hooks stay off: genui's Stop hook (an SDK callback) still runs, verified.
        settingSources: ['user', 'project', 'local'],
        settings: { disableAllHooks: true },
        mcpServers: { ui: uiServer() },
        allowedTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'mcp__ui__ui_show', 'mcp__ui__ui_ask', 'mcp__ui__ui_remove'],
        disallowedTools: ['AskUserQuestion'],
        canUseTool,
        hooks: { Stop: [{ hooks: [stopHook] }] },
        includePartialMessages: true, // stream activity into the Send button tip
        thinking: { type: 'adaptive', display: 'summarized' },
        env: process.env,
      },
    }));
    (async () => {
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init') {
            console.log(`[${rec.id}] planner: ${m.model}, cwd ${m.cwd}, mcp: ${m.mcp_servers.map(s => `${s.name}:${s.status}`).join(', ')}`);
            if (!rec.started) {
              rec.started = true;
              save();
              if (rec.userTitled) renameSession(rec.id, rec.title, { dir: rec.cwd }).catch(() => {});
            }
          }
          if (m.type === 'stream_event' && !m.parent_tool_use_id) onStream(m.event);
          if (m.type === 'assistant' && !m.parent_tool_use_id) {
            // The tool name streamed first; now the input is complete, refine that step with its argument.
            for (const b of m.message.content) if (b.type === 'tool_use') setStatus(describe(b), false);
          }
          if (m.type === 'result') {
            setBusy(false);
            if (m.is_error && !stopping) setStatus(`Error: ${m.subtype}`);
            else clearStatus();
            stopping = false;
            armIdle();
            refreshInfo();
          }
        }
      } catch (e) {
        console.error(`[${rec.id}] planner:`, e.message);
      }
      if (planner !== q) return; // closed on purpose (archived or idle)
      // One session's crash must not take down the others: the next prompt resumes it.
      console.error(`[${rec.id}] planner session ended`);
      planner = null;
      for (const askId of asks.keys()) resolveAsk(askId, '(The session ended.)');
      if (busy) {
        setBusy(false);
        setStatus('Error: planner session ended');
      }
    })();
  }

  async function stop() {
    if (!busy || !planner) return;
    stopping = true;
    for (const askId of asks.keys()) resolveAsk(askId, '(The user stopped the task.)');
    await planner.interrupt(); // pending approvals resolve as denied via their abort signal
  }

  function toPlanner(content) {
    clearTimeout(idleTimer);
    rec.lastActive = Date.now();
    save();
    if (!planner) start();
    renderedThisTurn = false;
    steps = [];
    setBusy(true);
    if (rec.canvasCleared) { // told with the next message rather than spending a turn on it
      const note = '[The user cleared the canvas: no panels are showing now.]';
      content = typeof content === 'string' ? `${note}\n${content}` : [{ type: 'text', text: note }, ...content];
      delete rec.canvasCleared;
    }
    plannerInput.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
  }

  function close() {
    const q = planner;
    planner = null;
    q?.close();
    for (const res of clients) {
      allClients.delete(res);
      res.end();
    }
    clients.clear(); // in-flight renders must not write to ended responses
    clearTimeout(idleTimer);
  }

  async function rename(title) {
    Object.assign(rec, { title, userTitled: true });
    if (rec.started) await renameSession(rec.id, title, { dir: rec.cwd }).catch(() => {}); // keeps `claude --resume` in sync
    save();
    broadcastSessions();
  }

  // Routes one POST /api message for this session.
  // The chat bar shows what the planner is working on, and its history button lists these.
  function logInput(entry) {
    send({ t: 'input', entry: addInput(rec, entry) });
    save();
  }

  async function handle(msg) {
    const panelTitle = panels.get(msg.panel)?.title;
    if (msg.t === 'prompt') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      const { blocks, names } = await prepareAttachments(msg.attachments, path.join(HOME, 'uploads', rec.id)); // throws: the route replies 400
      if (!text && !names.length) return;
      if (!rec.title) rec.title = (text.split('\n')[0] || names[0]).slice(0, 60); // until Claude names it
      logInput({ kind: 'prompt', text, files: names });
      toPlanner(blocks.length ? [...(text ? [{ type: 'text', text }] : []), ...blocks] : text);
    }
    if (msg.t === 'event') {
      // label: text of the clicked element, from the sandboxed panel. Only ever rendered as text.
      logInput({ kind: 'click', text: msg.label || JSON.stringify(msg.payload), panel: panelTitle });
      toPlanner(`[UI event] panel "${msg.panel}": ${JSON.stringify(msg.payload)}`);
    }
    if (msg.t === 'comment' && msg.text?.trim()) {
      logInput({ kind: 'comment', text: msg.text.trim(), panel: panelTitle, on: msg.target?.text });
      toPlanner(`[UI comment] panel "${msg.panel}" ("${panelTitle ?? 'removed'}"), on ${JSON.stringify(msg.target)}: ${msg.text}`);
    }
    if (msg.t === 'answer' && asks.has(msg.askId)) {
      logInput({ kind: 'answer', text: msg.value, on: asks.get(msg.askId).question });
      resolveAsk(msg.askId, msg.value);
    }
    if (msg.t === 'approval') approvals.get(msg.reqId)?.resolve(Boolean(msg.allow));
    if (msg.t === 'stop') await stop();
    if (msg.t === 'clearCanvas' && panels.size) {
      for (const id of panels.keys()) send({ t: 'remove', id }); // in-flight renders see they're superseded and stop
      panels.clear();
      rec.canvasCleared = true; // persisted, so a restart before the next message still tells the planner
      save();
    }
    // The session's own cwd, never a client-supplied path. explorer.exe exits 1 even on success: log, don't throw.
    if (msg.t === 'openFolder') execFile(FILE_MANAGER, [rec.cwd], e => e && console.error(`[${rec.id}] open folder:`, e.message));
  }

  // Settings changed in the ⚙ menu apply to running planners too.
  async function applySettings() {
    if (!planner) return;
    await planner.setPermissionMode(settings.permissionMode).catch(e => console.error(`[${rec.id}] permission mode:`, e.message));
    await planner.setModel(settings.plannerModel).catch(e => console.error(`[${rec.id}] model:`, e.message));
    const effortLevel = settings.plannerEffort === 'default' ? null : settings.plannerEffort; // null = model default
    await planner.applyFlagSettings({ effortLevel }).catch(e => console.error(`[${rec.id}] effort:`, e.message));
  }

  // Live status from this session's planner; otherwise the last status any planner reported.
  async function mcpStatus() {
    const list = planner && (await planner.mcpServerStatus().catch(() => null));
    if (list) mcpCache = list.filter(x => x.name !== 'ui').map(({ name, status }) => ({ name, status }));
    return { servers: mcpCache, live: Boolean(list) };
  }

  return {
    rec,
    clients,
    replay,
    handle,
    mcpStatus,
    close,
    rename,
    applySettings,
    get busy() { return busy; },
    summary: () => ({
      id: rec.id,
      title: rec.title,
      cwd: rec.cwd,
      branch: rec.branch,
      lastActive: rec.lastActive,
      busy,
      waiting: asks.size + approvals.size > 0,
      live: Boolean(planner),
      step: busy ? status : '',
    }),
  };
}

// Browsers never reveal absolute paths, so the local server shows the OS file/folder dialog.
// Resolves to the chosen paths, or [] if the user cancels. No AppleScript `activate`: it adds ~2s before the dialog shows.
let picking = false;
let mcpCache = null; // last MCP status any planner reported, for the chat bar's ＋ menu
async function pickPaths({ folder, multiple = false, prompt, start }) {
  if (picking) throw new Error('A file dialog is already open');
  const [cmd, args] = process.platform === 'darwin'
    ? ['osascript', [
        'on run argv',
        `set picked to choose ${folder ? 'folder' : 'file'} with prompt "${prompt}" default location (POSIX file (item 1 of argv))${multiple ? ' with multiple selections allowed' : ''}`,
        'if class of picked is not list then set picked to {picked}',
        'set out to ""',
        'repeat with f in picked',
        'set out to out & POSIX path of f & linefeed',
        'end repeat',
        'return out',
        'end run',
      ].flatMap(line => ['-e', line]).concat(start)]
    : ['zenity', ['--file-selection', ...(folder ? ['--directory'] : []), ...(multiple ? ['--multiple', '--separator=\n'] : []), `--title=${prompt}`, `--filename=${start}/`]];
  picking = true;
  try {
    return await new Promise((resolve, reject) => execFile(cmd, args, (e, out, err) => {
      if (!e) return resolve(out.split('\n').map(x => x.trim()).filter(Boolean));
      if (e.code === 'ENOENT') return reject(new Error(`No file dialog available (${cmd} not found)`));
      if (process.platform === 'darwin' ? /-128/.test(err) : e.code === 1) return resolve([]); // cancelled
      reject(new Error(err.trim() || e.message));
    }));
  } finally {
    picking = false;
  }
}

async function addSession(cwd) {
  const rec = newSession(await resolveDir(cwd));
  await saveSession(rec);
  sessions.set(rec.id, createSession(rec));
  broadcastSessions();
  return rec;
}

for (const rec of await loadSessions()) sessions.set(rec.id, createSession(rec));
if (!sessions.size) await addSession(process.env.GENUI_CWD || process.cwd());

// `genui` CLI: which session to show for a folder. new = fresh (reusing an untouched one), continue = latest, resume = pick in the jump list.
async function openFolder(dir, mode) {
  const cwd = await resolveDir(dir);
  const latest = [...sessions.values()].filter(x => x.rec.cwd === cwd).sort((a, b) => b.rec.lastActive - a.rec.lastActive)[0];
  if (mode === 'resume' && latest) return { jump: path.basename(cwd) };
  const untouched = latest && !latest.rec.started && !latest.busy;
  if (latest && (mode === 'continue' || mode === 'resume' || untouched)) return { session: latest.rec.id };
  return { session: (await addSession(cwd)).id };
}

// `genui stop` sends SIGTERM: close planners and warm renderers so no claude processes outlive the server.
process.on('SIGTERM', () => {
  for (const x of sessions.values()) x.close();
  pool.close();
  process.exit(0);
});

// ---------- HTTP ----------
const HTML = 'text/html; charset=utf-8';
const FILES = {
  '/': ['index.html', HTML],
  '/panel.html': ['panel.html', HTML],
  '/logo.svg': ['logo.svg', 'image/svg+xml'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.png': ['favicon.png', 'image/png'], // fallback for browsers without SVG favicons
  '/favicon.ico': ['favicon.ico', 'image/x-icon'], // browsers request this path on their own
};

const MAX_BODY = 64 * 1024 * 1024; // room for 10 attachments, base64-encoded
async function readJson(req) {
  let body = '';
  for await (const c of req) {
    body += c;
    if (body.length > MAX_BODY) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return JSON.parse(body);
}

const reply = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));

http
  .createServer(async (req, res) => {
    // DNS rebinding: a hostile page that points its own hostname at 127.0.0.1 still sends that Host.
    if (!HOSTS.includes(req.headers.host)) return res.writeHead(403).end();
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return reply(res, 200, { app: 'genui', version, pid: process.pid, busy: [...sessions.values()].filter(x => x.busy).length });
    }
    if (req.method === 'GET' && FILES[url.pathname]) {
      const [file, type] = FILES[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }); // always pick up UI edits on reload
      return res.end(await readFile(new URL(`./public/${file}`, import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      // Unknown or missing id falls back to the most recent session; the client sees it isn't in the list and switches.
      const p = sessions.get(url.searchParams.get('session')) ?? [...sessions.values()].sort((a, b) => b.rec.lastActive - a.rec.lastActive)[0];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      allClients.add(res);
      p.clients.add(res);
      sse(res, listEvent());
      sse(res, settingsEvent());
      p.replay(res);
      return req.on('close', () => { allClients.delete(res); p.clients.delete(res); });
    }
    if (req.method === 'POST' && url.pathname === '/api') {
      // This endpoint approves tool calls on this machine: reject cross-site requests.
      if (!ORIGINS.includes(req.headers.origin)) return res.writeHead(403).end();
      let msg;
      try {
        msg = await readJson(req);
      } catch (e) {
        return reply(res, e.status ?? 400, { error: e.status ? e.message : 'Bad JSON' }); // an escaped throw here would crash the server
      }
      if (msg.t === 'settings') {
        try {
          settings = { ...settings, ...validate(msg.value) };
        } catch (e) {
          return reply(res, 400, { error: e.message });
        }
        await saveSettings(settings);
        pool.configure(settings.renderModel, settings.renderEffort);
        await Promise.all([...sessions.values()].map(x => x.applySettings()));
        const ev = settingsEvent();
        for (const c of allClients) sse(c, ev);
        return res.writeHead(204).end();
      }
      if (msg.t === 'open') {
        let target;
        try {
          target = await openFolder(msg.cwd, msg.mode);
        } catch (e) {
          return reply(res, 400, { error: e.message });
        }
        for (const c of allClients) sse(c, { t: 'goto', ...target }); // an open tab switches instead of a new one opening
        return reply(res, 200, { ...target, switched: allClients.size > 0 });
      }
      if (msg.t === 'newSession' || msg.t === 'pickFolder') {
        try {
          const near = sessions.get(msg.session)?.rec.cwd;
          const cwd = msg.t === 'pickFolder'
            ? (await pickPaths({ folder: true, prompt: 'Choose a folder for the new session', start: near ? path.dirname(near) : homedir() }))[0]
            : msg.cwd;
          if (!cwd) return reply(res, 200, {}); // dialog cancelled
          const rec = await addSession(cwd);
          return reply(res, 200, { id: rec.id });
        } catch (e) {
          return reply(res, 400, { error: e.message });
        }
      }
      if (msg.t === 'renameSession' || msg.t === 'archiveSession') {
        const x = sessions.get(msg.id);
        if (!x) return reply(res, 400, { error: 'Unknown session' });
        if (msg.t === 'renameSession') {
          const title = String(msg.title ?? '').trim().slice(0, 100);
          if (!title) return reply(res, 400, { error: 'Title is empty' });
          await x.rename(title);
          return res.writeHead(204).end();
        }
        if (x.busy) return reply(res, 400, { error: 'Session is busy' });
        if (sessions.size === 1) return reply(res, 400, { error: 'Cannot archive the last session' });
        sessions.delete(msg.id);
        x.close();
        await archiveSession(msg.id);
        broadcastSessions();
        return res.writeHead(204).end();
      }
      const p = sessions.get(msg.session);
      if (!p) return reply(res, 400, { error: 'Unknown session' });
      if (msg.t === 'mcpStatus') return reply(res, 200, await p.mcpStatus());
      if (msg.t === 'pickPaths') { // ＋ menu: attach files or a folder by path, nothing uploaded
        try {
          const folder = Boolean(msg.folder);
          return reply(res, 200, { paths: await pickPaths({ folder, multiple: !folder, prompt: folder ? 'Attach a folder' : 'Attach files', start: p.rec.cwd }) });
        } catch (e) {
          return reply(res, 400, { error: e.message });
        }
      }
      try {
        await p.handle(msg);
      } catch (e) {
        return reply(res, 400, { error: e.message }); // e.g. a rejected attachment
      }
      return res.writeHead(204).end();
    }
    res.writeHead(404).end();
  })
  .listen(PORT, '127.0.0.1', () => console.log(`genui on http://127.0.0.1:${PORT}  (${sessions.size} sessions)`));
