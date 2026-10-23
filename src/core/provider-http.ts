import type { ResolvedProvider } from '../types/provider.js';
import { cancelResponseBody, ImageGenError, providerLogLabel } from './errors.js';
import { metaSupportsPiLogin, providerBaseUrlLocator, providerLocator } from './provider-hints.js';

/** Short, body-free category label for an HTTP status. */
function httpCategory(status: number): string {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  if (status >= 500 && status < 600) return 'server-error';
  if (status === 400 || status === 422) return 'bad-request';
  return 'http-error';
}

/**
 * Actionable, body-free error for a provider HTTP failure. The raw response body
 * (which can echo the prompt, credentials, a signed URL, or another tenant's
 * data) is never interpolated — only status + category leave this module.
 */
export function classifyHttpError(res: Response, provider: ResolvedProvider): ImageGenError {
  const where = providerLocator(provider);
  const summary = `${providerLogLabel(provider)} HTTP ${res.status} (${httpCategory(res.status)})`;
  // 403 may be a policy refusal; 5xx may follow upstream acceptance. Neither
  // is evidence that another paid generation is safe.
  const fallbackReason = res.status === 401 ? 'auth'
    : res.status === 404 ? 'not-found'
    : res.status === 429 ? 'rate-limit' : undefined;
  const err = (message: string) => new ImageGenError(message, summary, fallbackReason);

  if (res.status === 401 || res.status === 403) {
    const credential = metaSupportsPiLogin(provider) ? 'credential' : 'API key';
    return err(
      `${provider.name} rejected the ${credential} (HTTP ${res.status}). Tell the user to verify ${where}. Do not retry — this will keep failing until the credential is fixed.`,
    );
  }
  if (res.status === 404) {
    return err(
      `${provider.name} returned 404 at this baseUrl. Tell the user to verify ${providerBaseUrlLocator(provider)} — the model id may be wrong, or this gateway doesn't expose the image API.`,
    );
  }
  if (res.status === 429) {
    return err(
      `${provider.name} rate-limited the request (HTTP 429). Wait a few seconds before retrying, or suggest a different provider/model.`,
    );
  }
  if (res.status >= 500 && res.status < 600) {
    return err(
      `${provider.name} had a server-side failure (HTTP ${res.status}). This is likely transient — one retry is reasonable, but if it keeps failing tell the user the provider is down.`,
    );
  }
  if (res.status === 400 || res.status === 422) {
    return err(
      `${provider.name} rejected the request (HTTP ${res.status}) — likely a bad parameter or unsupported model id. Tell the user the model name or size may not be supported by this provider.`,
    );
  }
  return err(`${provider.name} returned HTTP ${res.status}.`);
}

/** Release an unread HTTP error body, then throw its body-free classification. */
export async function throwHttpError(res: Response, provider: ResolvedProvider): Promise<never> {
  const error = classifyHttpError(res, provider);
  await cancelResponseBody(res);
  throw error;
}
