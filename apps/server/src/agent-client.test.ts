import { describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { AgentServiceRequest } from '@agent3d/shared';
import { createAgentClient } from './agent-client';

const request: AgentServiceRequest = {
  model: {
    providerId: 'agnes',
    modelId: 'agnes/agnes-3.0-flash',
    baseURL: 'https://models.example.test/v1',
    protocol: 'openai-compatible',
    apiKey: 'test-only-secret',
    supportsInlineImages: true,
  },
  messages: [
    { role: 'user', content: 'Use a stone-like style.' },
    { role: 'assistant', content: 'Understood.' },
    { role: 'user', content: '' },
  ],
  documents: [{ fileName: 'brief.txt', mediaType: 'text/plain', text: 'A shallow bowl.' }],
  images: [{
    fileName: 'reference.png',
    mediaType: 'image/png',
    dataUrl: 'data:image/png;base64,AAAA',
  }],
  preferences: [{ key: 'visualStyle', value: 'faceted' }],
};

const chunks: UIMessageChunk[] = [
  { type: 'start', messageId: 'reply-1' },
  { type: 'text-start', id: 'text-1' },
  { type: 'text-delta', id: 'text-1', delta: 'Ready.' },
  { type: 'text-end', id: 'text-1' },
  { type: 'data-structured-output', data: { object: { result: { type: 'chat', reply: 'Ready.' } } } },
  { type: 'finish', finishReason: 'stop' },
];

function encodeSSE(values: unknown[]): string {
  return values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('');
}

async function collectChunks(stream: AsyncIterable<UIMessageChunk>) {
  const result: UIMessageChunk[] = [];
  for await (const chunk of stream) {
    result.push(chunk);
  }
  return result;
}

function createClient(fetcher: typeof fetch) {
  return createAgentClient({
    baseURL: 'http://127.0.0.1:62687/',
    token: 'test-agent-token',
    fetch: fetcher,
  });
}

describe('Hono Agent client', () => {
  it('postsV7MessagesAndHonoBuiltRequestContextToTheAgentRoute', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(encodeSSE(chunks), {
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    await collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }));

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(input).toBe('http://127.0.0.1:62687/chat/asset-creation-agent');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('X-Agent3D-Agent-Token')).toBe('test-agent-token');
    expect(new Headers(init?.headers).get('Accept')).toContain('text/event-stream');

    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      requestContext: { agent3d: Record<string, unknown> };
    };
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'Use a stone-like style.' }],
    });
    expect(body.messages[2]).toMatchObject({
      role: 'user',
      parts: [{
        type: 'text',
        text: '',
      }, {
        type: 'file',
        filename: 'reference.png',
        mediaType: 'image/png',
        url: 'data:image/png;base64,AAAA',
      }],
    });
    expect(body.requestContext.agent3d).toEqual({
      model: request.model,
      latestUserText: '',
      documents: request.documents,
      images: [{ fileName: 'reference.png', mediaType: 'image/png' }],
      preferences: request.preferences,
    });
    expect(JSON.stringify(body.requestContext)).not.toContain('data:image/png;base64');
    expect(body.requestContext.agent3d).not.toHaveProperty('untrustedInput');
  });

  it('decodesValidatedMastraUiMessageSseChunks', async () => {
    const fetcher = vi.fn(async () => new Response(encodeSSE(chunks), {
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    await expect(collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }))).resolves.toEqual(chunks);
  });

  it.each([
    ['malformed JSON', 'data: {"type":"text-delta"\n\n'],
    ['invalid chunks', encodeSSE([{ type: 'text-delta', id: 'text-1', delta: 42 }, chunks.at(-1)])],
    ['oversized event lines', encodeSSE([
      { type: 'text-delta', id: 'text-1', delta: 'x'.repeat(300 * 1024) },
      chunks.at(-1),
    ])],
  ])('rejects%sWithoutExposingAgentData', async (_label, payload) => {
    const privateText = 'private provider response';
    const fetcher = vi.fn(async () => new Response(payload, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    await expect(collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }))).rejects.not.toThrow(privateText);
  });

  it('rejectsNonSuccessfulResponsesWithoutExposingTheirBodies', async () => {
    const fetcher = vi.fn(async () => new Response('private provider response', { status: 502 }));

    await expect(collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }))).rejects.not.toThrow('private provider response');
  });

  it('rejectsStreamsThatEndWithoutAFinishChunk', async () => {
    const fetcher = vi.fn(async () => new Response(encodeSSE(chunks.slice(0, -1)), {
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    await expect(collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }))).rejects.toThrow();
  });

  it('rejectsChunksAfterTheFinishChunk', async () => {
    const fetcher = vi.fn(async () => new Response(encodeSSE([
      ...chunks,
      { type: 'text-delta', id: 'text-1', delta: 'late' },
    ]), { headers: { 'Content-Type': 'text/event-stream' } }));

    await expect(collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }))).rejects.toThrow();
  });

  it('limitsTheCombinedSizeOfEachSseEvent', async () => {
    const oversizedEvent = [
      'data: {"type":"text-delta",\n',
      `data: ${' '.repeat(150 * 1024)}\n`,
      'data: "id":"text-1",\n',
      `data: ${' '.repeat(150 * 1024)}\n`,
      'data: "delta":"x"}\n\n',
      `data: ${JSON.stringify(chunks.at(-1))}\n\n`,
    ].join('');
    const fetcher = vi.fn(async () => new Response(oversizedEvent, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    await expect(collectChunks(createClient(fetcher).stream(request, {
      signal: new AbortController().signal,
    }))).rejects.toThrow('oversized');
  });

  it('passesTheCallerAbortSignalToFetch', async () => {
    const controller = new AbortController();
    let observedAbort = false;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          observedAbort = true;
          reject(new DOMException('Request aborted.', 'AbortError'));
        }, { once: true });
      }));
    const iterator = createClient(fetcher).stream(request, { signal: controller.signal })[Symbol.asyncIterator]();

    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(observedAbort).toBe(true);
  });

  it('cancelsTheResponseReaderWhenTheCallerAborts', async () => {
    const controller = new AbortController();
    let responseCancelled = false;
    const responseBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(encodeSSE([chunks[0]])));
      },
      cancel() {
        responseCancelled = true;
      },
    });
    const fetcher = vi.fn(async () => new Response(responseBody, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const iterator = createClient(fetcher).stream(request, { signal: controller.signal })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: chunks[0], done: false });
    const pending = iterator.next();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(responseCancelled).toBe(true);
  });
});
