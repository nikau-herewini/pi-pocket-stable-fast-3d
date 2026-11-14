import { deflateSync } from 'node:zlib';
import { mkdtemp, mkdir, rm, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../stable-fast-3d/config.mjs';
import { createService } from '../stable-fast-3d/service.mjs';

export function png(width = 256, height = 256) {
  const chunk = (type, bytes) => {
    const data = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); data.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))]);
}

export function glb() {
  const json = Buffer.from('{"asset":{"version":"2.0"}}');
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.alloc(8 + json.length + pad);
  chunk.writeUInt32LE(json.length + pad, 0); chunk.write('JSON', 4); json.copy(chunk, 8);
  const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + chunk.length, 8);
  return Buffer.concat([header, chunk]);
}

export const values = () => ({ endpoint: 'http://127.0.0.1:8000', timeoutMinutes: 30 });
export const readyResponse = () => new Response(JSON.stringify({ status: 'ready', device: 'cpu' }), { status: 200, headers: { 'content-type': 'application/json' } });
export const glbResponse = () => new Response(glb(), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
export const Lock = Symbol('Lock');

export async function journal(path) {
  let state = { lock: {}, memos: {} }, line = Promise.resolve();
  try { state = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const transact = (fn, context) => {
    const next = line.then(async () => {
      context.abortSignal.throwIfAborted();
      const draft = structuredClone(state); const result = await fn(draft);
      context.abortSignal.throwIfAborted();
      await writeFile(path + '.tmp', JSON.stringify(draft)); await rename(path + '.tmp', path); state = draft; return result;
    }); line = next.catch(() => {}); return next;
  };
  return {
    snapshot: () => structuredClone(state),
    api(taskId = 'task', callId = 'call') {
      const key = `${taskId}:${callId}`;
      return { taskId, callId, conversationId: 1,
        commit: (fn, context) => transact(draft => fn({ doc: async token => { if (token !== Lock) throw new Error('wrong token'); return draft.lock; } }), context),
        memo: async (name, ...rest) => {
          if (rest.length === 1) { rest[0].abortSignal.throwIfAborted(); return structuredClone(state.memos[key]?.[name]); }
          return transact(draft => { draft.memos[key] ??= {}; draft.memos[key][name] ??= rest[0]; return structuredClone(draft.memos[key][name]); }, rest[1]);
        },
      };
    },
  };
}

export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sf3d-extension-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data'), uploads = join(dataDir, 'uploads', '1');
  await mkdir(uploads, { recursive: true }); await writeFile(join(uploads, 'input.png'), png());
  const disk = await journal(join(root, 'journal.json')), calls = [], settings = values();
  const controller = new AbortController(), context = { abortSignal: controller.signal };
  const service = createService(join(root, 'outputs'), Lock, () => configuration(settings), {
    dataDir, readyMs: 100,
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      if (options.handler) return options.handler(url, init, calls);
      if (url.endsWith('/readyz')) return readyResponse();
      return glbResponse();
    }, ...options.serviceOptions,
  });
  return { root, dataDir, uploads, disk, calls, settings, service, controller, context, api: disk.api(), inputPath: join(uploads, 'input.png') };
}
