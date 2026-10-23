import type { ResolvedProvider } from '../types/provider.js';
import { ImageGenError, providerLogLabel } from './errors.js';

/**
 * Settings path where the user should fix the apiKey: the env var for built-ins,
 * the JSON path for customProviders. Also used to name the key in HTTP-401 hints.
 */
export function providerLocator(provider: ResolvedProvider): string {
  if (provider.builtIn) {
    if (provider.id === 'meta') {
      const apiKeyOptions = 'the META_API_KEY env var or pi-image-gen.providers.meta.apiKey in settings.json (legacy MODEL_API_KEY is also accepted)';
      if (provider.authMode === 'oauth') return '`/login meta`';
      return metaSupportsPiLogin(provider) ? `\`/login meta\`, ${apiKeyOptions}` : apiKeyOptions;
    }
    const envVar = BUILT_IN_ENV_VAR[provider.id] ?? `${provider.id.toUpperCase()}_API_KEY`;
    return `the ${envVar} env var (or pi-image-gen.providers.${provider.id}.apiKey in settings.json)`;
  }
  return `pi-image-gen.customProviders.${provider.id}.apiKey in settings.json`;
}

export function metaSupportsPiLogin(provider: ResolvedProvider): boolean {
  if (!provider.builtIn || provider.id !== 'meta' || provider.authMode === 'api-key') return false;
  try {
    const trimmed = provider.baseUrl.replace(/\/+$/, '');
    const url = new URL(trimmed);
    const path = url.pathname === '' || url.pathname === '/' ? '/v1' : url.pathname;
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.meta.ai' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      path === '/v1' &&
      (url.pathname === '/' || url.pathname === '' || (url.search === '' && url.hash === ''))
    );
  } catch {
    return false;
  }
}

export function providerBaseUrlLocator(provider: ResolvedProvider): string {
  if (provider.builtIn) {
    return `pi-image-gen.providers.${provider.id}.baseUrl`;
  }
  return `pi-image-gen.customProviders.${provider.id}.baseUrl`;
}

const BUILT_IN_ENV_VAR: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ark: 'ARK_API_KEY',
  meta: 'META_API_KEY',
  mai: 'AZURE_MAI_API_KEY',
};

/** Missing-API-key error naming the exact env var / settings path to fix. */
export function missingKeyError(provider: ResolvedProvider): ImageGenError {
  const credential = metaSupportsPiLogin(provider) ? 'usable credential' : 'API key';
  return new ImageGenError(
    `Provider "${provider.id}" has no ${credential}. Tell the user to set ${providerLocator(provider)}.`,
    `${providerLogLabel(provider)} missing ${credential}`,
    'missing-credentials',
  );
}
