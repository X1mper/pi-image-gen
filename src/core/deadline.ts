import { cancelledError, ImageGenError } from './errors.js';

export function executionDeadline(parent?: AbortSignal, timeoutMs = 120_000): {
  signal: AbortSignal; timedOut(): boolean; cleanup(): void;
} {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new ImageGenError('Image timeout must be between 1000 and 900000 milliseconds.', 'invalid image timeout');
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => { clearTimeout(timer); parent?.removeEventListener('abort', onAbort); },
  };
}

/** Bound waiting even when a foreign host/adapter does not honor cancellation. */
export function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(cancelledError('image generation'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancelledError('image generation'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return active.length ? AbortSignal.any(active) : undefined;
}
