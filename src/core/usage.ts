import type { ApiStyle, RawImageResult, RawGenerationMetadata } from '../types/provider.js';
import type { ImageTokenUsage, ReportedUsage, UsageValue } from './protocol.js';

/**
 * Bounded sanitizer for provider-reported usage. Only finite nonnegative
 * numbers, booleans, null, short allowlisted strings, short arrays and objects
 * with allowlisted keys survive, with fixed depth/key/item/total-value caps. This keeps
 * meaningful nested token details (e.g. `input_tokens_details.text_tokens`)
 * without retaining arbitrary response text, URLs or raw bodies as metadata.
 */
const KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const USAGE_TAGS = new Set(['text', 'image', 'audio', 'video', 'input', 'output', 'cached', 'uncached', 'tokens']);
const MAX_DEPTH = 4;
const MAX_KEYS = 64;
const MAX_ITEMS = 16;
const MAX_VALUES = 256;

export function sanitizeReportedUsage(value: unknown): ReportedUsage | undefined {
  const budget = { keys: MAX_KEYS, values: MAX_VALUES };
  const clean = sanitizeValue(value, 0, budget);
  if (typeof clean !== 'object' || clean === null || Array.isArray(clean)) return undefined;
  return Object.keys(clean).length > 0 ? (clean as ReportedUsage) : undefined;
}

function sanitizeValue(value: unknown, depth: number, budget: { keys: number; values: number }): UsageValue | undefined {
  if (budget.values <= 0) return undefined;
  budget.values -= 1;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
  }
  if (typeof value === 'string') return USAGE_TAGS.has(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const items: UsageValue[] = [];
    for (const item of value.slice(0, MAX_ITEMS)) {
      const clean = sanitizeValue(item, depth + 1, budget);
      if (clean !== undefined) items.push(clean);
    }
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const out: Record<string, UsageValue> = Object.create(null) as Record<string, UsageValue>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (budget.keys <= 0) break;
      if (!KEY_RE.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const clean = sanitizeValue(item, depth + 1, budget);
      if (clean === undefined) continue;
      budget.keys -= 1;
      out[key] = clean;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** Top-level finite numeric usage kept for the legacy desktop result contract. */
export function legacyNumericUsage(
  usage: ReportedUsage | undefined,
): Record<string, number> | undefined {
  if (!usage) return undefined;
  const entries = Object.entries(usage)
    .filter(([name, value]) => KEY_RE.test(name) && typeof value === 'number' && Number.isFinite(value))
    .slice(0, 50);
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined;
}

/** Normalize known provider counters without charging cached input twice. */
export function normalizeTokenUsage(usage: ReportedUsage | undefined, api: ApiStyle | 'catalog'): ImageTokenUsage | undefined {
  if (!usage) return undefined;
  let input: number | undefined;
  let output: number | undefined;
  let cacheRead = 0;
  let cacheWrite = 0;
  if (api === 'gemini') {
    input = count(usage, 'promptTokenCount');
    output = count(usage, 'candidatesTokenCount');
    cacheRead = count(usage, 'cachedContentTokenCount') ?? 0;
    if (output !== undefined) output += count(usage, 'thoughtsTokenCount') ?? 0;
  } else if (['openai', 'openrouter', 'meta', 'catalog', 'codex'].includes(api)) {
    input = count(usage, 'input_tokens', 'prompt_tokens');
    output = count(usage, 'output_tokens', 'completion_tokens');
    cacheRead = count(usage, 'input_tokens_details.cached_tokens', 'prompt_tokens_details.cached_tokens', 'cached_input_tokens') ?? 0;
    cacheWrite = count(usage, 'input_tokens_details.cache_write_tokens', 'prompt_tokens_details.cache_write_tokens') ?? 0;
    // OpenRouter's cached counter includes cache writes; OpenAI's read counter does not.
    if (api === 'openrouter' && cacheWrite > 0) {
      if (cacheWrite > cacheRead) return undefined;
      cacheRead -= cacheWrite;
    }
  } else return undefined; // No established billing-counter semantics for this API.
  if (input === undefined || output === undefined || input < cacheRead + cacheWrite) return undefined;
  input -= cacheRead + cacheWrite;
  if (![input, output, cacheRead, cacheWrite, input + output + cacheRead + cacheWrite].every(Number.isSafeInteger)) return undefined;
  return { input, output, cacheRead, cacheWrite };
}

function count(usage: ReportedUsage, ...paths: string[]): number | undefined {
  for (const path of paths) {
    let value: UsageValue | undefined = usage;
    for (const key of path.split('.')) {
      value = value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

export type ReportedCost = {
  amount: number;
  currency: string;
  source: string;
  basis: 'provider-response' | 'gateway-estimate';
};

/** Extra provider metadata carrier; validated again by `readCoreRawMetadata`. */
export type CoreRawMetadataFields = {
  requestId?: string;
  usage?: unknown;
  reportedUsage?: unknown;
  reportedCost?: ReportedCost;
  cost?: number;
  costCurrency?: string;
  costSource?: string;
  costBasis?: 'provider-response' | 'gateway-estimate';
};

/**
 * Attach core metadata to a provider raw result. `RawGenerationMetadata` is the
 * published desktop type (flat numeric usage, numeric cost); the carrier keeps
 * richer values for the shared engine without widening that public type.
 */
export function coreMetadata(fields: CoreRawMetadataFields): RawGenerationMetadata {
  const reportedUsage = sanitizeReportedUsage(fields.reportedUsage ?? fields.usage);
  const usage = legacyNumericUsage(reportedUsage);
  const { usage: _usage, reportedUsage: _reported, ...rest } = fields;
  return { ...rest, ...(usage ? { usage } : {}), ...(reportedUsage ? { reportedUsage } : {}) };
}

export type CoreRawMetadata = {
  requestId?: string;
  reportedUsage?: ReportedUsage;
  reportedCost?: ReportedCost;
};

const REQUEST_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;

/** Read the rich metadata carrier from whichever raw result carries it. */
export function readCoreRawMetadata(
  metadata: RawImageResult['metadata'] | undefined,
): CoreRawMetadata {
  if (!metadata || typeof metadata !== 'object') return {};
  const raw = metadata as unknown as CoreRawMetadataFields;
  const requestId =
    typeof raw.requestId === 'string' && REQUEST_ID_RE.test(raw.requestId) ? raw.requestId : undefined;
  const reportedUsage = sanitizeReportedUsage(raw.reportedUsage ?? raw.usage);
  let reportedCost = sanitizeReportedCost(raw.reportedCost);
  if (!reportedCost && typeof raw.cost === 'number') {
    reportedCost = parseReportedCost({ amount: raw.cost, currency: raw.costCurrency,
      source: raw.costSource, basis: raw.costBasis }, undefined, 'provider-response');
  }
  return {
    ...(requestId ? { requestId } : {}),
    ...(reportedUsage ? { reportedUsage } : {}),
    ...(reportedCost ? { reportedCost } : {}),
  };
}

/** Only a provider charge is eligible; explicitly identified estimates are not charges. */
export function preferredReportedCost(...candidates: Array<ReportedCost | undefined>): ReportedCost | undefined {
  return candidates.find((cost) => cost?.basis === 'provider-response');
}

export function parseReportedCost(
  value: unknown, currency: unknown, basis: ReportedCost['basis'], fallbackCurrency?: unknown,
): ReportedCost | undefined {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const amount = object ? object.amount : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return undefined;
  if (object?.basis !== undefined && object.basis !== 'provider-response' && object.basis !== 'gateway-estimate') {
    return undefined;
  }
  // An explicitly identified estimate can never be promoted to a provider charge.
  const effectiveBasis = basis === 'gateway-estimate' || object?.basis === 'gateway-estimate'
    ? 'gateway-estimate' : 'provider-response';
  const unit = [object?.currency, object?.unit, currency, fallbackCurrency]
    .find((value): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(value));
  const source = typeof object?.source === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(object.source)
    ? object.source : effectiveBasis === 'gateway-estimate' ? 'cloudflare-gateway' : 'provider-response';
  return { amount, currency: unit ?? 'unknown', source, basis: effectiveBasis };
}

function sanitizeReportedCost(value: unknown): ReportedCost | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return parseReportedCost(value, undefined, 'provider-response');
}
