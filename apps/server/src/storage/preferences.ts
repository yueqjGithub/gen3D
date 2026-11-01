import type { SqliteDatabase } from './database';

interface PreferenceRow {
  key: string;
  value: string;
}

export interface PreferenceRepository {
  list(): Record<string, string>;
  upsert(key: string, value: string): void;
  delete(key: string): boolean;
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
    list(): Record<string, string> {
      const rows = database
        .prepare('SELECT key, value FROM preferences ORDER BY key ASC')
        .all() as PreferenceRow[];
      return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
    },

    upsert(key: string, value: string): void {
      database.prepare(`
        INSERT INTO preferences (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(validateKey(key), validateValue(value), new Date().toISOString());
    },

    delete(key: string): boolean {
      return database.prepare('DELETE FROM preferences WHERE key = ?')
        .run(validateKey(key)).changes === 1;
    },
  };
}
