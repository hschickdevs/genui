#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { USAGE, broadDir, parseArgs } from '../cli.mjs';
import { HOME } from '../sessions.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) die('genui needs Node 22 or newer');

const PORT = Number(process.env.PORT || 4317);
const BASE = `http://127.0.0.1:${PORT}`;
const LOG = path.join(HOME, 'server.log');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function die(message) {
  console.error(`genui: ${message}`);
  process.exit(1);
}

const health = () =>
  fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) })
    .then(r => r.json())
    .catch(() => null);

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  die(`${e.message}\n\n${USAGE}`);
}
if (opts.cmd === 'help') {
  console.log(USAGE);
  process.exit(0);
}

let h = await health();
if (h && h.app !== 'genui') die(`port ${PORT} is used by another program. Try: PORT=4318 genui`);

if (opts.cmd === 'stop') {
  if (!h) die('not running');
  if (h.busy && !opts.force) die(`${h.busy} session(s) still working. Wait, or run: genui stop --force`);
  process.kill(h.pid, 'SIGTERM');
  for (let i = 0; i < 50 && (await health()); i++) await sleep(100);
  console.log('genui stopped. Sessions are saved and resume next time.');
  process.exit(0);
}

const cwd = path.resolve(opts.dir ?? '.');
if (broadDir(cwd, opts.dir !== null)) die(`refusing to open ${cwd}. cd into a project, or run: genui "${cwd}"`);

if (!h) {
  preflight();
  mkdirSync(HOME, { recursive: true });
  const log = openSync(LOG, 'w'); // truncated per start, so it never grows unbounded
  const server = fileURLToPath(new URL('../server.mjs', import.meta.url));
  // Detached: closing this terminal must not end the server or its sessions.
  spawn(process.execPath, [server], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, PORT: String(PORT), GENUI_CWD: cwd } }).unref();
  for (let i = 0; i < 150 && !(h = await health()); i++) await sleep(100);
  if (h?.app !== 'genui') die(`server did not start. See ${LOG}`);
} else if (h.version !== version) {
  console.warn(`genui: the running server is v${h.version}, this CLI is v${version}. Restart it with: genui stop && genui`);
}

const r = await fetch(`${BASE}/api`, {
  method: 'POST',
  headers: { origin: BASE, 'content-type': 'application/json' }, // the server only accepts its own origin
  body: JSON.stringify({ t: 'open', cwd, mode: opts.mode }),
});
const target = await r.json().catch(() => ({ error: `request failed (${r.status})` }));
if (!r.ok) die(target.error);

const hash = target.session ? `s=${target.session}` : `jump=${encodeURIComponent(target.jump)}`;
const url = `${BASE}/#${hash}`;
if (target.switched) console.log(`genui: switched your open tab to ${path.basename(cwd)}  (${url})`);
else {
  console.log(`genui: ${path.basename(cwd)} → ${url}`);
  if (opts.open) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

function preflight() {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX) return;
  const s = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8' });
  if (s.error) die('Claude Code not found. Install it (https://code.claude.com/docs/en/setup) and run `claude auth login`, or set ANTHROPIC_API_KEY.');
  let status = {};
  try {
    status = JSON.parse(s.stdout);
  } catch {}
  if (!status.loggedIn) die('not logged in to Claude. Run: claude auth login');
}
