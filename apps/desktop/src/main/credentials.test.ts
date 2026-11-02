import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CredentialStorageUnavailableError,
  createSafeStorageCredentialStore,
} from './credentials';

describe('encrypted local credentials', () => {
  let directory: string;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refusesCredentialPersistenceWhenSafeStorageUnavailable', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent3d-credentials-'));
    const store = createSafeStorageCredentialStore({
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async (value) => ({
        shouldReEncrypt: false,
        result: value.toString(),
      }),
    }, directory);

    await expect(store.set('agnes', 'secret')).rejects.toBeInstanceOf(
      CredentialStorageUnavailableError,
    );
  });

  it('storesCredentialsEncryptedAndReadsBack', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent3d-credentials-'));
    const store = createSafeStorageCredentialStore({
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
      decryptStringAsync: async (value) => ({
        shouldReEncrypt: false,
        result: value.toString().replace(/^encrypted:/, ''),
      }),
    }, directory);

    await store.set('agnes', 'secret-for-test-only');
    const savedFile = await readFile(join(directory, 'credentials.json'), 'utf8');

    expect(savedFile).not.toContain('secret-for-test-only');
    await expect(store.get('agnes')).resolves.toBe('secret-for-test-only');
    await store.delete('agnes');
    await expect(store.get('agnes')).resolves.toBeNull();
  });

  it('retriesAsyncDecryptionWhenTheStorageKeyHasRotated', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent3d-credentials-'));
    let decryptions = 0;
    const store = createSafeStorageCredentialStore({
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`),
      decryptStringAsync: async () => {
        decryptions += 1;
        return decryptions === 1
          ? { shouldReEncrypt: true, result: 'old-key-result' }
          : { shouldReEncrypt: false, result: 'rotated-key-result' };
      },
    }, directory);

    await store.set('agnes', 'secret-for-test-only');

    await expect(store.get('agnes')).resolves.toBe('rotated-key-result');
    expect(decryptions).toBe(2);
  });
});
