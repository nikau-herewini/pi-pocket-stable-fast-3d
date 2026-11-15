import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageInfo, readImage } from '../stable-fast-3d/input.mjs';
import { hash } from '../stable-fast-3d/config.mjs';
import { processedDirectory, recordGeneratedImage } from '../stable-fast-3d/sources.mjs';
import { fixture, png } from './support.mjs';

function pngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12);
  header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header;
}

test('imageInfo distinguishes unsupported format, invalid header, dimensions, and pixel limit', () => {
  assert.deepEqual(imageInfo(pngHeader(256, 128)), { width: 256, height: 128, mimeType: 'image/png' });
  assert.equal(imageInfo(pngHeader(4000, 4000)).width, 4000);
  assert.throws(() => imageInfo(pngHeader(5000, 4000)), /5000 × 4000.*16 million.*Reduce/);
  assert.throws(() => imageInfo(pngHeader(0, 10)), /header.*zero.*Re-export/);
  assert.throws(() => imageInfo(Buffer.from('garbage')), /Unsupported.*PNG or JPEG/);
  assert.throws(() => imageInfo(pngHeader(10, 10).subarray(0, 20)), /header.*Re-export/);
  assert.throws(() => imageInfo(Buffer.from([0xff, 0xd8])), /header/);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 10, 0, 20, 1]);
  assert.deepEqual(imageInfo(jpeg), { width: 20, height: 10, mimeType: 'image/jpeg' });
});

test('readImage scopes uploads and reports actionable path, format, and file errors', async t => {
  const f = await fixture(t), read = path => readImage(f.dataDir, path, 1, f.controller.signal);
  const image = await read(f.inputPath);
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.width, 256); assert.equal(image.sha256.length, 64);
  await assert.rejects(read('/etc/passwd'), /outside the allowed locations/);
  await assert.rejects(read(join(f.dataDir, 'uploads', '2', 'x.png')), /outside/);
  await assert.rejects(read('relative.png'), /absolute local file path/);
  await assert.rejects(read(f.inputPath + '\0'), /null bytes/);
  await assert.rejects(read(join(f.uploads, 'missing.png')), /could not be read.*exists.*accessible/);
  await mkdir(join(f.uploads, 'directory'));
  await assert.rejects(read(join(f.uploads, 'directory')), /not a regular file/);
  const path = join(f.uploads, 'image.png');
  await writeFile(path, Buffer.from('plain text'));
  await assert.rejects(read(path), /Unsupported.*PNG or JPEG/);
  await writeFile(path, Buffer.alloc(0));
  await assert.rejects(read(path), /empty.*Re-export/);
  await truncate(path, 10_000_001);
  await assert.rejects(read(path), /10000001 bytes.*10 MB.*Resize or compress/);
  await writeFile(path, pngHeader(4000, 4000)); await truncate(path, 10_000_000);
  assert.equal((await read(path)).width, 4000);
});

test('processed images must stay in the current conversation folder, including after symlink resolution', async t => {
  const f = await fixture(t), cwd = join(f.root, 'workspace');
  const processedDir = processedDirectory(cwd, 1), other = processedDirectory(cwd, 2);
  await mkdir(processedDir, { recursive: true }); await mkdir(other, { recursive: true });
  const path = join(processedDir, 'resized.png'); await writeFile(path, png(32, 32));
  const read = path => readImage(f.dataDir, path, 1, f.controller.signal, { processedDir });
  assert.equal((await read(path)).width, 32);
  await assert.rejects(read(join(other, 'resized.png')), /outside/);
  await assert.rejects(read(join(processedDir, '..', '2', 'resized.png')), /outside/);
  await symlink(f.inputPath, join(processedDir, 'same-conversation.png'));
  assert.equal((await read(join(processedDir, 'same-conversation.png'))).width, 256);
  const secret = join(f.root, 'secret.png'); await writeFile(secret, png());
  await symlink(secret, join(processedDir, 'escape.png'));
  await assert.rejects(read(join(processedDir, 'escape.png')), /outside/);
  await symlink(other, join(processedDir, 'other'));
  await writeFile(join(other, 'resized.png'), png());
  await assert.rejects(read(join(processedDir, 'other', 'resized.png')), /outside/);
  assert.equal(processedDirectory('ssh://remote/workspace', 1), undefined);
});

test('a symlinked processed folder cannot grant access to arbitrary files', async t => {
  const f = await fixture(t), processedDir = join(f.root, '.sf3d-inputs', '1');
  await mkdir(join(f.root, '.sf3d-inputs'));
  await symlink(f.root, processedDir);
  await writeFile(join(f.root, 'private.png'), png());
  await assert.rejects(readImage(f.dataDir, join(processedDir, 'private.png'), 1, f.controller.signal, { processedDir }), /outside/);
});

test('SD outputs require a conversation receipt and unchanged bytes, not just a shared output path', async t => {
  const f = await fixture(t), outputs = join(f.dataDir, 'extensions', 'stable-diffusion', 'outputs');
  await mkdir(outputs, { recursive: true });
  const path = join(outputs, 'generated.png'), bytes = png(); await writeFile(path, bytes);
  const generatedImages = { [path]: hash(bytes) };
  assert.equal((await readImage(f.dataDir, path, 1, f.controller.signal, { generatedImages })).width, 256);
  await assert.rejects(readImage(f.dataDir, path, 2, f.controller.signal, { generatedImages: {} }), /outside.*recorded Stable Diffusion/);
  await writeFile(path, png(32, 32));
  await assert.rejects(readImage(f.dataDir, path, 1, f.controller.signal, { generatedImages }), /has changed.*processed-image folder/);
  const secret = join(f.root, 'private.png'); await writeFile(secret, bytes);
  const link = join(outputs, 'escape.png'); await symlink(secret, link);
  await assert.rejects(readImage(f.dataDir, link, 1, f.controller.signal, { generatedImages: { [link]: hash(bytes) } }), /outside/);
  await assert.rejects(readImage(f.dataDir, secret, 1, f.controller.signal, { generatedImages: { [secret]: hash(bytes) } }), /outside/);
});

test('SD hook records structured successful results in the current conversation, idempotently', async () => {
  const Sources = Symbol('sources'), conversations = new Map();
  const api = id => ({ conversationId: id, commit: async fn => fn({ doc: async (token, conversationId) => {
    assert.equal(token, Sources); assert.equal(conversationId, id);
    if (!conversations.has(id)) conversations.set(id, { images: {} });
    return conversations.get(id);
  } }) });
  const result = { details: { path: '/data/extensions/stable-diffusion/outputs/a.png', sha256: 'a'.repeat(64) } };
  await recordGeneratedImage({ name: 'sd_generate' }, result, api(1), {}, Sources);
  await recordGeneratedImage({ name: 'sd_generate' }, result, api(1), {}, Sources);
  assert.deepEqual(conversations.get(1).images, { [result.details.path]: result.details.sha256 });
  for (const [call, value] of [
    [{ name: 'other_tool' }, result], [{ name: 'sd_generate' }, { ...result, diagnostics: [{ code: 'exception' }] }],
    [{ name: 'sd_generate' }, { details: { path: result.details.path, sha256: 'invalid' } }],
    [{ name: 'sd_generate' }, { output: [{ type: 'text', text: result.details.path }] }],
  ]) await recordGeneratedImage(call, value, api(2), {}, Sources);
  assert.equal(conversations.has(2), false);
});

test('service preserves validation errors, releases the lock, and does not contact the backend', async t => {
  const f = await fixture(t);
  await writeFile(f.inputPath, Buffer.from('not an image'));
  await assert.rejects(f.service.generate({ image: f.inputPath }, f.api, f.context), /SF3D: Unsupported image format.*PNG or JPEG/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.disk.snapshot().lock.active, undefined);
});

test('service sends program-processed and recorded SD images through the normal generation flow', async t => {
  const f = await fixture(t, { serviceOptions: { sources: async () => sources } });
  const processedDir = join(f.root, 'workspace', '.sf3d-inputs', '1');
  const outputs = join(f.dataDir, 'extensions', 'stable-diffusion', 'outputs');
  await mkdir(processedDir, { recursive: true }); await mkdir(outputs, { recursive: true });
  const generated = join(outputs, 'sd.png'), processed = join(processedDir, 'compressed.jpg');
  const bytes = png(32, 32); await writeFile(generated, bytes); await writeFile(processed, bytes);
  const sources = { processedDir, generatedImages: { [generated]: hash(bytes) } };
  for (const [i, path] of [generated, processed].entries()) {
    const result = await f.service.generate({ image: path }, f.disk.api('task' + i), f.context);
    assert.equal(result.details.width, 32);
  }
  assert.equal(f.calls.filter(call => call.url.endsWith('/generate')).length, 2);
});
