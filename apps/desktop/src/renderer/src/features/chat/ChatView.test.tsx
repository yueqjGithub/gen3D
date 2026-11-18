// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';

vi.mock('../settings/ModelContext', () => ({ useModelSettings: () => ({
  selection: { chat: { providerId: 'test', modelId: 'test-model', baseURL: 'https://example.com/v1' } },
  apiKeys: { 'test:test-model': 'test-key' },
}) }));
vi.mock('./Composer', () => ({ Composer: () => null }));
vi.mock('./MessageParts', () => ({ MessageParts: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('retries after refresh with the persisted turn ID, original user message and attachments', async () => {
  const fetchSpy = vi.fn(async () => new Response('data: {"type":"start","messageId":"reply"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
  }));
  vi.stubGlobal('fetch', fetchSpy);
  render(<ChatView conversation={{ id: 'conversation', title: '模型', createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z' }}
    initialMessages={[
      { id: 'user', role: 'user', metadata: { persistedStatus: 'complete', clientTurnId: 'original-turn' }, parts: [
        { type: 'text', text: '生成模型' },
        { type: 'data-attachment', data: { id: 'image-id', fileName: 'image.png', mediaType: 'image/png' } },
      ] },
      { id: 'internal-copy', role: 'user', metadata: { persistedStatus: 'complete' }, parts: [{ type: 'text', text: '生成模型' }] },
      { id: 'failed', role: 'assistant', metadata: { persistedStatus: 'error' }, parts: [{ type: 'text', text: '连接中断' }] },
    ]} onArtifactChange={() => {}} onOpenAsset={() => {}} onOpenModelSettings={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
  const body = JSON.parse(String((fetchSpy.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
  expect(body.clientTurnId).toBe('original-turn');
  expect(body.attachmentIds).toEqual(['image-id']);
  expect(body.messages).toHaveLength(1);
  expect(body.messages[0].id).toBe('user');
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('就绪'));
});
