import { genericCapabilitiesForApi, SIZE_PIXEL_RE, validateGenerateParams } from '../capabilities.js';
import { describeNetworkError, ImageGenError, missingKeyError } from '../errors.js';
import type { ImageProviderAdapter, ResolvedProvider } from '../types.js';
import { withDefaultPath } from '../url.js';
import {
  bearerHeaders,
  hasProviderAuthentication,
  parseImagesResponse,
  setHeaderCaseInsensitive,
} from './openai.js';

/** Azure MAI uses a resource-specific endpoint and deployment name as `model`. */
export const maiAdapter: ImageProviderAdapter = {
  async generate(provider, remoteModelId, params, fetchImpl, signal, inputs) {
    const base = maiBaseUrl(provider);
    if (!hasProviderAuthentication(provider)) throw missingKeyError(provider);
    // Even an explicitly supplied custom capability contract cannot make this
    // wire format carry unsupported controls (quality, n > 1, masks, etc.).
    validateGenerateParams(params, genericCapabilitiesForApi('mai'), remoteModelId);
    for (const control of ['quality', 'aspectRatio', 'imageSize'] as const) {
      if (params[control] !== undefined) {
        throw new ImageGenError(
          `Microsoft MAI does not support ${control}. Omit it from the request.`,
          `MAI ${control} unsupported`,
        );
      }
    }

    const editing = Boolean(inputs?.length);
    if (editing && params.size !== undefined) {
      throw new ImageGenError(
        'Microsoft MAI edits do not support size. Omit size when passing reference images.',
        'MAI edit size unsupported',
      );
    }
    const headers = bearerHeaders({
      ...provider,
      // Custom gateways can explicitly opt into bearer or no authentication.
      // Azure's built-in route always sends the resource key as api-key.
      customAuth: provider.builtIn
        ? { type: 'header', header: 'api-key' }
        : provider.customAuth ?? { type: 'header', header: 'api-key' },
    });
    let body: string | FormData;
    if (editing) {
      const form = new FormData();
      form.append('model', remoteModelId);
      form.append('prompt', params.prompt);
      for (const [index, input] of inputs!.entries()) {
        if (input.mimeType !== 'image/png' && input.mimeType !== 'image/jpeg') {
          throw new ImageGenError(
            'Microsoft MAI reference images must be PNG or JPEG.',
            'MAI reference format unsupported',
          );
        }
        form.append(
          'image',
          new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }),
          `image-${index}.${input.mimeType === 'image/png' ? 'png' : 'jpg'}`,
        );
      }
      // Let fetch attach the multipart boundary, even with custom headers.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'content-type') delete headers[name];
      }
      body = form;
    } else {
      const payload: Record<string, unknown> = { model: remoteModelId, prompt: params.prompt };
      if (params.size !== undefined) {
        const match = SIZE_PIXEL_RE.exec(params.size);
        if (!match) {
          throw new ImageGenError(
            'Microsoft MAI size must be a pixel size such as "1024x1024". Omit size for the model default.',
            'MAI size invalid',
          );
        }
        payload.width = Number(match[1]);
        payload.height = Number(match[2]);
      }
      setHeaderCaseInsensitive(headers, 'content-type', 'application/json');
      body = JSON.stringify(payload);
    }
    const url = `${base}/images/${editing ? 'edits' : 'generations'}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: signal ?? null,
        // Never forward Azure's named credential header through redirects.
        redirect: 'error',
      });
    } catch (error) {
      throw describeNetworkError(error, provider);
    }
    return parseImagesResponse(response, url, provider);
  },
};

function maiBaseUrl(provider: ResolvedProvider): string {
  try {
    const url = new URL(provider.baseUrl);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username || url.password || url.search || url.hash ||
      /\/images\/(generations|edits)\/?$/.test(url.pathname)
    ) throw new Error('invalid endpoint');
    return withDefaultPath(provider.baseUrl, '/mai/v1');
  } catch {
    const setting = provider.builtIn
      ? 'pi-image-gen.providers.mai.baseUrl'
      : 'the custom MAI provider baseUrl';
    throw new ImageGenError(
      `Set ${setting} to your Azure resource endpoint, such as https://<resource>.services.ai.azure.com/mai/v1, without query parameters or an images endpoint suffix.`,
      'MAI baseUrl missing or invalid',
    );
  }
}
