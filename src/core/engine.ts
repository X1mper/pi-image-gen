import type { RawImageResult } from '../types/provider.js';
import { MAX_GENERATED_IMAGES } from '../image-input.js';
import { MAX_CATALOG_RESPONSE_BYTES, runCatalog } from './catalog.js';
import { ProviderResultError } from './provider-result.js';
import { awaitWithAbort, executionDeadline } from './deadline.js';
import { readImageDimensions } from './dimensions.js';
import { cancelledError, ImageGenError } from './errors.js';
import { byteLimit, loadReferences, materializeOutput } from './materialize.js';
import { buildMetadata } from './metadata.js';
import { ImageCoreError } from './outcome.js';
import type { ImageCallResult, ImageHost, ImageOutputDescriptor, Phase, PreparedImageRequest } from './protocol.js';

/**
 * Shared execution for catalog and desktop adapters. Host authorization/admission
 * precedes this call. No retries, global queue, response-count cap or receipt rollback.
 */
export async function generateImageCore<Stored>(
  request: PreparedImageRequest,
  host: ImageHost<Stored>,
): Promise<ImageCallResult<Stored>> {
  const startedAt = Date.now();
  const stored: Stored[] = [];
  const outputs: ImageOutputDescriptor[] = [];
  let raws: RawImageResult[] = [];
  let dispatched = false;
  let confirmed = false;
  let storageUnconfirmed = false;
  let phase: ImageCoreError['phase'] = 'pre-dispatch';
  let deadline: ReturnType<typeof executionDeadline> | undefined;
  let signal = host.signal;
  try {
    deadline = executionDeadline(host.signal, host.timeoutMs);
    signal = deadline.signal;
    if (signal.aborted) throw cancelledError('image generation');
    if (request.route.kind === 'catalog') byteLimit(host.limits?.responseBytes, MAX_CATALOG_RESPONSE_BYTES);
    if (request.route.kind === 'catalog' ? !host.cloudflareRun : !host.adapter) {
      throw new ImageGenError('The trusted image transport is not configured.', 'image transport missing');
    }
    progress(host, 'loading-inputs');
    const { images, mask } = await loadReferences(request, host, signal);
    if (signal.aborted) throw cancelledError('image generation');
    progress(host, 'waiting-provider');
    const markDispatched = () => { dispatched = true; phase = 'dispatched'; };
    if (request.route.kind === 'catalog') {
      raws = await awaitWithAbort(runCatalog(request, images, host, signal, markDispatched), signal);
    } else {
      // Legacy adapters retain their own auth/upload/read protocols. Entry is conservatively dispatched.
      markDispatched();
      const params = { ...request.effective,
        ...(request.effective.image ? { image: [...request.effective.image] } : {}) };
      raws = await awaitWithAbort(host.adapter!.generate(
        request.route.provider, request.route.remoteModelId, params,
        host.providerFetch ?? fetch, signal, images,
        { ...host.providerRuntime, ...(mask ? { mask } : {}) },
      ), signal);
    }
    if (!Array.isArray(raws) || !raws.length || raws.length > MAX_GENERATED_IMAGES) {
      throw new ImageGenError('Provider returned no usable image batch.', 'invalid image batch');
    }
    confirmed = true;
    phase = 'materializing';
    progress(host, 'saving-output');
    for (let index = 0; index < raws.length; index++) {
      if (signal.aborted) throw cancelledError('image generation');
      const raw = raws[index]!;
      const output = await materializeOutput(raw, host, signal, request.route.kind === 'catalog');
      const dimensions = readImageDimensions(output.bytes, output.mimeType);
      outputs.push({ index, mimeType: output.mimeType, bytes: output.bytes.byteLength,
        ...(dimensions ? dimensions : {}),
        ...(typeof raw.revisedPrompt === 'string' ? { revisedPrompt: raw.revisedPrompt } : {}) });
      if (signal.aborted) throw cancelledError('image generation');
      storageUnconfirmed = true;
      // A rejection can follow a real commit. Only its receipt confirms storage to this call.
      const saving = host.store(output, index, {
        signal, total: raws.length, descriptor: outputs[index]!,
      }).then((receipt) => { stored.push(receipt); storageUnconfirmed = false; return receipt; });
      await awaitWithAbort(saving, signal);
    }
    return { images: [...stored], metadata: await buildMetadata(request, raws, outputs, startedAt,
      undefined, host.calculateCost?.bind(host)) };
  } catch (error) {
    const safe = error instanceof ImageGenError ? error : undefined;
    const timedOut = deadline?.timedOut() ?? false;
    const message = timedOut ? 'Image generation exceeded its execution deadline.'
      : safe?.message ?? 'Image generation could not be completed.';
    const metadata = await buildMetadata(request, raws, outputs, startedAt,
      error instanceof ProviderResultError ? error.metadata : undefined, host.calculateCost?.bind(host));
    const summary = timedOut ? 'image generation timed out' : safe?.logSummary ?? 'image execution failed';
    throw new ImageCoreError(message, summary, phase, {
      dispatched, uncertain: dispatched && !confirmed,
      storageUncertain: storageUnconfirmed,
      partial: stored.length > 0, stored: [...stored],
    }, metadata, !timedOut && !signal?.aborted && dispatched && !confirmed
      ? safe?.fallbackReason : undefined);
  } finally {
    deadline?.cleanup();
  }
}

function progress<Stored>(host: ImageHost<Stored>, phase: Phase): void {
  try { void Promise.resolve(host.onProgress?.(phase)).catch(() => {}); }
  catch { /* Progress is observational, not authority to lose a paid result. */ }
}
