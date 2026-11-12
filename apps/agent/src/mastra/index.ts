import { chatRoute } from '@mastra/ai-sdk';
import { Mastra } from '@mastra/core/mastra';
import { agent } from './agents/agent';
import { agentChatRequestContextSchema } from '@agent3d/shared';
import { LibSQLStore } from "@mastra/libsql";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';

// Mastra dev 的子进程工作目录是 public，MASTRA_PROJECT_ROOT 指向 Agent 工程根目录。
// 普通启动时 pnpm 会在 apps/agent 下运行，因此可使用当前工作目录。
const dataDirectory = process.env.AGENT3D_DATA_DIR;
if (!dataDirectory || !isAbsolute(dataDirectory)) {
  throw new Error('AGENT3D_DATA_DIR in undefined');
}
mkdirSync(dataDirectory, { recursive: true });

export const mastra = new Mastra({
  agents: {
    [agent.id]: agent,
  },
  storage: new LibSQLStore({
    id: 'libsql-storage',
    url: `file:${join(dataDirectory, 'agent3d.sqlite')}`,
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: "mastra",
        exporters: [
          new MastraStorageExporter(), // Persists traces to storage for Mastra Studio
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
  server: {
    host: '127.0.0.1',
    port: 62687,
    cors: false,
    apiRoutes: [
      {
        ...chatRoute({
          path: '/chat/:agentId',
          version: 'v7',
          sendReasoning: true,
        }),
        middleware: async (context, next) => {
          // Mastra 已为每个请求创建 RequestContext，直接向其中写入业务数据。
          const body = await context.req.json();
          const agent3d = agentChatRequestContextSchema.parse(body.agent3d);
          context.get('requestContext').set('agent3d', agent3d);
          await next();
        },
      },
    ],
  },
});
