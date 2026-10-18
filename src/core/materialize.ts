import type { RawImageResult } from '../types/provider.js';
import {
  MAX_BASE64_IMAGE_CHARS, MAX_IMAGE_BYTES, MAX_TOTAL_REFERENCE_IMAGE_BYTES, sniffMime,
} from '../image-input.js';
import { decodeBase64 } from './base64.js';
import { awaitWithAbort } from './deadline.js';
import { ImageGenError } from './errors.js';
import type { ImageHost, Original, PreparedImageRequest } from './protocol.js';

export function byteLimit(value: number | undefined, ceiling: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > ceiling)) {
    throw new ImageGenError('Host byte limit is outside the package safety bounds.', 'invalid image byte limit');
  }
  return value ?? ceiling;
}

export function validateOriginal(original: Original, limit: number, catalog = false): Original {
  if (!original || !(original.bytes instanceof Uint8Array) || typeof original.mimeType !== 'string' ||
      !original.bytes.byteLength || original.bytes.byteLength > limit) {
    throw new ImageGenError('Original image bytes are missing or exceed the safety ceiling.', 'invalid original bytes');
  }
  const actual = sniffMime(original.bytes);
  const declared = original.mimeType.toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!actual || actual !== declared ||
      (catalog && !['image/png', 'image/jpeg', 'image/webp'].includes(actual))) {
    throw new ImageGenError('Original bytes do not match a supported image format.', 'original format mismatch');
  }
  return original;
}

export async function loadReferences<Stored>(
  request: PreparedImageRequest, host: ImageHost<Stored>, signal: AbortSignal,
): Promise<{ images: Original[]; mask?: Original }> {
  const totalLimit = byteLimit(host.limits?.referenceBytes, MAX_TOTAL_REFERENCE_IMAGE_BYTES);
  const imageLimit = byteLimit(host.limits?.imageBytes, MAX_IMAGE_BYTES);
  const images: Original[] = [];
  let total = 0;
  let mask: Original | undefined;
  // Sequential loading bounds input-sized work; it does not serialize independent image tools.
  for (const reference of request.references) {
    const original = validateOriginal(
      await awaitWithAbort(host.loadOriginal(reference, signal), signal),
      Math.min(imageLimit, totalLimit - total), request.route.kind === 'catalog',
    );
    total += original.bytes.byteLength;
    if (reference.role === 'mask') mask = original;
    else images.push(original);
  }
  return { images, ...(mask ? { mask } : {}) };
}

export async function materializeOutput<Stored>(
  raw: RawImageResult, host: ImageHost<Stored>, signal: AbortSignal, catalog: boolean,
): Promise<Original> {
  const limit = byteLimit(host.limits?.imageBytes, MAX_IMAGE_BYTES);
  if (!raw?.data) throw new ImageGenError('Provider returned invalid image data.', 'invalid image output');
  if (raw.data.kind === 'base64') {
    if (typeof raw.data.bytes !== 'string' || raw.data.bytes.length > MAX_BASE64_IMAGE_CHARS) {
      throw new ImageGenError('Provider output exceeds the size ceiling.', 'oversized image output');
    }
    const bytes = decodeBase64(raw.data.bytes);
    const mimeType = sniffMime(bytes);
    if (!mimeType) throw new ImageGenError('Provider output is not a supported image.', 'invalid output format');
    return validateOriginal({ bytes, mimeType }, limit, catalog);
  }
  if (raw.data.kind !== 'url' || typeof raw.data.url !== 'string' || !/^https?:\/\//i.test(raw.data.url)) {
    throw new ImageGenError('Provider did not return a supported output URL.', 'invalid output URL');
  }
  return validateOriginal(await awaitWithAbort(host.loadOutput(raw.data.url, signal), signal), limit, catalog);
}
