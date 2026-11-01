import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../storage/database';
import {
  DEFAULT_MODEL_SELECTION,
  providerCatalog,
} from './provider-catalog';
import {
  ProviderNotConfiguredError,
  UnsupportedProviderError,
  resolveModel,
} from './model-resolver';
import { createSettingsRepository } from './settings-repository';
import { readServerEnvironment } from './env';

describe('model configuration', () => {
  it('readsExplicitMockModeAndEmptyDevelopmentCredentials', () => {
    expect(readServerEnvironment({
      AGENT3D_MOCK_MODE: 'true',
      AGENT3D_CHAT_API_KEY: '',
      AGENT3D_IMAGE_API_KEY: '',
    })).toEqual({
      mockMode: true,
      chatApiKey: null,
      imageApiKey: null,
    });

    expect(() => readServerEnvironment({ AGENT3D_MOCK_MODE: 'sometimes' })).toThrow();
  });

  it('usesAgnesDefaultsForIndependentModels', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-settings-'));
    const database = createDatabase(join(directory, 'app.sqlite'));
    const settings = createSettingsRepository(database.connection, { get: async () => null });

    try {
      const selection = await settings.getModelSelection();

      expect(selection.chat).toMatchObject({
        providerId: 'agnes',
        modelId: 'agnes/agnes-3.0-flash',
        baseURL: 'https://apihub.agnes-ai.com/v1',
        apiKeyConfigured: false,
      });
      expect(selection.image).toMatchObject({
        providerId: 'agnes',
        modelId: 'agnes-image-2.5-flash',
        apiKeyConfigured: false,
      });
      expect(selection.chat.modelId).not.toBe(selection.image.modelId);
      expect(DEFAULT_MODEL_SELECTION.chat.modelId).toBe('agnes/agnes-3.0-flash');
      expect(providerCatalog.anthropic.models.chat).toContain('anthropic/claude-sonnet-4-5');
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('readsModelSelectionAfterItHasBeenSaved', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-settings-'));
    const database = createDatabase(join(directory, 'app.sqlite'));
    const settings = createSettingsRepository(database.connection, { get: async () => null });

    try {
      settings.saveModelSelection(DEFAULT_MODEL_SELECTION);

      await expect(settings.getModelSelection()).resolves.toEqual(DEFAULT_MODEL_SELECTION);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('migratesPreviouslySavedAgnesChatModelToTheCurrentDefault', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-settings-'));
    const database = createDatabase(join(directory, 'app.sqlite'));
    const settings = createSettingsRepository(database.connection, { get: async () => null });
    const oldSelection = {
      chat: {
        providerId: 'agnes',
        modelId: 'agnes/agnes-2.5-flash',
        baseURL: 'https://apihub.agnes-ai.com/v1',
      },
      image: {
        providerId: 'agnes',
        modelId: 'agnes-image-2.5-flash',
        baseURL: 'https://apihub.agnes-ai.com/v1',
      },
    };

    try {
      database.connection.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      `).run('model-selection', JSON.stringify(oldSelection), new Date().toISOString());

      const selection = await settings.getModelSelection();
      const stored = JSON.parse(
        (database.connection.prepare(
          'SELECT value FROM settings WHERE key = ?',
        ).get('model-selection') as { value: string }).value,
      ) as typeof oldSelection;

      expect(selection.chat.modelId).toBe('agnes/agnes-3.0-flash');
      expect(stored.chat.modelId).toBe('agnes/agnes-3.0-flash');
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('neverReturnsCredentialValues', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-settings-'));
    const database = createDatabase(join(directory, 'app.sqlite'));
    const settings = createSettingsRepository(database.connection, {
      get: async () => 'secret-for-test-only',
    });

    try {
      const selection = await settings.getModelSelection();

      expect(selection.chat.apiKeyConfigured).toBe(true);
      expect(JSON.stringify(selection)).not.toContain('secret-for-test-only');
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejectsUnknownProviders', async () => {
    await expect(resolveModel({
      providerId: 'unknown',
      modelId: 'unknown/model',
      baseURL: 'https://example.com/v1',
      apiKeyConfigured: true,
    }, 'chat', { get: async () => 'secret' })).rejects.toBeInstanceOf(UnsupportedProviderError);
  });

  it('reportsMissingCredentials', async () => {
    await expect(resolveModel(DEFAULT_MODEL_SELECTION.chat, 'chat', {
      get: async () => null,
    })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it('disablesInlineImagesForProvidersThatOnlyDocumentPublicImageUrls', async () => {
    const resolved = await resolveModel(DEFAULT_MODEL_SELECTION.chat, 'chat', {
      get: async () => 'test-only-key',
    });

    expect(resolved.supportsInlineImages).toBe(false);
  });
});
