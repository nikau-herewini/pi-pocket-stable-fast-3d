import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '../stable-fast-3d/config.mjs';
import { createService, MEMO } from '../stable-fast-3d/service.mjs';
import { fixture, journal, Lock, readyResponse, glbResponse, glb } from './support.mjs';

const args = { image: '/tmp/placeholder' };

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
