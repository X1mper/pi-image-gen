import type { Cost, ImageCostCalculator, ImageTokenUsage } from './protocol.js';
import type { ReportedCost } from './usage.js';

/** One cost answer per provider request. No local rate tables or token estimates. */
export async function buildImageCost(input: {
  readonly reported?: ReportedCost;
  readonly usage?: ImageTokenUsage;
  readonly calculateCost?: ImageCostCalculator;
}): Promise<Cost> {
  if (input.reported?.basis === 'provider-response') {
    return {
      kind: 'reported',
      amount: input.reported.amount,
      currency: input.reported.currency,
      source: input.reported.source,
      basis: 'provider-response',
    };
  }
  if (!input.usage) return { kind: 'unknown', missing: ['normalized-token-usage'] };
  if (!input.calculateCost) return { kind: 'unknown', missing: ['compatible-pi-model-pricing'] };
  try {
    const usd = await input.calculateCost(input.usage);
    if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) {
      return {
        kind: 'estimated', completeness: 'complete', usd,
        components: { totalUsd: usd }, missing: [], sources: ['pi-ai.calculateCost'],
      };
    }
  } catch { /* Optional accounting must not hide paid outputs or committed receipts. */ }
  return { kind: 'unknown', missing: ['compatible-pi-model-pricing'] };
}
