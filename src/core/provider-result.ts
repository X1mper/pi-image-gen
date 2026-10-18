import type { RawGenerationMetadata } from '../types/provider.js';
import { ImageGenError } from './errors.js';

/** Safe accounting survives an unusable provider result, without retaining its body. */
export class ProviderResultError extends ImageGenError {
  constructor(error: ImageGenError, readonly metadata: RawGenerationMetadata) {
    super(error.message, error.logSummary);
  }
}
