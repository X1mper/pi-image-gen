import { decodeBase64, encodeBase64 } from './core/base64.js';
import { ImageGenError } from './errors.js';
import type { ResolvedImageInput } from './types.js';

/**
 * Portable image byte policy. Deliberately free of `node:fs`/`node:path` and of
 * pi-shared so the shared engine and Workers-safe providers can import it. The
 * desktop's file/public-URL resolution lives in `node/inputs.ts`.
 */
const MAGIC_BYTES: Array<{ mimeType: string; bytes: number[] }> = [
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: "RIFF....WEBP" — bytes 0..3 = RIFF, bytes 8..11 = WEBP
  { mimeType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mimeType: 'image/bmp', bytes: [0x42, 0x4d] },
  // TIFF little-endian ("II*\0") and big-endian ("MM\0*")
  { mimeType: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mimeType: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

// ISO-BMFF major brands (bytes 8..11 of the ftyp box) → HEIC/HEIF family.
// qwen/seedream/gemini all accept these as reference-image formats.
const FTYP_BRAND_MIME: Record<string, string> = {
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
};

const DATA_URI_RE = /^data:(image\/[a-z+.-]+);base64,(.+)$/i;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_INPUTS = 16;
export const MAX_TOTAL_REFERENCE_IMAGE_BYTES = 128 * 1024 * 1024;
export const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_GENERATED_IMAGES = 10;
/** Package safety ceiling on one admitted prompt; not a provider-declared limit. */
export const MAX_PROMPT_CHARS = 32_000;

export function sniffMime(bytes: Uint8Array): string | undefined {
  // ISO-BMFF (HEIC/HEIF): no fixed magic at offset 0 — the box size varies —
  // so match "ftyp" at offset 4 and read the major brand at offset 8.
  const brand = sniffFtypBrand(bytes);
  if (brand) return brand;
  for (const { mimeType, bytes: magic } of MAGIC_BYTES) {
    if (bytes.length < magic.length) continue;
    let match = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (mimeType === 'image/webp') {
      // RIFF prefix matched — verify WEBP at offset 8.
      if (
        bytes.length >= 12 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return 'image/webp';
      }
      continue;
    }
    return mimeType;
  }
  return undefined;
}

/**
 * Detect HEIC/HEIF via the ISO-BMFF `ftyp` box: 4-byte box size, then the
 * literal "ftyp", then a 4-char major brand. Returns undefined for anything
 * else (including AVIF's "avif" brand, which no built-in model accepts).
 */
function sniffFtypBrand(bytes: Uint8Array): string | undefined {
  if (
    bytes.length < 12 ||
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70 // p
  ) {
    return undefined;
  }
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  return FTYP_BRAND_MIME[brand];
}

export function assertReferenceImageAggregateBytes(
  totalBytes: number,
  ceiling = MAX_TOTAL_REFERENCE_IMAGE_BYTES,
): void {
  if (totalBytes > ceiling) {
    throw new ImageGenError(
      'Reference images exceed the combined size ceiling.',
      'reference images exceed aggregate safety ceiling',
    );
  }
}

export function toDataUri(input: ResolvedImageInput): string {
  return `data:${input.mimeType};base64,${encodeBase64(input.bytes)}`;
}

/**
 * Classify a string returned by an image-generation API as either a URL the
 * caller should fetch, or base64 image bytes the caller already has.
 *
 * Different providers / gateways return image output in different shapes:
 *   - http(s):// URL       → fetch it
 *   - `data:image/...;base64,...`  → strip prefix, decode bytes
 *   - bare base64 string (PNG/JPEG/WebP/GIF magic bytes) → decode bytes
 *   - empty / whitespace   → invalid, return null
 *
 * Returning `null` lets adapters skip junk entries (e.g. when a provider's
 * response had `text` parts but no actual image).
 */
export function classifyImageOutput(
  value: string | undefined | null,
): { kind: 'url'; url: string } | { kind: 'base64'; bytes: string; mimeType: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', url: trimmed };
  }

  const dataMatch = DATA_URI_RE.exec(trimmed);
  if (dataMatch) {
    if (dataMatch[2]!.length > MAX_BASE64_IMAGE_CHARS) return null;
    return {
      kind: 'base64',
      bytes: dataMatch[2]!,
      mimeType: dataMatch[1]!.toLowerCase(),
    };
  }

  // Maybe bare base64 — try to decode and sniff. Bail cheaply on anything that
  // can't possibly be an image (too short, contains non-base64 chars).
  if (
    trimmed.length < 16 ||
    trimmed.length > MAX_BASE64_IMAGE_CHARS ||
    /[^A-Za-z0-9+/=\s]/.test(trimmed)
  ) {
    return null;
  }
  const decoded = decodeBase64(trimmed);
  if (decoded.length < 8) return null;
  const mimeType = sniffMime(decoded);
  if (!mimeType) return null;
  return { kind: 'base64', bytes: trimmed, mimeType };
}
