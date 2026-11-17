import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  agentServiceRequestSchema,
  chatMessageSchema,
  modelConfigSchema,
  MAX_CONVERSATION_ATTACHMENTS,
  validateAssetScript,
  userAnswerSchema,
  type UserAnswer,
  type AgentOutput,
  type AgentServiceRequest,
  type ChatMessage,
  type ModelConfig,
  type PersistedMessagePart,
  type UploadMetadata,
} from '@agent3d/shared';
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from 'ai';
import { z } from 'zod';
import {
  AgentServiceUnavailableError,
  streamAgent,
} from '../agent-client';
import { providerCatalog } from '../config/provider-catalog';
import { prepareConversationInput } from '../attachments/prepare-conversation-input';
import type { AttachmentStore } from '../storage/attachments';
import type { createArtifactRepository } from '../storage/artifacts';
import type { createConversationRepository } from '../storage/conversations';
import { ChatTurnConflictError } from '../storage/conversations';
import { HttpError } from '../http-errors';
import {
  type ChatDataParts,
  type ChatUIMessage,
  type ChatUIMessageChunk,
} from '../streaming/agent-ui-stream';
import type { createSettingsRepository } from '../config/settings-repository';
import type { PreferenceRepository } from '../storage/preferences';

type ConversationRepository = ReturnType<typeof createConversationRepository>;
type ArtifactRepository = ReturnType<typeof createArtifactRepository>;
type SettingsRepository = ReturnType<typeof createSettingsRepository>;

// 以下 schema 校验渲染进程提交的请求体。useChat 会把整段消息历史一起发来，
// 但服务端只使用最后一条用户消息，历史以数据库为准，避免客户端伪造历史。
const textPartSchema = z.object({
  type: z.literal('text'),
  text: z.string().max(8000),
});
const filePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().max(100).optional(),
  filename: z.string().max(255).optional(),
  url: z.string().max(15 * 1024 * 1024).optional(),
});
const attachmentReferenceSchema = z.object({
  type: z.literal('data-attachment'),
  data: z.object({
    id: z.uuid(),
    url: z.string().optional(),
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(100),
  }).strict(),
});
const submittedMessageSchema = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(['system', 'user', 'assistant']),
  parts: z.array(z.unknown()).max(100),
});
// 聊天请求：clientTurnId 由前端为每一轮生成，重试同一轮时保持不变，服务端据此做幂等（见 beginTurn）
const chatRequestSchema = z.object({
  toolApproval: z.enum(['manual', 'auto']).default('manual'),
  conversationId: z.uuid(),
  clientTurnId: z.uuid(),
  // 只接收本轮用户消息；历史消息由服务端从数据库读取
  messages: z.array(submittedMessageSchema).length(1),
  attachmentIds: z.array(z.uuid()).max(MAX_CONVERSATION_ATTACHMENTS),
  model: modelConfigSchema,
  apiKey: z.string().trim().min(1).max(4096),
}).strict();

export interface ChatRouteDependencies {
  conversations: ConversationRepository;
  artifacts: ArtifactRepository;
  attachments: AttachmentStore;
  preferences: PreferenceRepository;
  settings: SettingsRepository;
}

/**
 * 整理下一轮模型需要的历史内容。正常文本直接保留，工具结果额外带回源码和用户答案。
 * 因此“换成红色”能够参考上一版 source，“按刚才选的材质继续”也能找到之前的答案。
 * 工具事件的完整 UI 展示历史由 ui-chunk 保存，这里得到的文本供下一轮模型理解上下文。
 */
function messageText(message: ChatMessage): string {
  return message.parts
    .flatMap(part => {
      if (part.type === 'text') return [part.text];
      if (part.type !== 'ui-chunk' || part.chunk.type !== 'tool-output-available') return [];
      const output = part.chunk.output as { script?: string; answer?: string } | undefined;
      if (typeof output?.script === 'string') return ['上一版模型完整数据：' + output.script];
      if (typeof output?.answer === 'string') return ['用户对需求问题的回答：' + output.answer];
      return [];
    })
    .join('\n');
}

/**
 * 解析并校验用户本轮提交的消息：
 *  - 最后一条必须是用户消息
 *  - 附件引用必须属于当前会话，且文件名、类型与数据库记录一致
 *  - 文本和附件不能同时为空
 * 返回纯文本（发给 Agent）和要持久化的消息片段。
 */
function readSubmittedTurn(
  messages: z.infer<typeof submittedMessageSchema>[],
  attachmentIds: string[],
  availableAttachments: UploadMetadata[],
): { text: string; userParts: PersistedMessagePart[] } {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== 'user') {
    throw new HttpError(400, 'VALIDATION_FAILED', 'The last chat message must be from the user.');
  }

  const submittedParts = z.array(z.union([
    textPartSchema,
    filePartSchema,
    attachmentReferenceSchema,
  ])).max(30)
    .parse(lastMessage.parts);
  const textParts = submittedParts.flatMap((part) => part.type === 'text' ? [part.text] : []);
  const submittedFiles = submittedParts.filter((part) => part.type === 'file');
  const submittedReferences = submittedParts
    .filter((part) => part.type === 'data-attachment');
  if (
    (submittedFiles.length !== 0 && submittedFiles.length !== attachmentIds.length)
    || (submittedReferences.length !== 0 && submittedReferences.length !== attachmentIds.length)
  ) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'Uploaded file references do not match this request.');
  }
  const attachmentMap = new Map(availableAttachments.map((item) => [item.id, item]));
  const attachmentParts: PersistedMessagePart[] = attachmentIds.map((id, index) => {
    const metadata = attachmentMap.get(id);
    if (!metadata) {
      throw new HttpError(
        400,
        'ATTACHMENT_INVALID',
        'An attachment does not belong to this conversation.',
      );
    }

    const submittedFile = submittedFiles[index];
    const submittedReference = submittedReferences[index];
    if (
      submittedFile
      && (
        (submittedFile.filename && submittedFile.filename !== metadata.fileName)
        || (submittedFile.mediaType && submittedFile.mediaType !== metadata.mediaType)
      )
    ) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Uploaded file metadata does not match.');
    }
    if (
      submittedReference
      && (
        submittedReference.data.id !== id
        || submittedReference.data.fileName !== metadata.fileName
        || submittedReference.data.mediaType !== metadata.mediaType
      )
    ) {
      throw new HttpError(400, 'ATTACHMENT_INVALID', 'Uploaded attachment references do not match.');
    }

    return {
      type: 'attachment',
      attachmentId: metadata.id,
      fileName: metadata.fileName,
      mediaType: metadata.mediaType,
    };
  });
  const text = textParts.join('\n').trim();
  if (text.length > 8000) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'A chat message must not exceed 8000 characters.');
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new HttpError(400, 'ATTACHMENT_INVALID', 'Attachment IDs must be unique.');
  }
  if (!text && attachmentParts.length === 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Add a message or attach a file before sending.');
  }

  const userParts: PersistedMessagePart[] = [
    ...textParts.filter((part) => part.length > 0).map((textPart) => ({
      type: 'text' as const,
      text: textPart,
    })),
    ...attachmentParts,
  ];
  return { text, userParts };
}

/**
 * 构造发给 Agent 的消息列表：取最近 39 条已完成的历史消息，再加上本轮用户输入。
 * 失败后重试时，数据库里已存在本轮的用户消息，需要排除，避免重复。
 */
function toAgentMessages(
  history: ChatMessage[],
  currentText: string,
  currentTurnUserMessageId?: string,
): AgentServiceRequest['messages'] {
  const messages: AgentServiceRequest['messages'] = [];
  for (const message of history) {
    if (message.status !== 'complete' || message.id === currentTurnUserMessageId) {
      continue;
    }
    const text = messageText(message);
    if (!text) {
      continue;
    }
    messages.push({ role: message.role, content: text });
  }
  return [
    ...messages.slice(-39),
    { role: 'user', content: currentText },
  ];
}

/** 把已保存的一个消息片段重新写成流数据，用于重放已完成的轮次。 */
function appendStreamPart(
  writer: { write(part: ChatUIMessageChunk): void },
  part: PersistedMessagePart,
  artifact: ReturnType<ArtifactRepository['get']>,
): void {
  if (part.type === 'ui-chunk') {
    writer.write(part.chunk as unknown as ChatUIMessageChunk);
  } else if (part.type === 'text') {
    writer.write({ type: 'text-start', id: 'replay-text' });
    writer.write({ type: 'text-delta', id: 'replay-text', delta: part.text });
    writer.write({ type: 'text-end', id: 'replay-text' });
  } else if (part.type === 'reasoning') {
    writer.write({ type: 'reasoning-start', id: 'replay-reasoning' });
    writer.write({ type: 'reasoning-delta', id: 'replay-reasoning', delta: part.text });
    writer.write({ type: 'reasoning-end', id: 'replay-reasoning' });
  } else if (part.type === 'tool-activity') {
    const data: ChatDataParts['activity'] = {
      toolCallId: randomUUID(),
      toolName: part.toolName,
      state: part.state,
    };
    writer.write({ type: 'data-activity', id: data.toolCallId, data });
  } else if (part.type === 'asset' && artifact) {
    writer.write({ type: 'data-asset', id: artifact.id, data: artifact });
  } else if (part.type === 'preference-proposal') {
    writer.write({ type: 'data-preference', data: part.proposal });
  }
}

/**
 * 重试一个已经成功的 clientTurnId 时，不再调用模型，直接把保存的回复以流的形式重放。
 * 这样网络抖动导致的重复提交不会产生重复的回复或资产。
 */
function replayCompletedTurn(
  turn: ChatMessage,
  clientTurnId: string,
  artifactRepository: ArtifactRepository,
): Response {
  const stream = createUIMessageStream<ChatUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: 'start', messageId: turn.id });
      writer.write({ type: 'data-turn', data: { clientTurnId } });
      const nativeText = turn.parts.some(part => part.type === 'ui-chunk' && part.chunk.type === 'text-start');
      for (const part of turn.parts) {
        if (nativeText && (part.type === 'text' || part.type === 'reasoning')) continue;
        const artifact = part.type === 'asset'
          ? artifactRepository.get(part.artifactId)
          : null;
        appendStreamPart(writer, part, artifact);
      }
      writer.write({ type: 'finish', finishReason: 'stop' });
      writer.setOutcome({ status: 'completed' });
    },
    onError: () => 'The saved response could not be replayed.',
  });
  return createUIMessageStreamResponse({ stream });
}

/** 把流式过程中的异常转成可以展示给用户的提示；已知错误给出具体原因，其余用通用文案。 */
function safeStreamError(error: unknown): { message: string; code: 'STREAM_FAILED'; retryable: boolean } {
  if (error instanceof AgentServiceUnavailableError) {
    return {
      message: 'The Agent service is unavailable. Retry the request.',
      code: 'STREAM_FAILED',
      retryable: true,
    };
  }
  if (error instanceof HttpError) {
    return { message: error.message, code: 'STREAM_FAILED', retryable: true };
  }
  return {
    message: 'The model request failed. Check your model settings and retry.',
    code: 'STREAM_FAILED',
    retryable: true,
  };
}

/**
 * 聊天路由：POST /api/chat。完整流程：
 *  1. 校验请求，确认会话存在
 *  2. 幂等检查：同一 clientTurnId 已完成则重放，正在运行则返回冲突
 *  3. 读取当前选择的对话模型，准备附件（文档文本 / 图片）
 *  4. 记录本轮开始（beginTurn），调用 Agent 并把流转发给渲染进程
 *  5. 流结束后保存助手消息；失败则记录失败状态，允许用户重试
 */
export function createChatRoutes(dependencies: ChatRouteDependencies) {
  const {
    conversations,
    artifacts,
    attachments,
    preferences,
  } = dependencies;
  const routes = new Hono();
  // 这两张 Map 由 createChatRoutes 创建一次，同一个 Hono 路由实例下的 HTTP 请求共享它们。
  // /chat 在暂停时登记回调，/chat/answer 或 /chat/tool-approval 在用户提交时查出并调用。
  // Map 保存的是进程内的函数引用，SQLite 中的 Mastra 快照则保存 Agent 的暂停运行状态。
  // 两者各有用途：回调让当前 Server 请求继续，快照让 Mastra 恢复到正确的工具执行位置。
  // 断开、停止或失败会清理登记项。Server 重启后这些内存回调消失，旧页面不能继续提交。
  const pendingApprovals = new Map<string, {
    conversationId: string;
    decide(approved: boolean): void;
  }>();
  const pendingQuestions = new Map<string, {
    conversationId: string;
    answer(value: UserAnswer): void;
  }>();

  routes.post('/chat/answer', async context => {
    const body = z.object({ questionId: z.string().min(1), ...userAnswerSchema.shape }).strict().parse(await context.req.json());
    const question = pendingQuestions.get(body.questionId);
    if (!question || !conversations.get(question.conversationId, getCookie(context, 'username')!)) {
      throw new HttpError(404, 'NOT_FOUND', '此问题已结束或不属于当前用户。');
    }
    pendingQuestions.delete(body.questionId);
    // 删除在前，确保同一答案只被接收一次；并校验会话归属，避免其他用户操作此运行。
    // answer 是下面 Promise 内登记的函数，内部 resolve(value) 会唤醒 agent-client.ts
    // 的 await question.answer。当前这个短 HTTP 请求随后回 204，聊天结果走原来的响应流。
    question.answer({ answer: body.answer });
    return context.body(null, 204);
  });

  routes.post('/chat/tool-approval', async context => {
    const decision = z.object({ approvalId: z.string().min(1), approved: z.boolean() }).strict().parse(await context.req.json());
    const pending = pendingApprovals.get(decision.approvalId);
    if (!pending || !conversations.get(pending.conversationId, getCookie(context, 'username')!)) {
      throw new HttpError(404, 'NOT_FOUND', '此工具确认已结束或不属于当前用户。');
    }
    pendingApprovals.delete(decision.approvalId);
    pending.decide(decision.approved);
    return context.body(null, 204);
  });

  routes.post('/chat', async (context) => {
    const body = chatRequestSchema.parse(await context.req.json());
    const conversation = conversations.get(body.conversationId, getCookie(context, 'username')!);
    if (!conversation) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested conversation does not exist.');
    }

    const input = readSubmittedTurn(
      body.messages,
      body.attachmentIds,
      attachments.listByConversation(conversation.id),
    );
    const userMessage = chatMessageSchema.parse({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      parts: input.userParts,
      createdAt: new Date().toISOString(),
      status: 'complete',
    });

    // 幂等：已完成的轮次直接重放；仍在运行的轮次拒绝重复提交
    const existing = conversations.getTurn(conversation.id, body.clientTurnId);
    if (existing?.state === 'complete') {
      const replay = conversations.beginTurn(conversation.id, body.clientTurnId, userMessage);
      if (replay.assistantMessage) {
        return replayCompletedTurn(replay.assistantMessage, body.clientTurnId, artifacts);
      }
    }
    if (existing?.state === 'running') {
      conversations.beginTurn(conversation.id, body.clientTurnId, userMessage);
      throw new ChatTurnConflictError(body.clientTurnId);
    }

    // 每次请求携带当前选择和密钥，服务端只转发，不保存密钥。
    const selectedModel = body.model;
    const provider = Object.values(providerCatalog)
      .find(({ id }) => id === selectedModel.providerId);
    if (!provider?.models.chat.includes(selectedModel.modelId)) {
      throw new HttpError(400, 'PROVIDER_ERROR', 'The selected provider or model is not supported.');
    }
    const model: ModelConfig = {
      providerId: selectedModel.providerId,
      modelId: selectedModel.modelId,
      baseURL: new URL(selectedModel.baseURL).toString().replace(/\/$/, ''),
    };
    const preparedInput = await prepareConversationInput(
      attachments,
      conversation.id,
      body.attachmentIds,
      provider.supportsInlineImages,
    );
    // 汇总一次 Agent 请求需要的全部上下文：模型、历史消息、附件内容和用户偏好。
    // Desktop 只提交当前消息和附件 ID。Server 校验归属后从数据库补历史/偏好，从磁盘
    // 读取图片或提取文档文本，得到独立于 UI 展示格式的 AgentServiceRequest。
    // shared schema 描述本项目的 HTTP 入参约束，例如长度上限、模型配置和确认模式默认值。
    const history = conversations.listMessages(conversation.id);
    const agentRequest = agentServiceRequestSchema.parse({
      toolApproval: body.toolApproval,
      model,
      apiKey: body.apiKey,
      messages: toAgentMessages(
        history,
        input.text,
        existing?.state === 'failed' ? existing.userMessage.id : undefined,
      ),
      documents: preparedInput.documents,
      images: preparedInput.images,
      preferences: Object.entries(preferences.list(getCookie(context, 'username')!)).map(([key, value]) => ({ key, value })),
    });

    // 在真正调用模型前把本轮标记为 running（并保存用户消息），崩溃后可据此重试
    const turn = conversations.beginTurn(conversation.id, body.clientTurnId, userMessage);
    if (turn.state === 'complete' && turn.assistantMessage) {
      return replayCompletedTurn(turn.assistantMessage, body.clientTurnId, artifacts);
    }
    if (turn.state === 'running') {
      throw new ChatTurnConflictError(body.clientTurnId);
    }

    const assistantMessageId = turn.assistantMessage?.id ?? randomUUID();
    // createUIMessageStream 创建 Desktop 这次 POST /api/chat 的长响应。
    // execute 尚未返回时，用户可以另外提交答案，Server 也可以多次向 Agent 请求恢复。
    // writer 始终写入这同一条响应，所以 useChat 持续消费它便能收到恢复后的内容。
    const stream = createUIMessageStream<ChatUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start', messageId: assistantMessageId });
        // 先告知前端本轮的 clientTurnId，便于它在失败后用同一个 id 重试
        writer.write({ type: 'data-turn', data: { clientTurnId: body.clientTurnId } });
        const persistedParts: PersistedMessagePart[] = [];
        let output: AgentOutput | undefined;

        let streamedReply = '';

        const toolNamesByCallId = new Map<string, string>();
        const lifecycle = new AbortController();
        // 反向代理通常会回收长期没有字节传输的连接。等待人工回答时发送瞬时心跳，
        // AI SDK 不把它加入消息历史，模型也不会收到这类事件。
        const heartbeat = setInterval(() => {
          writer.write({ type: 'data-heartbeat', data: null, transient: true });
        }, 15000);
        // 用户停止/断开时由请求 signal 取消；成功或失败收尾时由 lifecycle 取消。
        // 合并后的 signal 同时约束上游 fetch 和所有等待用户输入的 Promise。
        const executionSignal = AbortSignal.any([context.req.raw.signal, lifecycle.signal]);

        try {
          for await (const chunk of streamAgent(agentRequest, executionSignal, (approvalId) => {
            return new Promise<boolean>((resolve, reject) => {
              const signal = executionSignal;
              const abort = () => {
                pendingApprovals.delete(approvalId);
                reject(new DOMException('Request aborted.', 'AbortError'));
              };
              if (signal.aborted) { abort(); return; }
              pendingApprovals.set(approvalId, {
                conversationId: conversation.id,
                decide: approved => {
                  signal.removeEventListener('abort', abort);
                  resolve(approved);
                },
              });
              signal.addEventListener('abort', abort, { once: true });
            });
          }, (questionId) => {
            // answerQuestion 回调由 streamAgent 在收到暂停事件时调用。
            // new Promise 的构造函数立即执行，先把闭包中的 resolve 登记到 Map，
            // Promise 本身随后交给 streamAgent 保存并 await。
            return new Promise<UserAnswer>((resolve, reject) => {
              const abort = () => {
                pendingQuestions.delete(questionId);
                reject(new DOMException('Request aborted.', 'AbortError'));
              };
              if (executionSignal.aborted) { abort(); return; }
              pendingQuestions.set(questionId, {
                conversationId: conversation.id,
                answer: value => {
                  // value 来自另一次 POST /chat/answer。
                  // resolve 只让等待处可以继续；读取快照并执行后续步骤由 Mastra 完成。
                  executionSignal.removeEventListener('abort', abort);
                  resolve(value);
                },
              });
              executionSignal.addEventListener('abort', abort, { once: true });
            });
          })) {
            if (context.req.raw.signal.aborted) {
              throw new DOMException('Request aborted.', 'AbortError');
            }
            // AI SDK 原生事件直接交给 useChat，不提取 JSON、不重写工具事件。
            // 下面的读取仅用于保存历史和创建待审批资产，不改变转发的数据。
            if (chunk.type === 'abort') throw new Error('Agent aborted the request.');
            // 一个暂停/恢复过程有多段上游流，各段都有自己的 start/finish。
            // Desktop 应当看到一条助手消息，所以由 Server 在整轮最外层统一写 start/finish。
            if (chunk.type !== 'start' && chunk.type !== 'finish') writer.write(chunk as ChatUIMessageChunk);
            if (chunk.type === 'text-delta') streamedReply += chunk.delta;
            if (chunk.type === 'data-tool-call-suspended' || chunk.type === 'file' || chunk.type.startsWith('tool-') || chunk.type.startsWith('text-') || chunk.type.startsWith('reasoning-') || chunk.type === 'start-step' || chunk.type === 'finish-step') {
              persistedParts.push({ type: 'ui-chunk', chunk: { ...chunk } });
            }
            if (chunk.type === 'reasoning-delta') persistedParts.push({ type: 'reasoning', text: chunk.delta });
            if (chunk.type === 'tool-input-available') toolNamesByCallId.set(chunk.toolCallId, chunk.toolName);
            if (chunk.type === 'tool-output-available' && ['generate-three-model'].includes(toolNamesByCallId.get(chunk.toolCallId) ?? '')) {
              const result = chunk.output as { script?: string; validation?: string };
              if (result?.validation === 'passed' && typeof result.script === 'string') {
                output = { type: 'asset', brief: input.text.slice(0, 4000), script: result.script, blenderVersion: '4.x', preferenceProposals: [] };
              }
            }
          }
          if (context.req.raw.signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
          if (output?.type === 'asset' && validateAssetScript(output.script).ok) {
            // 工具成功导出 GLB 后，Server 创建可审批的业务资产，再额外发出 data-asset。
            // ChatView 监听这个 part 并调用 onArtifactChange，右侧面板据此切换到新资产。
            // 普通回复中说“已完成”不会触发这里，必须有成功的工具输出。
            const artifact = artifacts.createPending({ conversationId: conversation.id, brief: output.brief, script: output.script });
            writer.write({ type: 'data-asset', id: artifact.id, data: artifact });
            persistedParts.push({ type: 'asset', artifactId: artifact.id });
          }
          if (context.req.raw.signal.aborted) throw new DOMException('Request aborted.', 'AbortError');
          conversations.completeTurn(conversation.id, body.clientTurnId, {
            id: assistantMessageId, conversationId: conversation.id, role: 'assistant',
            parts: [{ type: 'text', text: streamedReply }, ...persistedParts],
            createdAt: new Date().toISOString(), status: 'complete',
          });
          writer.write({ type: 'finish', finishReason: 'stop' });
        } catch (error) {
          const failure = safeStreamError(error);
          conversations.failTurn(conversation.id, body.clientTurnId, {
            id: assistantMessageId, conversationId: conversation.id, role: 'assistant',
            parts: [{ type: 'text', text: failure.message }], createdAt: new Date().toISOString(), status: 'error',
          });
          writer.write({ type: 'error', errorText: failure.message });
        } finally {
          clearInterval(heartbeat);
          lifecycle.abort();
        }
      },
      onError: () => 'The model request failed. Check your model settings and retry.',
    });
    return createUIMessageStreamResponse({ stream });
  });
  return routes;
}

