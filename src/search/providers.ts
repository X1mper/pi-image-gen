import { safeFetch } from '@amaster.ai/pi-shared';
import { readResponseBytes } from '../core/response.js';
import { imageSearchCredential, isRecord } from './config.js';
import { ImageSearchError } from './errors.js';
import type { ImageSearchCandidate, ImageSearchProvider, ImageSearchSettings } from './types.js';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
type Row = Record<string, unknown>;

/** Bound the wait too: safeFetch's DNS lookup does not observe AbortSignal. */
function fetchSearch(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', abort);
      abort();
      return;
    }
    // maxRedirects, not RequestInit.redirect, owns safeFetch redirect policy.
    // Never forward provider credentials to a redirect target.
    void safeFetch(url, init, { maxRedirects: 0 }).then((response) => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      resolve(response);
    }, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 2000) : undefined;
}

/** Return only HTTP(S) links, never data URIs, credentials or executable schemes. */
function link(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

function dimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function child(row: Row, key: string): Row {
  return isRecord(row[key]) ? row[key] : {};
}

/** Each adapter owns its provider's wire shape; the caller sees one candidate contract. */
function normalize(provider: ImageSearchProvider, row: Row): ImageSearchCandidate | undefined {
  const properties = child(row, 'properties');
  const imageUrl = link(provider === 'serper' ? row.imageUrl : provider === 'brave' ? properties.url :
    provider === 'serpapi' ? row.original : row.url);
  if (!imageUrl) return undefined;
  const values = {
    title: text(row.title),
    providerResultId: text(provider === 'serpapi' ? row.image_id : row.id),
    thumbnailUrl: link(provider === 'serper' ? row.thumbnailUrl : provider === 'brave' ? child(row, 'thumbnail').src : row.thumbnail),
    sourcePageUrl: link(provider === 'serper' || provider === 'serpapi' ? row.link : provider === 'brave' ? row.url : row.foreign_landing_url),
    width: dimension(provider === 'serper' ? row.imageWidth : provider === 'brave' ? properties.width : provider === 'serpapi' ? row.original_width : row.width),
    height: dimension(provider === 'serper' ? row.imageHeight : provider === 'brave' ? properties.height : provider === 'serpapi' ? row.original_height : row.height),
    ...(provider === 'openverse' ? {
      creator: text(row.creator), creatorUrl: link(row.creator_url),
      license: text(row.license), licenseUrl: link(row.license_url), attribution: text(row.attribution),
    } : {}),
  };
  // Omit unavailable metadata rather than inventing a license, title or dimensions.
  return { provider, imageUrl, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) };
}

export async function searchProvider(
  provider: ImageSearchProvider,
  query: string,
  limit: number,
  settings: ImageSearchSettings,
  signal: AbortSignal,
): Promise<ImageSearchCandidate[]> {
  const key = imageSearchCredential(provider, settings);
  if (!key && provider !== 'openverse') {
    throw new ImageSearchError(`Image search credentials are missing for ${provider}. Configure its search apiKey or environment variable.`, 'credentials', true);
  }
  let url: URL;
  const init: RequestInit = { signal, redirect: 'error', headers: { Accept: 'application/json' } };
  if (provider === 'serper') {
    url = new URL('https://google.serper.dev/images');
    init.method = 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json', 'X-API-KEY': key! };
    init.body = JSON.stringify({ q: query, num: limit });
  } else if (provider === 'brave') {
    url = new URL('https://api.search.brave.com/res/v1/images/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    url.searchParams.set('safesearch', 'strict');
    init.headers = { ...init.headers, 'X-Subscription-Token': key! };
  } else if (provider === 'serpapi') {
    url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google_images');
    url.searchParams.set('q', query);
    url.searchParams.set('api_key', key!);
    url.searchParams.set('safe', 'active');
  } else {
    url = new URL('https://api.openverse.org/v1/images/');
    url.searchParams.set('q', query);
    url.searchParams.set('page_size', String(limit));
    url.searchParams.set('mature', 'false');
    if (key) init.headers = { ...init.headers, Authorization: `Bearer ${key}` };
  }
  try {
    signal.throwIfAborted();
    const response = await fetchSearch(url, init, signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ImageSearchError(`${provider} image search returned HTTP ${response.status}.`, 'http', [401, 403, 404, 429].includes(response.status));
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(await readResponseBytes(response, MAX_JSON_BYTES)));
    } catch {
      signal.throwIfAborted();
      throw new ImageSearchError(`${provider} returned an unreadable or oversized search response.`, 'response');
    }
    if (!isRecord(body)) throw new ImageSearchError(`${provider} returned an invalid search response.`, 'response');
    // Provider error payloads are not safe user messages, and are not empty searches.
    if (body.error || (provider === 'serpapi' && child(body, 'search_metadata').status === 'Error')) {
      throw new ImageSearchError(`${provider} reported an image search error.`, 'response');
    }
    const rows = body[provider === 'serper' ? 'images' : provider === 'serpapi' ? 'images_results' : 'results'];
    // SerpApi can omit images_results on a documented no-results response.
    if (provider === 'serpapi' && rows === undefined && child(body, 'search_information').image_results_state === 'Fully empty') return [];
    if (!Array.isArray(rows)) throw new ImageSearchError(`${provider} returned an invalid image list.`, 'response');
    const images: ImageSearchCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const image = normalize(provider, row);
      if (!image || seen.has(image.imageUrl)) continue;
      seen.add(image.imageUrl);
      images.push(image);
      if (images.length === limit) break;
    }
    return images;
  } catch (error) {
    if (signal.aborted) throw error; // The orchestration boundary classifies cancellation/deadline.
    if (error instanceof ImageSearchError) throw error;
    throw new ImageSearchError(`${provider} image search could not reach the provider. No automatic retry was made.`, 'network');
  }
}
