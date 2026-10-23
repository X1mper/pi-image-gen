import { generateImageCore } from './core/engine.js';
import { canonicalProviderRouteId, configuredImageRoutes, normalizeImageGenSettings } from './config.js';
import { prepareImageRequest } from './core/prepare.js';
import { legacyNumericUsage } from './core/usage.js';
import { desktopRoute, desktopTimeout } from './desktop/configuration.js';
import { ImageCoreError } from './core/outcome.js';
import { cancelledError, errorMessageForUser, ImageGenError } from './errors.js';
import { desktopHost } from './desktop/host.js';
import { desktopSink } from './desktop/output-sink.js';
import type { GenerateImageOptions } from './desktop/options.js';
import type { GenerateImageParams, ImageGenResult, ImageRouteAttempt, ImageRouteSelection } from './types.js';

export type { GenerateImageOptions } from './desktop/options.js';

/** Existing desktop API; filesystem/auth/security stay outside the shared portable engine. */
export async function generateImage(
  params: GenerateImageParams,
  options: GenerateImageOptions,
): Promise<ImageGenResult> {
  if (options.signal?.aborted) throw cancelledError('image generation');
  const settings = normalizeImageGenSettings(options.settings);
  const fallbacks = configuredImageRoutes(settings, 'fallback');
  const primary = desktopRoute(params, { ...options, settings });
  const primarySelection: ImageRouteSelection = {
    provider: settings.defaultProvider
      ? canonicalProviderRouteId(settings.defaultProvider, settings) ?? settings.defaultProvider
      : primary.provider.id,
    model: primary.requestedId,
  };
  const selections = [primarySelection, ...fallbacks];
  const attempts: ImageRouteAttempt[] = [];
  for (const [index, selection] of selections.entries()) {
    if (options.signal?.aborted) throw cancelledError('image generation');
    const { modelCapabilities, ...shared } = options;
    const attemptOptions: GenerateImageOptions = index === 0
      ? { ...options, settings }
      : { ...shared, settings: { ...settings, defaultProvider: selection.provider, defaultModel: selection.model } };
    try {
      const result = await generateSingleImage(params, attemptOptions);
      if (attempts.length) {
        attempts.push({ route: selection, status: 'success' });
        return { ...result, attempts };
      }
      return result;
    } catch (error) {
      attempts.push({ route: selection, status: 'failed', error: errorMessageForUser(error) });
      if (options.signal?.aborted || !(error instanceof ImageGenError) || !error.fallbackReason || index === selections.length - 1) {
        if (attempts.length === 1) throw error;
        throw new ImageGenError(
          `${errorMessageForUser(error)} Attempted routes: ${attempts.map((attempt) => `${attempt.route.provider}/${attempt.route.model}`).join(', ')}. No further fallback was attempted.`,
          error instanceof ImageGenError ? error.logSummary : 'image fallback failed',
        );
      }
    }
  }
  throw new ImageGenError('No image route is configured.', 'image route missing');
}

/** One dispatch only; orchestration above never changes provider adapter semantics. */
async function generateSingleImage(params: GenerateImageParams, options: GenerateImageOptions): Promise<ImageGenResult> {
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
        ...(metadata.reportedUsage ? { reportedUsage: metadata.reportedUsage } : {}),
        ...(metadata.tokenUsage ? { tokenUsage: metadata.tokenUsage } : {}),
        costDetails: metadata.cost,
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
      throw new ImageGenError(error.message, error.logSummary, error.fallbackReason);
    }
    throw error;
  }
}
