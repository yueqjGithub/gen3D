import {
  modelSelectionSchema,
  type ModelSelection,
} from '@agent3d/shared';
import { DEFAULT_MODEL_SELECTION } from './provider-catalog';
import type { SqliteDatabase } from '../storage/database';

const selectionKey = 'model-selection';
const previousAgnesChatModelId = 'agnes/agnes-2.5-flash';

/**
 * 模型选择的持久化：以 JSON 形式存放在 settings 表的 model-selection 键下。
 */
export function createSettingsRepository(database: SqliteDatabase) {
  return {
    /** 读取已保存的选择；没有保存过时返回默认值。 */
    getModelSelection(_username?: string): ModelSelection {
      const row = database.prepare('SELECT value FROM settings WHERE key = ?')
        .get(selectionKey) as { value: string } | undefined;
      let stored = row
        ? modelSelectionSchema.parse(JSON.parse(row.value))
        : DEFAULT_MODEL_SELECTION;

      // 兼容旧数据：早期默认的 2.5 模型已不可用，读取时自动升级并写回数据库
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

      return stored;
    },

    /** 保存选择；使用 UPSERT，所以首次写入和覆盖更新都是同一条语句。 */
    saveModelSelection(selection: ModelSelection, _username?: string): void {
      const valid = modelSelectionSchema.parse(selection);
      database.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(selectionKey, JSON.stringify(valid), new Date().toISOString());
    },
  };
}
