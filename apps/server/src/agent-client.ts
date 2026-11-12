import { randomUUID } from 'node:crypto';
import {
  parseJsonEventStream,
  uiMessageChunkSchema,
  type UIMessageChunk,
} from 'ai';
import type { AgentServiceRequest } from '@agent3d/shared';

// Mastra 原生 chatRoute 的地址：端口在 apps/agent 的 Mastra server 配置中固定为 62687，
// 路径中的 asset-creation-agent 是 Agent 的 id
const agentURL = process.env.AGENT_URL ?? 'http://127.0.0.1:62687/chat/asset-creation-agent';

/** 无法连接到 Agent 服务（通常是 apps/agent 没有启动），属于可重试错误。 */
export class AgentServiceUnavailableError extends Error {
  constructor() {
    super('The Agent service is unavailable. Retry the request.');
    this.name = 'AgentServiceUnavailableError';
  }
}

/**
 * 调用 Mastra 原生 chat 路由，并把响应的 SSE 解析为 UI message chunk。
 * 这是 Hono 与 Agent 之间唯一的通信点：
 *  - 请求体里的 messages 是 AI SDK 的 UIMessage 格式
 *  - agent3d 由 Agent 路由中间件放入 Mastra 的 requestContext（模型、文档、偏好等）
 *  - 响应是 SSE 流，用 parseJsonEventStream 按 uiMessageChunkSchema 校验后逐块 yield
 */
export async function* streamAgent(
  request: AgentServiceRequest,
  signal: AbortSignal,
): AsyncGenerator<UIMessageChunk> {
  const latestMessage = request.messages.at(-1);
  const messages = request.messages.map((message) => ({
    id: randomUUID(),
    role: message.role,
    parts: [
      { type: 'text' as const, text: message.content },
      // 图片只随最后一条用户消息发送
      ...(message === latestMessage
        ? request.images.map((image) => ({
          type: 'file' as const,
          filename: image.fileName,
          mediaType: image.mediaType,
          url: image.dataUrl,
        }))
        : []),
    ],
  }));

  let response: Response;
  try {
    response = await fetch(agentURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        messages,
        agent3d: {
          model: request.model,
          apiKey: request.apiKey,
          latestUserText: latestMessage?.content ?? '',
          documents: request.documents,
          images: request.images.map(({ fileName, mediaType }) => ({ fileName, mediaType })),
          preferences: request.preferences,
        },
      }),
      signal,
    });
  } catch (error) {
    // 用户主动取消时原样抛出 AbortError，其余网络错误统一视为 Agent 不可用
    if (signal.aborted) {
      throw error;
    }
    throw new AgentServiceUnavailableError();
  }

  if (!response.ok || !response.body) {
    throw new Error('The Agent service rejected the request.');
  }

  for await (const event of parseJsonEventStream({
    stream: response.body,
    schema: uiMessageChunkSchema,
  })) {
    if (!event.success) {
      throw new Error('The Agent service returned an invalid stream chunk.');
    }
    // Agent 内部失败会以 error chunk 形式出现在流里，不透传上游可能包含密钥的错误。
    if (event.value.type === 'error') {
      throw new Error('The Agent service could not complete the request.');
    }
    yield event.value;
  }
}
