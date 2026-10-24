/** Search routes never contain generation model ids or generation credentials. */
export const IMAGE_SEARCH_PROVIDERS = ['serper', 'brave', 'serpapi', 'openverse'] as const;
export type ImageSearchProvider = typeof IMAGE_SEARCH_PROVIDERS[number];
export type ImageSearchRoute = { provider: ImageSearchProvider };

export type ImageSearchSettings = {
  default?: ImageSearchRoute;
  fallback?: ImageSearchRoute[];
  compare?: ImageSearchRoute[];
  /** Whole-search deadline, including fallback. Default 30 seconds; 1–120 seconds. */
  requestTimeoutMs?: number;
  /** Openverse apiKey is an optional existing Bearer access token. */
  providers?: Partial<Record<ImageSearchProvider, { apiKey?: string }>>;
};

export type ImageSearchParams = { query: string; limit?: number };
export type ImageSearchImage = {
  provider: ImageSearchProvider;
  imageUrl: string;
  title?: string;
  providerResultId?: string;
  thumbnailUrl?: string;
  sourcePageUrl?: string;
  width?: number;
  height?: number;
  creator?: string;
  creatorUrl?: string;
  license?: string;
  licenseUrl?: string;
  attribution?: string;
};
export type ImageSearchAttempt = {
  route: ImageSearchRoute;
  status: 'success' | 'failed';
  error?: string;
};
export type ImageSearchResult = {
  query: string;
  provider: ImageSearchProvider;
  images: ImageSearchImage[];
  attempts: ImageSearchAttempt[];
};
export type ImageSearchCompareEntry =
  | { route: ImageSearchRoute; status: 'success'; result: ImageSearchResult }
  | { route: ImageSearchRoute; status: 'failed' | 'cancelled'; error: string };
export type ImageSearchCompareResult = { entries: ImageSearchCompareEntry[] };
export type ImageSearchOptions = { settings: ImageSearchSettings; signal?: AbortSignal };
