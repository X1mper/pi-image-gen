import type { ResolvedProvider } from '../types.js';

export function hasProviderAuthentication(provider: ResolvedProvider): boolean {
  return provider.customAuth?.type === 'none' || Boolean(provider.apiKey);
}

export function credentialRedirectMode(provider: ResolvedProvider): 'error' | 'follow' {
  return provider.customAuth?.type === 'header' ||
      (provider.api === 'gemini' && (provider.builtIn || provider.customAuth == null)) ||
      Object.keys(provider.headers ?? {}).length > 0
    ? 'error'
    : 'follow';
}

export function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
  headers[name] = value;
}

export function bearerHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  if (provider.customAuth?.type === 'none') return headers;
  if (provider.customAuth?.type === 'header') {
    if (provider.apiKey) setHeaderCaseInsensitive(headers, provider.customAuth.header, provider.apiKey);
    return headers;
  }
  if (provider.customAuth == null) {
    const legacyAuthorization = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() === 'authorization')
      .at(-1)?.[1];
    if (legacyAuthorization != null) {
      setHeaderCaseInsensitive(headers, 'authorization', legacyAuthorization);
      return headers;
    }
  }
  if (provider.apiKey) setHeaderCaseInsensitive(headers, 'authorization', `Bearer ${provider.apiKey}`);
  return headers;
}

export function jsonHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers = bearerHeaders(provider);
  setHeaderCaseInsensitive(headers, 'content-type', 'application/json');
  return headers;
}
