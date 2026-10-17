import { ImageGenError } from '../errors.js';
import type { ResolvedProvider } from '../types.js';

/** Keep Azure's resource key and endpoint separate from public OpenAI billing. */
export function configureAzureOpenAiProvider(provider: ResolvedProvider): ResolvedProvider {
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid endpoint');
    }
    const path = url.pathname.replace(/\/images\/(generations|edits)\/?$/, '').replace(/\/+$/, '');
    if (path !== '' && path !== '/openai/v1') throw new Error('invalid endpoint path');
    url.pathname = '/openai/v1';
    return {
      ...provider,
      baseUrl: url.toString().replace(/\/+$/, ''),
      customAuth: { type: 'header', header: 'api-key' },
    };
  } catch {
    throw new ImageGenError(
      'Set pi-image-gen.providers.azure-openai.baseUrl (or AZURE_OPENAI_ENDPOINT) to your HTTPS Azure resource endpoint or /openai/v1 base URL, without query parameters. Legacy /openai/deployments URLs are not supported by this v1 route.',
      'Azure OpenAI baseUrl missing or invalid',
    );
  }
}

export function openAiImageUrl(provider: ResolvedProvider, base: string, operation: 'generations' | 'edits'): string {
  const url = `${base}/images/${operation}`;
  // Microsoft documents both image operations under the v1 preview API.
  return provider.builtIn && provider.id === 'azure-openai' ? `${url}?api-version=preview` : url;
}
