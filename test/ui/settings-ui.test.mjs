import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserFixture, clickText, fill, loaded, saved } from './harness.mjs';

test('loads endpoint and timeout, then saves valid values', async t => {
  const { page, state } = await browserFixture(t);
  await loaded(page);
  await fill(page, 'endpoint', 'http://mesh.example.org:8000');
  await fill(page, 'timeoutMinutes', '45');
  await clickText(page, 'Save settings');
  await saved(page);
  assert.equal(state.values.endpoint, 'http://mesh.example.org:8000');
  assert.equal(state.values.timeoutMinutes, 45);
  assert.deepEqual(state.patches.at(-1), { endpoint: 'http://mesh.example.org:8000', timeoutMinutes: 45 });
});
test('rejects an invalid URL and an out-of-range timeout without saving', async t => {
  const { page, state } = await browserFixture(t);
  await loaded(page);
  await fill(page, 'endpoint', 'file:///tmp/service');
  await clickText(page, 'Save settings');
  await page.waitForSelector('.error-box');
  await fill(page, 'endpoint', 'http://mesh.example.org:8000');
  await fill(page, 'timeoutMinutes', '121');
  await clickText(page, 'Save settings');
  await page.waitForSelector('.error-box');
  assert.equal(state.patches.length, 0);
});
