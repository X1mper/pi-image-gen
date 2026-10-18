/**
 * Bounded Response-body reader shared by the desktop Node path and the
 * Workers-safe core. Deliberately free of `node:` imports and of the
 * `@amaster.ai/pi-shared` root barrel (whose network module pins DNS through
 * Node request options). Behavior and message text match the previous
 * pi-shared helper so the existing `/size ceiling/i` error classification in
 * this package keeps working unchanged.
 */
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Remote response exceeds the size ceiling.');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Remote response exceeds the size ceiling.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
