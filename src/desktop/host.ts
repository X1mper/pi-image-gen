import { safeFetch, trustedHostsFromUrls } from '@amaster.ai/pi-shared';
import { describeDownloadError, ImageGenError, throwDownloadHttpError } from '../errors.js';
import { MAX_IMAGE_BYTES, sniffMime } from '../image-input.js';
import { resolveImageInputValue } from '../node/inputs.js';
import { getAdapter } from '../providers/index.js';
import { readResponseBytes } from '../core/response.js';
import type { GeneratedImage } from '../types.js';
import type { ImageHost, Original, PreparedImageRequest } from '../core/protocol.js';
import type { GenerateImageOptions } from './options.js';
import type { desktopSink } from './output-sink.js';
import { desktopTimeout } from './configuration.js';
import { desktopCostCalculator } from './pricing.js';

export function desktopHost(
  request: PreparedImageRequest,
  options: GenerateImageOptions,
  sink: ReturnType<typeof desktopSink>,
): ImageHost<GeneratedImage> {
  if (request.route.kind !== 'provider') throw new ImageGenError('Desktop provider route is missing.', 'invalid desktop route');
  const trustedHosts = trustedHostsFromUrls(request.route.provider.baseUrl);
  const calculateCost = desktopCostCalculator(request, options.modelRegistry);
  return {
    ...(calculateCost ? { calculateCost } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    timeoutMs: desktopTimeout(options.settings.requestTimeoutMs),
    providerFetch: options.fetchImpl ?? fetch,
    adapter: getAdapter(request.route.provider.api),
    ...(options.modelRegistry ? { providerRuntime: { modelRegistry: options.modelRegistry } } : {}),
    loadOriginal: (reference, signal) => resolveImageInputValue(reference.url,
      reference.role === 'image' && (request.effective.image?.length ?? 0) > 1
        ? `Image input #${reference.index + 1}` : 'Image input', options.cwd, safeFetch, signal),
    async loadOutput(url, signal): Promise<Original> {
      let response: Response;
      try { response = await safeFetch(url, { signal: signal ?? null }, { trustedHosts }); }
      catch (error) {
        if (error instanceof Error && /public HTTP|redirect limit/i.test(error.message)) {
          throw new ImageGenError(error.message, 'generated image rejected (unsafe URL)');
        }
        throw describeDownloadError('generated image', url, { rejected: error });
      }
      if (!response.ok) await throwDownloadHttpError('generated image', url, response);
      let bytes: Uint8Array;
      try { bytes = await readResponseBytes(response, MAX_IMAGE_BYTES); }
      catch (error) {
        if (error instanceof Error && /size ceiling/i.test(error.message)) {
          throw new ImageGenError(error.message, 'generated image rejected (too large)');
        }
        throw describeDownloadError('generated image', url, { rejected: error });
      }
      const mimeType = sniffMime(bytes);
      if (!mimeType) throw new ImageGenError('Provider returned a file that is not a supported image.', 'invalid image output');
      return { bytes, mimeType };
    },
    store: (output, index, context) => sink.store(output, index, context),
    onProgress: (phase) => {
      if (phase === 'saving-output') sink.begin();
      options.onProgress?.(phase);
    },
  };
}
