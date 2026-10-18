import type { GenerateImageParams, ResolvedImageInput } from './image.js';

export type ApiStyle =
  | 'openai'
  | 'gemini'
  | 'dashscope'
  | 'openrouter'
  | 'ark'
  | 'meta'
  | 'mai'
  | 'codex';
export type CustomApiStyle = Exclude<ApiStyle, 'codex'>;

/** A user-defined image-generation provider. */
export type CustomProviderAuth =
  | { type: 'bearer' }
  | { type: 'header'; header: string }
  | { type: 'none' };

/** Resolved provider entry: either a built-in or a custom one. */
export type ResolvedProvider = {
  /** Provider key as referenced by the user (e.g. "openai", "my-stable-diffusion"). */
  id: string;
  api: ApiStyle;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Authentication behavior selected by a user-facing provider route. */
  authMode?: 'auto' | 'oauth' | 'api-key';
  /** Credential wire policy; Azure's built-in route uses an api-key header. */
  customAuth?: CustomProviderAuth;
  /** Display label. */
  name: string;
  /** True for built-in providers (openai/gemini/dashscope/openrouter). */
  builtIn: boolean;
};

/** Adapter interface implemented by each api shape. */
export type ImageProviderAdapter = {
  generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
    runtime?: ImageProviderRuntime,
  ): Promise<RawImageResult[]>;
};

/** Narrow Pi model-registry contract used to resolve subscription OAuth. */
export type ImageModelRegistry = {
  getAvailable(): Array<{ id: string; provider: string; baseUrl?: string }>;
  /** Resolve the active provider credential, including OAuth refresh when configured. */
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  /** Report whether a concrete provider model is currently backed by OAuth. */
  isUsingOAuth?(model: { id: string; provider: string; baseUrl?: string }): boolean;
  getApiKeyAndHeaders(model: {
    id: string;
    provider: string;
    baseUrl?: string;
  }): Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    error?: string;
  }>;
};

export type ImageProviderRuntime = {
  modelRegistry?: ImageModelRegistry;
  mask?: ResolvedImageInput;
};

export type RawGenerationMetadata = {
  requestId?: string;
  usage?: Record<string, number>;
  cost?: number;
};

export type RawImageResult = {
  /** Either base64 PNG bytes or a URL to fetch. */
  data: { kind: 'base64'; bytes: string; mimeType?: string } | { kind: 'url'; url: string };
  revisedPrompt?: string;
  metadata?: RawGenerationMetadata;
};
