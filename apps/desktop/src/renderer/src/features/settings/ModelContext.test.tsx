// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelProvider, useModelSettings } from './ModelContext';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('loads the selected model and keeps its API key in context and localStorage', async () => {
  localStorage.setItem('agent3d-api-keys', JSON.stringify({ 'agnes:agnes/agnes-3.0-flash': 'old-key' }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    providers: [],
    selection: {
      chat: { providerId: 'agnes', modelId: 'agnes/agnes-3.0-flash', baseURL: 'https://example.test' },
      image: { providerId: 'agnes', modelId: 'image', baseURL: 'https://example.test' },
    },
  })));
  function Consumer() {
    const { selection, apiKeys, setApiKey } = useModelSettings();
    return <button onClick={() => setApiKey('agnes', 'agnes/agnes-3.0-flash', 'new-key')}>
      {selection?.chat.modelId}:{apiKeys['agnes:agnes/agnes-3.0-flash']}
    </button>;
  }
  render(<ModelProvider><Consumer /></ModelProvider>);
  await waitFor(() => expect(screen.getByText('agnes/agnes-3.0-flash:old-key')).toBeTruthy());
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('agnes/agnes-3.0-flash:new-key')).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('agent3d-api-keys')!)).toEqual({ 'agnes:agnes/agnes-3.0-flash': 'new-key' });
});
