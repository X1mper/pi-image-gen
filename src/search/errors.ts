export type ImageSearchErrorCode =
  | 'configuration' | 'input' | 'credentials' | 'http' | 'network'
  | 'timeout' | 'cancelled' | 'response';

/** Only body-free, locally authored messages may cross the search boundary. */
export class ImageSearchError extends Error {
  constructor(
    message: string,
    readonly code: ImageSearchErrorCode,
    readonly fallbackAllowed = false,
  ) {
    super(message);
    this.name = 'ImageSearchError';
  }
}

export function imageSearchErrorMessage(error: unknown): string {
  return error instanceof ImageSearchError ? error.message : 'Image search failed unexpectedly.';
}
