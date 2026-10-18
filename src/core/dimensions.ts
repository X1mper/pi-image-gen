import type { ImageDimensions } from '../types/image.js';

/**
 * Read pixel dimensions from PNG/WebP/JPEG headers without any Node buffer or
 * image library. Absent/garbled headers return undefined instead of guessing:
 * dimensions only inform honest cost estimates and display metadata.
 */
export function readImageDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | undefined {
  const dimensions = readHeaderDimensions(bytes, mimeType);
  return dimensions && dimensions.width > 0 && dimensions.height > 0 ? dimensions : undefined;
}

function readHeaderDimensions(bytes: Uint8Array, mimeType: string): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === 'image/png' && bytes.byteLength >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType === 'image/webp' && bytes.byteLength >= 30) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === 'VP8X') {
      return {
        width: 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16),
        height: 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16),
      };
    }
    if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if ((mimeType === 'image/jpeg' || mimeType === 'image/jpg') && bytes.byteLength >= 4) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.byteLength) break;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 carry the frame size.
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += length + 2;
    }
  }
  return undefined;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]!);
  return out;
}
