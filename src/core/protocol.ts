import type { GenerateImageParams, ImageModelCapabilities } from '../types/image.js';
import type { ImageProviderAdapter, ImageProviderRuntime, ResolvedProvider } from '../types/provider.js';

/**
 * Shared Workers-safe image protocol. Types only, no runtime imports beyond
 * erased `import type` from pure DTO modules, so runtime and declarations never
 * reach desktop/sprite settings or auth modules through these types.
 *
 * `ImageArgs` keeps every existing `GenerateImageParams` control except local
 * `outputDir`: output-directory handling stays with the desktop sink, and a
 * model argument can never choose a local path, provider, endpoint, credential
 * or gateway.
 */
export type ImageArgs = Omit<GenerateImageParams, 'outputDir'>;

/** Freezable per-response defaults used only for controls the model omitted. */
export type ImageDefaults = Omit<ImageArgs, 'prompt' | 'image' | 'mask' | 'filename'>;

export type ControlSource = 'explicit' | 'response-default';
export type ControlSources = Partial<Record<keyof ImageArgs, ControlSource>>;

export type Phase = 'loading-inputs' | 'waiting-provider' | 'saving-output';

/** One ordered original reference: full URL identifier plus its request role. */
export type OriginalReference = {
  readonly url: string;
  readonly role: 'image' | 'mask';
  readonly index: number;
};

/** Authorized original bytes returned by a host loader. */
export type Original = { readonly bytes: Uint8Array; readonly mimeType: string };

export type CatalogImageModelId = 'openai/gpt-image-2.5-flare' | 'openai/gpt-image-2.5-sunburst';

export type ProviderImageRoute = {
  readonly kind: 'provider';
  readonly provider: ResolvedProvider;
  readonly remoteModelId: string;
  readonly requestedId: string;
  readonly capabilities: ImageModelCapabilities;
};

export type CatalogImageRoute = {
  readonly kind: 'catalog';
  readonly model: CatalogImageModelId;
  /** Trusted host configuration; never model-supplied. */
  readonly gatewayId: string;
  readonly capabilities: ImageModelCapabilities;
};

export type ResolvedImageRoute = ProviderImageRoute | CatalogImageRoute;

/**
 * Host-frozen dispatch input. The host prepares this against exactly ONE frozen
 * response-settings snapshot, fingerprints it, and only then dispatches. Core
 * consumes these exact values; it never re-reads current settings or routes.
 */
export type PreparedImageRequest = {
  readonly route: ResolvedImageRoute;
  readonly supplied: Readonly<ImageArgs>;
  readonly effective: Readonly<ImageArgs>;
  readonly controlSources: Readonly<ControlSources>;
  readonly references: readonly OriginalReference[];
};

/** Trusted Cloudflare Gateway options; forced by the package, not the model. */
export type GatewayOptions = {
  readonly id: string;
  readonly skipCache: true;
  readonly collectLog: false;
  readonly retries: { readonly maxAttempts: 1 };
};

export type CloudflareRun = (
  model: CatalogImageModelId,
  input: Readonly<Record<string, unknown>>,
  options: { readonly gateway: GatewayOptions; readonly returnRawResponse: true; readonly signal?: AbortSignal },
) => Promise<unknown>;

export type UsageValue =
  | number
  | string
  | boolean
  | null
  | UsageValue[]
  | { [key: string]: UsageValue };

/** Bounded, validated nested provider usage (never an arbitrary raw body). */
export type ReportedUsage = { [key: string]: UsageValue };

/** Disjoint billing buckets: input excludes cache reads and writes. */
export type ImageTokenUsage = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/** Bind pi-ai calculateCost to the exact route's compatible catalog model; return USD. */
export type ImageCostCalculator = (
  usage: ImageTokenUsage,
) => number | undefined | Promise<number | undefined>;

export type Cost =
  | {
      readonly kind: 'reported';
      readonly amount: number;
      readonly currency: string;
      readonly source: string;
      readonly basis: 'provider-response' | 'gateway-estimate';
    }
  | {
      readonly kind: 'estimated';
      readonly completeness: 'complete' | 'partial';
      readonly usd: number;
      readonly components: Readonly<Record<string, number>>;
      readonly missing: readonly string[];
      readonly sources: readonly string[];
    }
  | { readonly kind: 'unknown'; readonly missing: readonly string[] };

export type ImageOutputDescriptor = {
  readonly index: number;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly revisedPrompt?: string;
};

/** ONE metadata object per provider request, including the single cost answer. */
export type ImageMetadata = {
  readonly model: string;
  readonly provider: string;
  readonly durationMs: number;
  readonly requestId?: string;
  readonly reportedUsage?: ReportedUsage;
  readonly tokenUsage?: ImageTokenUsage;
  readonly cost: Cost;
  readonly outputs: readonly ImageOutputDescriptor[];
  readonly quality?: string;
  readonly size?: string;
};

export type ImageCallResult<Stored> = {
  readonly images: readonly Stored[];
  readonly metadata: ImageMetadata;
};

export type ImageDispatchOutcome = {
  readonly dispatched: boolean;
  /** Transport invoked but no usable provider result was confirmed. */
  readonly uncertain: boolean;
  /** Store was invoked without a confirmed receipt; even a rejected write needs ledger reconciliation. */
  readonly storageUncertain: boolean;
  /** At least one output was already committed and is never rolled back. */
  readonly partial: boolean;
  readonly stored: readonly unknown[];
};

export type ImageStoreContext = {
  readonly signal: AbortSignal;
  readonly total: number;
  readonly descriptor: ImageOutputDescriptor;
};

/**
 * Real I/O seams. The host owns route/credentials/authorization/storage; core
 * owns validation, exactly one dispatch, byte materialization and metadata.
 */
export interface ImageHost<Stored> {
  readonly signal?: AbortSignal;
  /** Trusted execution budget, 1000–900000 ms; defaults to 120000. */
  readonly timeoutMs?: number;
  /** Stricter aggregate-original/per-image ceilings; responseBytes bounds catalog envelopes only.
   * Loaders must preflight/stream-bound reads. Provider adapters retain their transport policies. */
  readonly limits?: { referenceBytes?: number; imageBytes?: number; responseBytes?: number };
  /** HTTP transport for provider-route adapters. */
  readonly providerFetch?: typeof fetch;
  /** Optional official Pi calculator bound to compatible pricing for this exact route. */
  readonly calculateCost?: ImageCostCalculator;
  /** Cloudflare AI binding transport for the catalog route. */
  readonly cloudflareRun?: CloudflareRun;
  /** Optional adapter override (desktop Codex etc.). */
  readonly adapter?: ImageProviderAdapter;
  /** Provider runtime extras such as the Pi model registry; mask is core-owned. */
  readonly providerRuntime?: Omit<ImageProviderRuntime, 'mask'>;
  loadOriginal(reference: OriginalReference, signal?: AbortSignal): Promise<Original>;
  loadOutput(providerUrl: string, signal?: AbortSignal): Promise<Original>;
  store(output: Original, index: number, context: ImageStoreContext): Promise<Stored>;
  onProgress?(phase: Phase): void;
}
