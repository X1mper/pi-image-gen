import sharp from 'sharp';
import { MAX_IMAGE_BYTES, sniffMime } from '../image-input.js';
import type { ImageResize } from '../types/image.js';

export const MAX_RASTER_PIXELS = 40_000_000;
export const MAX_RESIZE_EDGE = 8192;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

/** Local policy errors only; decoder errors must never expose source URLs or bytes. */
export class RasterError extends Error {}

export function validateResize(value: unknown): asserts value is ImageResize | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RasterError('resize must be an object.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['width', 'height', 'fit'].includes(key)) ||
      !Number.isInteger(record.width) || !Number.isInteger(record.height) ||
      (record.width as number) < 1 || (record.height as number) < 1 ||
      (record.width as number) > MAX_RESIZE_EDGE || (record.height as number) > MAX_RESIZE_EDGE ||
      (record.width as number) * (record.height as number) > MAX_RASTER_PIXELS ||
      (record.fit !== undefined && record.fit !== 'contain' && record.fit !== 'cover')) {
    throw new RasterError('resize requires width/height from 1–8192, at most 40 million pixels, and fit contain or cover.');
  }
}

/** Full decode, not just header sniffing. Only still JPEG/PNG/WebP enter processing. */
export async function inspectRaster(bytes: Uint8Array): Promise<{ mimeType: string; width: number; height: number }> {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new RasterError('Image exceeds the 20 MiB byte limit or is empty.');
  const detected = sniffMime(bytes);
  if (detected === 'image/png' && hasAnimationControl(bytes)) {
    throw new RasterError('Animated images are not supported for downloading or resizing.');
  }
  if (!Object.values(MIME).some((mime) => mime === detected)) {
    throw new RasterError('Unsupported image format. Only still JPEG, PNG and WebP are supported.');
  }
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_RASTER_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_RASTER_PIXELS) {
      throw new RasterError('Image dimensions are missing or exceed 40 million pixels.');
    }
    if ((metadata.pages ?? 1) > 1) throw new RasterError('Animated images are not supported for downloading or resizing.');
    const mimeType = MIME[metadata.format as keyof typeof MIME];
    if (!mimeType || mimeType !== detected) throw new RasterError('Image format does not match its bytes.');
    await image.stats();
    return { mimeType, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (error instanceof RasterError) throw error;
    throw new RasterError('Image could not be fully decoded within the supported raster limits.');
  }
}

/** libvips may expose only APNG's first frame, so inspect PNG's animation control chunk. */
function hasAnimationControl(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return false; // Full decoder handles malformed chunks.
    if (bytes[offset + 4] === 0x61 && bytes[offset + 5] === 0x63 &&
        bytes[offset + 6] === 0x54 && bytes[offset + 7] === 0x4c) return true; // acTL
    offset += 12 + length;
  }
  return false;
}

/** Exact-sized PNG derivative; contain pads transparently, cover explicitly crops. */
export async function resizeRaster(bytes: Uint8Array, resize: ImageResize): Promise<{
  bytes: Uint8Array; mimeType: string; width: number; height: number;
}> {
  validateResize(resize);
  await inspectRaster(bytes);
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: MAX_RASTER_PIXELS, failOn: 'warning' })
      .autoOrient()
      .resize({ width: resize.width, height: resize.height, fit: resize.fit ?? 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer({ resolveWithObject: true });
    if (info.width !== resize.width || info.height !== resize.height || data.length > MAX_IMAGE_BYTES) {
      throw new RasterError('Resized image exceeds the 20 MiB limit or does not match the requested dimensions.');
    }
    return { bytes: data, mimeType: 'image/png', width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof RasterError) throw error;
    throw new RasterError('Image resizing failed.');
  }
}
