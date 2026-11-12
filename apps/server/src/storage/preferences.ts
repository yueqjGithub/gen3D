import type { SqliteDatabase } from './database';

interface PreferenceRow {
  key: string;
  value: string;
}

/** 用户偏好：简单的键值表，Agent 会把它们作为上下文，修改需经用户确认。 */
export interface PreferenceRepository {
  list(username: string): Record<string, string>;
  upsert(key: string, value: string, username: string): void;
  delete(key: string, username: string): boolean;
}

function validateKey(key: string): string {
  const normalized = key.trim();
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(normalized)) {
    throw new TypeError('Preference keys must contain 1-80 letters, numbers, dots, underscores, or hyphens.');
  }
  return normalized;
}

function validateValue(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 500) {
    throw new TypeError('Preference values must contain 1-500 characters.');
  }
  return normalized;
}

export function createPreferenceRepository(database: SqliteDatabase): PreferenceRepository {
  return {
    list(username: string): Record<string, string> {
      const rows = database
        .prepare('SELECT key, value FROM user_preferences WHERE username = ? ORDER BY key ASC')
        .all(username) as PreferenceRow[];
      return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
    },

    upsert(key: string, value: string, username: string): void {
      database.prepare(`
        INSERT INTO user_preferences (username, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(username, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(username, validateKey(key), validateValue(value), new Date().toISOString());
    },

    delete(key: string, username: string): boolean {
      return database.prepare('DELETE FROM user_preferences WHERE username = ? AND key = ?')
        .run(username, validateKey(key)).changes === 1;
    },
  };
}
