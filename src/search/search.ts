import { normalizeImageSearchSettings } from './config.js';
import { imageSearchErrorMessage, ImageSearchError } from './errors.js';
import { searchProvider } from './providers.js';
import type {
  ImageSearchAttempt, ImageSearchCompareResult, ImageSearchOptions, ImageSearchParams,
  ImageSearchResult, ImageSearchRoute, ImageSearchSettings,
} from './types.js';

function input(params: ImageSearchParams): { query: string; limit: number } {
  // Use the common provider envelope: Openverse allows 200 characters;
  // Brave additionally limits queries to 50 words. Never truncate the query.
  if (!params || typeof params.query !== 'string' || !params.query.trim() ||
      params.query.trim().length > 200 || params.query.trim().split(/\s+/).length > 50) {
    throw new ImageSearchError('Image search query must contain 1–200 characters and at most 50 words.', 'input');
  }
  const limit = params.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ImageSearchError('Image search limit must be an integer from 1 to 20.', 'input');
  }
  return { query: params.query.trim(), limit };
}

async function runRoutes(
  params: ReturnType<typeof input>,
  routes: ImageSearchRoute[],
  settings: ImageSearchSettings,
  callerSignal?: AbortSignal,
): Promise<ImageSearchResult> {
  const deadline = AbortSignal.timeout(settings.requestTimeoutMs ?? 30000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
  const attempts: ImageSearchAttempt[] = [];
  for (const [index, route] of routes.entries()) {
    try {
      signal.throwIfAborted();
      const images = await searchProvider(route.provider, params.query, params.limit, settings, signal);
      attempts.push({ route, status: 'success' });
      return { query: params.query, provider: route.provider, images, attempts };
    } catch (error) {
      if (callerSignal?.aborted) throw new ImageSearchError('Image search was cancelled.', 'cancelled');
      if (deadline.aborted) throw new ImageSearchError('Image search exceeded its deadline. No automatic retry was made.', 'timeout');
      const failure = error instanceof ImageSearchError ? error : new ImageSearchError('Image search failed unexpectedly.', 'network');
      attempts.push({ route, status: 'failed', error: failure.message });
      if (!failure.fallbackAllowed || index === routes.length - 1) throw failure;
    }
  }
  throw new ImageSearchError('Configure pi-image-search.default before searching.', 'configuration');
}

/** Existing-image discovery only. Does not generate, download, save or modify images. */
export async function searchImages(params: ImageSearchParams, options: ImageSearchOptions): Promise<ImageSearchResult> {
  const request = input(params);
  const settings = normalizeImageSearchSettings(options.settings);
  if (!settings.default) throw new ImageSearchError('Configure pi-image-search.default with a provider before searching.', 'configuration');
  return runRoutes(request, [settings.default, ...(settings.fallback ?? [])], settings, options.signal);
}

/** Explicit configured comparison. Never uses default/fallback or retries a failed entry. */
export async function compareImageSearches(params: ImageSearchParams, options: ImageSearchOptions): Promise<ImageSearchCompareResult> {
  const request = input(params);
  const settings = normalizeImageSearchSettings(options.settings);
  if (!settings.compare?.length) throw new ImageSearchError('Configure pi-image-search.compare with at least one provider route before comparing.', 'configuration');
  const entries: ImageSearchCompareResult['entries'] = [];
  for (const route of settings.compare) {
    if (options.signal?.aborted) {
      entries.push({ route, status: 'cancelled', error: 'Comparison cancelled; this provider was not started.' });
      continue;
    }
    try {
      const result = await runRoutes(request, [route], settings, options.signal);
      entries.push({ route, status: 'success', result });
    } catch (error) {
      entries.push({ route, status: options.signal?.aborted ? 'cancelled' : 'failed', error: imageSearchErrorMessage(error) });
    }
  }
  return { entries };
}
