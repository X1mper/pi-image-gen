import { ImageGenError } from './errors.js';
import { MAX_PROMPT_CHARS, MAX_REFERENCE_IMAGE_INPUTS } from '../image-input.js';
import type { ImageArgs, ImageDefaults, ResolvedImageRoute } from './protocol.js';

export const DEFAULT_KEYS = [
  'n', 'size', 'aspectRatio', 'imageSize', 'quality', 'outputFormat', 'background',
  'outputCompression', 'negativePrompt', 'seed', 'promptEnhance', 'enableThinking',
  'watermark', 'seriesMaxImages',
] as const satisfies ReadonlyArray<keyof ImageDefaults>;
const PROVIDER_KEYS = new Set(['prompt', 'image', 'mask', 'filename', ...DEFAULT_KEYS]);
const CATALOG_KEYS = new Set(['prompt', 'image', 'size', 'quality', 'background', 'outputFormat']);
const STRING_KEYS = new Set([
  'size', 'aspectRatio', 'imageSize', 'quality', 'outputFormat', 'background',
  'negativePrompt', 'filename', 'mask',
]);
const BOOLEAN_KEYS = new Set(['promptEnhance', 'enableThinking', 'watermark']);

export function validateArguments(
  args: ImageArgs,
  defaults: ImageDefaults,
  route: ResolvedImageRoute,
): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Image arguments must be an object.');
  const record = args as unknown as Record<string, unknown>;
  const allowed = route.kind === 'catalog' ? CATALOG_KEYS : PROVIDER_KEYS;
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (!allowed.has(key)) fail(`This route does not support the ${key} control.`);
    checkScalar(key, value);
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined) continue;
    if (!DEFAULT_KEYS.includes(key as typeof DEFAULT_KEYS[number]) || !allowed.has(key)) {
      fail('Frozen defaults contain a control unsupported by this route.');
    }
    checkScalar(key, value);
  }
  if (typeof record.prompt !== 'string' || !record.prompt.trim()) fail('prompt must be a non-empty string.');
  if (route.kind === 'catalog' && record.prompt.length > MAX_PROMPT_CHARS) {
    fail(`prompt exceeds the ${MAX_PROMPT_CHARS}-character catalog safety ceiling.`);
  }
  if (record.image !== undefined) {
    if (!Array.isArray(record.image) || record.image.length > MAX_REFERENCE_IMAGE_INPUTS) {
      fail(`image must be an array of at most ${MAX_REFERENCE_IMAGE_INPUTS} original references.`);
    }
    for (const value of record.image) checkReference(value, route.kind === 'catalog');
  }
  if (record.mask !== undefined) checkReference(record.mask, false);
  return record;
}

function checkScalar(key: string, value: unknown): void {
  if (STRING_KEYS.has(key) && typeof value !== 'string') fail(`${key} must be a string.`);
  if (BOOLEAN_KEYS.has(key) && typeof value !== 'boolean') fail(`${key} must be boolean.`);
  if (['n', 'outputCompression', 'seed', 'seriesMaxImages'].includes(key) &&
      (typeof value !== 'number' || !Number.isFinite(value))) fail(`${key} must be a finite number.`);
}

function checkReference(value: unknown, requireUrl: boolean): void {
  if (typeof value !== 'string' || !value.trim() || /^data:/i.test(value)) {
    fail('References must identify original files, not embedded image data.');
  }
  if (!requireUrl) return;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch {
    fail('Catalog references must be full HTTP(S) original URLs without credentials.');
  }
}

export function assertMember(name: string, value: unknown, allowed: readonly string[] | undefined): void {
  if (value !== undefined && (!allowed || typeof value !== 'string' || !allowed.includes(value))) {
    fail(`${name} is not supported by the configured catalog route.`);
  }
}

function fail(message: string): never {
  throw new ImageGenError(message, 'invalid image request');
}
