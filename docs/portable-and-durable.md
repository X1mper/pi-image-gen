# Portable images and native Pi Durable

The existing root `generateImage(params, options)` and `/extension` remain desktop APIs.
They retain Node settings/auth discovery, all existing providers, filesystem security,
non-overwriting files, and optional sprites. No version or application migration is implied.

`/core` is the shared execution engine used by that desktop adapter and `/durable`.
Neither new entry imports the desktop entry. Common declarations do not import sprites.
`/durable` requires the optional `@earendil-works/pi-durable` peer **1.1.0** plus TypeBox;
install these in the host application, not in a browser. The native API is experimental.
Desktop-only users do not need the Durable runtime. Production dependency resolution
and the host's native SDK lock remain the host's responsibility.

## Trusted route and prepared request

```ts
import {
  catalogImageRoute, prepareImageRequest, canonicalizePreparedRequest,
  generateImageCore, ImageCoreError,
} from '@abhishek944/pi-image-gen/core';

const route = catalogImageRoute('openai/gpt-image-2.5-flare', trustedGatewayId);
const request = prepareImageRequest(modelArguments, frozenResponseDefaults, route);
const identityToHash = canonicalizePreparedRequest(request);
// Authorize/reserve/durably admit this exact identity BEFORE calling the engine.
const result = await generateImageCore(request, admittedHost);
```

The example variables are application-owned, not hidden package globals.
Flare and Sunburst use the genuine Cloudflare catalog IDs. This is not a subscription
login, provider fallback, new queue, separate execution service, or batch endpoint.
The catalog schema has one output and no `n` knob; independent native calls remain parallel.
The package sends `skipCache: true`, `collectLog: false`, `retries.maxAttempts: 1`,
`returnRawResponse: true` and the bounded signal. The host binding transport must forward
these options to `AI.run`; raw JSON responses are stream-bounded before parsing.
A binding that instead returns an already-parsed object owns that prior allocation.

Preparation copies/freezes args, trusted route and provenance. Supported explicit controls
win; omissions use the supplied frozen response defaults. Original identifiers retain
full URL and order. Canonical serialization excludes provider keys/headers, but contains
private prompt/original identifiers: hash it, do not log or persist it as extra plaintext.
No arbitrary endpoint, Gateway, provider, local path or credential is a model argument.
The native tool exposes prompt, ordered original URLs, size and quality only.
The generic core still supports the desktop controls through its provider host.

## Native admission

```ts
import { createImageExtension } from '@abhishek944/pi-image-gen/durable';
import { prepareImageRequest, canonicalizePreparedRequest } from '@abhishek944/pi-image-gen/core';

const images = createImageExtension({
  async runAdmittedCall(api, context, args, run) {
    const snapshot = await app.responseImageSnapshot(api, context);
    const prepared = prepareImageRequest(args, snapshot.defaults, snapshot.route);
    const admission = await app.admitImage({
      api, context, args, prepared,
      fingerprint: await app.hash(canonicalizePreparedRequest(prepared)),
    });
    if (admission.kind === 'existing') return admission.result;
    try {
      const result = await run(app.imageIO(admission), prepared);
      return await app.commitImageResult(admission, result);
    } catch (error) {
      return await app.commitImageFailure(admission, error);
    }
  },
});
registry.install(images);
```

`app.*` above is an integration outline of required application services, not package APIs
or a copyable authorization implementation. Admission must receive typed args AND the
canonical prepared request before dispatch. It owns same-account/chat authorization,
immutable response defaults, call identity, quota/storage/memory reservation, durable
attempt consumption, duplicate recovery and final accounting. Never implement it as an
opaque callback that generates first and inspects arguments later.

The actual export uses native `defineTool`/`defineExtension`, not a desktop-shaped shim.
It registers `image_generate`, `replay: 'unsafe'`, `executionMode: 'parallel'` and composes
native cancellation with the host signal. `run` accepts exactly the original explicit
arguments and a catalog route, can run once, and cannot be invoked after admission returns.
The host must await it. Progress is observational and cannot authorize billing.
No global tool serialization, app fan-out, image-count product limit or per-call permission
is introduced. The host returns compact private file links and one request metadata record,
never base64, original bytes, credentials, public original URLs or transient provider URLs.

## I/O, originals and resource ownership

`ImageHost` supplies actual original loading, output download policy, catalog binding
transport and idempotent storage. Storage receives original output bytes plus index,
bounded signal, actual batch total and validated descriptor. Commit a private durable
receipt before returning it. Keep edited outputs as new assets with exact original links.
An authenticated original loader must validate owner/chat/immutable identity BEFORE reading;
a provider-output loader must not inherit application cookies or authorization headers.
Reject unsafe/redirected private destinations according to the host's output policy.

No resizing/recompression occurs. MIME signatures/bytes and supported profile formats are
checked. Desktop ceilings remain 20 MiB per image, 128 MiB aggregate originals and 16
references; these are safety bounds, **not Cloudflare memory guarantees**. The host must
choose stricter `limits.referenceBytes` (aggregate), `imageBytes` (per image), and
`responseBytes` (catalog JSON envelope), preflight metadata and stream-bound its loaders
before allocation. Provider adapters retain their existing HTTP/body policies.
Native `AI.run` receives transient original bytes encoded in order, not public originals.
Base64/JSON copies and concurrent calls consume additional memory. Admission must budget
that aggregate; static compilation does not establish Workers heap safety.
No model can relax these limits. Oversized originals fail rather than silently shrinking.

## Failures and cost

`ImageCoreError` exposes phase, `outcome.dispatched`, provider-result `uncertain`, `partial`,
stored receipts and per-request metadata. `storageUncertain` separately means a store was
invoked without a confirmed receipt, even if its promise rejected: a write may have committed
before losing its acknowledgement. This is not a still-pending-promise flag. Reconcile the
host ledger; a known provider result does not become unknown merely because storage failed. Core never deletes receipts.
Desktop separately retains its legacy local partial-file cleanup and numeric result shape.
A host error not explicitly handled by admission becomes a body-free native error result.

There is one generation dispatch, with no automatic paid POST retry/replay. Native replay
is unsafe. Recover already-existing private results by bounded reads; after a dispatched
or uncertain failure, another paid attempt requires a new explicit user request. Cancellation
cannot promise a provider refund or force a transport to honor AbortSignal. Keep outputs
already durable through Stop/archive/sibling failure. Quota release/finalization is host-owned.

Metadata keeps bounded meaningful nested usage and ONE cost answer per request, not per image.
Each returned cost candidate is validated before fallback. Provider cost wins with supported
source/unit provenance; identifiers are bounded, not arbitrary URLs/userinfo. Explicit provider
or gateway estimates are not used as provider charges or fallback prices. Safe accounting survives
unusable-image errors without retaining the response body. Legacy desktop numeric cost/usage
stay numeric; additive `reportedUsage`, `tokenUsage` and `costDetails` preserve rich accounting,
and an estimate is never inserted into the old scalar cost field.

Core normalizes known API counters into disjoint `tokenUsage` buckets (`input`, `output`,
`cacheRead`, `cacheWrite`). Cached input is not billed twice. Raw nested counters are preserved
separately in `reportedUsage`. Unknown counter semantics or missing input/output totals leave
normalized usage unavailable. Optional `ImageHost.calculateCost` must bind the official
`pi-ai.calculateCost` to the exact admitted route's compatible Pi image-model catalog pricing:

```ts
calculateCost(tokens) {
  const usage = {
    ...tokens,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculatePiCost(compatiblePiModel, usage).total;
}
```

Here `calculatePiCost` is imported as `calculateCost` from `@earendil-works/pi-ai`, and
`compatiblePiModel` is host-resolved pricing for the exact route, not user-supplied rates or a
similarly named chat model. The host must verify its rates represent the complete request;
GPT Image's separate modality rates do not fit Pi's four-rate calculator. Desktop binds this
capability from modern Pi image-model registry lookups only when a trusted registry adapter
adds `costCompatibility: 'complete-four-bucket-token-pricing'` to the exact matching image
entry. That attestation means its Pi catalog rates cover the full request, including image
output, input modalities and caching; it must not be inferred from numeric validity, zero
rates or the mere presence of an image catalog entry. Stock Pi entries lack this assurance
and therefore do not enable desktop fallback by themselves. Durable forwards the admitted
host's callback under the same complete-pricing responsibility. Without compatible pricing or sufficient usage, cost is `unknown`, never a fabricated
zero. Calculator failures do not lose committed outputs. Computed prices are labeled
`estimated`, `completeness: 'complete'`, with source `pi-ai.calculateCost`. No local price table,
image dimension/quality formula, or gateway-estimate fallback is used. The callback must not
make network requests or perform generation; it calculates against already-resolved pricing.
Do not relabel Partial as total, multiply request cost by image count or inject estimates
as native text-model token usage.

## Verification and release

Use package typecheck/build/check and inspect emitted imports/Worker bundles/declarations.
Real provider, cancellation/crash, authorization, persistence and aggregate-memory checks
remain separate host acceptance work. No static check proves them. Do not replay a paid
attempt to verify recovery. Publish this same package through the owner's normal release;
applications must consume the actual published version, not a local link or invented pin.
