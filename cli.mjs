import { homedir } from 'node:os';
import path from 'node:path';

export const USAGE = `Usage: genui [dir] [options]
       genui stop [--force]

Opens dir (default: the current folder) in genui, starting the server if needed.

  -c, --continue   Open the most recent session in this folder
  -r, --resume     Pick a session for this folder in the browser
      --no-open    Print the URL instead of opening a browser
      --force      With stop: stop even while sessions are working
  -h, --help       Show this help

Environment: PORT (default 4317), GENUI_DIR (default ~/.genui)`;

export function parseArgs(argv) {
  const opts = { cmd: 'open', mode: 'new', dir: null, open: true, force: false };
  for (const a of argv) {
    if (a === '-c' || a === '--continue') opts.mode = 'continue';
    else if (a === '-r' || a === '--resume') opts.mode = 'resume';
    else if (a === '--no-open') opts.open = false;
    else if (a === '--force') opts.force = true;
    else if (a === '-h' || a === '--help') opts.cmd = 'help';
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else if (a === 'stop' && opts.cmd === 'open' && opts.dir === null) opts.cmd = 'stop';
    else if (opts.dir === null) opts.dir = a;
    else throw new Error(`Unexpected argument ${a}`);
  }
  return opts;
}

// Running bare `genui` in ~ or / would hand the agent your whole disk; naming it explicitly is allowed.
export function broadDir(cwd, explicit, home = homedir()) {
  return !explicit && (cwd === home || cwd === path.parse(cwd).root);
}
