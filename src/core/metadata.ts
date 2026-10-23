import type { RawGenerationMetadata, RawImageResult } from '../types/provider.js';
import { buildImageCost } from './cost.js';
import { normalizeTokenUsage, readCoreRawMetadata, type CoreRawMetadata } from './usage.js';
import type { ImageCostCalculator, ImageMetadata, ImageOutputDescriptor, PreparedImageRequest } from './protocol.js';

export async function buildMetadata(
  request: PreparedImageRequest,
  raws: readonly RawImageResult[],
  outputs: readonly ImageOutputDescriptor[],
  startedAt: number,
  failureMetadata?: RawGenerationMetadata,
  calculateCost?: ImageCostCalculator,
): Promise<ImageMetadata> {
  const route = request.route;
  let reported: CoreRawMetadata = {};
  try {
    const rawMetadata = failureMetadata ?? (Array.isArray(raws)
      ? raws.find((raw) => raw && raw.metadata)?.metadata : undefined);
    reported = readCoreRawMetadata(rawMetadata);
  } catch { /* Malformed optional metadata must never hide committed receipts. */ }
  const tokenUsage = normalizeTokenUsage(reported.reportedUsage,
    route.kind === 'catalog' ? 'catalog' : route.provider.api);
  return {
    model: route.kind === 'catalog' ? route.model : route.requestedId,
    provider: route.kind === 'catalog' ? 'cloudflare' : route.provider.id,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(reported.requestId ? { requestId: reported.requestId } : {}),
    ...(reported.reportedUsage ? { reportedUsage: reported.reportedUsage } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    cost: await buildImageCost({
      ...(reported.reportedCost ? { reported: reported.reportedCost } : {}),
      ...(tokenUsage ? { usage: tokenUsage } : {}),
      ...(calculateCost ? { calculateCost } : {}),
    }),
    outputs: [...outputs],
    ...(request.effective.quality !== undefined ? { quality: request.effective.quality } : {}),
    ...(request.effective.size !== undefined ? { size: request.effective.size } : {}),
  };
}
