import { RequestContext } from '@mastra/core/request-context';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { handleChatStream } from '@mastra/ai-sdk';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, describe, expect, it } from 'vitest';
import { agent } from './agent.js';
import { agentChatRequestContextSchema } from '@agent3d/shared';

const originalAgnesApiKey = process.env.AGNES_API_KEY;

afterEach(() => {
  if (originalAgnesApiKey === undefined) {
    delete process.env.AGNES_API_KEY;
  } else {
    process.env.AGNES_API_KEY = originalAgnesApiKey;
  }
});

function createRequestContext(latestUserText: string): RequestContext {
  const requestContext = new RequestContext();
  requestContext.set('agent3d', {
    model: {
      providerId: 'agnes',
      modelId: 'agnes/agnes-3.0-flash',
      baseURL: 'https://apihub.agnes-ai.com/v1',
    },
    apiKey: 'example-test-key',
    latestUserText,
    documents: [{
      fileName: 'brief.txt',
      mediaType: 'text/plain',
      text: 'Low-poly tree with a broad canopy.',
    }],
    images: [],
    preferences: [{ key: 'asset.style', value: 'low-poly' }],
  });
  return requestContext;
}

describe('3D asset agent', () => {
  it('emits the structured result expected by Server over the AI SDK stream', async () => {
    const requestContext = createRequestContext('你好');
    const storage = new LibSQLStore({ id: 'test-storage', url: ':memory:' });
    const mastra = new Mastra({ agents: { agent }, storage });
    await storage.init();
    const provider = createOpenAICompatible({
      name: 'local-test',
      baseURL: 'http://localhost:1',
      fetch: async () => {
        const content = JSON.stringify({ result: { type: 'chat', reply: '你好' } });
        const chunk = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
          choices: [{ index: 0, delta: { content }, finish_reason: null }] };
        const end = { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const originalModel = agent.model;
    try {
      agent.model = provider('test');
      const result = await handleChatStream({
        mastra,
        agentId: agent.id,
        version: 'v7',
        params: {
          messages: [{ id: 'test-message', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
          requestContext,
        },
      });
      const chunks = [];
      for await (const chunk of result) chunks.push(chunk);
      expect(chunks).toContainEqual({
        type: 'data-structured-output',
        data: { object: { result: { type: 'chat', reply: '你好' } } },
      });
    } finally {
      agent.model = originalModel;
      await storage.close();
    }
  });

  it('configures structured output for both conversation and asset generation', async () => {
    const chat = await agent.getDefaultOptions({ requestContext: createRequestContext('你好') });
    const asset = await agent.getDefaultOptions({
      requestContext: createRequestContext('请帮我生成一个低多边形树木模型'),
    });

    expect(chat.structuredOutput).toBeDefined();
    expect(asset.structuredOutput).toBeDefined();
    expect(await chat.structuredOutput?.schema['~standard'].validate({ result: { type: 'chat', reply: '你好' } })).toHaveProperty('value');
    expect(await chat.structuredOutput?.schema['~standard'].validate({
      result: { type: 'asset', brief: '树木', script: 'import bpy', blenderVersion: '4.x', preferenceProposals: [] },
    })).toHaveProperty('issues');
    expect(await asset.structuredOutput?.schema['~standard'].validate({
      result: { type: 'asset', brief: '树木', script: 'import bpy', blenderVersion: '4.x', preferenceProposals: [] },
    })).toHaveProperty('value');
  });

  it('requires the API key from the current request', async () => {
    const requestContext = createRequestContext('hello');
    const context = requestContext.get('agent3d') as { apiKey: string };
    context.apiKey = '';
    await expect(agent.getModel({ requestContext })).rejects.toThrow();
  });

  it('uses the requested provider and model instead of a fixed Agnes model', async () => {
    const requestContext = createRequestContext('hello');
    requestContext.set('agent3d', {
      ...agentChatRequestContextSchema.parse(requestContext.get('agent3d')),
      model: { providerId: 'anthropic', modelId: 'anthropic/claude-sonnet-4-5', baseURL: 'https://api.anthropic.com/v1' },
    });
    const model = await agent.getModel({ requestContext });
    expect(typeof model).toBe('object');
    if (typeof model !== 'object' || model === null || !('modelId' in model)) throw new Error('Expected a model instance.');
    expect(model.modelId).toBe('claude-sonnet-4-5');
  });

  it('exposes asset tools only for an explicit creation request', async () => {
    const chatTools = await agent.listTools({
      requestContext: createRequestContext('你好'),
    });
    const assetTools = await agent.listTools({
      requestContext: createRequestContext('请帮我生成一个低多边形树木模型'),
    });

    expect(Object.keys(chatTools)).toEqual(['analyze-input']);
    expect(Object.keys(assetTools)).toEqual([
      'analyze-input',
      'build-asset-brief',
      'generate-blender-script',
      'update-preferences',
    ]);
  });

  it('reads documents and preferences from the current request context', async () => {
    const requestContext = createRequestContext('请帮我看看设计文档');
    const tools: Record<string, unknown> = await agent.listTools({ requestContext });
    const tool = tools['analyze-input'];
    if (typeof tool !== 'object' || tool === null || !('execute' in tool) || typeof tool.execute !== 'function') {
      throw new Error('The input analysis tool is missing.');
    }
    const result = await tool.execute({}, { requestContext });

    expect(result).toEqual({
      latestUserText: '请帮我看看设计文档',
      documents: [{
        fileName: 'brief.txt',
        text: 'Low-poly tree with a broad canopy.',
        truncated: false,
      }],
      images: [],
      preferences: [{ key: 'asset.style', value: 'low-poly' }],
    });
  });

  it('rejects unsafe Blender scripts', async () => {
    const requestContext = createRequestContext('请帮我生成一个低多边形树木模型');
    const tools: Record<string, unknown> = await agent.listTools({ requestContext });
    const scriptTool = tools['generate-blender-script'];
    if (typeof scriptTool !== 'object' || scriptTool === null
      || !('execute' in scriptTool) || typeof scriptTool.execute !== 'function') {
      throw new Error('The explicit asset request did not expose the Blender script tool.');
    }

    await expect(scriptTool.execute({
      script: 'import bpy\nimport subprocess',
    }, { requestContext })).rejects.toThrow('Blender script failed static validation');
  });
});
