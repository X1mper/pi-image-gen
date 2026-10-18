/**
 * Portable base64 codec. `Buffer` is not assumed on every host (Cloudflare
 * Workers has `nodejs_compat` only when enabled), so the shared engine encodes
 * provider reference images and decodes provider output itself.
 *
 * `decodeBase64` matches `Buffer.from(value, 'base64')` for the cases this
 * package actually sees: whitespace and non-alphabet characters are skipped,
 * decoding stops at the first `=` pad, and trailing bits shorter than one byte
 * are dropped.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REVERSE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  table[45] = 62; // Buffer-compatible base64url aliases: '-' and '_'.
  table[95] = 63;
  return table;
})();

/** Encode bytes as standard base64 without exceeding the argument limit. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    chunk += ALPHABET[b0 >> 2]!;
    chunk += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]!;
    chunk += b1 === undefined ? '=' : ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]!;
    chunk += b2 === undefined ? '=' : ALPHABET[b2 & 0x3f]!;
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  if (chunk.length > 0) parts.push(chunk);
  return parts.join('');
}

/** Leniently decode base64 into exactly the bytes it represents. */
export function decodeBase64(value: string): Uint8Array {
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x3d) break; // '=' — rest is padding
    if (code > 127) continue;
    const index = REVERSE[code]!;
    if (index < 0) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, length);
}
