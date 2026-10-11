import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

export const HOME = process.env.GENUI_DIR || path.join(homedir(), '.genui'); // per-user, never in the repo; override for test instances
// A session = one Claude Code session (same id) + its canvas.
export const DIR = path.join(HOME, 'sessions');
const ID = /^[0-9a-f-]{36}$/; // ids become file names: only UUIDs

export async function loadSessions() {
  await mkdir(DIR, { recursive: true });
  const files = (await readdir(DIR)).filter(f => f.endsWith('.json'));
  const list = await Promise.all(files.map(async f => JSON.parse(await readFile(path.join(DIR, f), 'utf8'))));
  return list.filter(s => ID.test(s.id));
}

export async function saveSession(rec) {
  await writeFile(path.join(DIR, `${rec.id}.json`), JSON.stringify(rec));
}

// Archive instead of delete: the Claude transcript survives either way, the canvas stays recoverable.
export async function archiveSession(id) {
  if (!ID.test(id)) throw new Error('Bad session id');
  await mkdir(path.join(DIR, 'archive'), { recursive: true });
  await rename(path.join(DIR, `${id}.json`), path.join(DIR, 'archive', `${id}.json`));
}

export function newSession(cwd) {
  const now = Date.now();
  return { id: randomUUID(), cwd, title: '', branch: '', createdAt: now, lastActive: now, started: false, panels: [], inputs: [] };
}

// What the user sent the planner, for the chat bar's history. Capped: it rides along in every save.
export const MAX_INPUTS = 50;
export function addInput(rec, { kind, text, panel, on }) {
  const entry = { kind, text: String(text ?? '').slice(0, 4000), at: Date.now() };
  if (panel) entry.panel = String(panel).slice(0, 200);
  if (on) entry.on = String(on).slice(0, 300);
  rec.inputs = [...(rec.inputs ?? []), entry].slice(-MAX_INPUTS); // sessions saved before this feature have none
  return entry;
}

// Validates a user-supplied folder (trust boundary) and returns its real path.
export async function resolveDir(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('Path must be absolute');
  try {
    const real = await realpath(cwd);
    if ((await stat(real)).isDirectory()) return real;
  } catch {}
  throw new Error('Not an existing directory');
}
