// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelProvider, useModelSettings } from './ModelContext';
import { ModelSettings } from './ModelSettings';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('updates the key locally and publishes saved model selection without sending the key to settings API', async () => {
  const selection = {
    chat: { providerId: 'agnes', modelId: 'agnes/agnes-3.0-flash', baseURL: 'https://example.test' },
    image: { providerId: 'agnes', modelId: 'image', baseURL: 'https://example.test' },
  };
  const providers = [
    { id: 'agnes', name: 'Agnes', protocol: 'openai-compatible', baseURL: 'https://example.test',
      supportsInlineImages: false, models: { chat: ['agnes/agnes-3.0-flash'], image: ['image'] } },
    { id: 'openai', name: 'OpenAI', protocol: 'openai-compatible', baseURL: 'https://openai.test',
      supportsInlineImages: true, models: { chat: ['openai/model'], image: ['other-image'] } },
  ];
  const fetchSpy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PATCH') return Response.json({ selection: JSON.parse(String(init.body)) });
    return Response.json({ providers, selection });
  });
  vi.stubGlobal('fetch', fetchSpy);
  function CurrentModel() {
    const { selection: current } = useModelSettings();
    return <p>当前模型：{current?.chat.modelId}</p>;
  }
  render(<ModelProvider><CurrentModel /><ModelSettings /></ModelProvider>);
  const chat = await screen.findByRole('group', { name: '对话模型' });
  fireEvent.change(within(chat).getByLabelText('服务商'), { target: { value: 'openai' } });
  fireEvent.change(within(chat).getByLabelText('API Key'), { target: { value: 'local-test-key' } });
  expect(JSON.parse(localStorage.getItem('agent3d-api-keys')!)).toEqual({ 'openai:openai/model': 'local-test-key' });
  fireEvent.click(screen.getByRole('button', { name: '保存模型设置' }));
  await waitFor(() => expect(screen.getByText('当前模型：openai/model')).toBeTruthy());
  const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === 'PATCH');
  expect(String(patch?.[1]?.body)).not.toContain('local-test-key');
});
