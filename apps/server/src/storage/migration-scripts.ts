import initialMigration from './migrations/001-initial.sql?raw';
import settingsMigration from './migrations/002-settings.sql?raw';
import chatTurnsMigration from './migrations/003-chat-turns.sql?raw';

export const databaseMigrations = [
  { version: 1, sql: initialMigration },
  { version: 2, sql: settingsMigration },
  { version: 3, sql: chatTurnsMigration },
] as const;
