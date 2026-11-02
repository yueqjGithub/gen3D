import { z } from 'zod';
import type { CredentialStore } from '@agent3d/shared';

const providerIdPattern = /^[a-zA-Z0-9._-]{1,80}$/;
const credentialResponseSchema = z.object({
  apiKey: z.string().min(1).max(4096).nullable(),
}).strict();

export interface CredentialClientOptions {
  baseURL: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export class CredentialBrokerUnavailableError extends Error {
  constructor() {
    super('The local credential service is unavailable.');
    this.name = 'CredentialBrokerUnavailableError';
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError';
}

function normalizeBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('The credential broker URL must use loopback HTTP.');
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new TypeError('The credential broker URL must use loopback HTTP.');
  }
  return url.origin;
}

function validateProviderId(providerId: string): string {
  if (!providerIdPattern.test(providerId)) {
    throw new TypeError('Invalid provider ID.');
  }
  return providerId;
}

/**
 * Creates a Hono-side credential client that communicates only with the loopback broker.
 */
export function createCredentialClient({
  baseURL,
  token,
  fetch: fetchImplementation = globalThis.fetch,
  signal,
}: CredentialClientOptions): CredentialStore {
  const endpoint = normalizeBaseURL(baseURL);
  if (!token.trim()) {
    throw new TypeError('The credential broker token must be configured.');
  }

  async function send(
    providerId: string,
    method: 'GET' | 'PUT' | 'DELETE',
    body?: { apiKey: string },
  ): Promise<Response> {
    validateProviderId(providerId);
    if (signal?.aborted) {
      throw new DOMException('The credential request was aborted.', 'AbortError');
    }

    try {
      const response = await fetchImplementation(
        `${endpoint}/credentials/${encodeURIComponent(providerId)}`,
        {
          method,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'X-Agent3D-Credential-Token': token,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal,
        },
      );
      if (!response.ok) {
        throw new CredentialBrokerUnavailableError();
      }
      return response;
    } catch (error) {
      if (error instanceof CredentialBrokerUnavailableError || isAbortError(error)) {
        throw error;
      }
      throw new CredentialBrokerUnavailableError();
    }
  }

  return {
    async get(providerId) {
      const response = await send(providerId, 'GET');
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        throw new CredentialBrokerUnavailableError();
      }
      const parsed = credentialResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw new CredentialBrokerUnavailableError();
      }
      return parsed.data.apiKey;
    },

    async set(providerId, apiKey) {
      if (!apiKey.trim() || apiKey.length > 4096) {
        throw new TypeError('Credential cannot be empty or exceed 4096 characters.');
      }
      await send(providerId, 'PUT', { apiKey });
    },

    async delete(providerId) {
      await send(providerId, 'DELETE');
    },
  };
}
