import { describe, expect, it, vi } from 'vitest';
import {
  CredentialBrokerUnavailableError,
  createCredentialClient,
} from './credential-client';
import { toApiErrorResponse } from '../http-errors';

function createClient(fetcher: typeof fetch, signal?: AbortSignal) {
  return createCredentialClient({
    baseURL: 'http://127.0.0.1:62688/',
    token: 'credential-broker-test-token',
    fetch: fetcher,
    signal,
  });
}

describe('Hono credential broker client', () => {
  it('readsMissingCredentialsAsNullAndCallsTheAuthenticatedEndpoint', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ apiKey: null }), {
        headers: { 'Content-Type': 'application/json' },
      }));

    await expect(createClient(fetcher).get('agnes')).resolves.toBeNull();
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(input).toBe('http://127.0.0.1:62688/credentials/agnes');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('X-Agent3D-Credential-Token'))
      .toBe('credential-broker-test-token');
  });

  it('writesAndDeletesCredentialsWithoutExposingKeysInErrors', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    const client = createClient(fetcher);

    await expect(client.set('agnes', 'private-key')).resolves.toBeUndefined();
    await expect(client.delete('agnes')).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'DELETE']);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ apiKey: 'private-key' });
  });

  it('rejectsInvalidProviderIdsBeforeMakingRequests', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(createClient(fetcher).get('../agnes')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('convertsUnavailableAndMalformedBrokerResponsesToSafeRetryableErrors', async () => {
    const unavailableFetcher = vi.fn(async () => new Response(
      'private response body and api key',
      { status: 500 },
    ));

    await expect(createClient(unavailableFetcher).get('agnes'))
      .rejects.toBeInstanceOf(CredentialBrokerUnavailableError);
    await expect(createClient(unavailableFetcher).get('agnes'))
      .rejects.not.toThrow('private response body');
    await expect(createClient(unavailableFetcher).set('agnes', 'private-key'))
      .rejects.not.toThrow('private-key');
    const mapped = toApiErrorResponse(new CredentialBrokerUnavailableError());
    expect(mapped).toMatchObject({
      status: 502,
      body: {
        code: 'INTERNAL_ERROR',
        retryable: true,
      },
    });

    const malformedFetcher = vi.fn(async () => new Response('not json'));
    await expect(createClient(malformedFetcher).get('agnes'))
      .rejects.not.toThrow('not json');
  });

  it('reportsBrokerNetworkFailuresWithoutLeakingFetchErrors', async () => {
    const fetcher = vi.fn(async () => {
      throw new TypeError('private network endpoint details');
    });

    await expect(createClient(fetcher).get('agnes'))
      .rejects.toBeInstanceOf(CredentialBrokerUnavailableError);
    await expect(createClient(fetcher).get('agnes'))
      .rejects.not.toThrow('private network endpoint details');
  });

  it('propagatesAbortSignalsToBrokerRequests', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Request aborted.', 'AbortError'));
        }, { once: true });
      }));
    const client = createClient(fetcher, controller.signal);
    const pending = client.get('agnes');

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
