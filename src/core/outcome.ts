import { ImageGenError } from './errors.js';
import type { ImageDispatchOutcome, ImageMetadata } from './protocol.js';

/** Body-free failure with committed receipts; caller must reconcile, never replay a paid attempt. */
export class ImageCoreError extends ImageGenError {
  readonly outcome: ImageDispatchOutcome;
  constructor(
    message: string,
    summary: string,
    readonly phase: 'pre-dispatch' | 'dispatched' | 'materializing',
    outcome: ImageDispatchOutcome,
    readonly metadata: ImageMetadata,
  ) {
    super(message, summary);
    this.name = 'ImageCoreError';
    this.outcome = Object.freeze({ ...outcome, stored: Object.freeze([...outcome.stored]) });
  }
}
