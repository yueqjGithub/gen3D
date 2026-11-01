import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { databaseMigrations } from './migration-scripts';

export type SqliteDatabase = InstanceType<typeof Database>;

export interface DatabaseHandle {
  connection: SqliteDatabase;
  close(): void;
}

export function createDatabase(path: string): DatabaseHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const connection = new Database(path);
  connection.pragma('foreign_keys = ON');
  connection.pragma('journal_mode = WAL');
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of databaseMigrations) {
    const applied = connection
      .prepare('SELECT 1 FROM schema_migrations WHERE version = ?')
      .get(migration.version);
    if (applied) {
      continue;
    }

    const applyMigration = connection.transaction(() => {
      connection.exec(migration.sql);
      connection
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, new Date().toISOString());
    });
    applyMigration.immediate();
  }

  // A process exit can interrupt streaming; leave those turns retryable after restart.
  connection.prepare(`
    UPDATE chat_turns SET status = 'failed', updated_at = ?
    WHERE status = 'running'
  `).run(new Date().toISOString());

  return {
    connection,
    close: () => connection.close(),
  };
}
