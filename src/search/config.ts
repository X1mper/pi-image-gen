import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import { ImageSearchError } from './errors.js';
import { IMAGE_SEARCH_PROVIDERS, type ImageSearchProvider, type ImageSearchRoute, type ImageSearchSettings } from './types.js';

export const IMAGE_SEARCH_SETTINGS_KEY = 'pi-image-search';
const ENV_KEYS: Record<ImageSearchProvider, string> = {
  serper: 'SERPER_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
  serpapi: 'SERPAPI_API_KEY',
  openverse: 'OPENVERSE_ACCESS_TOKEN',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function route(value: unknown): ImageSearchRoute {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'provider') ||
      !IMAGE_SEARCH_PROVIDERS.includes(value.provider as ImageSearchProvider)) {
    throw new ImageSearchError('Image search routes must be { provider: "serper" | "brave" | "serpapi" | "openverse" }. Search routes have no model.', 'configuration');
  }
  return { provider: value.provider as ImageSearchProvider };
}

/** Validate settings from both the trusted loader and direct library callers. */
export function normalizeImageSearchSettings(value: unknown): ImageSearchSettings {
  if (!isRecord(value)) throw new ImageSearchError('pi-image-search settings must be an object.', 'configuration');
  const settings: ImageSearchSettings = {};
  if (value.default !== undefined) settings.default = route(value.default);
  for (const kind of ['fallback', 'compare'] as const) {
    const list = value[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > IMAGE_SEARCH_PROVIDERS.length) {
      throw new ImageSearchError(`pi-image-search.${kind} must be an array of at most four provider routes.`, 'configuration');
    }
    const routes = list.map(route);
    const identities = routes.map((item) => item.provider);
    if (new Set(identities).size !== identities.length ||
        (kind === 'fallback' && settings.default && identities.includes(settings.default.provider))) {
      throw new ImageSearchError(`pi-image-search.${kind} repeats a provider route.`, 'configuration');
    }
    settings[kind] = routes;
  }
  if (value.requestTimeoutMs !== undefined) {
    if (!Number.isInteger(value.requestTimeoutMs) || (value.requestTimeoutMs as number) < 1000 || (value.requestTimeoutMs as number) > 120000) {
      throw new ImageSearchError('pi-image-search.requestTimeoutMs must be an integer from 1000 to 120000.', 'configuration');
    }
    settings.requestTimeoutMs = value.requestTimeoutMs as number;
  }
  if (value.providers !== undefined) {
    if (!isRecord(value.providers)) throw new ImageSearchError('pi-image-search.providers must be an object.', 'configuration');
    settings.providers = {};
    for (const [id, config] of Object.entries(value.providers)) {
      if (!IMAGE_SEARCH_PROVIDERS.includes(id as ImageSearchProvider) || !isRecord(config) ||
          Object.keys(config).some((key) => key !== 'apiKey') ||
          (config.apiKey !== undefined && typeof config.apiKey !== 'string')) {
        throw new ImageSearchError('Search provider settings accept only an optional string apiKey for the four supported providers.', 'configuration');
      }
      settings.providers[id as ImageSearchProvider] = config.apiKey === undefined ? {} : { apiKey: config.apiKey as string };
    }
  }
  return settings;
}

export function loadImageSearchSettings(cwd: string, projectTrusted = false): ImageSearchSettings {
  try {
    return normalizeImageSearchSettings(loadPiSettings<unknown>(IMAGE_SEARCH_SETTINGS_KEY, {
      cwd, projectTrusted, strictProjectSettings: true,
    }) ?? {});
  } catch (error) {
    if (error instanceof ImageSearchError) throw error;
    throw new ImageSearchError('Image search settings could not load. Check settings.json syntax and permissions.', 'configuration');
  }
}

export function imageSearchCredential(provider: ImageSearchProvider, settings: ImageSearchSettings): string | undefined {
  const key = settings.providers?.[provider]?.apiKey?.trim() || process.env[ENV_KEYS[provider]]?.trim();
  if (!key || /\$\{|^\$[A-Z_]/.test(key)) return undefined;
  return key;
}
