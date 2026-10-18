import type { Cost, ReportedUsage } from './protocol.js';
import type { ReportedCost } from './usage.js';

/**
 * Grounded GPT Image 2.5 cost answer for ONE provider request.
 *
 * Provider-reported cost always wins (amount/currency/source retained, and a
 * Gateway estimate stays marked as an estimate). Otherwise the only first-party
 * fallback is OpenAI's shipped GPT Image 2.5 output calculator plus documented
 * standard rates. A reported usage breakdown with no cache ambiguity makes a
 * complete estimate; output-only data is Partial; missing usage with Auto
 * quality is Unknown. Absence is never $0, and file size/word count/pixels
 * never stand in for billable tokens.
 */
export const GPT_IMAGE_25_RATE_SOURCE =
  'https://developers.openai.com/api/docs/models/gpt-image-2.5-flare (observed 2026-10-18)';
export const GPT_IMAGE_25_CALCULATOR_SOURCE =
  'https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency GptImageTokenCalculator (observed 2026-10-18)';

export const GPT_IMAGE_25_USD_PER_MILLION_TOKENS = Object.freeze({
  textInput: 5,
  imageInput: 8,
  imageOutput: 30,
});

export const GPT_IMAGE_25_OUTPUT_COEFFICIENTS: Readonly<Record<string, number>> = Object.freeze({
  low: 16,
  medium: 24,
  high: 48,
  xhigh: 64,
  max: 96,
});

/** OpenAI $2/M cached image input versus Cloudflare $3/M: never silently chosen. */
export const GPT_IMAGE_25_CACHED_RATE_CONFLICT =
  'cached-image-input-rate-conflict (OpenAI $2/M, Cloudflare $3/M)';

export function estimateImageOutputTokens(
  width: number,
  height: number,
  quality: string,
): number | undefined {
  const q = GPT_IMAGE_25_OUTPUT_COEFFICIENTS[quality];
  if (q === undefined) return undefined;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(width * height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const shortGrid = roundHalfToEven((q * short) / long);
  if (shortGrid < 1) return undefined;
  const tokens = Math.ceil((q * shortGrid * (2_000_000 + width * height)) / 4_000_000);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

export function estimateImageOutputCostUsd(
  width: number,
  height: number,
  quality: string,
): { tokens: number; usd: number } | undefined {
  const tokens = estimateImageOutputTokens(width, height, quality);
  return tokens === undefined ? undefined : { tokens, usd: usd(tokens, 'imageOutput') };
}

export type BuildImageCostInput = {
  /** Only set for a verified GPT Image 2.5 route, never inferred from arbitrary usage. */
  readonly pricingModel?: 'gpt-image-2.5';
  /** Verified direct Images uncached semantics; catalog upstream behavior is not established. */
  readonly uncachedInput?: boolean;
  readonly reported?: ReportedCost;
  readonly usage?: ReportedUsage;
  readonly quality?: string;
  readonly width?: number;
  readonly height?: number;
  readonly outputs?: readonly { width?: number; height?: number }[];
};

export function buildImageCost(input: BuildImageCostInput): Cost {
  if (input.reported) {
    return {
      kind: 'reported',
      amount: input.reported.amount,
      currency: input.reported.currency,
      source: input.reported.source,
      basis: input.reported.basis,
    };
  }
  if (input.pricingModel !== 'gpt-image-2.5') {
    return { kind: 'unknown', missing: ['model-specific-pricing'] };
  }
  const usage = input.usage;
  const text = tokenCount(usage, 'input_tokens_details.text_tokens', 'input_text_tokens');
  const image = tokenCount(usage, 'input_tokens_details.image_tokens', 'input_image_tokens');
  const cached = tokenCount(usage, 'input_tokens_details.cached_tokens', 'cached_input_tokens');
  const outputImage = tokenCount(usage, 'output_tokens_details.image_tokens', 'output_image_tokens');
  const outputText = tokenCount(usage, 'output_tokens_details.text_tokens');

  const components: Record<string, number> = {};
  const missing: string[] = [];
  const sources: string[] = [GPT_IMAGE_25_RATE_SOURCE];

  if (input.uncachedInput && (cached === undefined || cached === 0)) {
    if (text !== undefined) components['textInputUsd'] = usd(text, 'textInput');
    if (image !== undefined) components['imageInputUsd'] = usd(image, 'imageInput');
  } else missing.push('resolved-input-cache-semantics');
  if (outputImage !== undefined) components['imageOutputUsd'] = usd(outputImage, 'imageOutput');
  if (outputText === undefined && tokenCount(usage, 'output_tokens') !== outputImage) {
    missing.push('output-token-modality-breakdown');
  }
  if (outputText !== undefined && outputText > 0) missing.push('text-output-token-rate');
  if (cached !== undefined && cached > 0) missing.push(GPT_IMAGE_25_CACHED_RATE_CONFLICT);

  if (outputImage === undefined) {
    const estimated = tokenEstimate(input);
    if (estimated !== undefined) {
      components['imageOutputUsd'] = usd(estimated, 'imageOutput');
      missing.push('image-output-tokens-estimated');
      sources.push(GPT_IMAGE_25_CALCULATOR_SOURCE);
    }
  }
  if (text === undefined || image === undefined) missing.push('input-token-usage');

  if (Object.keys(components).length === 0) {
    return {
      kind: 'unknown',
      missing: unique([
        'provider-usage',
        ...(input.quality === undefined || input.quality === 'auto'
          ? ['explicit-quality (auto or omitted)']
          : []),
        ...missing,
      ]),
    };
  }
  const complete =
    text !== undefined && image !== undefined && outputImage !== undefined && missing.length === 0;
  return {
    kind: 'estimated',
    completeness: complete ? 'complete' : 'partial',
    usd: Object.values(components).reduce((total, value) => total + value, 0),
    components,
    missing: unique(missing),
    sources: unique(sources),
  };
}

function tokenEstimate(input: BuildImageCostInput): number | undefined {
  if (!input.quality || input.quality === 'auto') return undefined;
  const outputs = input.outputs ?? [{ width: input.width, height: input.height }];
  if (!outputs.length) return undefined;
  let total = 0;
  for (const output of outputs) {
    if (output.width === undefined || output.height === undefined) return undefined;
    const tokens = estimateImageOutputTokens(output.width, output.height, input.quality);
    if (tokens === undefined) return undefined;
    total += tokens;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function tokenCount(usage: ReportedUsage | undefined, ...paths: string[]): number | undefined {
  for (const path of paths) {
    let current: unknown = usage;
    for (const key of path.split('.')) {
      if (typeof current !== 'object' || current === null) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[key];
    }
    if (typeof current === 'number' && Number.isSafeInteger(current) && current >= 0) return current;
  }
  return undefined;
}

function usd(tokens: number, kind: keyof typeof GPT_IMAGE_25_USD_PER_MILLION_TOKENS): number {
  return (tokens * GPT_IMAGE_25_USD_PER_MILLION_TOKENS[kind]) / 1_000_000;
}

/** Banker's rounding, matching the shipped OpenAI calculator's short grid. */
function roundHalfToEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
