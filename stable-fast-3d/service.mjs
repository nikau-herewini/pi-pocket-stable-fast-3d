import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { hash } from './config.mjs';
import { InputValidationError, readImage } from './input.mjs';

const PREFIX = 'x.stable-fast-3d.';
export const MEMO = Object.freeze({ started: PREFIX + 'started', outcome: PREFIX + 'outcome' });
export const LIMITS = Object.freeze({ glb: 64_000_000, json: 8192, readyMs: 15_000 });
const running = new Set();
const fail = message => { throw new Error(`SF3D: ${message}`); };

// Node's global fetch (undici) waits at most 300 seconds for response headers.
// CPU generation can take longer than the configured deadline allows, so give
// the request a dispatcher whose header wait covers the configured timeout.
export function longFetch(fetchImpl, timeoutMs, agentFactory = options => new Agent(options)) {
  const headerWait = Math.max(300_000, timeoutMs + 60_000);
  const agent = agentFactory({ connect: { timeout: 15_000 }, headersTimeout: headerWait, bodyTimeout: headerWait });
  return (url, init = {}) => fetchImpl(url, { ...init, dispatcher: agent });
}

export function validateGLB(bytes) {
  if (bytes.length < 20 || bytes.length > LIMITS.glb) fail('Backend returned an invalid or oversized GLB.');
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail('Backend returned a malformed GLB.');
  const jsonLength = bytes.readUInt32LE(12);
  if (jsonLength < 1 || 20 + jsonLength > bytes.length || bytes.toString('ascii', 16, 20) !== 'JSON') fail('Backend returned a malformed GLB.');
}

async function bounded(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) fail('Backend returned an empty response.');
  const chunks = []; let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) fail('Backend response exceeded its limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

export function createService(directory, Lock, getConfig, options = {}) {
  const base = options.fetch ?? fetch;
  const dataDir = options.dataDir;
  const readImageFile = options.readImage ?? (async (path, conversationId, signal, api, context) =>
    readImage(dataDir, path, conversationId, signal, await options.sources?.(api, context)));
  const readyMs = options.readyMs ?? LIMITS.readyMs;

  async function ready(http, config, signal) {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(readyMs)]);
    let response;
    try {
      response = await http(config.endpoint + '/readyz', { method: 'GET', redirect: 'error', signal: boundedSignal, headers: { Accept: 'application/json' } });
    } catch (error) {
      if (boundedSignal.aborted) fail('Backend readiness check timed out or stopped.');
      fail('Backend request failed. Check the connection.');
    }
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel(); fail('Backend is not ready.');
    }
    let body;
    try { body = JSON.parse((await bounded(response, LIMITS.json)).toString('utf8')); }
    catch { fail('Backend returned invalid readiness data.'); }
    if (body?.status !== 'ready') fail('Backend is not ready.');
  }

  async function clear(api, context, key) {
    await api.commit(async tx => { const lock = await tx.doc(Lock); if (lock.active?.key === key) delete lock.active; }, context);
  }

  async function persist(key, bytes) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, hash(key) + '.glb'), temp = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await rm(temp, { force: true }); }
    return { path, sha256: hash(bytes), bytes: bytes.length };
  }

  async function result(saved) {
    if (saved.error) fail(saved.error);
    let bytes;
    try {
      const file = await open(saved.path, 'r');
      try {
        if ((await file.stat()).size > LIMITS.glb) throw new Error();
        bytes = await file.readFile();
      } finally { await file.close(); }
      validateGLB(bytes);
      if (hash(bytes) !== saved.sha256) throw new Error();
    } catch { fail('Saved GLB is missing or changed. It will not be generated again automatically.'); }
    return {
      output: [{ type: 'text', text: `Generated a ${saved.width}×${saved.height} ${saved.mimeType} into a GLB saved at ${saved.path}. Render it with the artifact tool.` }],
      details: { path: saved.path, sha256: saved.sha256, bytes: saved.bytes, width: saved.width, height: saved.height, mimeType: saved.mimeType },
    };
  }

  return {
    isRunning: key => running.has(key),
    async generate(args, api, context) {
      const key = `${api.taskId}:${api.callId}`;
      const saved = await api.memo(MEMO.outcome, context);
      if (saved) { await clear(api, context, key); return result(saved); }
      const config = getConfig();
      const http = longFetch(base, config.timeoutMs);
      const started = await api.memo(MEMO.started, context);
      if (running.has(key)) fail('This request is already running.');
      running.add(key);
      let active, startedWritten = Boolean(started), resuming = false;
      try {
        await api.commit(async tx => {
          const lock = await tx.doc(Lock);
          if (lock.active && lock.active.key !== key) fail('Stable Fast 3D is busy or needs recovery. Use /sf3d-status.');
          if (!lock.active) {
            if (started) fail('This call was submitted or stopped. It will not be submitted again. Use /sf3d-status and owner recovery.');
            lock.active = { key, deadline: Date.now() + config.timeoutMs, connection: config.connection };
          } else {
            resuming = true;
          }
          active = { ...lock.active };
        }, context);
        if (active.connection !== config.connection) fail('The locked request belongs to another connection. Restore its settings or use owner recovery.');
        if (active.deadline <= Date.now()) fail('Generation deadline expired.');
        if (resuming) fail('This call was submitted or stopped; its outcome is unknown. Owner recovery is required. Do not retry.');
        const signal = AbortSignal.any([...(context.abortSignal ? [context.abortSignal] : []), AbortSignal.timeout(Math.max(1, active.deadline - Date.now()))]);
        const image = await readImageFile(args.image, api.conversationId, signal, api, context);
        await ready(http, config, signal);
        startedWritten = true;
        await api.memo(MEMO.started, true, context);
        const form = new FormData();
        form.append('image', new Blob([image.bytes], { type: image.mimeType }), image.mimeType === 'image/png' ? 'image.png' : 'image.jpg');
        let response;
        try {
          response = await http(config.endpoint + '/generate', { method: 'POST', redirect: 'error', signal, body: form });
        } catch (error) {
          if (signal.aborted) fail('Submission outcome is unknown because the request stopped. Owner recovery is required; do not retry.');
          fail('Submission outcome is unknown. Owner recovery is required; do not retry.');
        }
        if (response.status !== 200) {
          const status = response.status;
          await response.body?.cancel();
          const error = status === 503 ? 'Backend is busy. Try again later.' : `Backend rejected the request with HTTP ${status}.`;
          const receipt = await api.memo(MEMO.outcome, { error }, context);
          await clear(api, context, key);
          return result(receipt);
        }
        let glb;
        try {
          glb = await bounded(response, LIMITS.glb);
          validateGLB(glb);
        } catch (error) {
          const receipt = await api.memo(MEMO.outcome, { error: 'Backend returned an invalid GLB.' }, context);
          await clear(api, context, key);
          return result(receipt);
        }
        const receipt = await api.memo(MEMO.outcome, { ...await persist(key, glb), width: image.width, height: image.height, mimeType: image.mimeType }, context);
        await clear(api, context, key);
        return result(receipt);
      } catch (error) {
        if (active && !startedWritten) {
          try { await clear(api, context, key); } catch { /* Preserve a lock if the call ended. */ }
        }
        if (error instanceof InputValidationError) fail(error.message);
        if (error instanceof Error && error.message.startsWith('SF3D:')) throw error;
        fail('Generation stopped or failed. Use /sf3d-status if its lock remains.');
      } finally { running.delete(key); }
    },
    async inspect(active) {
      if (!active) return 'Stable Fast 3D is idle.';
      let status = 'unknown';
      try { status = active.connection !== getConfig().connection ? 'connection settings changed' : 'submitted; outcome unknown or still running'; } catch { /* no settings details in status output */ }
      return `Lock: ${active.key}\nStatus: ${status}\nDeadline: ${new Date(active.deadline).toISOString()}`;
    },
    async recover(active) {
      if (running.has(active.key)) fail('Stop the local call before recovery.');
    },
  };
}
