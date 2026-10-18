import {
  capabilitiesForApi, genericCapabilitiesForApi, hasAspectRatioKnob, validateImageCount,
} from '../capabilities.js';
import { resolveModel } from '../config.js';
import { ImageGenError } from '../errors.js';
import type { GenerateImageParams } from '../types.js';
import type { ProviderImageRoute } from '../core/protocol.js';
import type { GenerateImageOptions } from './options.js';

export function desktopRoute(params: GenerateImageParams, options: GenerateImageOptions): ProviderImageRoute {
  const configured: unknown = options.settings.defaultModel;
  const requested = typeof configured === 'string' ? configured.trim() : '';
  if (!requested) {
    throw new ImageGenError(
      'pi-image-gen.defaultModel is not set. Run /image-gen list, then /image-gen use <provider> <model> (for example, /image-gen use gemini-api nano-banana).',
      'defaultModel not set',
    );
  }
  const resolved = resolveModel(requested, options.settings);
  if ('error' in resolved) throw new ImageGenError(resolved.error, 'model did not resolve');
  validateImageCount(params);
  if (['ark', 'meta', 'mai'].includes(resolved.provider.api) && params.n != null && params.n !== 1) {
    throw new ImageGenError(`${resolved.requestedId} generates one image per request and does not accept n greater than 1.`,
      'n unsupported by provider API');
  }
  let capabilities = options.modelCapabilities ?? (resolved.capabilities
    ? capabilitiesForApi(resolved.capabilities, resolved.provider.api)
    : genericCapabilitiesForApi(resolved.provider.api));
  if (resolved.provider.api === 'gemini' && !hasAspectRatioKnob(capabilities)) {
    capabilities = { ...capabilities, aspectRatios: ['auto'] };
  }
  return { kind: 'provider', provider: resolved.provider, remoteModelId: resolved.remoteId,
    requestedId: resolved.requestedId, capabilities };
}

export function desktopTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1_000 && value <= 900_000
    ? value : 120_000;
}
