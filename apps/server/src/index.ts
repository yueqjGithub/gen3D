import { serve, type ServerType } from '@hono/node-server';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { PostgresStore } from '@mastra/pg';
import { createApp } from './app';
import { createPostgresRepositories } from './storage/postgres';

// 本地默认地址与 Desktop 一致。容器可使用 HOST/PORT 调整监听地址。
const serverURL = `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? 62586}`;

/** 关闭 HTTP 服务后释放云数据库连接池。 */
export interface StandaloneServer {
  close(): Promise<void>;
}

/**
 * 启动流程：读取 Supabase 配置 → 创建 PostgreSQL 仓库 → Hono → 监听端口。
 * Server 和独立 Agent 使用同一个 agent3d schema，附件和 GLB 使用私有 Storage。
 * 初始化表是单独的部署命令；每次启动或聊天都不重新建表，也不新建本地 SQLite。
 */
export async function startServer(): Promise<StandaloneServer> {
  for (const key of ['DATABASE_URL', 'SUPABASE_CA_PATH', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SESSION_SECRET']) {
    if (!process.env[key]) throw new Error(`Missing required configuration: ${key}`);
  }
  const url = new URL(process.env.DATABASE_URL!);
  url.port = '5432'; // Supabase Session pooler；Server 自己复用少量连接。
  url.searchParams.delete('sslmode');
  const storage = new PostgresStore({
    id: 'server-postgres', connectionString: url.toString(), schemaName: 'agent3d', max: 2,
    ssl: { ca: readFileSync(process.env.SUPABASE_CA_PATH!, 'utf8'), rejectUnauthorized: true },
    disableInit: true,
  });
  const app = createApp(createPostgresRepositories(storage, {
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY!,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'agent3d',
    SESSION_SECRET: process.env.SESSION_SECRET!,
  }));
  const server: ServerType = serve({
    fetch: app.fetch,
    // 容器需要监听网络接口；本地开发默认仍绑定回环地址。
    hostname: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 62586),
  });

  // 端口被占用等错误会触发 error 事件；这里让启动显式失败，并释放已打开的数据库
  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once('error', rejectListening);
      server.once('listening', resolveListening);
    });
  } catch (error) {
    await storage.close();
    throw error;
  }

  return {
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        void storage.close().then(() => error ? rejectClose(error) : resolveClose(), rejectClose);
      });
    }),
  };
}

/** 命令行入口：启动服务，并在收到 Ctrl+C / 终止信号时优雅关闭。 */
async function runServer(): Promise<void> {
  const server = await startServer();
  console.info(`Hono API listening at ${serverURL}`);
  const shutdown = () => void server.close().catch(console.error);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

// 仅当本文件被直接运行（pnpm dev / node dist/index.js）时才启动；被测试 import 时不会自动启动
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void runServer().catch((error: unknown) => {
    console.error('Failed to start the Hono API.', error);
    process.exitCode = 1;
  });
}
