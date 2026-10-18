import { generateImageCore } from './core/engine.js';
import { prepareImageRequest } from './core/prepare.js';
import { legacyNumericUsage } from './core/usage.js';
import { desktopRoute, desktopTimeout } from './desktop/configuration.js';
import { ImageCoreError } from './core/outcome.js';
import { cancelledError, ImageGenError } from './errors.js';
import { desktopHost } from './desktop/host.js';
import { desktopSink } from './desktop/output-sink.js';
import type { GenerateImageOptions } from './desktop/options.js';
import type { GenerateImageParams, ImageGenResult } from './types.js';

export type { GenerateImageOptions } from './desktop/options.js';

/** Existing desktop API; filesystem/auth/security stay outside the shared portable engine. */
export async function generateImage(
  params: GenerateImageParams,
  options: GenerateImageOptions,
): Promise<ImageGenResult> {
  if (options.signal?.aborted) throw cancelledError('image generation');
  const route = desktopRoute(params, options);
  const { outputDir: _outputDir, ...args } = params;
  const request = prepareImageRequest(args, {}, route);
  const sink = desktopSink(params, options, route.requestedId);
  try {
    const result = await generateImageCore(request, desktopHost(request, options, sink));
    const metadata = result.metadata;
    const usage = legacyNumericUsage(metadata.reportedUsage);
    return {
      model: route.requestedId,
      provider: route.provider.builtIn ? route.provider.id : `${route.provider.id} (custom)`,
      images: [...result.images],
      metadata: {
        durationMs: metadata.durationMs,
        ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
        ...(usage ? { usage } : {}),
        // Preserve the public numeric reported-cost contract; never disguise an estimate as actual.
        ...(metadata.cost.kind === 'reported' && metadata.cost.basis === 'provider-response'
          ? { cost: metadata.cost.amount } : {}),
      },
    };
  } catch (error) {
    await sink.cleanup();
    if (error instanceof ImageCoreError) {
      if (error.logSummary === 'image generation timed out') {
        const seconds = Math.round(desktopTimeout(options.settings.requestTimeoutMs) / 1000);
        throw new ImageGenError(`Image generation exceeded the ${seconds} second request timeout. Increase pi-image-gen.requestTimeoutMs if this provider normally needs longer.`, error.logSummary);
      }
      // Desktop cleanup deliberately differs from durable retention; do not expose stale receipts.
      throw new ImageGenError(error.message, error.logSummary);
    }
    throw error;
  }
}
