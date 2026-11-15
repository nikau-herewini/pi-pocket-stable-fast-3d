import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { hash } from './config.mjs';

export const INPUT_LIMITS = Object.freeze({ bytes: 10_000_000, pixels: 16_000_000 });
export class InputValidationError extends Error {}
const invalid = message => { throw new InputValidationError(message); };
const within = (path, root) => Boolean(root && path.startsWith(root + sep));

export function imageInfo(bytes) {
  let width, height, mimeType;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    mimeType = 'image/png';
    if (bytes.length >= 33 && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
      width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    }
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
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
  } else invalid('Unsupported image format. Use PNG or JPEG.');
  if (!width || !height) invalid('Image header is invalid or dimensions are zero. Re-export the image as PNG or JPEG.');
  if (width * height > INPUT_LIMITS.pixels) invalid(`Image is ${width} × ${height} pixels and exceeds 16 million pixels. Reduce its dimensions.`);
  return { width, height, mimeType };
}

export async function readImage(dataDir, path, conversationId, signal, sources = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0')) invalid('Image must be an absolute local file path, at most 4096 characters, without null bytes.');
  const uploadDir = join(dataDir, 'uploads', String(conversationId));
  const generatedDir = join(dataDir, 'extensions', 'stable-diffusion', 'outputs');
  const processedDir = sources.processedDir;
  const allowed = () => invalid('Image is outside the allowed locations. Use an upload or a recorded Stable Diffusion output from this conversation.' + (processedDir ? ` For resized or compressed images, save the file under ${processedDir}.` : ' A local conversation workspace is required for processed images.'));
  const requested = resolve(path);
  const expectedHash = Object.hasOwn(sources.generatedImages ?? {}, requested) ? sources.generatedImages[requested] : undefined;
  if (!within(requested, uploadDir) && !within(requested, processedDir) && !(within(requested, generatedDir) && expectedHash)) allowed();
  let bytes;
  try {
    signal.throwIfAborted();
    const [uploadRoot, generatedRoot, processedRoot, canonical] = await Promise.all([
      realpath(uploadDir).catch(() => undefined), realpath(generatedDir).catch(() => undefined),
      processedDir ? realpath(processedDir).catch(() => undefined) : undefined, realpath(path),
    ]);
    // The processed folder itself must not redirect to another directory.
    const safeProcessedRoot = processedRoot === processedDir ? processedRoot : undefined;
    const generated = within(requested, generatedDir) && expectedHash && within(canonical, generatedRoot);
    if (!within(canonical, uploadRoot) && !within(canonical, safeProcessedRoot) && !generated) allowed();
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) invalid('Image path is not a regular file. Select a PNG or JPEG file.');
      if (stat.size < 1) invalid('Image file is empty. Re-export the image as PNG or JPEG.');
      if (stat.size > INPUT_LIMITS.bytes) invalid(`Image is ${stat.size} bytes and exceeds 10 MB (10,000,000 bytes). Resize or compress it.`);
      bytes = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count !== stat.size) invalid('Image changed size while being read. Finish writing the file before trying again.');
      bytes = bytes.subarray(0, count);
      if (generated && hash(bytes) !== expectedHash) invalid('Recorded Stable Diffusion image has changed. Save the edited image in this conversation’s processed-image folder.');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof InputValidationError) throw error;
    if (signal.aborted) invalid('Image validation stopped or timed out. Try again when ready.');
    invalid('Image could not be read. Check that the file exists and is accessible in an allowed location.');
  }
  const info = imageInfo(bytes);
  return { bytes, ...info, sha256: hash(bytes) };
}
