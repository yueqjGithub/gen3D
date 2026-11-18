import { RequestContext } from '@mastra/core/request-context';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { handleChatStream } from '@mastra/ai-sdk';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { afterEach, describe, expect, it } from 'vitest';
import { createAssetAgent } from './agent.js';
import { generateThreeModel } from '../tools/generate-three-model.js';
import { agentChatRequestContextSchema } from '@agent3d/shared';

const originalAgnesApiKey = process.env.AGNES_API_KEY;
const agent = createAssetAgent(generateThreeModel);

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
        const content = '你好';
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
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta).join('')).toBe('你好');
      expect(chunks.some(chunk => chunk.type === 'data-structured-output')).toBe(false);
    } finally {
      agent.model = originalModel;
      await storage.close();
    }
  });

  it('uses native text output with enough modeling steps', async () => {
    const options = await agent.getDefaultOptions({ requestContext: createRequestContext('请生成树木模型') });
    expect('structuredOutput' in options).toBe(false);
    expect(options.maxSteps).toBe(8);
  });

  it('requires the API key from the current request', async () => {
    const requestContext = createRequestContext('hello');
    const context = requestContext.get('agent3d') as { apiKey: string };
    context.apiKey = '';
    await expect(agent.getModel({ requestContext })).rejects.toThrow();
  });

  it('lists tools for API discovery without allowing a model call without request configuration', async () => {
    const requestContext = new RequestContext();
    const tools = await agent.listTools({ requestContext });
    expect(Object.keys(tools)).toContain('generate-three-model');
    expect(Object.keys(tools)).toContain('ask-user');
    await expect(agent.getModel({ requestContext })).rejects.toThrow();
  });

  it('requires tool approval by default and allows explicitly selected automatic mode', async () => {
    const requestContext = createRequestContext('请生成花瓶');
    expect((await agent.getDefaultOptions({ requestContext })).requireToolApproval).toBe(true);
    requestContext.set('agent3d', {
      ...agentChatRequestContextSchema.parse(requestContext.get('agent3d')), toolApproval: 'auto',
    });
    expect((await agent.getDefaultOptions({ requestContext })).requireToolApproval).toBe(false);
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

  it.each(['你好', '换成蓝色', '只保留本体', '把口沿加宽一点'])('keeps modeling tools available for follow-up messages: %s', async (text) => {
    const chatTools = await agent.listTools({
      requestContext: createRequestContext(text),
    });
    const assetTools = await agent.listTools({
      requestContext: createRequestContext('请帮我生成一个低多边形树木模型'),
    });

    expect(Object.keys(chatTools)).toEqual(Object.keys(assetTools));
    expect(Object.keys(assetTools)).toEqual([
      'ask-user',
      'analyze-input',
      'generate-three-model',
      'build-asset-brief',
      'update-preferences',
    ]);
  });

  it('requires modeling on the first step of an explicit revision and allows automatic follow-up', async () => {
    const requestContext = createRequestContext('换成红色，口沿再宽一点');
    requestContext.set('hasExistingModel', true);
    const options = await agent.getDefaultOptions({ requestContext });
    const prepare = options.prepareStep as (input: { stepNumber: number }) => { toolChoice: unknown };
    expect(prepare({ stepNumber: 0 }).toolChoice).toEqual({ type: 'tool', toolName: 'generate-three-model' });
    expect(prepare({ stepNumber: 1 }).toolChoice).toBe('auto');
    requestContext.set('agent3d', {
      ...agentChatRequestContextSchema.parse(requestContext.get('agent3d')), latestUserText: '怎么修改颜色？',
    });
    expect((await agent.getDefaultOptions({ requestContext })).prepareStep).toBeUndefined();
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

});
