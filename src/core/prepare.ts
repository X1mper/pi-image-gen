import { validateGenerateParams } from '../capabilities.js';
import { assertMember, DEFAULT_KEYS, validateArguments } from './arg-validation.js';
import type {
  ControlSources, ImageArgs, ImageDefaults, OriginalReference,
  PreparedImageRequest, ResolvedImageRoute,
} from './protocol.js';

/** Prepare immutable controls against one trusted route and response snapshot, before admission. */
export function prepareImageRequest(
  args: ImageArgs,
  defaults: ImageDefaults,
  route: ResolvedImageRoute,
): PreparedImageRequest {
  const record = validateArguments(args, defaults, route);
  const supplied: Record<string, unknown> = { prompt: record.prompt };
  const effective: Record<string, unknown> = { prompt: record.prompt };
  const controlSources: ControlSources = { prompt: 'explicit' };
  for (const key of ['image', 'mask', 'filename', ...DEFAULT_KEYS] as const) {
    if (record[key] !== undefined) {
      const value = Array.isArray(record[key]) ? Object.freeze([...record[key]]) : record[key];
      supplied[key] = value;
      effective[key] = value;
      controlSources[key] = 'explicit';
    } else if (defaults[key as keyof ImageDefaults] !== undefined) {
      effective[key] = defaults[key as keyof ImageDefaults];
      controlSources[key] = 'response-default';
    }
  }
  const snapshot = freezeRoute(route);
  const model = snapshot.kind === 'catalog' ? snapshot.model : snapshot.requestedId;
  validateGenerateParams(effective as ImageArgs, snapshot.capabilities, model);
  if (snapshot.kind === 'catalog') {
    assertMember('size', effective.size, snapshot.capabilities.sizes);
    assertMember('quality', effective.quality, snapshot.capabilities.qualityValues);
  }
  const references: OriginalReference[] = ((effective.image as readonly string[] | undefined) ?? [])
    .map((url, index) => Object.freeze({ url, role: 'image' as const, index }));
  if (typeof effective.mask === 'string') {
    references.push(Object.freeze({ url: effective.mask, role: 'mask', index: 0 }));
  }
  return Object.freeze({
    route: snapshot,
    supplied: Object.freeze(supplied as ImageArgs),
    effective: Object.freeze(effective as ImageArgs),
    controlSources: Object.freeze(controlSources),
    references: Object.freeze(references),
  });
}

/**
 * Stable logical identity without provider credentials/headers. Hash before storing:
 * prompt and original identifiers are private. Never serialize the entire prepared route.
 */
export function canonicalizePreparedRequest(request: PreparedImageRequest): string {
  const route = request.route;
  const identity = route.kind === 'catalog'
    ? { kind: route.kind, model: route.model, gatewayId: route.gatewayId }
    : { kind: route.kind, providerId: route.provider.id, api: route.provider.api,
        remoteModelId: route.remoteModelId, requestedId: route.requestedId };
  return JSON.stringify({
    route: identity,
    effective: sortedEntries(request.effective),
    supplied: sortedEntries(request.supplied),
    controlSources: sortedEntries(request.controlSources),
    references: request.references.map(({ role, url }) => ({ role, url })),
  });
}

function sortedEntries(value: object): Array<[string, unknown]> {
  return Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function freezeRoute(route: ResolvedImageRoute): ResolvedImageRoute {
  const copy = structuredClone(route);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
}
