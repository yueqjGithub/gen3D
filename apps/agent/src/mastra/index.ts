import type { MiddlewareHandler } from '@mastra/core/server';
import { chatRoute } from '@mastra/ai-sdk';
import { Mastra } from '@mastra/core/mastra';
import { agent } from './agents/agent';

import { agentChatRequestContextSchema } from '@agent3d/shared';
import { LibSQLStore } from "@mastra/libsql";
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Mastra dev 的子进程工作目录是 public，MASTRA_PROJECT_ROOT 指向 Agent 工程根目录。
// 普通启动时 pnpm 会在 apps/agent 下运行，因此可使用当前工作目录。
const dataDirectory = process.env.AGENT3D_DATA_DIR;
if (!dataDirectory || !isAbsolute(dataDirectory)) {
  throw new Error('AGENT3D_DATA_DIR must be an absolute path. Set it in the repository root .env.');
}
mkdirSync(dataDirectory, { recursive: true });

export const mastra = new Mastra({
  // 保留运行时包目录：Playwright/原生 esbuild 和浏览器侧 Three.js 打包依赖这些实际文件。
  bundler: { externals: ['playwright', 'esbuild', 'three'], dynamicPackages: ['three'] },
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
    host: process.env.AGENT3D_AGENT_HOST ?? '127.0.0.1',
    port: 62687,
    cors: false,
    apiRoutes: [
      {
        ...chatRoute({
          path: '/chat/:agentId',
          version: 'v7',
          sendReasoning: true,
        }),
        middleware: (async (context: Parameters<MiddlewareHandler>[0], next: Parameters<MiddlewareHandler>[1]) => {
          // Mastra 已为每个请求创建 RequestContext，直接向其中写入业务数据。
          const body = await context.req.json();
          // HTTP 请求体进入 Agent 的入口。
          // messages、runId、toolCallId、resumeData 由 chatRoute 按 Mastra 原生协议读取。
          // agent3d 属于本项目的配置，单独校验后放入本次请求独有的 requestContext，
          // 供动态 model、工具和 defaultOptions 读取。每次恢复请求也要带上这份配置。
          const agent3d = agentChatRequestContextSchema.parse(body.agent3d);
          context.get('requestContext').set('agent3d', agent3d);
          // 修改时必须能找到上一版源码，不能仅凭 Agent 口头声称“已生成”判断。
          context.get('requestContext').set('hasExistingModel', Array.isArray(body.messages) && body.messages.some(
            (message: { role: string; parts?: { type: string; text?: string }[] }) =>
              message.role === 'assistant' && message.parts?.some(part =>
                part.type === 'text' && part.text?.includes('上一版模型完整数据：')),
          ));
          await next();
        }) as MiddlewareHandler,
      },
    ],
  },
});
