import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cancelledError, describeWriteError, isAbortError } from '../errors.js';

/** O_EXCL owns each candidate before writing; never unlink a pre-existing path. */
export async function writeUnique(dir: string, stem: string, ext: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  for (let version = 1; ; version++) {
    if (signal.aborted) throw cancelledError('image saving');
    const path = resolve(dir, version === 1 ? `${stem}.${ext}` : `${stem}-v${version}.${ext}`);
    let created = false;
    try {
      const file = await open(path, 'wx');
      created = true;
      try { await file.writeFile(bytes, { signal }); }
      finally { await file.close(); }
      if (signal.aborted) throw cancelledError('image saving');
      return path;
    } catch (error) {
      if (created) {
        try { await unlink(path); }
        catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') logCleanupFailure(cleanupError);
        }
      }
      if (signal.aborted || isAbortError(error)) throw cancelledError('image saving');
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw describeWriteError('write the image file', error);
    }
  }
}


function logCleanupFailure(error: unknown): void {
  console.error(`[pi-image-gen] cleanup failed: ${describeWriteError('remove an incomplete image file', error).logSummary}`);
}
