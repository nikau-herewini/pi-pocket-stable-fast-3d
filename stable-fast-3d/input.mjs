import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { hash } from './config.mjs';

export const INPUT_LIMITS = Object.freeze({ bytes: 10_000_000, pixels: 16_000_000 });

export function imageInfo(bytes) {
  let width, height, mimeType;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mimeType = 'image/png';
  } else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    mimeType = 'image/jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  }
  if (!width || !height || width * height > INPUT_LIMITS.pixels) throw new Error('Image must be PNG or JPEG with at most 16 million pixels.');
  return { width, height, mimeType };
}

export async function readImage(dataDir, path, conversationId, signal) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0')) throw new Error('Image must be an absolute local file path.');
  let canonical, bytes;
  try {
    signal.throwIfAborted();
    const root = await realpath(join(dataDir, 'uploads', String(conversationId))).catch(() => undefined);
    if (!root) throw new Error();
    canonical = await realpath(path);
    if (!canonical.startsWith(root + sep)) throw new Error();
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > INPUT_LIMITS.bytes) throw new Error();
      bytes = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count !== stat.size) throw new Error();
      bytes = bytes.subarray(0, count);
    } finally { await file.close(); }
  } catch { throw new Error('Image is unavailable, exceeds 10 MB, or is outside this conversation’s uploads.'); }
  const info = imageInfo(bytes);
  return { bytes, ...info, sha256: hash(bytes) };
}
