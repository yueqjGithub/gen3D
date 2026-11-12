import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../storage/database';
import { createTestDirectory } from '../test-directory';
import { DEFAULT_MODEL_SELECTION, providerCatalog } from './provider-catalog';
import { createSettingsRepository } from './settings-repository';

const fixtures: Array<{
  directory: string;
  database: Awaited<ReturnType<typeof createDatabase>>;
}> = [];

async function createSettings() {
  const directory = createTestDirectory('settings-');
  const database = await createDatabase(join(directory, 'app.sqlite'));
  fixtures.push({ directory, database });
  return {
    database,
    settings: createSettingsRepository(database.connection),
  };
}

afterEach(async () => {
  for (const { database } of fixtures.splice(0)) {
    database.close();
  }
});

describe('model configuration', () => {
  it('usesAgnesDefaultsForIndependentModels', async () => {
    const { settings } = await createSettings();
    const selection = settings.getModelSelection();

    expect(selection.chat).toEqual({
      providerId: 'agnes',
      modelId: 'agnes/agnes-3.0-flash',
      baseURL: 'https://apihub.agnes-ai.com/v1',
    });
    expect(selection.image).toEqual({
      providerId: 'agnes',
      modelId: 'agnes-image-2.5-flash',
      baseURL: 'https://apihub.agnes-ai.com/v1',
    });
    expect(selection.chat.modelId).not.toBe(selection.image.modelId);
    expect(providerCatalog.anthropic.models.chat).toContain('anthropic/claude-sonnet-4-5');
  });

  it('readsModelSelectionAfterItHasBeenSaved', async () => {
    const { settings } = await createSettings();
    settings.saveModelSelection(DEFAULT_MODEL_SELECTION);

    expect(settings.getModelSelection()).toEqual(DEFAULT_MODEL_SELECTION);
  });

  it('migratesPreviouslySavedAgnesChatModelToTheCurrentDefault', async () => {
    const { database, settings } = await createSettings();
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
    database.connection.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    `).run('model-selection', JSON.stringify(oldSelection), new Date().toISOString());

    const selection = settings.getModelSelection();
    const stored = JSON.parse(
      (database.connection.prepare(
        'SELECT value FROM settings WHERE key = ?',
      ).get('model-selection') as { value: string }).value,
    ) as typeof oldSelection;

    expect(selection.chat.modelId).toBe('agnes/agnes-3.0-flash');
    expect(stored.chat.modelId).toBe('agnes/agnes-3.0-flash');
  });
});
