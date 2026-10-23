import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { Extension, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable';
import { Type } from 'typebox';
import { generateImageCore } from './core/engine.js';
import { combineSignals } from './core/deadline.js';
import { ImageGenError } from './core/errors.js';
import { ImageCoreError } from './core/outcome.js';
import type { ImageArgs, ImageCallResult, ImageHost, PreparedImageRequest } from './core/protocol.js';

const parameters = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
  image: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 8192 }), { minItems: 1, maxItems: 16 })),
  size: Type.Optional(Type.Union((['auto', '1024x1024', '1024x1536', '1536x1024'] as const).map((value) => Type.Literal(value)))),
  quality: Type.Optional(Type.Union((['auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map((value) => Type.Literal(value)))),
}, { additionalProperties: false });

export type DurableImageHost<Stored> = {
  /**
   * Authorize exact args, freeze response defaults/route, persist canonical identity,
   * reserve storage and durably consume admission BEFORE calling run. Await run.
   * Recover duplicates by reading existing receipts, never by calling run again.
   * Handle ImageCoreError here to persist accounting/partial receipts and return
   * compact private links. Never commit original/output bytes or credentials.
   */
  runAdmittedCall(
    api: Parameters<ToolRegistration['execute']>[1],
    context: Parameters<ToolRegistration['execute']>[2],
    args: Readonly<ImageArgs>,
    run: (host: ImageHost<Stored>, request: PreparedImageRequest) => Promise<ImageCallResult<Stored>>,
  ): Promise<ToolExecutionResult>;
};

/** Real native tool. No desktop tool signature, fan-out, job queue or replay-safe paid operation. */
export function createImageExtension<Stored>(host: DurableImageHost<Stored>): Extension {
  const tool = defineTool({
    name: 'image_generate',
    description: 'Generate one image, or edit using ordered original image URLs from this chat. '
      + 'Omitted controls use the response-frozen account preferences. Never choose a provider, path or credential. '
      + 'Use independent native calls for multiple requested images. After a dispatched or uncertain failure, '
      + 'do not repeat generation without a new explicit user request; retain already-saved images.',
    parameters,
    replay: 'unsafe',
    executionMode: 'parallel',
    async execute(args, api, context) {
      const supplied = structuredClone(args);
      if (supplied.image) Object.freeze(supplied.image);
      Object.freeze(supplied);
      let accepting = true;
      let used = false;
      let pending: Promise<ImageCallResult<Stored>> | undefined;
      try {
        let result: ToolExecutionResult;
        try {
          result = await host.runAdmittedCall(api, context, supplied, (scopedHost, request) => {
            if (!accepting || used) throw new ImageGenError('Image execution is one-shot.', 'image run already used or closed');
            used = true;
            if (request.route.kind !== 'catalog' || explicitIdentity(request.supplied) !== explicitIdentity(supplied)) {
              throw new ImageGenError('Admitted image arguments do not match this native call.', 'native admission mismatch');
            }
            const signal = combineSignals(scopedHost.signal, context.abortSignal);
            const cloudflareRun = scopedHost.cloudflareRun?.bind(scopedHost);
            pending = generateImageCore(request, {
              // Bind resource methods to their owner; spreading a class loses prototype/private state.
              loadOriginal: scopedHost.loadOriginal.bind(scopedHost),
              loadOutput: scopedHost.loadOutput.bind(scopedHost),
              store: scopedHost.store.bind(scopedHost),
              ...(cloudflareRun ? { cloudflareRun } : {}),
              ...(scopedHost.calculateCost ? { calculateCost: scopedHost.calculateCost.bind(scopedHost) } : {}),
              ...(scopedHost.timeoutMs !== undefined ? { timeoutMs: scopedHost.timeoutMs } : {}),
              ...(scopedHost.limits ? { limits: scopedHost.limits } : {}),
              ...(signal ? { signal } : {}),
              onProgress(phase) {
                try { void Promise.resolve(scopedHost.onProgress?.(phase)).catch(() => {}); }
                catch { /* Observation must not lose a paid result. */ }
                api.output(`${phase}\n`);
              },
            });
            return pending;
          });
        } finally {
          accepting = false;
        }
        // A faulty host must not publish a result while its launched operation is still running.
        await pending?.catch(() => {});
        return result;
      } catch (error) {
        accepting = false;
        await pending?.catch(() => {});
        // Host handles rich failures above; fallback never echoes foreign error bodies or signed URLs.
        const outcome = error instanceof ImageCoreError ? error.outcome : undefined;
        return {
          isError: true,
          content: [{ type: 'text', text: outcome && !outcome.dispatched
            ? 'Image generation did not reach the provider. Check references and image settings.'
            : 'Image generation could not be completed. Do not retry generation without a new explicit user request. Already-saved images remain available.' }],
          ...(outcome ? { details: { dispatched: outcome.dispatched, uncertain: outcome.uncertain,
            storageUncertain: outcome.storageUncertain, partial: outcome.partial } } : {}),
        };
      }
    },
  });
  return defineExtension({ name: 'image-generation', tools: [tool] });
}

function explicitIdentity(args: Readonly<ImageArgs>): string {
  return JSON.stringify(Object.entries(args).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
