import type { MiddlewareHandler } from '@mastra/core/server';
import { chatRoute } from '@mastra/ai-sdk';
import { Mastra } from '@mastra/core/mastra';
import { createAssetAgent } from './agents/agent';
import { generateThreeModel } from './tools/generate-three-model';

import { agentChatRequestContextSchema } from '@agent3d/shared';
import { PostgresStore } from '@mastra/pg';
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// 本机开发和服务器部署使用同一套 PostgreSQL 存储，不再选择另一套 SQLite。
// dev 子进程工作目录会改变，因此 CA 证书路径需要明确配置为绝对路径。
function configuredStorage() {
  if (process.env.DATABASE_URL) {
    // Studio 可直接读取云端原生表和 Trace。此连接只在本机运行，不把 Studio 管理接口公开到外网。
    const url = new URL(process.env.DATABASE_URL);
    url.port = '5432';
    url.searchParams.delete('sslmode');
    // Mastra dev 子进程的工作目录会变化，所以证书与本地数据目录一样使用显式绝对路径。
    const caPath = process.env.SUPABASE_CA_PATH;
    if (!caPath || !isAbsolute(caPath)) throw new Error('Set SUPABASE_CA_PATH to the absolute path of the Supabase CA certificate.');
    return new PostgresStore({
      id: 'supabase-storage', connectionString: url.toString(), schemaName: 'agent3d', max: 2,
      ssl: { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true },
      // 云端表已由部署步骤初始化，Studio 只需使用它们，不重复执行建表迁移。
      disableInit: true,
    });
  }
  throw new Error('Missing DATABASE_URL. Configure the repository root .env.supabase.');
}

// Agent 独立运行，仅准备源码；执行和 GLB 导出由客户端 iframe 完成。
const agent = createAssetAgent(generateThreeModel);

export const mastra = new Mastra({
  // esbuild 只做生成脚本的 TS 语法转换；不在 Agent 中执行 Three.js 或启动浏览器。
  bundler: { externals: ['esbuild'] },
  agents: {
    [agent.id]: agent,
  },
  storage: configuredStorage(),
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
          onError: error => /429|too many requests|rate.?limit/i.test(String(error))
            ? 'PROVIDER_RATE_LIMITED' : 'AGENT_STREAM_FAILED',
        }),
        middleware: (async (context: Parameters<MiddlewareHandler>[0], next: Parameters<MiddlewareHandler>[1]) => {
          // Mastra 已为每个请求创建 RequestContext，直接向其中写入业务数据。
          const body = await context.req.json();
          // HTTP 请求体进入 Agent 的入口。
          // messages、runId、toolCallId、resumeData 由 chatRoute 按 Mastra 原生协议读取。
          // agent3d 属于本项目的配置，单独校验后放入本次请求独有的 requestContext，
          // 供动态 model、工具和 defaultOptions 读取。每次恢复请求也要带上这份配置。
          const agent3d = agentChatRequestContextSchema.parse(body.agent3d);
          context.get('requestContext').set('agent3d', { ...agent3d, apiKey: '[provided-per-request]' });
          context.get('requestContext').set('getAgentApiKey', () => agent3d.apiKey);
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
