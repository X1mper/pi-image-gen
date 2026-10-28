import type { AuthInteraction, OAuthLoginCallbacks } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CODEX_IMAGE_LOGIN_COMMAND, CODEX_IMAGE_LOGIN_PROVIDER } from './codex-auth.js';

/** Authentication only: never installs or replaces the user's chat models. */
export function registerCodexImageLogin(pi: ExtensionAPI): void {
  const oauth = openaiCodexProvider().auth.oauth!;
  pi.registerProvider(CODEX_IMAGE_LOGIN_PROVIDER, {
    name: 'OpenAI Images (pi-image-gen)',
    oauth: {
      name: 'OpenAI Images (ChatGPT subscription, pi-image-gen)',
      async login(callbacks) {
        try {
          return await oauth.login(loginInteraction(callbacks));
        } catch {
          // SDK errors may contain provider response bodies. Never forward them to logs/UI.
          throw new Error('OpenAI image login failed or was cancelled. No credentials were saved.');
        }
      },
      async refreshToken(credentials) {
        try {
          return await oauth.refresh({ ...credentials, type: 'oauth' });
        } catch {
          throw new Error(`OpenAI image login could not be refreshed. Run ${CODEX_IMAGE_LOGIN_COMMAND}.`);
        }
      },
      getApiKey: (credentials) => credentials.access,
    },
  });
}

function loginInteraction(callbacks: OAuthLoginCallbacks): AuthInteraction {
  return {
    ...(callbacks.signal ? { signal: callbacks.signal } : {}),
    async prompt(prompt) {
      const signal = prompt.signal && callbacks.signal
        ? AbortSignal.any([prompt.signal, callbacks.signal])
        : prompt.signal ?? callbacks.signal;
      return abortable(async () => {
        if (prompt.type === 'select') {
          const selected = await callbacks.onSelect({
            message: prompt.message,
            options: prompt.options.map(({ id, label }) => ({ id, label })),
          });
          if (!selected) throw new Error('Login cancelled');
          return selected;
        }
        if (prompt.type === 'manual_code' && callbacks.onManualCodeInput) {
          return callbacks.onManualCodeInput();
        }
        return callbacks.onPrompt({
          message: prompt.message,
          ...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {}),
        });
      }, signal);
    },
    notify(event) {
      if (event.type === 'auth_url') callbacks.onAuth(event);
      else if (event.type === 'device_code') callbacks.onDeviceCode(event);
      else callbacks.onProgress?.(event.message);
    },
  };
}

function abortable<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  if (signal.aborted) return Promise.reject(new Error('Login cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Login cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
