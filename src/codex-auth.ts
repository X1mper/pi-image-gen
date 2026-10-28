import { ImageGenError } from './errors.js';
import type { ImageModelRegistry } from './types.js';

const AUTH_CLAIM = 'https://api.openai.com/auth';

export const CODEX_IMAGE_LOGIN_PROVIDER = 'pi-image-gen-openai';
export const CODEX_IMAGE_LOGIN_COMMAND = `/login ${CODEX_IMAGE_LOGIN_PROVIDER}`;

/** Availability only: no token retrieval/refresh and no dependency on chat models. */
export function hasCodexLogin(registry: ImageModelRegistry): boolean {
  return isConfirmedOAuth(registry, { id: '', provider: CODEX_IMAGE_LOGIN_PROVIDER }) ||
    isConfirmedOAuth(registry, { id: '', provider: 'openai-codex' }) ||
    registry.getAvailable().some((model) =>
      model.provider === 'openai-codex' && isConfirmedOAuth(registry, model));
}

export type CodexAuth = {
  headers: Record<string, string>;
};

export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) throw new Error('malformed JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const claim = payload[AUTH_CLAIM];
    if (!claim || typeof claim !== 'object') throw new Error('missing auth claim');
    const accountId = (claim as Record<string, unknown>).chatgpt_account_id;
    if (typeof accountId !== 'string' || accountId.trim() === '') {
      throw new Error('missing account id');
    }
    return accountId;
  } catch {
    throw invalidLoginError();
  }
}

export async function resolveCodexAuth(registry: ImageModelRegistry): Promise<CodexAuth> {
  // Select once: a failed refresh must never silently switch accounts.
  const provider = isConfirmedOAuth(registry, { id: '', provider: CODEX_IMAGE_LOGIN_PROVIDER })
    ? CODEX_IMAGE_LOGIN_PROVIDER
    : 'openai-codex';
  const model = provider === 'openai-codex' ? registry
    .getAvailable()
    .filter((candidate) => candidate.provider === provider)
    .sort((a, b) => a.id.localeCompare(b.id))[0] : undefined;
  if (!isConfirmedOAuth(registry, model ?? { id: '', provider })) {
    const chatLoginHint = isConfirmedOAuth(registry, { id: '', provider: 'openai' })
      ? ' Your existing openai ChatGPT chat login uses a different authorization flow and cannot be reused for this image route.'
      : '';
    throw new ImageGenError(
      `No compatible image login was detected.${chatLoginHint} Run ${CODEX_IMAGE_LOGIN_COMMAND}. An existing Pi openai-codex OAuth login is also detected automatically.`,
      'Codex login missing',
      'missing-credentials',
    );
  }

  let resolved: Awaited<ReturnType<ImageModelRegistry['getApiKeyAndHeaders']>>;
  try {
    if (model) {
      resolved = await registry.getApiKeyAndHeaders(model);
    } else {
      const apiKey = await registry.getApiKeyForProvider?.(provider);
      resolved = apiKey ? { ok: true, apiKey } : { ok: false };
    }
  } catch {
    throw invalidLoginError();
  }
  if (!resolved.ok || !resolved.apiKey) throw invalidLoginError();

  const token = resolved.apiKey;
  return {
    headers: {
      ...withoutProtectedHeaders(resolved.headers),
      authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': extractCodexAccountId(token),
      originator: 'pi',
      'content-type': 'application/json',
      accept: 'application/json',
    },
  };
}

export function withoutProtectedCodexHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return withoutProtectedHeaders(headers);
}

function withoutProtectedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const protectedNames = new Set([
    'authorization',
    'content-type',
    'chatgpt-account-id',
    'originator',
    'accept',
  ]);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !protectedNames.has(name.toLowerCase())),
  );
}

function isConfirmedOAuth(
  registry: ImageModelRegistry,
  model: ReturnType<ImageModelRegistry['getAvailable']>[number],
): boolean {
  if (!registry.isUsingOAuth) return false;
  try {
    return registry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

function invalidLoginError(): ImageGenError {
  return new ImageGenError(
    `The Codex image login is invalid or expired. Run ${CODEX_IMAGE_LOGIN_COMMAND}, or repair your legacy Pi openai-codex login.`,
    'Codex login invalid',
    'missing-credentials',
  );
}
