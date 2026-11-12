import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { RequestContext } from '../../agent/node_modules/@mastra/core/dist/request-context/index.js';
import { expect, it, vi } from 'vitest';
import { createTestDirectory } from './test-directory';

it('runs the Mastra chat route with request context and returns structured output', async () => {
  const previousDirectory = process.env.AGENT3D_DATA_DIR;
  process.env.AGENT3D_DATA_DIR = createTestDirectory('agent-route-');
  const { mastra } = await import('../../agent/src/mastra/index');
  try {
    const route = mastra.getServer()?.apiRoutes?.find((item) => item.path === '/chat/:agentId');
    if (!route || !('middleware' in route) || typeof route.middleware !== 'function') {
      throw new Error('Chat route middleware is missing.');
    }

    const app = new Hono<{ Variables: { requestContext: RequestContext; mastra: typeof mastra } }>();
    app.use('*', async (context, next) => {
      context.set('requestContext', new RequestContext());
      context.set('mastra', mastra);
      await next();
    });
    if (!('handler' in route)) throw new Error('Chat route handler is missing.');
    app.post('/chat/:agentId', route.middleware, route.handler);
    const agent3d = {
      model: { providerId: 'openai', modelId: 'openai/gpt-4.1-mini', baseURL: 'http://localhost:1/v1' },
      apiKey: 'example-test-key',
      latestUserText: 'hello',
      documents: [],
      images: [],
      preferences: [],
    };
    const agent = mastra.getAgentById('asset-creation-agent');
    if (!agent) throw new Error('Agent is missing.');
    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
        const content = JSON.stringify({ result: { type: 'chat', reply: 'Hello' } });
        const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
          choices: [{ index: 0, delta: { content }, finish_reason: null }] };
        const end = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const response = await app.request('/chat/asset-creation-agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ id: 'test-message', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
          agent3d,
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"type":"data-structured-output"');
      expect(body).toContain('"reply":"Hello"');
      const request = fetchSpy.mock.calls[0];
      expect(String(request?.[0])).toContain('localhost:1/v1/chat/completions');
      expect(JSON.parse(String(request?.[1]?.body)).model).toBe('gpt-4.1-mini');
      expect(new Headers(request?.[1]?.headers).get('authorization')).toBe('Bearer example-test-key');
      await mastra.observability.flush();
      const database = new Database(join(process.env.AGENT3D_DATA_DIR!, 'agent3d.sqlite'), { readonly: true });
      try {
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
        const rows = tables.flatMap(({ name }) => database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
        expect(rows.length).toBeGreaterThan(0);
        expect(JSON.stringify(rows).includes('example-test-key')).toBe(false);
      } finally {
        database.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  } finally {
    await mastra.getStorage()?.init();
    await mastra.getStorage()?.close();
    if (previousDirectory === undefined) delete process.env.AGENT3D_DATA_DIR;
    else process.env.AGENT3D_DATA_DIR = previousDirectory;
  }
}, 60000);
