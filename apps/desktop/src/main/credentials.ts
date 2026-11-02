import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CredentialStore } from '@agent3d/shared';

export interface SafeStorageAdapter {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{
    shouldReEncrypt: boolean;
    result: string;
  }>;
}

export class CredentialStorageUnavailableError extends Error {
  constructor() {
    super('OS-backed encryption is unavailable; credentials were not saved.');
    this.name = 'CredentialStorageUnavailableError';
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function validateProviderId(providerId: string): string {
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(providerId)) {
    throw new TypeError('Invalid provider ID.');
  }
  return providerId;
}

function parseCredentialFile(contents: string): Record<string, string> {
  const parsed: unknown = JSON.parse(contents);
  if (
    typeof parsed !== 'object'
    || parsed === null
    || Array.isArray(parsed)
    || !Object.entries(parsed).every(([providerId, value]) => (
      /^[a-zA-Z0-9._-]{1,80}$/.test(providerId) && typeof value === 'string'
    ))
  ) {
    throw new TypeError('Stored credential data is invalid.');
  }
  return Object.fromEntries(Object.entries(parsed));
}

export function createSafeStorageCredentialStore(
  storage: SafeStorageAdapter,
  userDataDirectory: string,
): CredentialStore {
  const filePath = resolve(userDataDirectory, 'credentials.json');

  async function readCredentialFile(): Promise<Record<string, string>> {
    try {
      return parseCredentialFile(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (isMissingFile(error)) {
        return {};
      }
      throw error;
    }
  }

  async function saveCredentialFile(credentials: Record<string, string>): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      // safeStorage encrypts the secret with the operating system before it reaches disk.
      await writeFile(temporaryPath, JSON.stringify(credentials), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  return {
    async get(providerId: string): Promise<string | null> {
      const id = validateProviderId(providerId);
      const credentials = await readCredentialFile();
      const encrypted = credentials[id];
      if (encrypted === undefined) {
        return null;
      }
      if (!await storage.isAsyncEncryptionAvailable()) {
        throw new CredentialStorageUnavailableError();
      }
      const encryptedBytes = Buffer.from(encrypted, 'base64');
      const decrypted = await storage.decryptStringAsync(encryptedBytes);
      if (decrypted.shouldReEncrypt) {
        return (await storage.decryptStringAsync(encryptedBytes)).result;
      }
      return decrypted.result;
    },

    async set(providerId: string, secret: string): Promise<void> {
      const id = validateProviderId(providerId);
      if (!secret.trim()) {
        throw new TypeError('Credential cannot be empty.');
      }
      if (!await storage.isAsyncEncryptionAvailable()) {
        throw new CredentialStorageUnavailableError();
      }

      const credentials = await readCredentialFile();
      // The file contains only OS-encrypted bytes, encoded for JSON storage.
      credentials[id] = (await storage.encryptStringAsync(secret)).toString('base64');
      await saveCredentialFile(credentials);
    },

    async delete(providerId: string): Promise<void> {
      const id = validateProviderId(providerId);
      const credentials = await readCredentialFile();
      if (!(id in credentials)) {
        return;
      }

      delete credentials[id];
      if (Object.keys(credentials).length === 0) {
        await rm(filePath, { force: true });
        return;
      }
      await saveCredentialFile(credentials);
    },
  };
}
