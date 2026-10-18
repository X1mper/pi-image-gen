import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { cancelledError, describeWriteError, isAbortError } from '../errors.js';
import type { GeneratedImage, GenerateImageParams } from '../types.js';
import type { ImageStoreContext, Original } from '../core/protocol.js';
import type { GenerateImageOptions } from './options.js';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif',
};

export function desktopSink(params: GenerateImageParams, options: GenerateImageOptions, model: string) {
  const configured: unknown = options.settings.outputDir;
  const target = params.outputDir ?? (typeof configured === 'string' ? configured : undefined);
  const directory = target?.trim() ? target : '.pi/images';
  const outDir = isAbsolute(directory) ? directory : resolve(options.cwd, directory);
  const saved: GeneratedImage[] = [];
  let stem: string | undefined;
  let ready = false;
  const begin = () => { stem ??= sanitizeFilename(params.filename ?? `${model}-${formatStamp((options.now ?? (() => new Date()))())}`); };
  return {
    begin,
    async store(output: Original, index: number, context: ImageStoreContext): Promise<GeneratedImage> {
      begin();
      if (!ready) {
        try { await mkdir(outDir, { recursive: true }); ready = true; }
        catch (error) { throw describeWriteError('create the output directory', error); }
      }
      const suffix = context.total > 1 ? `-${index + 1}` : '';
      const path = await writeUnique(outDir, `${stem}${suffix}`, MIME_TO_EXT[output.mimeType] ?? 'png',
        output.bytes, context.signal);
      const info = context.descriptor;
      const image: GeneratedImage = { path, mimeType: output.mimeType,
        ...(info.width !== undefined && info.height !== undefined
          ? { dimensions: { width: info.width, height: info.height } } : {}),
        ...(info.revisedPrompt !== undefined ? { revisedPrompt: info.revisedPrompt } : {}) };
      saved.push(image);
      return image;
    },
    async cleanup(): Promise<void> {
      // Desktop retains its legacy local partial-batch policy; core never deletes host receipts.
      await Promise.all(saved.map(async ({ path }) => {
        try { await unlink(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logCleanupFailure(error);
        }
      }));
    },
  };
}

/** O_EXCL owns each candidate before writing; never unlink a pre-existing path. */
async function writeUnique(dir: string, stem: string, ext: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  for (let version = 1; ; version++) {
    if (signal.aborted) throw cancelledError('image generation');
    const path = resolve(dir, version === 1 ? `${stem}.${ext}` : `${stem}-v${version}.${ext}`);
    let created = false;
    try {
      const file = await open(path, 'wx');
      created = true;
      try { await file.writeFile(bytes, { signal }); }
      finally { await file.close(); }
      if (signal.aborted) throw cancelledError('image generation');
      return path;
    } catch (error) {
      if (created) {
        try { await unlink(path); }
        catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') logCleanupFailure(cleanupError);
        }
      }
      if (signal.aborted || isAbortError(error)) throw cancelledError('image generation');
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw describeWriteError('write the image file', error);
    }
  }
}

function logCleanupFailure(error: unknown): void {
  console.error(`[pi-image-gen] cleanup failed: ${describeWriteError('remove an incomplete image file', error).logSummary}`);
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function sanitizeFilename(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_');
  return safe.length ? safe.slice(0, 100) : 'image';
}
