import { readResponseBytes } from '../core/response.js';
import { describeDownloadError, ImageGenError, throwDownloadHttpError } from '../errors.js';
import { MAX_IMAGE_BYTES, sniffMime } from '../image-input.js';
import type { ResolvedImageInput } from '../types.js';

/**
 * Desktop-only public-URL reference loader. The fetch implementation is the
 * package's DNS-pinned `safeFetch`; provider output has its own loader policy.
 * Every throw is an ImageGenError so the raw URL (which may be signed) never
 * reaches a log through the plain-Error path.
 */
export async function resolveRemoteImageInput(
  url: string,
  inputLabel: string,
  logLabel: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<ResolvedImageInput> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: signal ?? null });
  } catch (error) {
    if (error instanceof Error && /public HTTP|redirect limit/i.test(error.message)) {
      throw new ImageGenError(error.message, `${logLabel} rejected (unsafe URL)`);
    }
    throw describeDownloadError(logLabel, url, { rejected: error });
  }
  if (!res.ok) {
    await throwDownloadHttpError(logLabel, url, res);
  }
  // Body reads can fail after headers; keep them in the sanitized download boundary.
  let buf: Uint8Array;
  try {
    buf = await readResponseBytes(res, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof Error && /size ceiling/i.test(error.message)) {
      throw new ImageGenError(error.message, `${logLabel} rejected (too large)`);
    }
    throw describeDownloadError(logLabel, url, { rejected: error });
  }
  const mimeType = sniffMime(buf);
  if (!mimeType) {
    throw new ImageGenError(
      `${inputLabel} is not a valid supported image.`,
      `${logLabel} rejected (invalid image)`,
    );
  }
  return { bytes: buf, mimeType };
}
