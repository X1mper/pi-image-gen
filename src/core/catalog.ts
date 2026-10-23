import type { ImageModelCapabilities } from '../types/image.js';
import type { RawGenerationMetadata, RawImageResult } from '../types/provider.js';
import { classifyImageOutput, MAX_BASE64_IMAGE_CHARS, MAX_IMAGE_BYTES, toDataUri } from '../image-input.js';
import { ImageGenError, cancelResponseBody } from './errors.js';
import { readResponseBytes } from './response.js';
import { coreMetadata, parseReportedCost, preferredReportedCost, sanitizeReportedUsage } from './usage.js';
import { ProviderResultError } from './provider-result.js';
import type { CatalogImageModelId, CatalogImageRoute, ImageHost, Original, PreparedImageRequest } from './protocol.js';

export const CATALOG_MODELS: readonly CatalogImageModelId[] = Object.freeze([
  'openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst',
]);
export const MAX_CATALOG_RESPONSE_BYTES = MAX_BASE64_IMAGE_CHARS + 1024 * 1024;

export function catalogImageRoute(model: CatalogImageModelId, gatewayId: string): CatalogImageRoute {
  if (!CATALOG_MODELS.includes(model) || !gatewayId.trim()) {
    throw new ImageGenError('Configure a supported image model and Gateway ID.', 'invalid catalog route');
  }
  const capabilities: ImageModelCapabilities = {
    sizes: ['auto', '1024x1024', '1024x1536', '1536x1024'],
    qualityValues: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    backgroundValues: ['auto', 'opaque', 'transparent'], outputFormats: ['png', 'jpeg', 'webp'],
    // The schema has no count knob; this does not limit independent native calls.
    nMax: 1, nMaxSource: 'provider', maxReferenceImages: 16,
    inputFormats: ['PNG', 'JPEG', 'WEBP'], inputMaxBytes: MAX_IMAGE_BYTES,
    referenceLimitsSource: 'extension',
  };
  return { kind: 'catalog', model, gatewayId, capabilities };
}

/** One native binding invocation. No retries, cache/log enabling, batching or credentials discovery. */
export async function runCatalog<Stored>(
  request: PreparedImageRequest,
  inputs: readonly Original[],
  host: ImageHost<Stored>,
  signal: AbortSignal,
  onDispatch: () => void,
): Promise<RawImageResult[]> {
  if (request.route.kind !== 'catalog' || !host.cloudflareRun) {
    throw new ImageGenError('The catalog binding transport is not configured.', 'catalog transport missing');
  }
  const args = request.effective;
  const body: Record<string, unknown> = { prompt: args.prompt };
  if (inputs.length) body.images = inputs.map(toDataUri);
  for (const key of ['size', 'quality', 'background'] as const) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  if (args.outputFormat !== undefined) body.output_format = args.outputFormat;
  if (signal.aborted) throw new ImageGenError('Image generation was cancelled.', 'image cancelled');
  onDispatch();
  const raw = await host.cloudflareRun(request.route.model, body, {
    gateway: { id: request.route.gatewayId, skipCache: true, collectLog: false, retries: { maxAttempts: 1 } },
    returnRawResponse: true,
    signal,
  });
  return parseCatalogResponse(raw, host.limits?.responseBytes);
}

async function parseCatalogResponse(raw: unknown, responseLimit?: number): Promise<RawImageResult[]> {
  let metadata: RawGenerationMetadata = {};
  try {
    let requestId: string | undefined;
    if (raw instanceof Response) {
      requestId = raw.headers.get('cf-aig-request-id') ?? raw.headers.get('x-request-id') ?? undefined;
      metadata = coreMetadata({ ...(requestId ? { requestId } : {}) });
      if (!raw.ok) {
        await cancelResponseBody(raw);
        throw new ImageGenError(`Image Gateway returned HTTP ${raw.status}.`, `catalog HTTP ${raw.status}`);
      }
      const limit = Math.min(responseLimit ?? MAX_CATALOG_RESPONSE_BYTES, MAX_CATALOG_RESPONSE_BYTES);
      const bytes = await readResponseBytes(raw, limit);
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { throw invalidResponse(); }
    }
    const outer = record(raw);
    if (!outer) throw invalidResponse();
    const result = outer.result === undefined ? outer : record(outer.result);
    const reportedCost = preferredReportedCost(
      parseReportedCost(result?.cost, result?.currency, 'provider-response', outer.currency),
      parseReportedCost(outer.cost, outer.currency, 'provider-response'),
    );
    metadata = coreMetadata({
      ...(requestId ? { requestId } : {}),
      reportedUsage: sanitizeReportedUsage(result?.usage) ?? sanitizeReportedUsage(outer.usage),
      ...(reportedCost ? { reportedCost } : {}),
    });
    if (outer.success === false || (outer.state !== undefined && outer.state !== 'Completed') ||
        (Array.isArray(outer.errors) && outer.errors.length > 0) || !result ||
        typeof result.image !== 'string' || !/^(?:https:\/\/|data:image\/)/i.test(result.image)) {
      throw invalidResponse();
    }
    const data = classifyImageOutput(result.image);
    if (!data) throw invalidResponse();
    return [{ data, metadata }];
  } catch (error) {
    const safe = error instanceof ImageGenError ? error : invalidResponse();
    throw new ProviderResultError(safe, metadata);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function invalidResponse(): ImageGenError {
  return new ImageGenError('The image Gateway did not return a confirmed image result.', 'invalid catalog result');
}
