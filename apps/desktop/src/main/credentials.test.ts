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
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    }, directory);

    await expect(store.set('agnes', 'secret')).rejects.toBeInstanceOf(
      CredentialStorageUnavailableError,
    );
  });

  it('storesCredentialsEncryptedAndReadsBack', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent3d-credentials-'));
    const store = createSafeStorageCredentialStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
    }, directory);

    await store.set('agnes', 'secret-for-test-only');
    const savedFile = await readFile(join(directory, 'credentials.json'), 'utf8');

    expect(savedFile).not.toContain('secret-for-test-only');
    await expect(store.get('agnes')).resolves.toBe('secret-for-test-only');
    await store.delete('agnes');
    await expect(store.get('agnes')).resolves.toBeNull();
  });
});
