import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialStore } from '@agent3d/shared';
import { startCredentialBroker } from './credential-broker';

const token = 'credential-broker-test-token';

function createStore(): CredentialStore {
  const credentials = new Map<string, string>();
  return {
    async get(providerId) {
      return credentials.get(providerId) ?? null;
    },
    async set(providerId, apiKey) {
      credentials.set(providerId, apiKey);
    },
    async delete(providerId) {
      credentials.delete(providerId);
    },
  };
}

let broker: Awaited<ReturnType<typeof startCredentialBroker>> | undefined;

afterEach(async () => {
  await broker?.close();
  broker = undefined;
});

async function startBroker(store = createStore()) {
  broker = await startCredentialBroker({ store, token, port: 0 });
  return broker;
}

function authHeaders(value = token): Headers {
  return new Headers({ 'X-Agent3D-Credential-Token': value });
}

describe('Electron credential broker', () => {
  it('bindsToLoopbackAndClosesOnShutdown', async () => {
    const activeBroker = await startBroker();
    expect(activeBroker.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(activeBroker.port).toBeGreaterThan(0);

    await activeBroker.close();
    broker = undefined;
    await expect(fetch(`${activeBroker.baseURL}/credentials/agnes`)).rejects.toThrow();
  });

  it('rejectsMissingAndIncorrectTokensWithTheSameGenericResponse', async () => {
    const activeBroker = await startBroker();
    const missingToken = await fetch(`${activeBroker.baseURL}/credentials/agnes`);
    const wrongToken = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      headers: authHeaders('wrong-secret'),
    });

    expect(missingToken.status).toBe(401);
    expect(wrongToken.status).toBe(401);
    const missingResponse = await missingToken.text();
    const wrongResponse = await wrongToken.text();
    expect(missingResponse).toBe(wrongResponse);
    expect(wrongResponse).not.toContain('wrong-secret');
  });

  it('rejectsInvalidProviderIdsAndMalformedBodiesWithoutEchoingInput', async () => {
    const activeBroker = await startBroker();
    const invalidProvider = await fetch(`${activeBroker.baseURL}/credentials/bad%20provider`, {
      headers: authHeaders(),
    });
    const malformedBody = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      method: 'PUT',
      headers: {
        ...Object.fromEntries(authHeaders()),
        'Content-Type': 'application/json',
      },
      body: 'private malformed request body',
    });

    expect(invalidProvider.status).toBe(400);
    expect(malformedBody.status).toBe(400);
    expect(await malformedBody.text()).not.toContain('private malformed request body');
  });

  it('supportsMissingCredentialAndEncryptedStoreRoundTrips', async () => {
    const store = createStore();
    const activeBroker = await startBroker(store);
    const missing = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      headers: authHeaders(),
    });
    expect(await missing.json()).toEqual({ apiKey: null });

    const saved = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      method: 'PUT',
      headers: {
        ...Object.fromEntries(authHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey: 'secret-for-test-only' }),
    });
    expect(saved.status).toBe(204);

    const loaded = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      headers: authHeaders(),
    });
    expect(await loaded.json()).toEqual({ apiKey: 'secret-for-test-only' });

    const deleted = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    expect(deleted.status).toBe(204);
    expect(await (await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      headers: authHeaders(),
    })).json()).toEqual({ apiKey: null });
  });

  it('doesNotIncludeKeysOrRequestBodiesInStoreErrors', async () => {
    const store: CredentialStore = {
      get: async () => { throw new Error('private storage failure'); },
      set: async () => { throw new Error('private storage failure'); },
      delete: async () => { throw new Error('private storage failure'); },
    };
    const activeBroker = await startBroker(store);
    const response = await fetch(`${activeBroker.baseURL}/credentials/agnes`, {
      method: 'PUT',
      headers: {
        ...Object.fromEntries(authHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ apiKey: 'secret-value' }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(500);
    expect(responseText).not.toContain('secret-value');
    expect(responseText).not.toContain('private storage failure');
  });
});
