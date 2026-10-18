import type { RawGenerationMetadata, RawImageResult } from '../types/provider.js';
import { buildImageCost } from './cost.js';
import { readCoreRawMetadata, type CoreRawMetadata } from './usage.js';
import type { ImageMetadata, ImageOutputDescriptor, PreparedImageRequest } from './protocol.js';

export function buildMetadata(
  request: PreparedImageRequest,
  raws: readonly RawImageResult[],
  outputs: readonly ImageOutputDescriptor[],
  startedAt: number,
  failureMetadata?: RawGenerationMetadata,
): ImageMetadata {
  const route = request.route;
  let reported: CoreRawMetadata = {};
  const count = Array.isArray(raws) ? raws.length : 0;
  try {
    const rawMetadata = failureMetadata ?? (Array.isArray(raws)
      ? raws.find((raw) => raw && raw.metadata)?.metadata : undefined);
    reported = readCoreRawMetadata(rawMetadata);
  } catch { /* Malformed optional metadata must never hide committed receipts. */ }
  const direct = route.kind === 'provider' && route.provider.api === 'openai' &&
    officialDirectImage25(route.provider.baseUrl, route.remoteModelId);
  const knownPricing = route.kind === 'catalog' || direct;
  return {
    model: route.kind === 'catalog' ? route.model : route.requestedId,
    provider: route.kind === 'catalog' ? 'cloudflare' : route.provider.id,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(reported.requestId ? { requestId: reported.requestId } : {}),
    ...(reported.reportedUsage ? { reportedUsage: reported.reportedUsage } : {}),
    cost: buildImageCost({
      ...(knownPricing ? { pricingModel: 'gpt-image-2.5' as const } : {}),
      uncachedInput: direct,
      ...(reported.reportedCost ? { reported: reported.reportedCost } : {}),
      ...(reported.reportedUsage ? { usage: reported.reportedUsage } : {}),
      ...(request.effective.quality !== undefined ? { quality: request.effective.quality } : {}),
      // Never multiply per-request usage by image count or estimate only a partial batch.
      outputs: outputs.length === count ? outputs : [],
    }),
    outputs: [...outputs],
    ...(request.effective.quality !== undefined ? { quality: request.effective.quality } : {}),
    ...(request.effective.size !== undefined ? { size: request.effective.size } : {}),
  };
}

function officialDirectImage25(baseUrl: string, model: string): boolean {
  // Only the already-established dated variants share this verified pricing family.
  if (!/^gpt-image-2\.5(?:-(?:flare|sunburst)(?:-2026-09-08)?)?$/.test(model)) return false;
  try { return new URL(baseUrl).origin === 'https://api.openai.com'; }
  catch { return false; }
}
