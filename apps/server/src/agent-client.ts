import { randomUUID } from 'node:crypto';
import {
  parseJsonEventStream,
  uiMessageChunkSchema,
  type UIMessageChunk,
} from 'ai';
import { userQuestionSchema, type AgentServiceRequest, type UserQuestion, type UserAnswer } from '@agent3d/shared';

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

/** 上游明确限流时，给客户端可理解的提示，不泄露完整的上游异常和请求内容。 */
export class AgentRateLimitError extends Error {
  constructor() {
    super('模型服务当前限流，请稍后重试或切换服务商。');
    this.name = 'AgentRateLimitError';
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
  confirmTool?: (approvalId: string) => Promise<boolean>,
  answerQuestion?: (questionId: string, question: UserQuestion) => Promise<UserAnswer>,
  agentFetch: typeof fetch = fetch,
): AsyncGenerator<UIMessageChunk> {
  const latestMessage = request.messages.at(-1);
  // routes/chat.ts 已把数据库历史整理成 role/content。这里再转为 chatRoute 接受的
  // UIMessage：文本放进 text part，当前轮图片放进 file part，内容使用 data URL。
  // Desktop 的图片预览 URL 需要本地登录 Cookie，因此给模型的图片使用这里读取的实际字节。
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

  // 一个聊天轮次可经过多次 Mastra 暂停/恢复，对外仍然是同一条原生 SSE 流。
  // 下面的 while 每循环一次，会向 Agent 发出一次 POST 并读完该次上游响应。
  // Agent 暂停时，这个上游响应可以结束，Desktop → Server 的响应仍在 execute 中等待。
  // approvalMessages 用于原生工具审批恢复；continuation 用于 ask-user 的运行时暂停恢复。
  let approvalMessages: unknown[] = messages;
  let continuation: { runId: string; toolCallId: string; resumeData: UserAnswer } | undefined;
  const answeredQuestions = new Set<string>();
  while (true) {
    let response: Response;
    try {
      response = await agentFetch(agentURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          messages: approvalMessages,
          // 历史已由 Server 整理并保存到 Mastra 原生表。lastMessages:false 只关闭读取，
          // 必须同时设 readOnly:true 才不会重复写入模型内部的用户/工具消息。
          // 但保留 thread/resource 关联，让 Trace、暂停快照和工作记忆都指向正确的会话/用户。
          ...(request.conversationId && request.resourceId ? {
            memory: { thread: request.conversationId, resource: request.resourceId, options: { lastMessages: false, readOnly: true } },
          } : {}),
          ...continuation,
          // messages 是对话内容；agent3d 是本次调用所需的应用配置和工具上下文。
          // Agent 的路由中间件会把 agent3d 写入 Mastra RequestContext。
          // 图片完整 data URL 已在 file part，这里只传文件名/类型，避免重复传输图片字节。
          agent3d: {
            toolApproval: request.toolApproval,
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

    const inputs = new Map<string, { toolName: string; input: unknown }>();
    const approvals: { approvalId: string; toolCallId: string; decision: Promise<boolean> }[] = [];
    let question: { runId: string; toolCallId: string; answer: Promise<UserAnswer> } | undefined;
    for await (const event of parseJsonEventStream({
      stream: response.body,
      schema: uiMessageChunkSchema,
    })) {
      // 网络 read() 返回的是任意大小的字节片段，可能半个事件，也可能包含多个事件。
      // parseJsonEventStream 负责按 SSE 边界拆出 JSON，schema 检查事件能否被 AI SDK 消费。
      // yield 交给 routes/chat.ts 转发；它不是等待用户输入的地方。
      if (!event.success) {
        throw new Error('The Agent service returned an invalid stream chunk.');
      }
      // Agent 内部失败会以 error chunk 形式出现在流里，不透传上游可能包含密钥的错误。
      if (event.value.type === 'error') {
        if (event.value.errorText === 'PROVIDER_RATE_LIMITED') throw new AgentRateLimitError();
        throw new Error('The Agent service could not complete the request.');
      }
      const chunk = event.value;
      if (chunk.type === 'tool-input-available') inputs.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input });
      if (chunk.type === 'tool-approval-request') {
        if (!confirmTool) throw new Error('Tool approval handler is missing.');
        // 先注册再推送，用户立即点击确认也能找到对应请求。恢复要等原始流保存完暂停快照。
        const decision = confirmTool(chunk.approvalId);
        void decision.catch(() => {}); // 用户停止时原始流可能仍在关闭，避免未处理的 Promise 拒绝。
        approvals.push({ approvalId: chunk.approvalId, toolCallId: chunk.toolCallId, decision });
      }
      if (chunk.type === 'data-tool-call-suspended') {
        const data = chunk.data as { runId: string; toolCallId: string; toolName: string; suspendPayload: unknown };
        const questionId = data.runId + '::' + data.toolCallId;
        // Mastra 恢复流可能重放旧的暂停事件。同一问题只等待一次答案。
        if (answeredQuestions.has(questionId)) { yield chunk; continue; }
        if (data.toolName !== 'ask-user' || !answerQuestion || question) throw new Error('Unsupported suspended tool.');
        const answer = answerQuestion(questionId, userQuestionSchema.parse(data.suspendPayload));
        // 回调立刻在 routes/chat.ts 的 Map 中登记 resolve，再返回一个尚未完成的 Promise。
        // 此处仅保存 Promise，随后 yield 会先把问题送到桌面，用户才有机会提交答案。
        void answer.catch(() => {});
        question = { runId: data.runId, toolCallId: data.toolCallId, answer };
      }
      yield chunk;
    }
    if (question) {
      // 这里是“另一个 HTTP 请求如何让 chat 继续”的实际等待点。
      // await 挂起本次函数，Node 仍能处理 /chat/answer。那个路由调用登记好的 resolve，
      // question.answer 就变成已完成，await 得到 { answer: 用户输入 }，继续执行下面的代码。
      // 此时本次 Agent 响应已经读完，Mastra 的暂停快照也已准备好，才可以发起恢复。
      continuation = { runId: question.runId, toolCallId: question.toolCallId, resumeData: await question.answer };
      answeredQuestions.add(question.runId + '::' + question.toolCallId);
      approvalMessages = messages;
      // 回到 while 开头发送带 runId/toolCallId/resumeData 的新 POST。
      // chatRoute 看到 resumeData 后调用 agent.resumeStream，恢复这个工具和它所在的运行。
      continue;
    }
    if (!approvals.length) return;
    continuation = undefined;
    const parts = [];
    for (const approval of approvals) {
      const tool = inputs.get(approval.toolCallId);
      if (!tool) throw new Error('Approval has no matching tool input.');
      const approved = await approval.decision;
      // 审批走 Mastra AI SDK 另一条原生恢复入口。它会从 approval-responded part 中
      // 拆出 approval.id 里的 runId/toolCallId，再按 approved 决定执行或拒绝工具。
      parts.push({
        type: 'dynamic-tool', toolName: tool.toolName, toolCallId: approval.toolCallId,
        input: tool.input, state: 'approval-responded',
        approval: {
          id: approval.approvalId, approved,
          ...(!approved ? { reason: '用户拒绝本次工具调用，请停止当前操作并说明未执行，不要换工具重试。' } : {}),
        },
      });
    }
    approvalMessages = [...messages, { id: randomUUID(), role: 'assistant', parts }];
  }
}
