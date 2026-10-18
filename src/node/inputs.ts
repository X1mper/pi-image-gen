import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ImageGenError } from '../errors.js';
import {
  assertReferenceImageAggregateBytes,
  MAX_IMAGE_BYTES,
  MAX_REFERENCE_IMAGE_INPUTS,
  MAX_TOTAL_REFERENCE_IMAGE_BYTES,
  sniffMime,
} from '../image-input.js';
import type { ResolvedImageInput } from '../types.js';
import { resolveRemoteImageInput } from './url-input.js';

/**
 * Desktop-only reference resolution: approved-cwd file reads and public-URL
 * downloads through an injected fetch (the package's DNS-pinned safeFetch).
 * The portable engine re-validates the returned bytes; this module owns path,
 * symlink, cwd and URL safety, and keeps every failure body-free.
 */
export async function resolveImageInputs(
  raw: string[] | undefined,
  cwd: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
  aggregateByteCeiling = MAX_TOTAL_REFERENCE_IMAGE_BYTES,
): Promise<ResolvedImageInput[]> {
  if (!raw || raw.length === 0) return [];
  if (raw.length > MAX_REFERENCE_IMAGE_INPUTS) {
    throw new ImageGenError(
      `Too many reference images (maximum ${MAX_REFERENCE_IMAGE_INPUTS}).`,
      'reference image count exceeds safety ceiling',
    );
  }
  const out: ResolvedImageInput[] = [];
  let totalBytes = 0;
  for (let index = 0; index < raw.length; index++) {
    if (signal?.aborted) {
      throw new ImageGenError('Image input loading was cancelled.', 'image input loading cancelled');
    }
    const inputLabel = raw.length > 1 ? `Image input #${index + 1}` : 'Image input';
    const resolved = await resolveImageInputValue(raw[index]!, inputLabel, cwd, fetchImpl, signal);
    totalBytes += resolved.bytes.byteLength;
    assertReferenceImageAggregateBytes(totalBytes, aggregateByteCeiling);
    out.push(resolved);
  }
  return out;
}

/** Resolve one reference with the exact label the caller's message should use. */
export async function resolveImageInputValue(
  value: string,
  inputLabel: string,
  cwd: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<ResolvedImageInput> {
  const trimmed = value.trim();
  const logLabel = inputLabel.toLowerCase();
  // Every throw below is an ImageGenError so it survives the body-free log sink
  // (toLogSummary) with an actionable message; none interpolate the raw value —
  // an image input could be a giant base64 blob or a signed URL.
  if (!trimmed) {
    throw new ImageGenError(`${inputLabel} is empty.`, `${logLabel} empty`);
  }

  // Reject base64 / data: URIs — tool-call payloads don't survive megabyte-sized
  // string arguments cleanly across providers. Force callers to point us at a
  // path or URL instead, which is also what /image_generate's tool description
  // tells the model.
  if (/^data:/i.test(trimmed)) {
    throw new ImageGenError(
      `${inputLabel} as a \`data:\` URI is not supported. Pass a file path (absolute or relative to cwd) or an http(s) URL instead. If you have raw image bytes, write them to a file under .pi/uploads first and pass that path.`,
      `${logLabel} rejected (data: URI)`,
    );
  }
  // Heuristic for raw base64: long, only base64 chars. Not foolproof but
  // catches the common case where the model dumps a giant base64 blob.
  if (trimmed.length > 256 && !/[\s/\\]/.test(trimmed) && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new ImageGenError(
      `${inputLabel} looks like a raw base64 blob; this is not supported because it bloats the tool argument. Write the bytes to a file path and pass that path instead.`,
      `${logLabel} rejected (raw base64)`,
    );
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return resolveRemoteImageInput(trimmed, inputLabel, logLabel, fetchImpl, signal);
  }

  // Anything else — treat as a file path (absolute or relative to cwd).
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  const lexicalRoot = resolve(cwd);
  const root = await realpath(cwd).catch(() => resolve(cwd));
  const pathFromRoot = relative(lexicalRoot, absolute);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new ImageGenError(
      `${inputLabel} must be inside the approved project directory.`,
      `${logLabel} rejected (outside cwd)`,
    );
  }
  let bytes: Uint8Array;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new ImageGenError(
        `${inputLabel} must not be a symlink.`,
        `${logLabel} rejected (symlink)`,
      );
    }
    if (!info.isFile()) {
      throw new ImageGenError(
        `${inputLabel} must be a regular file.`,
        `${logLabel} rejected (not regular)`,
      );
    }
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ImageGenError(
        `${inputLabel} exceeds the image size ceiling.`,
        `${logLabel} rejected (too large)`,
      );
    }
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedInfo = await file.stat();
      if (!openedInfo.isFile()) {
        throw new ImageGenError(
          `${inputLabel} must be a regular file.`,
          `${logLabel} rejected (not regular)`,
        );
      }
      if (openedInfo.size > MAX_IMAGE_BYTES) {
        throw new ImageGenError(
          `${inputLabel} exceeds the image size ceiling.`,
          `${logLabel} rejected (too large)`,
        );
      }
      const canonical = await realpath(absolute);
      const canonicalInfo = await lstat(canonical);
      const canonicalFromRoot = relative(root, canonical);
      if (
        canonicalFromRoot === '..' ||
        canonicalFromRoot.startsWith(`..${sep}`) ||
        isAbsolute(canonicalFromRoot) ||
        canonicalInfo.dev !== openedInfo.dev ||
        canonicalInfo.ino !== openedInfo.ino
      ) {
        throw new ImageGenError(
          `${inputLabel} must be inside the approved project directory.`,
          `${logLabel} rejected (outside cwd)`,
        );
      }
      bytes = await readBoundedFile(file);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    // Do NOT interpolate the resolved absolute path or the raw fs error (errno +
    // full path) — both are sensitive and would reach stderr via the plain-Error
    // path. Keep the message body-free, path-free, and actionable.
    throw new ImageGenError(
      `${inputLabel} is not a readable file path or http(s) URL. Pass an absolute path, a path relative to the session cwd, or an http(s) URL.`,
      `${logLabel} not readable`,
    );
  }
  const mimeType = sniffMime(bytes);
  if (!mimeType) {
    throw new ImageGenError(
      `${inputLabel} is not a valid supported image.`,
      `${logLabel} rejected (invalid image)`,
    );
  }
  return { bytes, mimeType };
}

async function readBoundedFile(
  file: Awaited<ReturnType<typeof open>>,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(MAX_IMAGE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await file.read(buffer, total, buffer.length - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > MAX_IMAGE_BYTES) {
    throw new ImageGenError(
      'Reference image exceeds the image size ceiling.',
      'reference image rejected (too large)',
    );
  }
  // Copy only the bytes read so tiny inputs do not retain the full 20MB guard buffer.
  return buffer.slice(0, total);
}
