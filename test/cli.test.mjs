import { test } from 'node:test';
import assert from 'node:assert/strict';
import { broadDir, parseArgs } from '../cli.mjs';

test('parseArgs maps flags, commands and the folder', () => {
  assert.deepEqual(parseArgs([]), { cmd: 'open', mode: 'new', dir: null, open: true, force: false });
  assert.deepEqual(parseArgs(['-c', 'src', '--no-open']), { cmd: 'open', mode: 'continue', dir: 'src', open: false, force: false });
  assert.equal(parseArgs(['--resume']).mode, 'resume');
  assert.deepEqual(parseArgs(['stop', '--force']), { cmd: 'stop', mode: 'new', dir: null, open: true, force: true });
  assert.equal(parseArgs(['./stop']).dir, './stop'); // a folder literally named stop is still reachable
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['a', 'b']), /Unexpected argument/);
});

test('broadDir refuses home and root only when the folder was not named explicitly', () => {
  assert.equal(broadDir('/home/me', false, '/home/me'), true);
  assert.equal(broadDir('/', false, '/home/me'), true);
  assert.equal(broadDir('/home/me', true, '/home/me'), false);
  assert.equal(broadDir('/home/me/project', false, '/home/me'), false);
});
