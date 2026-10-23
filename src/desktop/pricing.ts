import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import type { ImageCostCalculator, PreparedImageRequest } from '../core/protocol.js';
import type { ImageModelRegistry } from '../types/provider.js';

/** Resolve only the actual image model. Never borrow a similarly named chat model's rates. */
export function desktopCostCalculator(
  request: PreparedImageRequest,
  registry: ImageModelRegistry | undefined,
): ImageCostCalculator | undefined {
  if (request.route.kind !== 'provider' || !registry) return undefined;
  const { provider, remoteModelId } = request.route;
  // GPT Image has separate text/image input rates that Pi's four buckets cannot express.
  if (/(?:^|\/)gpt-image-/i.test(remoteModelId)) return undefined;
  try {
    const model = registry.findOfType?.('image', provider.id, remoteModelId)
      ?? registry.getModelOfType?.('image', provider.id, remoteModelId);
    // Stock Pi catalogs can use default zeros or omit image-specific tariffs.
    // Only a trusted host/registry adapter can affirm complete billing semantics.
    if (!model || model.costCompatibility !== 'complete-four-bucket-token-pricing' ||
        model.id !== remoteModelId || model.provider !== provider.id ||
        !model.baseUrl || model.baseUrl.replace(/\/+$/, '') !== provider.baseUrl.replace(/\/+$/, '') ||
        !model.cost) return undefined;
    const rates = [model.cost, ...(model.cost.tiers ?? [])];
    if (rates.some((rate) => ![rate.input, rate.output, rate.cacheRead, rate.cacheWrite]
      .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) ||
        model.cost.tiers?.some((tier) => !Number.isSafeInteger(tier.inputTokensAbove) || tier.inputTokensAbove < 0)) {
      return undefined;
    }
    // Freeze this call's catalog rates; no model refresh or network request is needed.
    const cost = { ...model.cost, ...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) } : {}) };
    return async (tokens) => {
      const { calculateCost } = await import('@earendil-works/pi-ai');
      const usage: Usage = {
        ...tokens,
        totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      // Pi 0.80's signature names a chat Model, but its calculator reads only .cost.
      // Image catalog entries supply the same validated rates; no synthetic rates are added.
      return calculateCost({ cost } as Model<Api>, usage).total;
    };
  } catch { return undefined; } // Optional pricing must never prevent generation.
}
