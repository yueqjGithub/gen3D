import { readUIMessageStream, type UIMessageChunk } from 'ai';
import {
  apiErrorSchema,
  assetArtifactSchema,
  chatMessageSchema,
  conversationSchema,
  modelSelectionSchema,
  preferenceProposalSchema,
  uploadMetadataSchema,
  type ApiError,
  type ModelSelection,
} from '@agent3d/shared';
import { z } from 'zod';
import type { ArtifactDetails, ChatDataParts, ChatUIMessage, ModelSettings } from './types';

/** Hono 的错误响应同时保留错误码、是否可重试和 HTTP 状态码。 */
export class LocalApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiError['code'],
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LocalApiError';
  }
}

const scriptValidationSchema = z.object({
  ok: z.boolean(),
  code: z.string().optional(),
}).strict();

// 偏好是字符串键值对，读取和保存都会返回这一结构。
function parsePreferences(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The local API returned invalid preferences.');
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, preference]) => {
      if (typeof preference !== 'string') {
        throw new Error('The local API returned an invalid preference value.');
      }
      return [key, preference];
    }),
  );
}

// 未配置时沿用本地 Hono 地址。去掉末尾斜杠，拼接 /api 路径时只保留一个斜杠。
// Web 构建显式注入空字符串，使用当前站点的 origin。Electron 未配置时沿用本机地址。
// Web 的 JS 交给任何浏览器后，都应请求它正在访问的站点，不能请求访问者自己的 127.0.0.1。
const baseUrl = (import.meta.env.AGENT3D_SERVER_URL === ''
  ? window.location.origin
  : import.meta.env.AGENT3D_SERVER_URL?.trim() || 'http://127.0.0.1:62586').replace(/\/+$/, '');

// 普通 JSON 接口共用请求与错误处理；下载文件和聊天流分别使用自己的响应方式。
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api${path}`, { ...init, credentials: 'include' });
  if (response.status === 204) {
    return undefined;
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    const error: ApiError = parsed.success
      ? parsed.data
      : {
        code: 'INTERNAL_ERROR',
        message: 'The local API request failed.',
        retryable: false,
      };
    throw new LocalApiError(error.message, error.code, error.retryable, response.status);
  }
  return body;
}

// 资产详情不仅用于面板，也用于把历史消息中的资产 ID 还原成完整资产。
async function getArtifact(id: string): Promise<ArtifactDetails> {
  const response = await request(`/artifacts/${encodeURIComponent(id)}`);
  const result = response as { artifact: unknown; scriptValidation: unknown };
  return {
    artifact: assetArtifactSchema.parse(result.artifact),
    scriptValidation: scriptValidationSchema.parse(result.scriptValidation),
  };
}

// 界面直接使用同一个 API 对象，不再创建客户端或逐层传递实例。
export const api = {
  // questionId 由 Mastra 的 runId 和 toolCallId 组成，精确定位这一次暂停的提问。
  // 这里只传用户答案；模型配置、源码及聊天历史仍属于原先那一轮聊天。
  // Server 收到后唤醒原请求中的等待点，204 表示答案已接收，建模可能仍在继续。
  async answerQuestion(questionId: string, answer: string) {
    await request('/chat/answer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId, answer }),
    });
  },
  async confirmTool(approvalId: string, approved: boolean) {
    await request('/chat/tool-approval', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, approved }),
    });
  },
  baseUrl,
  async currentUser() {
    const response = await request('/login');
    return z.object({ username: z.string() }).parse(response).username;
  },
  async login(username: string, password: string) {
    const response = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return z.object({ username: z.string() }).parse(response).username;
  },
  async changePassword(username: string, oldPassword: string, newPassword: string) {
    await request('/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, oldPassword, newPassword }),
    });
  },
  async listConversations() {
    const response = await request('/conversations');
    return conversationSchema.array().parse((response as { conversations: unknown }).conversations);
  },
  async createConversation(title = 'New conversation') {
    const response = await request('/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return conversationSchema.parse((response as { conversation: unknown }).conversation);
  },
  async renameConversation(id: string, title: string) {
    const response = await request(`/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return conversationSchema.parse((response as { conversation: unknown }).conversation);
  },
  async deleteConversation(id: string) {
    await request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  // 数据库的消息与 UI 无关；在这里转换成 useChat 所需的 parts。
  // 资产消息只存 ID，需要请求详情以获得最新版本和审批状态。
  async getMessages(conversationId: string): Promise<ChatUIMessage[]> {
    const response = await request(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    const parsed = response as { messages: unknown };
    const messages = chatMessageSchema.array().parse(parsed.messages);

    return Promise.all(messages.map(async (message) => {
      const parts: ChatUIMessage['parts'] = [];
      const hasNativeText = message.parts.some(part => part.type === 'ui-chunk' && part.chunk.type === 'text-start');
      for (const [index, part] of message.parts.entries()) {
        if (part.type === 'text' || part.type === 'reasoning') {
          if (!hasNativeText) parts.push(part);
        } else if (part.type === 'tool-activity') {
          const activity: ChatDataParts['activity'] = {
            toolCallId: `${message.id}-${index}`,
            toolName: part.toolName,
            state: part.state,
          };
          parts.push({ type: 'data-activity', id: activity.toolCallId, data: activity });
        } else if (part.type === 'attachment') {
          parts.push({
            type: 'data-attachment',
            id: part.attachmentId,
            data: {
              url: baseUrl + '/api/conversations/' + conversationId + '/attachments/' + part.attachmentId,
              id: part.attachmentId,
              fileName: part.fileName,
              mediaType: part.mediaType,
            },
          });
        } else if (part.type === 'asset') {
          const details = await getArtifact(part.artifactId);
          parts.push({
            type: 'data-asset',
            id: details.artifact.id,
            data: details.artifact,
          });
        } else if (part.type === 'preference-proposal') {
          const proposal = preferenceProposalSchema.parse(part.proposal);
          parts.push({ type: 'data-preference', data: proposal });
        }
      }

      const chunks = message.parts.flatMap(part => part.type === 'ui-chunk' ? [part.chunk as UIMessageChunk] : []);
      // 历史恢复使用 AI SDK 同一个事件归并器。它把输入、暂停和输出事件合并到同一工具
      // part 中，也还原 data-tool-call-suspended，所以问题卡片及最终答案能够一起回显。
      if (chunks.length) {
        const stream = new ReadableStream<UIMessageChunk>({ start(controller) {
          controller.enqueue({ type: 'start', messageId: message.id });
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.enqueue({ type: 'finish' }); controller.close();
        }});
        let restored: ChatUIMessage | undefined;
        for await (const snapshot of readUIMessageStream<ChatUIMessage>({ stream })) restored = snapshot;
        if (restored) parts.unshift(...restored.parts);
      }
      return {
        id: message.id,
        role: message.role,
        metadata: { persistedStatus: message.status, clientTurnId: message.clientTurnId },
        parts,
      };
    }));
  },
  async uploadAttachment(conversationId: string, file: File) {
    // FormData 自动生成 multipart 边界，不要手动设置 Content-Type。
    const form = new FormData();
    form.set('file', file);
    const response = await request(
      `/conversations/${encodeURIComponent(conversationId)}/attachments`,
      { method: 'POST', body: form },
    );
    return uploadMetadataSchema.parse((response as { attachment: unknown }).attachment);
  },
  getArtifact,
  async saveModel(id: string, expectedVersion: number, bytes: ArrayBuffer) {
    await request(`/artifacts/${encodeURIComponent(id)}/model?expectedVersion=${expectedVersion}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes,
    });
  },
  async updateArtifact(id: string, expectedVersion: number, script: string) {
    // expectedVersion 交给服务端做乐观锁检查，避免覆盖别处的新版本。
    const response = await request(`/artifacts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion, script }),
    });
    const result = response as { artifact: unknown; scriptValidation: unknown };
    return {
      artifact: assetArtifactSchema.parse(result.artifact),
      scriptValidation: scriptValidationSchema.parse(result.scriptValidation),
    };
  },
  async approveArtifact(id: string, expectedVersion: number) {
    const response = await request(
      `/artifacts/${encodeURIComponent(id)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion }),
      },
    );
    return assetArtifactSchema.parse((response as { artifact: unknown }).artifact);
  },
  async rejectArtifact(id: string, expectedVersion: number) {
    const response = await request(
      `/artifacts/${encodeURIComponent(id)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion }),
      },
    );
    return assetArtifactSchema.parse((response as { artifact: unknown }).artifact);
  },
  async downloadArtifact(id: string) {
    // 下载返回二进制 Blob，而不是 JSON；失败时仍按普通 API 错误解析。
    const response = await fetch(
      `${baseUrl}/api/artifacts/${encodeURIComponent(id)}/download`,
      { credentials: 'include' },
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const parsed = apiErrorSchema.safeParse(body);
      const error = parsed.success
        ? parsed.data
        : { code: 'INTERNAL_ERROR' as const, message: 'The local API request failed.', retryable: false };
      throw new LocalApiError(error.message, error.code, error.retryable, response.status);
    }
    return response.blob();
  },
  async getModelSettings() {
    const response = await request('/models');
    const result = response as { providers: ModelSettings['providers']; selection: unknown };
    return {
      providers: result.providers,
      selection: modelSelectionSchema.parse(result.selection),
    };
  },
  async saveModelSettings(selection: ModelSelection) {
    const response = await request('/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection),
    });
    return modelSelectionSchema.parse((response as { selection: unknown }).selection);
  },
  async getPreferences() {
    const response = await request('/preferences');
    const values = (response as { preferences: unknown }).preferences;
    return parsePreferences(values);
  },
  async savePreference(key: string, value: string) {
    const response = await request('/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    const values = (response as { preferences: unknown }).preferences;
    return parsePreferences(values);
  },
  async deletePreference(key: string) {
    await request('/preferences', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
  },
};
