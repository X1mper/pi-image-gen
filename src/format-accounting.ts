import type { GenerationMetadata } from './types/desktop.js';

/** Shared accounting text for tool results, command summaries and sprites. */
export function formatAccounting(metadata: GenerationMetadata | undefined): string[] {
  if (!metadata) return [];
  const lines: string[] = [];
  if (metadata.reportedUsage) lines.push(`Usage: ${JSON.stringify(metadata.reportedUsage)}`);
  else if (metadata.usage) lines.push(`Usage: ${Object.entries(metadata.usage)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join(', ')}`);
  if (metadata.tokenUsage) lines.push(`Tokens: ${Object.entries(metadata.tokenUsage)
    .map(([key, value]) => `${key}=${value}`).join(', ')}`);
  const cost = metadata.costDetails;
  if (cost?.kind === 'reported') {
    lines.push(`Cost: ${cost.amount} ${cost.currency} (provider-reported)`);
  } else if (cost?.kind === 'estimated') {
    lines.push(`Cost: ${cost.usd} USD (estimated, ${cost.completeness}; ${cost.sources.join(', ')})`);
  } else if (cost?.kind === 'unknown') {
    lines.push(`Cost: unknown (${cost.missing.join(', ')})`);
  } else if (metadata.cost != null) lines.push(`Cost: ${metadata.cost}`);
  return lines;
}
