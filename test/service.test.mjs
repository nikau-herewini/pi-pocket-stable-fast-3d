import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../stable-fast-3d/config.mjs';
import { createService, longFetch, MEMO } from '../stable-fast-3d/service.mjs';
import { fixture, journal, Lock, readyResponse, glbResponse, glb } from './support.mjs';

const args = { image: '/tmp/placeholder' };

test('longFetch waits past the default 5-minute response-header timeout', async () => {
  const captured = {};
  const agent = Symbol('agent');
  const wrapped = longFetch(
    (url, init) => { captured.url = url; captured.init = init; return Promise.resolve(new Response('ok')); },
    60 * 60 * 1000,
    options => { captured.options = options; return agent; },
  );
  const response = await wrapped('http://example.invalid/readyz', { method: 'GET', signal: AbortSignal.timeout(1000) });
  assert.equal(captured.url, 'http://example.invalid/readyz');
  assert.equal(captured.init.dispatcher, agent);
  assert.equal(captured.init.method, 'GET');
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(captured.options.connect.timeout, 15_000);
  assert.ok(captured.options.headersTimeout >= 60 * 60 * 1000 + 60_000);
  assert.equal(captured.options.headersTimeout, captured.options.bodyTimeout);
  assert.equal(response.status, 200);
});

test('longFetch never lowers the header wait below undici\'s default', async () => {
  let options;
  const wrapped = longFetch((_url, _init) => Promise.resolve(new Response()), 60_000, captured => { options = captured; return {}; });
  await wrapped('http://example.invalid/readyz');
  assert.ok(options.headersTimeout >= 300_000);
});

test('generates one persisted GLB, then replays from disk without network calls', async t => {
  const f = await fixture(t);
  const result = await f.service.generate({ image: f.inputPath }, f.api, f.context);
  assert.equal(result.output[0].type, 'text'); assert.ok(result.details.path.endsWith('.glb'));
  assert.equal(f.disk.snapshot().lock.active, undefined);
  assert.ok((await readFile(result.details.path)).subarray(0, 4).toString('ascii') === 'glTF');
  const reopened = await journal(join(f.root, 'journal.json'));
  const service = createService(join(f.root, 'outputs'), Lock, () => { throw new Error('settings unavailable'); }, { fetch: () => { throw new Error('must not fetch'); }, dataDir: f.dataDir });
  assert.deepEqual(await service.generate({ image: f.inputPath }, reopened.api(), f.context), result);
  await writeFile(result.details.path, 'changed');
  await assert.rejects(service.generate({ image: f.inputPath }, reopened.api(), f.context), /missing or changed/);
});
test('publishes successful models for the current conversation and preserves the original if preview fails', async t => {
  const token = 'a'.repeat(64), published = [];
  const f = await fixture(t, { serviceOptions: { publishPreview: async (id, bytes) => {
    published.push({ id, bytes });
    return token;
  } } });
  const result = await f.service.generate({ image: f.inputPath }, f.api, f.context);
  assert.equal(result.details.modelPreview, token);
  assert.match(result.output[0].text, /View in 3D/);
  assert.deepEqual(published, [{ id: f.api.conversationId, bytes: await readFile(result.details.path) }]);
  assert.deepEqual(await f.service.generate({ image: f.inputPath }, f.api, f.context), result);
  assert.equal(f.calls.filter(({ url }) => url.endsWith('/generate')).length, 1);

  const unavailable = await fixture(t, { serviceOptions: { publishPreview: async () => { throw new Error('disk unavailable'); } } });
  const fallback = await unavailable.service.generate({ image: unavailable.inputPath }, unavailable.api, unavailable.context);
  assert.equal(fallback.details.modelPreview, undefined);
  assert.match(fallback.output[0].text, /artifact tool/);
  assert.deepEqual(await readFile(fallback.details.path), await readFile(result.details.path));
});

test('backend rejection and busy responses are saved as outcomes and clear the lock', async t => {
  for (const [status, message] of [[422, /rejected the request/], [503, /busy/]]) {
    const f = await fixture(t, { handler: url => url.endsWith('/readyz') ? readyResponse() : new Response('{}', { status, headers: { 'content-type': 'application/json' } }) });
    await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), message);
    assert.equal(f.disk.snapshot().lock.active, undefined);
    // A new call may submit again (no stuck lock).
    const again = await fixture(t);
    assert.equal((await again.service.generate({ image: again.inputPath }, again.api, again.context)).output[0].type, 'text');
  }
});
test('an invalid GLB is a known failure that clears the lock', async t => {
  const f = await fixture(t, { handler: url => url.endsWith('/readyz') ? readyResponse() : new Response(Buffer.from('not a glb'), { status: 200 }) });
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), /invalid GLB/);
  assert.equal(f.disk.snapshot().lock.active, undefined);
});
test('a lost response keeps its lock and never POSTs again on replay', async t => {
  const f = await fixture(t, { handler: url => url.endsWith('/readyz') ? readyResponse() : (() => { throw new Error('network lost'); })() });
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), /outcome is unknown/);
  assert.ok(f.disk.snapshot().lock.active);
  const count = f.calls.length;
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), /submitted or stopped/);
  assert.equal(f.calls.length, count);
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.disk.api('other'), f.context), /busy/);
});
test('connection changes do not resubmit on the replacement backend', async t => {
  const f = await fixture(t, { handler: url => url.endsWith('/readyz') ? readyResponse() : (() => { throw new Error(); })() });
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context));
  f.settings.endpoint = 'https://example.org/replacement'; const count = f.calls.length;
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), /another connection/);
  assert.equal(f.calls.length, count);
});
test('deadline expiry releases an unsubmitted lock', async t => {
  const f = await fixture(t);
  await f.api.commit(async tx => { (await tx.doc(Lock)).active = { key: 'task:call', connection: configuration(f.settings).connection, deadline: Date.now() - 1 }; }, f.context);
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), /deadline expired/);
  assert.equal(f.disk.snapshot().lock.active, undefined);
});
