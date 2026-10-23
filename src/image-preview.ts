import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { MAX_IMAGE_BYTES } from './image-input.js';
import type { GeneratedImage } from './types.js';

const MAX_PREVIEWS = 4;
// Pi's resizeImage maxBytes bounds the base64 payload, not decoded image bytes.
const MAX_PREVIEW_BASE64_CHARS = 384 * 1024;

/** Display copies only: never modify originals or fail an already-saved generation. */
export async function buildImagePreviews(
  images: readonly GeneratedImage[],
  signal?: AbortSignal,
): Promise<Array<TextContent | ImageContent>> {
  const content: Array<TextContent | ImageContent> = [];
  let attached = 0;
  for (const [index, image] of images.slice(0, MAX_PREVIEWS).entries()) {
    if (signal?.aborted) break;
    try {
      const file = await open(image.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES) continue;
        // Read only the bounded snapshot size, even if the file subsequently grows.
        bytes = Buffer.alloc(info.size);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length) continue;
      } finally {
        await file.close();
      }
      if (signal?.aborted) break;
      const preview = await resizeImage(bytes, image.mimeType, {
        maxWidth: 1024,
        maxHeight: 1024,
        maxBytes: MAX_PREVIEW_BASE64_CHARS,
      });
      if (signal?.aborted) break;
      if (!preview || preview.data.length > MAX_PREVIEW_BASE64_CHARS ||
          !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(preview.mimeType)) continue;
      content.push(
        { type: 'text', text: `Preview of image ${index + 1} (display copy; use the saved original for editing).` },
        { type: 'image', data: preview.data, mimeType: preview.mimeType },
      );
      attached++;
    } catch {
      // A missing file or failed decoder must not hide successful saved outputs.
    }
  }
  if (attached < images.length) {
    content.push({
      type: 'text',
      text: `Attached ${attached} of ${images.length} inline previews (up to ${MAX_PREVIEWS}). All saved originals remain available through the links above.`,
    });
  }
  return content;
}
