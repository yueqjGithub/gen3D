import { readFileSync } from 'node:fs';

// 按版本号顺序列出所有迁移；新增表结构时，新建一个 .sql 文件并在这里追加一项即可
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
  {
    version: 4,
    sql: readFileSync(new URL('./migrations/004-login.sql', import.meta.url), 'utf8'),
  },
  {
    version: 5,
    sql: readFileSync(new URL('./migrations/005-user-preferences.sql', import.meta.url), 'utf8'),
  },
] as const;
