import type { ResolvedProvider } from '../types/provider.js';
import { cancelResponseBody, ImageGenError, isAbortError, providerLogLabel, redactUrl } from './errors.js';
import { providerBaseUrlLocator } from './provider-hints.js';
import { readResponseBytes } from './response.js';

/** Short, body-free category label for a non-HTTP (network/parse) error. */
function networkCategory(error: unknown): string {
  if (isAbortError(error)) return 'cancelled';
  const msg = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return 'timeout';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET/i.test(msg)) return 'unreachable';
  return 'network-error';
}

/**
 * Actionable, body-free error for a non-HTTP failure (timeout / DNS / abort).
 * The underlying message is used ONLY to classify the failure — it can carry the
 * full request URL (incl. a signed `?token=…`) or host internals, so it is never
 * reproduced. Only the provider name + derived category leave this module.
 */
export function describeNetworkError(error: unknown, provider: ResolvedProvider): ImageGenError {
  const category = networkCategory(error);
  const summary = `${providerLogLabel(provider)} request failed (${category})`;
  const err = (message: string) => new ImageGenError(message, summary);
  if (category === 'cancelled') {
    return err(`Request to ${provider.name} was cancelled.`);
  }
  if (category === 'timeout') {
    return err(
      `Request to ${provider.name} timed out. The provider was too slow — try a smaller \`n\`, a different model, or check ${providerBaseUrlLocator(provider)}.`,
    );
  }
  if (category === 'unreachable') {
    return err(
      `Cannot reach ${provider.name}. Tell the user to check network connectivity or verify ${providerBaseUrlLocator(provider)}.`,
    );
  }
  return err(`${provider.name} request failed because of a network error.`);
}

/** Read a successful provider body, converting mid-stream failures without echoing raw text. */
export async function readBodyText(res: Response, provider: ResolvedProvider): Promise<string> {
  try {
    if (!res.body) return await res.text();
    return new TextDecoder().decode(await readResponseBytes(res, 128 * 1024 * 1024));
  } catch (error) {
    if (error instanceof Error && /size ceiling/i.test(error.message)) {
      throw new ImageGenError(
        `${provider.name} returned a response that exceeds the size ceiling.`,
        `${providerLogLabel(provider)} response too large`,
      );
    }
    throw describeNetworkError(error, provider);
  }
}

/**
 * Body-free error for a failed image download (a caller-supplied URL or the
 * provider CDN URL, either of which may embed a signed `?token=…`). The URL is
 * always redacted and no raw fetch text / HTTP body is interpolated. `what` is a
 * fixed caller label. Pass `{ httpStatus }` for a non-OK response, or
 * `{ rejected }` with the raw thrown value for a fetch rejection (classify only).
 */
export function describeDownloadError(
  what: string,
  url: string,
  cause: { httpStatus: number } | { rejected: unknown },
): ImageGenError {
  const where = redactUrl(url);
  if ('httpStatus' in cause) {
    return new ImageGenError(
      `Failed to download ${what} from ${where} (HTTP ${cause.httpStatus}). Tell the user to verify the URL is reachable.`,
      `${what} download failed (HTTP ${cause.httpStatus})`,
    );
  }
  const category = networkCategory(cause.rejected);
  return new ImageGenError(
    category === 'cancelled'
      ? `Downloading ${what} from ${where} was cancelled.`
      : `Could not reach ${where} to download ${what}. Tell the user to verify the URL is reachable.`,
    `${what} download failed (${category})`,
  );
}

/** Release an unread download error body, then throw its body-free classification. */
export async function throwDownloadHttpError(
  what: string,
  url: string,
  res: Response,
): Promise<never> {
  const error = describeDownloadError(what, url, { httpStatus: res.status });
  await cancelResponseBody(res);
  throw error;
}
