import { readFileSync } from 'node:fs';

export const databaseMigrations = [
  {
    version: 1,
    sql: readFileSync(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8'),
  },
  {
    version: 2,
    sql: readFileSync(new URL('./migrations/002-settings.sql', import.meta.url), 'utf8'),
  },
  {
    version: 3,
    sql: readFileSync(new URL('./migrations/003-chat-turns.sql', import.meta.url), 'utf8'),
  },
] as const;
