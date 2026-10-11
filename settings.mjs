import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HOME } from './sessions.mjs';

const FILE = path.join(HOME, 'settings.json');
const MODELS = [
  ['claude-fable-5-1', 'Fable 5.1 (strongest)'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5 (fastest)'],
];
const EFFORTS = [
  ['default', 'Default'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
];

// [value, label] pairs; the client renders these, the server only accepts these.
export const OPTIONS = {
  permissionMode: [
    ['bypassPermissions', 'Allow all (no prompts)'],
    ['auto', 'Auto (classifier decides)'],
    ['acceptEdits', 'Auto-accept edits, ask for commands'],
    ['default', 'Ask before edits and commands'],
  ],
  plannerModel: MODELS,
  plannerEffort: EFFORTS,
  renderModel: MODELS,
  renderEffort: EFFORTS,
};

export const DEFAULTS = {
  permissionMode: 'bypassPermissions',
  plannerModel: process.env.GENUI_PLANNER_MODEL || 'claude-opus-5-5',
  renderModel: process.env.GENUI_RENDER_MODEL || 'claude-haiku-5-5',
  plannerEffort: 'default', // 'default' = the model's own default effort
  renderEffort: 'default',
};

// Trust boundary: keeps only known keys with allowed values.
export function validate(partial) {
  const out = {};
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (!OPTIONS[key]) continue;
    if (!OPTIONS[key].some(([v]) => v === value)) throw new Error(`Invalid ${key}`);
    out[key] = value;
  }
  return out;
}

export async function loadSettings() {
  try {
    return { ...DEFAULTS, ...validate(JSON.parse(await readFile(FILE, 'utf8'))) };
  } catch {
    return { ...DEFAULTS }; // missing or hand-broken file: fall back rather than refuse to start
  }
}

export async function saveSettings(settings) {
  await mkdir(HOME, { recursive: true });
  await writeFile(FILE, `${JSON.stringify(settings, null, 2)}\n`);
}
