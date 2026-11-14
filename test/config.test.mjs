import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuration, hash } from '../stable-fast-3d/config.mjs';
import { values } from './support.mjs';

test('connection hash ignores object key order but not array order', () => {
  assert.equal(hash({ b: 'two', a: 'one' }), hash({ a: 'one', b: 'two' }));
  assert.notEqual(hash(['one', 'two']), hash(['two', 'one']));
});
test('configuration accepts path prefixes and rejects credentials, query, fragment, and bad timeouts', () => {
  assert.equal(configuration({ ...values(), endpoint: 'https://example.org/sf3d/' }).endpoint, 'https://example.org/sf3d');
  for (const endpoint of ['', 'file:///tmp/service', 'https://user:pass@example.org', 'https://example.org?token=x', 'https://example.org/#x']) {
    assert.throws(() => configuration({ ...values(), endpoint }), /Invalid/);
  }
  for (const timeoutMinutes of [0, 1.5, 121, '30']) assert.throws(() => configuration({ ...values(), timeoutMinutes }), /Invalid/);
  assert.equal(configuration(values()).timeoutMs, 30 * 60_000);
});
