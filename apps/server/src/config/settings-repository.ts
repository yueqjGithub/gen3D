import {
  modelConfigSchema,
  modelSelectionSchema,
  type CredentialReader,
  type ModelSelection,
} from '@agent3d/shared';
import { DEFAULT_MODEL_SELECTION } from './provider-catalog';
import type { SqliteDatabase } from '../storage/database';
import { z } from 'zod';

const selectionKey = 'model-selection';
const previousAgnesChatModelId = 'agnes/agnes-2.5-flash';

const storedConfigSchema = modelConfigSchema.omit({ apiKeyConfigured: true });
const storedSelectionSchema = z.object({
  chat: storedConfigSchema,
  image: storedConfigSchema,
}).strict();

type StoredSelection = ReturnType<typeof storedSelectionSchema.parse>;

function publicConfig(
  config: StoredSelection['chat'],
  apiKeyConfigured: boolean,
): ModelSelection['chat'] {
  return {
    ...config,
    apiKeyConfigured,
  };
}

export function createSettingsRepository(
  database: SqliteDatabase,
  credentials: CredentialReader,
) {
  return {
    async getModelSelection(): Promise<ModelSelection> {
      const row = database.prepare('SELECT value FROM settings WHERE key = ?')
        .get(selectionKey) as { value: string } | undefined;
      let stored: StoredSelection = row
        ? storedSelectionSchema.parse(JSON.parse(row.value))
        : {
          chat: {
            providerId: DEFAULT_MODEL_SELECTION.chat.providerId,
            modelId: DEFAULT_MODEL_SELECTION.chat.modelId,
            baseURL: DEFAULT_MODEL_SELECTION.chat.baseURL,
          },
          image: {
            providerId: DEFAULT_MODEL_SELECTION.image.providerId,
            modelId: DEFAULT_MODEL_SELECTION.image.modelId,
            baseURL: DEFAULT_MODEL_SELECTION.image.baseURL,
          },
        };

      if (
        stored.chat.providerId === 'agnes'
        && stored.chat.modelId === previousAgnesChatModelId
      ) {
        stored = {
          ...stored,
          chat: {
            ...stored.chat,
            modelId: DEFAULT_MODEL_SELECTION.chat.modelId,
          },
        };
        database.prepare(`
          UPDATE settings SET value = ?, updated_at = ? WHERE key = ?
        `).run(JSON.stringify(stored), new Date().toISOString(), selectionKey);
      }

      const [chatKey, imageKey] = await Promise.all([
        credentials.get(stored.chat.providerId),
        credentials.get(stored.image.providerId),
      ]);

      return modelSelectionSchema.parse({
        chat: publicConfig(stored.chat, Boolean(chatKey)),
        image: publicConfig(stored.image, Boolean(imageKey)),
      });
    },

    saveModelSelection(selection: ModelSelection): void {
      const valid = modelSelectionSchema.parse(selection);
      const stored = storedSelectionSchema.parse({
        chat: {
          providerId: valid.chat.providerId,
          modelId: valid.chat.modelId,
          baseURL: valid.chat.baseURL,
        },
        image: {
          providerId: valid.image.providerId,
          modelId: valid.image.modelId,
          baseURL: valid.image.baseURL,
        },
      });
      database.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(selectionKey, JSON.stringify(stored), new Date().toISOString());
    },
  };
}
