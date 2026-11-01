import {
  apiErrorSchema,
  assetArtifactSchema,
  chatMessageSchema,
  conversationSchema,
  modelSelectionSchema,
  preferenceProposalSchema,
  uploadMetadataSchema,
  type ApiError,
  type AssetArtifact,
  type Conversation,
  type ModelSelection,
  type PreferenceProposal,
  type UploadMetadata,
} from '@agent3d/shared';
import { z } from 'zod';
import type { ArtifactDetails, ChatDataParts, ChatUIMessage, ModelSettings } from './types';

export interface DesktopBridge {
  platform: string;
  apiBaseUrl: string;
  apiToken: string;
}

export interface ApiClient {
  baseUrl: string;
  authHeaders(): Record<string, string>;
  fetch: typeof fetch;
  listConversations(): Promise<Conversation[]>;
  createConversation(title?: string): Promise<Conversation>;
  renameConversation(id: string, title: string): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  getMessages(conversationId: string): Promise<ChatUIMessage[]>;
  uploadAttachment(conversationId: string, file: File): Promise<UploadMetadata>;
  getArtifact(id: string): Promise<ArtifactDetails>;
  updateArtifact(id: string, expectedVersion: number, script: string): Promise<ArtifactDetails>;
  approveArtifact(id: string, expectedVersion: number): Promise<AssetArtifact>;
  rejectArtifact(id: string, expectedVersion: number): Promise<AssetArtifact>;
  downloadArtifact(id: string): Promise<Blob>;
  getModelSettings(): Promise<ModelSettings>;
  saveModelSettings(selection: ModelSelection): Promise<ModelSelection>;
  saveCredential(providerId: string, apiKey: string): Promise<void>;
  removeCredential(providerId: string): Promise<void>;
  getPreferences(): Promise<Record<string, string>>;
  savePreference(key: string, value: string): Promise<Record<string, string>>;
  deletePreference(key: string): Promise<void>;
}

declare global {
  interface Window {
    desktopApi?: DesktopBridge;
  }
}

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

function messageFromUnknown(error: unknown): string {
  const parsed = apiErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.message : 'The local API request failed.';
}

export function createApiClient(
  bridge: DesktopBridge | undefined = window.desktopApi,
  fetcher: typeof fetch = globalThis.fetch,
): ApiClient {
  if (!bridge?.apiBaseUrl || !bridge.apiToken) {
    throw new Error('The local API bridge is not ready. Restart the desktop application.');
  }

  const baseUrl = bridge.apiBaseUrl.replace(/\/+$/, '');
  const authHeaders = (): Record<string, string> => ({
    'X-Agent3D-Token': bridge.apiToken,
  });
  const fetchWithToken: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Agent3D-Token', bridge.apiToken);
    return fetcher(input, { ...init, headers });
  };

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchWithToken(`${baseUrl}/api${path}`, init);
    if (response.status === 204) {
      return undefined as T;
    }

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(body);
      const error: ApiError = parsed.success
        ? parsed.data
        : {
          code: 'INTERNAL_ERROR',
          message: messageFromUnknown(body),
          retryable: false,
        };
      throw new LocalApiError(error.message, error.code, error.retryable, response.status);
    }
    return body as T;
  }

  async function getArtifact(id: string): Promise<ArtifactDetails> {
    const response = await request<unknown>(`/artifacts/${encodeURIComponent(id)}`);
    const result = response as { artifact: unknown; scriptValidation: unknown };
    return {
      artifact: assetArtifactSchema.parse(result.artifact),
      scriptValidation: scriptValidationSchema.parse(result.scriptValidation),
    };
  }

  async function getMessages(conversationId: string): Promise<ChatUIMessage[]> {
    const response = await request<unknown>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    const parsed = response as { messages: unknown };
    const messages = chatMessageSchema.array().parse(parsed.messages);

    return Promise.all(messages.map(async (message) => {
      const parts: ChatUIMessage['parts'] = [];
      for (const [index, part] of message.parts.entries()) {
        if (part.type === 'text' || part.type === 'reasoning') {
          parts.push(part);
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

      return {
        id: message.id,
        role: message.role,
        metadata: { persistedStatus: message.status },
        parts,
      };
    }));
  }

  return {
    baseUrl,
    authHeaders,
    fetch: fetchWithToken,
    async listConversations() {
      const response = await request<unknown>('/conversations');
      return conversationSchema.array().parse((response as { conversations: unknown }).conversations);
    },
    async createConversation(title = 'New conversation') {
      const response = await request<unknown>('/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      return conversationSchema.parse((response as { conversation: unknown }).conversation);
    },
    async renameConversation(id, title) {
      const response = await request<unknown>(`/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      return conversationSchema.parse((response as { conversation: unknown }).conversation);
    },
    async deleteConversation(id) {
      await request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    getMessages,
    async uploadAttachment(conversationId, file) {
      const form = new FormData();
      form.set('file', file);
      const response = await request<unknown>(
        `/conversations/${encodeURIComponent(conversationId)}/attachments`,
        { method: 'POST', body: form },
      );
      return uploadMetadataSchema.parse((response as { attachment: unknown }).attachment);
    },
    getArtifact,
    async updateArtifact(id, expectedVersion, script) {
      const response = await request<unknown>(`/artifacts/${encodeURIComponent(id)}`, {
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
    async approveArtifact(id, expectedVersion) {
      const response = await request<unknown>(
        `/artifacts/${encodeURIComponent(id)}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion }),
        },
      );
      return assetArtifactSchema.parse((response as { artifact: unknown }).artifact);
    },
    async rejectArtifact(id, expectedVersion) {
      const response = await request<unknown>(
        `/artifacts/${encodeURIComponent(id)}/reject`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedVersion }),
        },
      );
      return assetArtifactSchema.parse((response as { artifact: unknown }).artifact);
    },
    async downloadArtifact(id) {
      const response = await fetchWithToken(
        `${baseUrl}/api/artifacts/${encodeURIComponent(id)}/download`,
      );
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        const parsed = apiErrorSchema.safeParse(body);
        const error = parsed.success
          ? parsed.data
          : { code: 'INTERNAL_ERROR' as const, message: messageFromUnknown(body), retryable: false };
        throw new LocalApiError(error.message, error.code, error.retryable, response.status);
      }
      return response.blob();
    },
    async getModelSettings() {
      const response = await request<unknown>('/models');
      const result = response as { providers: ModelSettings['providers']; selection: unknown };
      return {
        providers: result.providers,
        selection: modelSelectionSchema.parse(result.selection),
      };
    },
    async saveModelSettings(selection) {
      const response = await request<unknown>('/models', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selection),
      });
      return modelSelectionSchema.parse((response as { selection: unknown }).selection);
    },
    async saveCredential(providerId, apiKey) {
      await request(`/models/credentials/${encodeURIComponent(providerId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
    },
    async removeCredential(providerId) {
      await request(`/models/credentials/${encodeURIComponent(providerId)}`, {
        method: 'DELETE',
      });
    },
    async getPreferences() {
      const response = await request<unknown>('/preferences');
      const values = (response as { preferences: unknown }).preferences;
      return parsePreferences(values);
    },
    async savePreference(key, value) {
      const response = await request<unknown>('/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      const values = (response as { preferences: unknown }).preferences;
      return parsePreferences(values);
    },
    async deletePreference(key) {
      await request('/preferences', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
    },
  };
}
