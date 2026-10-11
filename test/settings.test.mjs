import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../settings.mjs';

test('validate keeps allowed values, drops unknown keys, rejects bad values', () => {
  assert.deepEqual(validate({ permissionMode: 'acceptEdits', junk: 1 }), { permissionMode: 'acceptEdits' });
  assert.throws(() => validate({ plannerModel: 'gpt-5' }), /Invalid plannerModel/);
  assert.throws(() => validate({ permissionMode: 'yolo' }), /Invalid permissionMode/);
});
