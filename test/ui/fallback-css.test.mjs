import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture, loaded } from './harness.mjs';

test('hides the basic-settings fallback only for this module row', async t => {
  const { page } = await browserFixture(t);
  await loaded(page);
  const hidden = await page.$eval('#ext-more-stable-fast-3d-ts details:has(> .ext-settings)', element => getComputedStyle(element).display === 'none');
  assert.equal(hidden, true);
});
