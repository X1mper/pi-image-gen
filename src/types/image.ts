export type GenerateImageParams = {
  prompt: string;
  /**
   * Optional reference / input images for image-to-image, editing, style
   * transfer, or character preservation. Each entry MUST be either:
   *   - an absolute or relative file path on the local filesystem, or
   *   - an http(s) URL.
   *
   * `data:` URIs and raw base64 strings are intentionally rejected — tool
   * arguments don't survive megabyte-sized strings cleanly across providers.
   * If you have raw image bytes, write them to a file first.
   */
  image?: string[];
  /** Number of images to generate. Default 1. */
  n?: number;
  /** Image size hint (e.g. "1024x1024"). Provider may ignore. */
  size?: string;
  /**
   * Gemini-style aspect ratio (e.g. "16:9"). Only honored when the active
   * model's capabilities declare `aspectRatios` (Gemini image models have no
   * pixel-size knob); rejected by validation otherwise.
   */
  aspectRatio?: string;
  /**
   * Gemini-style size tier (e.g. "2K"). Only honored when the active model's
   * capabilities declare `imageSizes`; rejected by validation otherwise.
   */
  imageSize?: string;
  /**
   * Quality hint (e.g. "low" | "medium" | "high" | "auto" for OpenAI gpt-image).
   * Provider-specific: forwarded on OpenAI-shaped providers, ignored by adapters
   * that don't expose a quality knob.
   */
  quality?: string;
  /** Provider-supported output encoding. */
  outputFormat?: 'png' | 'jpeg' | 'webp';
  /** Provider-supported background behavior. */
  background?: 'auto' | 'transparent' | 'opaque';
  /** JPEG/WebP compression from 0–100. */
  outputCompression?: number;
  /** Optional edit mask path/URL; exposed only for verified mask-capable models. */
  mask?: string;
  /** Provider-native negative prompt. */
  negativePrompt?: string;
  /** Provider-native reproducibility seed. */
  seed?: number;
  /** Ask the provider to enhance/extend the prompt where supported. */
  promptEnhance?: boolean;
  /** Enable provider-side thinking where supported. */
  enableThinking?: boolean;
  /** Add the provider's visible AI watermark where supported. Default false. */
  watermark?: boolean;
  /** Seedream related-series maximum; distinct from independent `n` variants. */
  seriesMaxImages?: number;
  /** Output filename prefix. */
  filename?: string;
  /** Override settings.outputDir for this call. */
  outputDir?: string;
};

/** Materialized reference image, ready for adapters to encode. */
export type ResolvedImageInput = {
  bytes: Uint8Array;
  mimeType: string;
};

export type ImageDimensions = { width: number; height: number };

/**
 * Per-model capability contract, sourced from official provider docs (the
 * registry in models.ts quotes the values). Drives the tool schema shape at
 * registration time and pre-flight validation before any paid call — mirrors
 * pi-video-gen's `VideoModelCapabilities`.
 */
export type ImageModelCapabilities = {
  /**
   * Discrete allowed `size` values (DALL·E-style fixed lists). Mutually
   * exclusive with `sizeRange`; when present, `size` is a string enum.
   */
  sizes?: string[];
  /** Range-based `size` validation for "<width><sep><height>" pixel strings. */
  sizeRange?: {
    /** Separator the provider's API expects: qwen uses "*", everyone else "x". */
    separator: 'x' | '*';
    /** Tier tokens accepted instead of a pixel string (Seedream: "1K"/"2K"/…). */
    tiers?: string[];
    /** The literal "auto" is accepted (model picks the size; gpt-image-2). */
    allowAuto?: boolean;
    /** Inclusive total-pixel (width × height) bounds. */
    minArea: number;
    maxArea: number;
    /** Inclusive width/height ratio bounds. */
    minRatio?: number;
    maxRatio?: number;
    /** Both dimensions must be divisible by this (gpt-image-2: 16). */
    divisibleBy?: number;
    /** Longest-edge ceiling in px (gpt-image-2: 3840). */
    maxEdge?: number;
  };
  /**
   * Gemini-style aspect-ratio vocabulary. Its presence means the model has NO
   * pixel-size knob: the schema hides `size` and exposes `aspectRatio` instead.
   */
  aspectRatios?: string[];
  /**
   * Gemini-style `imageSize` tiers (e.g. ["1K","2K","4K"]). A single entry
   * means a fixed tier — the param is hidden from the schema. Absent means the
   * model has no tier knob at all (gemini-2.5-flash-image is fixed at 1024px).
   */
  imageSizes?: string[];
  /** Model-specific quality vocabulary when the provider exposes a quality knob. */
  qualityValues?: string[];
  outputFormats?: Array<'png' | 'jpeg' | 'webp'>;
  backgroundValues?: Array<'auto' | 'transparent' | 'opaque'>;
  supportsOutputCompression?: boolean;
  supportsMask?: boolean;
  supportsNegativePrompt?: boolean;
  supportsSeed?: boolean;
  supportsPromptEnhance?: boolean;
  supportsThinking?: boolean;
  supportsWatermark?: boolean;
  supportsSeries?: boolean;
  /** Max images per request via `n`. 1 = the model has no count knob; `n` is hidden. */
  nMax: number;
  /** Whether nMax comes from provider docs or a conservative extension ceiling. */
  nMaxSource?: 'provider' | 'extension';
  /** Max reference images per request. */
  maxReferenceImages: number;
  /** Accepted reference-image formats as display labels (e.g. "PNG", "JPEG"). */
  inputFormats: string[];
  /** Per-reference-image byte ceiling. */
  inputMaxBytes: number;
  /** Whether reference count/format/byte values come from provider docs or local safety limits. */
  referenceLimitsSource?: 'provider' | 'extension';
  /**
   * Documented advisory for reference-image dimensions (e.g. "both dimensions
   * between 384 and 2048 px"). Surfaced in the `image` param description only —
   * it is a provider recommendation, never hard-validated.
   */
  inputDimAdvice?: string;
};
