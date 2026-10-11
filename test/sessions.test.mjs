import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDir, newSession, archiveSession, addInput, MAX_INPUTS } from '../sessions.mjs';

test('addInput keeps the newest inputs, capped, and works on sessions saved before inputs existed', () => {
  const rec = {};
  for (let i = 0; i < MAX_INPUTS + 5; i++) addInput(rec, { kind: 'prompt', text: `p${i}` });
  assert.equal(rec.inputs.length, MAX_INPUTS);
  assert.equal(rec.inputs[0].text, 'p5');
  assert.equal(rec.inputs.at(-1).text, `p${MAX_INPUTS + 4}`);

  const e = addInput(rec, { kind: 'click', text: 'x'.repeat(5000), panel: 'Demo' });
  assert.equal(e.text.length, 4000);
  assert.equal(e.panel, 'Demo');
  assert.ok(!('on' in e));
});

test('resolveDir only accepts existing absolute directories and returns the real path', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'genui-')));
  const dir = path.join(root, 'My App');
  await mkdir(dir);
  await writeFile(path.join(root, 'file'), '');

  await assert.rejects(resolveDir('relative/path'), /absolute/);
  await assert.rejects(resolveDir(path.join(root, 'missing')), /existing directory/);
  await assert.rejects(resolveDir(path.join(root, 'file')), /existing directory/);
  assert.equal(await resolveDir(path.join(dir, '..', 'My App')), dir);
});

test('session ids are UUIDs, so they are safe file names', async () => {
  assert.match(newSession('/tmp').id, /^[0-9a-f-]{36}$/);
  await assert.rejects(archiveSession('../../etc/passwd'), /Bad session id/);
});
