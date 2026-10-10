import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFences } from '../renderer.mjs';

test('stripFences removes markdown fences the model adds despite instructions', () => {
  assert.equal(stripFences('```html\n<div>x</div>\n```'), '<div>x</div>');
  assert.equal(stripFences('```\n<p>y</p>```'), '<p>y</p>');
  assert.equal(stripFences('<div>```inline```</div>'), '<div>```inline```</div>');
});
