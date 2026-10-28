import { mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { safeFetch } from '@amaster.ai/pi-shared';
import { readResponseBytes } from '../core/response.js';
import { MAX_IMAGE_BYTES } from '../image-input.js';
import { writeUnique } from '../node/output-files.js';
import { inspectRaster, RasterError, resizeRaster } from '../node/raster.js';
import type { ImageSearchCandidate, ImageSearchImage, ImageSearchParams, ImageSearchRejection } from './types.js';

/** Materialize every search result. Provider order and source/license metadata survive. */
export async function downloadSearchImages(
  candidates: ImageSearchCandidate[], params: ImageSearchParams, cwd: string, signal: AbortSignal,
): Promise<{ images: ImageSearchImage[]; rejected: ImageSearchRejection[] }> {
  const images: ImageSearchImage[] = [];
  const rejected: ImageSearchRejection[] = [];
  const saved: string[] = [];
  const directory = resolve(cwd, params.outputDir ?? '.pi/images/search');
  try {
    for (const [index, candidate] of candidates.entries()) {
      signal.throwIfAborted();
      const deadline = AbortSignal.timeout(10_000);
      const candidateSignal = AbortSignal.any([signal, deadline]);
      const created: string[] = [];
      try {
        const url = new URL(candidate.imageUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new RasterError('Only public HTTP(S) image URLs without credentials are supported.');
        }
        // safeFetch validates public destinations and redirects. Never forward search credentials.
        // Race DNS lookup too: safeFetch DNS itself does not observe AbortSignal.
        const bytes = await downloadBytes(url, candidateSignal);
        const original = await inspectRaster(bytes);
        const resized = params.resize ? await resizeRaster(bytes, params.resize) : undefined;
        candidateSignal.throwIfAborted();
        await mkdir(directory, { recursive: true });
        const stem = `search-${candidate.provider}-${Date.now()}-${index + 1}`;
        const extension = original.mimeType === 'image/jpeg' ? 'jpg' : original.mimeType === 'image/webp' ? 'webp' : 'png';
        const originalPath = await writeUnique(directory, stem, extension, bytes, candidateSignal);
        created.push(originalPath);
        let path = originalPath;
        if (resized) {
          path = await writeUnique(directory, `${stem}-resized`, 'png', resized.bytes, candidateSignal);
          created.push(path);
        }
        candidateSignal.throwIfAborted();
        const final = resized ?? original;
        images.push({ ...candidate, path, mimeType: final.mimeType,
          // Source dimensions stay separate from independently measured local-file dimensions.
          dimensions: { width: final.width, height: final.height },
          ...(resized ? { originalPath } : {}) });
        saved.push(...created);
      } catch (error) {
        await Promise.all(created.map((path) => unlink(path).catch(() => {})));
        signal.throwIfAborted();
        rejected.push({ imageUrl: candidate.imageUrl, reason: deadline.aborted ? 'Image download or processing timed out.'
          : error instanceof RasterError ? error.message : 'Image could not be safely downloaded, decoded or saved.' });
      }
    }
    signal.throwIfAborted();
    return { images, rejected };
  } catch (error) {
    await Promise.all(saved.map((path) => unlink(path).catch(() => {})));
    throw error;
  }
}

async function downloadBytes(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); return; }
    void (async () => {
      const response = await safeFetch(url, { signal, headers: { Accept: 'image/jpeg,image/png,image/webp' } });
      if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
      if (!response.ok) {
        await response.body?.cancel();
        throw new RasterError(`Image download returned HTTP ${response.status}.`);
      }
      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType && contentType !== 'application/octet-stream' &&
          !['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(contentType)) {
        await response.body?.cancel();
        throw new RasterError('Unsupported response content type. Only JPEG, PNG and WebP images are supported.');
      }
      return readResponseBytes(response, MAX_IMAGE_BYTES);
    })().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
