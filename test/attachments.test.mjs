import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareAttachments, MAX_ATTACHMENTS, MAX_IMAGE_BYTES } from '../attachments.mjs';

const b64 = s => Buffer.from(s).toString('base64');

test('images go inline, files are saved and listed, picked paths pass through', async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'genui-att-')));
  const uploads = path.join(dir, 'uploads');
  const { blocks, names } = await prepareAttachments([
    { type: 'image', name: 'shot.png', mediaType: 'image/png', data: b64('png') },
    { type: 'file', name: '../../evil name?.txt', data: b64('hello') },
    { type: 'path', path: dir },
  ], uploads);

  assert.deepEqual(blocks[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64('png') } });
  const [saved] = await readdir(uploads);
  assert.match(saved, /^\d+-evil name_.txt$/); // basename only, odd characters replaced: no escaping uploadDir
  assert.equal(await readFile(path.join(uploads, saved), 'utf8'), 'hello');
  assert.match(blocks[1].text, new RegExp(`- ${path.join(uploads, saved)}\\n- ${dir} \\(folder\\)$`));
  assert.deepEqual(names, ['shot.png', 'evil name_.txt', path.basename(dir)]);
});

test('bad attachments are rejected before anything is written', async () => {
  const uploads = path.join(await mkdtemp(path.join(tmpdir(), 'genui-att-')), 'uploads');
  const file = { type: 'file', name: 'a.txt', data: b64('a') };
  await assert.rejects(prepareAttachments([file, { type: 'image', mediaType: 'image/svg+xml', data: '' }], uploads), /Unsupported image type/);
  await assert.rejects(prepareAttachments([{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) }], uploads), /over 5 MB/);
  await assert.rejects(prepareAttachments([file, { type: 'path', path: 'relative/x' }], uploads), /absolute/);
  await assert.rejects(prepareAttachments([{ type: 'path', path: '/definitely/not/here' }], uploads), /Not found/);
  await assert.rejects(prepareAttachments(Array(MAX_ATTACHMENTS + 1).fill(file), uploads), /At most/);
  await assert.rejects(readdir(uploads), { code: 'ENOENT' }); // nothing saved by any failed call
  assert.deepEqual(await prepareAttachments(undefined, uploads), { blocks: [], names: [] });
});
