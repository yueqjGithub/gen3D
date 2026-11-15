import { serve, type ServerType } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createApp } from './app';
import { createSettingsRepository } from './config/settings-repository';
import { createArtifactRepository } from './storage/artifacts';
import { createAttachmentStore } from './storage/attachments';
import { createConversationRepository } from './storage/conversations';
import { createDatabase } from './storage/database';
import { createPreferenceRepository } from './storage/preferences';
import { createLoginRepository } from './storage/login';

// Hono 固定监听的地址，Desktop 渲染进程直接请求这个地址（端口不可配置，便于学习）
const serverURL = 'http://127.0.0.1:62586';

/** startServer 的返回值：数据库文件位置，以及一个同时关闭 HTTP 服务和数据库的方法。 */
export interface StandaloneServer {
  databasePath: string;
  close(): Promise<void>;
}

/**
 * 启动流程：确定数据目录 → 打开 SQLite（自动迁移）→ 创建仓库和 Hono 应用 → 监听固定端口。
 * Agent 与 Server 使用 apps/agent/.env 指定的同一个绝对目录。
 * 测试可以传入独立目录，避免修改用户数据库。
 */
export async function startServer(
  dataDirectory = process.env.AGENT3D_DATA_DIR ?? parseEnv(readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8')).AGENT3D_DATA_DIR ?? '',
): Promise<StandaloneServer> {
  if (!isAbsolute(dataDirectory)) {
    throw new Error('AGENT3D_DATA_DIR in apps/agent/.env must be an absolute path.');
  }
  const databasePath = join(dataDirectory, 'agent3d.sqlite');
  const database = await createDatabase(databasePath);

  // 每个仓库都共用同一个数据库连接；附件文件本身存放在 data/attachments 目录
  const app = createApp({
    conversations: createConversationRepository(database.connection),
    artifacts: createArtifactRepository(database.connection),
    attachments: createAttachmentStore(
      database.connection,
      join(dataDirectory, 'data', 'attachments'),
    ),
    preferences: createPreferenceRepository(database.connection),
    settings: createSettingsRepository(database.connection),
    users: createLoginRepository(database.connection),
  });
  const server: ServerType = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 62586,
  });

  // 端口被占用等错误会触发 error 事件；这里让启动显式失败，并释放已打开的数据库
  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once('error', rejectListening);
      server.once('listening', resolveListening);
    });
  } catch (error) {
    database.close();
    throw error;
  }

  return {
    databasePath,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        database.close();
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
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
