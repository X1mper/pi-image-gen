---
name: image-gen
description: "Generate or edit raster images with the image_generate tool: photos, illustrations, textures, sprites, product/UI mockups, concept art, icons, logos, diagrams, or image-to-image edits. For assets that could be repo-native SVG/vector/CSS/canvas, treat that format as a preference when editability or exact integration matters—not as a prohibition on image generation."
---

# Image generation

This skill guides `image_generate` and explicit `image_compare` requests from `@abhishek944/pi-image-gen`. The primary pair is configured by `pi-image-gen.default: { provider, model }` (legacy `defaultProvider`/`defaultModel` also work). Neither tool accepts arbitrary model/provider arguments. Run `/image-gen list` to see the default, configured fallback/comparison pairs and available authentication routes; use `/image-gen use <provider> <model>` to update the default and refresh the schema. Current config schema is `version: 2` inside `pi-image-gen` (not the package version). Legacy settings remain readable. For an explicit migration request, preview with `/image-gen migrate --dry-run`, then apply `/image-gen migrate`; `--scope global|agent|project|all` selects files. Migration preserves raw scopes/placeholders, backs up changed files, removes obsolete default keys and refuses ambiguous or unsupported configurations. Do not run migration merely to generate an image or downgrade a future config version.

## When to use

- A brand-new bitmap image: concept art, product shot, cover, website hero, texture, sprite.
- A new image guided by one or more reference images (style, composition, mood, subject).
- Editing an existing image: inpainting, background replacement, object removal, lighting or weather changes, compositing, style transfer, character preservation.
- Several assets or variants for one task.

## Choosing image generation vs repo-native assets

Repo-native SVG/vector/CSS/canvas is a preference in the cases below, not a hard restriction. If the user asks to generate an icon, logo, diagram, or UI graphic as an image, use `image_generate`.

Prefer editing or writing the native source when:

- Extending or matching an existing SVG/vector icon set, logo system, or illustration library in the repo.
- The asset is a simple shape, diagram, wireframe, or icon and deterministic, editable code-native output matters.
- The source already exists in an editable native format and only needs a small project-local change.
- The user clearly wants deterministic code-native output rather than a generated bitmap.

## Two questions before every call

1. **Intent — generate or edit?**
   - No `image`, or `image` entries used only as style/composition/mood references → **generate**.
   - Modify an existing image while preserving most of it → **edit** (pass that image).
   - When unsure, assume the user wants a new image unless they clearly ask to change an existing one.
2. **Strategy — one asset or many?**
   - `n` produces **variants of ONE prompt**, not distinct assets.
   - For several *different* assets, make **one `image_generate` call per asset**, each with its own prompt. Do not raise `n` to cover distinct subjects.

## Fallback and explicit comparison

- Ordinary generation uses `image_generate`. Configured `fallback` routes are tried in order only for a missing/unusable credential before generation or explicit generation HTTP 401/404/429. Do not automatically repeat a failed request after timeout, network loss, cancellation, policy refusal or output/storage failure; the provider may already have consumed quota.
- Use `image_compare` only when the user explicitly asks to compare image models. It runs exactly the configured `compare` list, each entry may incur charges, and it neither changes the default nor substitutes fallback models. If the list is empty, ask the user to configure it; do not rewrite settings or invent targets.
- Comparison takes the same `prompt` and optional `image` references, `filename`, and `outputDir`, using each model's native defaults. Report each labeled success/failure and its own cost when known. Different models may return different dimensions. Never turn an ordinary image request into a comparison.
- Explicit controls are never silently dropped for fallback compatibility. If a fallback cannot honor a mask, size or other supplied control, explain the incompatibility rather than stripping it and generating again.
- Native previews are display copies. Use saved originals for edits and exact-pixel inspection.

## Prompt structure

Order the prompt as: **scene/backdrop → subject → key details → constraints → intended use.** For complex requests, use short labeled lines instead of one long paragraph:

```text
Use case: <e.g. product-mockup, ui-mockup, illustration, photorealistic, concept-art>
Asset type: <where the asset will be used>
Primary request: <the main ask>
Input images: <Image 1: role; Image 2: role>   (only when passing `image`)
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo / illustration / 3D / etc.>
Composition/framing: <wide / close / top-down; placement; negative space if needed>
Lighting/mood: <lighting + mood>
Color palette: <palette notes>
Text (verbatim): "<exact text>"
Constraints: <must keep / must avoid>
```

## Specificity policy

- If the user's prompt is already **specific and detailed**, normalize it into a clean spec — do not add creative requirements it didn't ask for.
- If the prompt is **generic**, add tasteful detail only when it materially improves output.

Allowed augmentation: composition/framing cues, polish-level or intended-use hints, practical layout guidance, reasonable scene concreteness. Do **not** add: extra characters/props not implied, brand palettes/slogans/story beats not implied, or arbitrary left/right placement the layout doesn't support.

## Text inside images

- Put literal text in quotes or ALL CAPS; specify typography (style, size, color, placement).
- Spell uncommon words letter-by-letter when accuracy matters; require verbatim rendering.
- Where the model exposes a quality knob, use a higher `quality` for small text, dense infographics, legends, axes, and multi-font layouts.

## Editing and multi-image conditioning

- Label every input image by index and role: `Image 1: edit target`, `Image 2: style reference`. Do not assume every provided image is an edit target.
- For edits, state invariants explicitly — `change only X; keep Y unchanged` — and **repeat them on every iteration** to reduce drift.
- For compositing, describe how images interact: `place the subject from Image 2 into Image 1; match lighting, perspective, and scale`.
- To iterate on a previous result, pass its saved file path back as `image`.
- Reference images must be a **file path** (absolute or relative to cwd) or an **http(s) URL**. Base64 and `data:` URIs are rejected — write bytes to a file first.

## Iterate deliberately

Start from a clean base prompt, then make **one targeted change at a time** and re-check subject, style, composition, text accuracy, and invariants. Prefer a single focused follow-up over rewriting the whole prompt.

## Parameters

- `prompt` (required) — what to draw or how to edit.
- Meta Muse Image authentication — use the explicit `meta-subscription` route after `/login meta` from `pi-meta-oauth`, or `meta-api` with `META_API_KEY` (`MODEL_API_KEY` remains a legacy fallback). In a legacy model-only config, an active login takes precedence. An individual route never silently swaps authentication; only explicitly configured fallback pairs can authorize another route. Custom or overridden endpoints never receive the Pi login credential.
- Azure OpenAI — select `azure-openai-api` with the Azure image deployment name. Configure `providers.azure-openai.baseUrl` as the resource root or `/openai/v1` (local `AZURE_OPENAI_ENDPOINT` is the fallback). Credentials come from `providers.azure-openai.apiKey` first, then `AZURE_OPENAI_API_KEY`; no public OpenAI key or Pi login fallback is used. The route shares OpenAI generation/edit controls with PNG/JPEG output (not WebP), uses the Azure `api-key` header and v1 preview endpoints, and rejects credential redirects. Arbitrary deployment names receive common GPT Image control advice; catalog-named deployments receive model-specific profiles.
- Microsoft MAI (Azure) — select `mai-api` with the Azure deployment name. Configure `providers.mai.baseUrl` as the resource root or `/mai/v1`. Credentials come from `providers.mai.apiKey` first, then local `AZURE_MAI_API_KEY`; no Pi login is used. Current documented MAI 2.5/2.6 deployments support up to five PNG/JPEG edit inputs and return PNG. Omit `size` with references: MAI edits have no size control. Generation dimensions must each be at least 768; total pixels are capped at 1,048,576 for 2.5 and 2,359,296 for 2.6. Arbitrary deployment names do not identify their version; let Azure validate limits. Do not request quality, transparent background, masks, or multiple variants; PNG does not imply alpha support.
- `image` — array of reference/target image paths or URLs. Extension-wide safety ceilings are 16 images, 20MB per input, and 128MB combined; providers may be stricter.
- `n` — model-specific variants of one prompt (default 1; universal extension maximum 10, with the schema description naming any lower active ceiling, such as 6 for Qwen). It is hidden for models such as Seedream, Meta Muse Image, and Microsoft MAI that return one image per request; direct calls requesting more than one are rejected.
- `resize` — optional `{ width, height, fit?: "contain" | "cover" }` for exact local output dimensions, separate from provider size controls. Dimensions are 1–8192, at most 40 million pixels. Still JPEG/PNG/WebP inputs produce a PNG copy. `contain` (default) pads transparently without cropping; `cover` explicitly crops. The original stays at `originalPath`. If `resizeError` is present, report the failure and saved original; never regenerate paid output automatically. This option is on `image_generate`, not `image_compare` or portable/Durable APIs.
- `size` — e.g. `"1024x1024"`. Provider-specific; some models require a minimum (Seedream ≥ 4.5 needs 2K+, so `1024x1024` fails there). Meta Muse Image accepts a free-form size; official cookbook examples include `1024x1024`, `1536x1024`, and `1024x1536`.
- `quality` — model-specific. GPT Image 2 and the verified Codex route expose `"low"` / `"medium"` / `"high"` / `"auto"`; OpenAI API models `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst` also expose `"xhigh"` and `"max"`. This parameter is **provider-conditional**: it exists in the tool schema for a built-in gpt-image route, including Azure OpenAI image deployments. It is absent for Gemini, DashScope/Qwen, Ark/Seedream, Meta Muse Image, Microsoft MAI, non-gpt-image routes, and custom providers unless their model explicitly declares `capabilities.qualityValues` on an adapter that forwards quality. If you don't see `quality`, do not try to force it.
- `outputFormat`, `background`, `outputCompression` — model-aware web-asset controls for verified OpenAI API and discovered OpenRouter routes. Transparent output requires PNG or WebP; compression is for JPEG/WebP.
- `mask` — precise edit mask for verified OpenAI API models. It requires at least one `image` edit target; use a transparent mask region for the area to replace.
- `negativePrompt`, `seed`, `promptEnhance`, `enableThinking`, `watermark` — provider-native controls shown only when the active model advertises them. Seeds improve reproducibility but do not guarantee identical bytes.
- `seriesMaxImages` — Seedream related-image series, distinct from independent `n` variants.
- Generation reports safe progress phases and is bounded by the configured request timeout. Result details can include duration, dimensions, request id, usage, and cost when available.
- `filename` — output filename prefix (no extension). Reusing a name does not overwrite an earlier file — a sibling `-v2` is written instead.
- `outputDir` — override the configured output dir for this call.

## Reporting results

The tool result already contains a copy-pasteable markdown line per image (`![alt](/abs/path.png)`). Render each generated image inline in your reply so the UI can display it — do not paste the bare path. Always report the final saved path(s).
