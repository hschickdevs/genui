import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Limits at the trust boundary (the browser). The Messages API caps images at 5 MB each.
export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const bytesOf = b64 => Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
const safeName = n => path.basename(String(n || 'file')).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
const mb = n => `${n / 1024 / 1024} MB`;

// Chat-bar attachments -> planner content. Images go inline (the model sees them at once); pasted or
// dropped files are saved under uploadDir; paths from the native picker pass through. All are checked
// before anything is written, so a bad attachment never leaves half an upload behind.
export async function prepareAttachments(list, uploadDir) {
  if (list == null) return { blocks: [], names: [] };
  if (!Array.isArray(list)) throw new Error('Bad attachments');
  if (list.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments`);
  const checked = [];
  for (const a of list) {
    const name = safeName(a?.name);
    if (a?.type === 'image') {
      if (!IMAGE_TYPES.includes(a.mediaType)) throw new Error(`Unsupported image type: ${String(a.mediaType).slice(0, 40)}`);
      if (typeof a.data !== 'string' || bytesOf(a.data) > MAX_IMAGE_BYTES) throw new Error(`${name} is over ${mb(MAX_IMAGE_BYTES)}`);
      checked.push({ ...a, name });
    } else if (a?.type === 'file') {
      if (typeof a.data !== 'string' || bytesOf(a.data) > MAX_FILE_BYTES) throw new Error(`${name} is over ${mb(MAX_FILE_BYTES)}`);
      checked.push({ ...a, name });
    } else if (a?.type === 'path') {
      if (typeof a.path !== 'string' || !path.isAbsolute(a.path)) throw new Error('Attached paths must be absolute');
      const s = await stat(a.path).catch(() => null);
      if (!s) throw new Error(`Not found: ${a.path}`);
      checked.push({ type: 'path', path: a.path, dir: s.isDirectory(), name: path.basename(a.path) });
    } else {
      throw new Error('Unknown attachment type');
    }
  }

  const blocks = [];
  const paths = [];
  for (const a of checked) {
    if (a.type === 'image') blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    if (a.type === 'path') paths.push(a.dir ? `${a.path} (folder)` : a.path);
    if (a.type === 'file') {
      await mkdir(uploadDir, { recursive: true });
      const file = path.join(uploadDir, `${Date.now()}-${a.name}`);
      await writeFile(file, Buffer.from(a.data, 'base64'));
      paths.push(file);
    }
  }
  if (paths.length) blocks.push({ type: 'text', text: `[Attached files: open them with Read, Glob or Grep]\n${paths.map(p => `- ${p}`).join('\n')}` });
  return { blocks, names: checked.map(a => a.name) };
}
