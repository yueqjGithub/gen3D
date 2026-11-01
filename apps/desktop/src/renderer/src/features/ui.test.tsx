// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetArtifact, Conversation } from '@agent3d/shared';
import App from '../App';
import { MessageParts } from './chat/MessageParts';
import { Composer } from './chat/Composer';
import { ChatView } from './chat/ChatView';
import { AssetPanel } from './assets/AssetPanel';
import { ModelSettings } from './settings/ModelSettings';

const firstConversation: Conversation = {
  id: '123e4567-e89b-42d3-a456-426614174001',
  title: '陶瓷碗',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};
const secondConversation: Conversation = {
  id: '123e4567-e89b-42d3-a456-426614174002',
  title: '石雕',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

function createApi(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: 'http://127.0.0.1:4567',
    authHeaders: () => ({ 'X-Agent3D-Token': 'test-token' }),
    fetch: vi.fn<typeof fetch>(),
    listConversations: vi.fn(async () => [firstConversation, secondConversation]),
    createConversation: vi.fn(async () => secondConversation),
    renameConversation: vi.fn(async () => firstConversation),
    deleteConversation: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    uploadAttachment: vi.fn(async () => ({
      id: '123e4567-e89b-42d3-a456-426614174003',
      conversationId: firstConversation.id,
      fileName: 'reference.png',
      mediaType: 'image/png',
      size: 12,
      kind: 'image' as const,
      createdAt: '2026-11-01T00:00:00.000Z',
    })),
    getArtifact: vi.fn(async () => ({ artifact, scriptValidation: { ok: true } })),
    updateArtifact: vi.fn(),
    approveArtifact: vi.fn(),
    rejectArtifact: vi.fn(),
    downloadArtifact: vi.fn(),
    getModelSettings: vi.fn(async () => ({
      providers: [{
        id: 'agnes',
        name: 'Agnes AI',
        protocol: 'openai-compatible',
        baseURL: 'https://apihub.agnes-ai.com/v1',
        supportsInlineImages: false,
        models: {
          chat: ['agnes/agnes-3.0-flash'],
          image: ['agnes-image-2.5-flash'],
        },
      }],
      selection: {
        chat: {
          providerId: 'agnes',
          modelId: 'agnes/agnes-3.0-flash',
          baseURL: 'https://apihub.agnes-ai.com/v1',
          apiKeyConfigured: true,
        },
        image: {
          providerId: 'agnes',
          modelId: 'agnes-image-2.5-flash',
          baseURL: 'https://apihub.agnes-ai.com/v1',
          apiKeyConfigured: true,
        },
      },
    })),
    saveModelSettings: vi.fn(),
    saveCredential: vi.fn(),
    removeCredential: vi.fn(),
    getPreferences: vi.fn(async () => ({})),
    savePreference: vi.fn(),
    deletePreference: vi.fn(),
    ...overrides,
  };
}

const artifact = {
  id: '123e4567-e89b-42d3-a456-426614174010',
  conversationId: firstConversation.id,
  version: 1,
  brief: 'A shallow ceramic bowl with a hand-cut rim.',
  script: 'import bpy\nbpy.ops.mesh.primitive_uv_sphere_add()',
  blenderVersion: '4.x' as const,
  status: 'pending' as const,
  createdAt: '2026-11-01T00:00:00.000Z',
};

describe('renderer features', () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('switchesBetweenPersistedConversations', async () => {
    const api = createApi({
      getMessages: vi.fn(async (conversationId: string) => [{
        id: '123e4567-e89b-42d3-a456-426614174020',
        role: 'user',
        metadata: { persistedStatus: 'complete' },
        parts: [{
          type: 'text',
          text: conversationId === firstConversation.id ? '第一条已保存消息' : '第二条已保存消息',
        }],
      }]),
    });
    const user = userEvent.setup();

    render(<App api={api as never} />);
    await waitFor(() => expect(api.getMessages).toHaveBeenCalledWith(firstConversation.id));
    expect(await screen.findByText('第一条已保存消息')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^石雕/ }));
    expect(await screen.findByText('第二条已保存消息')).toBeTruthy();
  });

  it('rendersStreamingAndReasoningParts', () => {
    render(
      <MessageParts
        message={{
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: '正在构思资产。' },
            { type: 'reasoning', text: '分析了轮廓和比例。' },
            {
              type: 'data-activity',
              id: 'tool-1',
              data: { toolCallId: 'tool-1', toolName: 'analyze-input', state: 'output-available' },
            },
            { type: 'data-asset', id: artifact.id, data: artifact },
          ],
        } as never}
      />,
    );

    expect(screen.getByText('正在构思资产。')).toBeTruthy();
    expect(screen.getByText('分析了轮廓和比例。')).toBeTruthy();
    expect(screen.getByText('analyze-input')).toBeTruthy();
    expect(screen.getByText(artifact.brief)).toBeTruthy();
  });

  it('showsAttachmentValidationErrors', async () => {
    const onUpload = vi.fn();
    const user = userEvent.setup();
    render(<Composer onUpload={onUpload} onSubmit={vi.fn()} disabled={false} />);

    fireEvent.change(screen.getByLabelText('添加图片或文档'), {
      target: {
        files: [new File(['not supported'], 'model.exe', { type: 'application/octet-stream' })],
      },
    });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('retriesFailedTurnWithoutDuplicate', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const api = createApi({
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const responseChunks = requestBodies.length === 1
          ? [{ type: 'start', messageId: 'assistant-retry' }, {
            type: 'error',
            errorText: 'The model request failed. Check your model settings and retry.',
          }]
          : [
            { type: 'start', messageId: 'assistant-retry' },
            { type: 'text-start', id: 'reply' },
            { type: 'text-delta', id: 'reply', delta: '完成了。' },
            { type: 'text-end', id: 'reply' },
            { type: 'finish', finishReason: 'stop' },
          ];
        const body = responseChunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
          + 'data: [DONE]\n\n';
        return new Response(body, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        });
      }),
    });
    const user = userEvent.setup();

    render(
      <ChatView
        api={api as never}
        conversation={firstConversation}
        initialMessages={[]}
        onArtifactChange={vi.fn()}
        onOpenAsset={vi.fn()}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: '写下你的想法' }), '设计一个陶瓷碗');
    await user.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(requestBodies).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(requestBodies).toHaveLength(2));

    expect(requestBodies[0]?.clientTurnId).toBe(requestBodies[1]?.clientTurnId);
    expect(requestBodies[0]?.attachmentIds).toEqual([]);
    expect(requestBodies[1]?.attachmentIds).toEqual([]);
  });

  it('requiresApprovalForEditedArtifactVersion', async () => {
    const updatedArtifact = { ...artifact, script: 'import bpy\n# revised', version: 2 };
    const api = createApi({
      updateArtifact: vi.fn(async (_id: string, version: number, script: string) => {
        expect(version).toBe(1);
        expect(script).toBe(updatedArtifact.script);
        return { artifact: updatedArtifact, scriptValidation: { ok: true } };
      }),
      approveArtifact: vi.fn(async (_id: string, version: number) => ({
        ...updatedArtifact,
        version,
        status: 'approved',
      })),
    });
    const user = userEvent.setup();

    function StatefulAssetPanel() {
      const [currentArtifact, setCurrentArtifact] = useState<AssetArtifact>(artifact);
      return (
        <AssetPanel
          api={api as never}
          artifact={currentArtifact}
          onChange={setCurrentArtifact}
        />
      );
    }

    render(<StatefulAssetPanel />);
    const editor = screen.getByRole('textbox', { name: 'Blender Python 脚本' });
    await user.clear(editor);
    await user.type(editor, updatedArtifact.script);
    await user.click(screen.getByRole('button', { name: '保存脚本' }));
    const approveButton = await screen.findByRole('button', { name: '批准资产' });
    await waitFor(() => expect((approveButton as HTMLButtonElement).disabled).toBe(false));
    await user.click(approveButton);

    expect(api.approveArtifact).toHaveBeenCalledWith(artifact.id, 2);
  });

  it('masksSavedCredentials', async () => {
    const api = createApi();
    render(<ModelSettings api={api as never} />);

    const keyField = await screen.findByLabelText('Chat API key input') as HTMLInputElement;
    expect(keyField.type).toBe('password');
    expect(keyField.value).toBe('');
    expect(document.body.textContent).not.toContain('test-only-key');

    fireEvent.change(keyField, { target: { value: 'new-secret' } });
    await userEvent.setup().click(screen.getByRole('button', { name: '保存 Chat API key' }));
    expect(api.saveCredential).toHaveBeenCalledWith('agnes', 'new-secret');
  });

  it('shows a model settings load error and retries the request', async () => {
    const api = createApi();
    const loadSettings = api.getModelSettings;
    api.getModelSettings = vi.fn()
      .mockRejectedValueOnce(new Error('本地 API 暂时不可用。'))
      .mockImplementationOnce(loadSettings);
    render(<ModelSettings api={api as never} />);

    expect((await screen.findByRole('alert')).textContent).toContain('本地 API 暂时不可用。');
    await userEvent.setup().click(screen.getByRole('button', { name: '重试读取模型设置' }));

    expect(await screen.findByLabelText('Chat API key input')).toBeTruthy();
    expect(api.getModelSettings).toHaveBeenCalledTimes(2);
  });

  it('confirmsPreferenceProposalsExplicitly', async () => {
    const confirmPreference = vi.fn();
    render(
      <MessageParts
        message={{
          id: 'assistant-proposal',
          role: 'assistant',
          parts: [{
            type: 'data-preference',
            data: {
              key: 'visualStyle',
              value: 'faceted',
              reason: 'The current design conversation favors low-poly forms.',
            },
          }],
        } as never}
        onConfirmPreference={confirmPreference}
      />,
    );

    expect(confirmPreference).not.toHaveBeenCalled();
    await userEvent.setup().click(
      screen.getByRole('button', { name: '保存偏好：visualStyle' }),
    );
    expect(confirmPreference).toHaveBeenCalledWith({
      key: 'visualStyle',
      value: 'faceted',
      reason: 'The current design conversation favors low-poly forms.',
    });
  });
});
