import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { databaseMigrations } from './migration-scripts';

export type SqliteDatabase = InstanceType<typeof Database>;

/** 数据库连接及关闭方法（由 index.ts 在服务关闭时调用）。 */
export interface DatabaseHandle {
  connection: SqliteDatabase;
  close(): void;
}

/**
 * 打开 SQLite 并自动执行尚未应用的迁移。迁移是按版本追加的增量变更：
 *  - schema_migrations 记录已成功应用的版本；已有数据库启动时会跳过这些版本
 *  - 迁移 SQL 和版本记录在同一个事务中提交，失败时一起回滚
 *  - WAL 模式允许流式写入的同时读取数据
 */
export async function createDatabase(path: string): Promise<DatabaseHandle> {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  if (path === ':memory:') {
    throw new Error('Mastra and Server need a shared SQLite file, not :memory:.');
  }
  // 旧版的业务表不能与新的外键一起使用；不做迁移，也不修改旧数据库。
  if (existsSync(path)) {
    const existing = new Database(path, { readonly: true });
    try {
      const legacy = existing.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('conversations', 'messages') LIMIT 1
      `).get();
      if (legacy) {
        throw new Error('Legacy conversation tables found. Back up the database and create a new one.');
      }
    } finally {
      existing.close();
    }
  }
  // 由 Mastra 创建和维护自己的表；初始化后关闭临时连接，再打开业务数据库连接。
  // libSQL 含原生模块，保持为运行时依赖，不能被 esbuild 内联到 ESM 文件。
  const { LibSQLStore } = createRequire(import.meta.url)('@mastra/libsql') as typeof import('@mastra/libsql');
  const mastraStorage = new LibSQLStore({ id: 'agent3d-storage', url: `file:${resolve(path)}` });
  try {
    await mastraStorage.init();
  } finally {
    await mastraStorage.close();
  }
  const connection = new Database(path);
  connection.pragma('foreign_keys = ON');
  connection.pragma('journal_mode = WAL');
  // 迁移台账：每个 version 对应 migration-scripts.ts 中的一项，applied_at 记录成功应用时间。
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // 按版本顺序检查迁移；只执行台账中还没有的版本。
  // 已有数据库因此只会补上后来新增的迁移，不会重新执行旧 SQL。
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
    try {
      applyMigration.immediate();
    } catch (error) {
      // 事务已回滚；启动失败时也要关闭连接，方便修复后重新启动。
      connection.close();
      throw new Error('Database migration ' + migration.version + ' failed.', { cause: error });
    }
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
