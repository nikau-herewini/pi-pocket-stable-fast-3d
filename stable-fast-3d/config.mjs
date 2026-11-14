import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const fail = () => { throw new Error('Invalid Stable Fast 3D settings. Check the endpoint and timeout.'); };
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function configuration(values) {
  let url;
  try { url = new URL(values.endpoint); } catch { fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail();
  const endpoint = url.href.replace(/\/+$/, '');
  if (!integer(values.timeoutMinutes, 1, 120)) fail();
  return { endpoint, timeoutMs: values.timeoutMinutes * 60_000, connection: hash([endpoint]) };
}
