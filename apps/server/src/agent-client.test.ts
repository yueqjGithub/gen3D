import { afterEach, expect, it, vi } from 'vitest';
import { streamAgent } from './agent-client';

afterEach(() => vi.unstubAllGlobals());

it('sends application context separately from Mastra requestContext', async () => {
  const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  vi.stubGlobal('fetch', fetchSpy);
  const request = {
    toolApproval: 'manual' as const,
    model: { providerId: 'agnes', modelId: 'agnes/agnes-3.0-flash', baseURL: 'https://apihub.agnes-ai.com/v1' },
    apiKey: 'example-test-key',
    messages: [{ role: 'user' as const, content: 'hello' }],
    documents: [],
    images: [],
    preferences: [],
  };
  for await (const _chunk of streamAgent(request, new AbortController().signal)) { /* consume stream */ }
  const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
  expect(body.requestContext).toBeUndefined();
  expect(body.agent3d).toMatchObject({ model: request.model, latestUserText: 'hello' });
});

it('forwards the selected model and API key to the Agent', async () => {
  const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  vi.stubGlobal('fetch', fetchSpy);
  const request = {
    toolApproval: 'manual' as const,
    model: { providerId: 'openai', modelId: 'openai/gpt-4.1-mini', baseURL: 'https://api.openai.com/v1' },
    apiKey: 'example-test-key',
    messages: [{ role: 'user' as const, content: 'hello' }],
    documents: [], images: [], preferences: [],
  };
  for await (const _chunk of streamAgent(request, new AbortController().signal)) { /* consume stream */ }
  const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
  expect(body.agent3d.model).toEqual(request.model);
  expect(body.agent3d.apiKey).toBe(request.apiKey);
});

it('does not expose the Agent error body, which might contain credentials', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private-test-key', { status: 500 })));
  const request = {
    toolApproval: 'manual' as const,
    model: { providerId: 'agnes', modelId: 'agnes/agnes-3.0-flash', baseURL: 'https://apihub.agnes-ai.com/v1' },
    apiKey: 'private-test-key',
    messages: [{ role: 'user' as const, content: 'hello' }],
    documents: [], images: [], preferences: [],
  };
  await expect(async () => {
    for await (const _chunk of streamAgent(request, new AbortController().signal)) { /* consume stream */ }
  }).rejects.toThrow('The Agent service rejected the request.');
});
