import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageInfo, readImage } from '../stable-fast-3d/input.mjs';
import { fixture } from './support.mjs';

function pngHeader(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(13, 8); header.write('IHDR', 12);
  header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20);
  return header;
}

test('imageInfo detects PNG dimensions and rejects oversized or non-image input', () => {
  assert.deepEqual({ width: 256, height: 128, mimeType: 'image/png' }, { ...imageInfo(pngHeader(256, 128)) });
  assert.throws(() => imageInfo(pngHeader(5000, 4000)), /16 million/);
  assert.throws(() => imageInfo(Buffer.from('garbage')), /PNG or JPEG/);
});

test('readImage reads only current-conversation uploads and returns hashed bytes', async t => {
  const f = await fixture(t);
  const image = await readImage(f.dataDir, f.inputPath, 1, f.controller.signal);
  assert.equal(image.mimeType, 'image/png'); assert.equal(image.width, 256); assert.equal(image.sha256.length, 64);
  assert.ok(image.bytes.length > 100);
  await assert.rejects(readImage(f.dataDir, '/etc/passwd', 1, f.controller.signal), /outside/);
  await assert.rejects(readImage(f.dataDir, join(f.dataDir, 'uploads', '2', 'x.png'), 1, f.controller.signal), /outside/);
  await writeFile(join(f.uploads, 'not-an-image.png'), Buffer.from('plain text'));
  await assert.rejects(readImage(f.dataDir, join(f.uploads, 'not-an-image.png'), 1, f.controller.signal), /PNG or JPEG/);
});
