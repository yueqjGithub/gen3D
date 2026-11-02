import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import {
  MAX_ATTACHMENT_BYTES,
  type AgentServiceRequest,
  type AgentStructuredOutput,
} from '@agent3d/shared';
import { createApp } from '../app';
import { createArtifactRepository } from '../storage/artifacts';
import { createAttachmentStore } from '../storage/attachments';
import { createConversationRepository } from '../storage/conversations';
import { createDatabase } from '../storage/database';
import { createPreferenceRepository } from '../storage/preferences';
import { createSettingsRepository } from '../config/settings-repository';
import { createAgentClient } from '../agent-client';
import { CredentialBrokerUnavailableError } from '../config/credential-client';
import type { ResolvedModelConfig } from '../config/model-resolver';
import { DEFAULT_MODEL_SELECTION } from '../config/provider-catalog';

const origin = 'http://localhost:5173';
const token = 'test-local-api-token';
const resolvedModel: ResolvedModelConfig = {
  providerId: 'test',
  modelId: 'test/model',
  baseURL: 'https://models.example.test/v1',
  protocol: 'openai-compatible',
  supportsInlineImages: true,
  apiKey: 'test-only-key',
};

const validOutput: AgentStructuredOutput = {
  result: {
    type: 'asset',
    brief: 'A shallow ceramic bowl with a hand-cut rim.',
    script: 'import bpy\nbpy.ops.mesh.primitive_uv_sphere_add()',
    blenderVersion: '4.x',
    preferenceProposals: [{
      key: 'visualStyle',
      value: 'faceted',
      reason: 'The current design conversation favors low-poly forms.',
    }],
  },
};

interface FakeStreamOptions {
  shouldFail?: boolean;
  waitForAbort?: boolean;
  includeStructuredOutput?: boolean;
  structuredOutputCount?: number;
  textAfterStructuredOutput?: boolean;
  output?: unknown;
  streamedText?: string;
  onRequest?: (request: AgentServiceRequest) => void;
}

type FakeAgentRunner = (
  request: AgentServiceRequest,
  options: { signal: AbortSignal },
) => AsyncIterable<UIMessageChunk>;

function createFakeAgentRunner({
  shouldFail = false,
  waitForAbort = false,
  includeStructuredOutput = true,
  structuredOutputCount = 1,
  textAfterStructuredOutput = false,
  output = validOutput,
  streamedText = 'Designing the asset.',
  onRequest,
}: FakeStreamOptions = {}): FakeAgentRunner {
  return async function* (request, { signal }) {
    onRequest?.(request);
    const result = (
      typeof output === 'object'
      && output !== null
      && 'result' in output
      && typeof output.result === 'object'
      && output.result !== null
    ) ? output.result : null;
    if (result && 'type' in result && result.type === 'asset') {
      yield { type: 'reasoning-start', id: 'asset-reasoning' };
      yield { type: 'reasoning-delta', id: 'asset-reasoning', delta: 'Reviewing the design context.' };
      yield { type: 'reasoning-end', id: 'asset-reasoning' };
      yield {
        type: 'tool-input-start',
        toolCallId: 'mock-analyze',
        toolName: 'analyze-input',
      };
      yield {
        type: 'tool-output-available',
        toolCallId: 'mock-analyze',
        output: { status: 'analyzed' },
      };
    }
    yield { type: 'text-start', id: 'asset-brief' };
    yield { type: 'text-delta', id: 'asset-brief', delta: streamedText };
    if (waitForAbort) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      });
      return;
    }
    if (shouldFail) {
      yield { type: 'error', errorText: 'The selected model could not complete the request.' };
      yield { type: 'finish', finishReason: 'error' };
      return;
    }
    yield { type: 'text-end', id: 'asset-brief' };
    if (includeStructuredOutput) {
      for (let index = 0; index < structuredOutputCount; index += 1) {
        yield { type: 'data-structured-output', data: { object: output } };
      }
      yield { type: 'finish-step' };
    }
    if (textAfterStructuredOutput) {
      yield { type: 'text-delta', id: 'late-text', delta: 'late response content' };
    }
    yield { type: 'finish', finishReason: 'stop' };
  };
}

function createFixture(
  agentRunner: FakeAgentRunner = createFakeAgentRunner(),
  credentialReader: { get(providerId: string): Promise<string | null> } = {
    get: async () => 'test-only-key',
  },
) {
  const directory = mkdtempSync(join(tmpdir(), 'agent3d-api-'));
  const database = createDatabase(join(directory, 'app.sqlite'));
  const credentials = {
    get: credentialReader.get,
    set: async () => undefined,
    delete: async () => undefined,
  };
  const conversations = createConversationRepository(database.connection);
  const artifacts = createArtifactRepository(database.connection);
  const attachments = createAttachmentStore(database.connection, join(directory, 'attachments'));
  const preferences = createPreferenceRepository(database.connection);
  const settings = createSettingsRepository(database.connection, credentials);
  const app = createApp({
    auth: { allowedOrigin: origin, token },
    conversations,
    artifacts,
    attachments,
    preferences,
    settings,
    credentials,
    resolveModel: async () => resolvedModel,
    agentClient: { stream: agentRunner },
  });

  return {
    app,
    conversations,
    artifacts,
    attachments,
    preferences,
    artifactCount() {
      const row = database.connection
        .prepare('SELECT COUNT(*) AS count FROM artifacts')
        .get() as { count: number };
      return row.count;
    },
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function authorizedRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  headers.set('X-Agent3D-Token', token);
  return Promise.resolve(app.request(path, { ...init, headers }));
}

function chatRequest(
  conversationId: string,
  clientTurnId = randomUUID(),
  text = 'Create a small ceramic bowl.',
): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      clientTurnId,
      messages: [{
        id: clientTurnId,
        role: 'user',
        parts: [{ type: 'text', text }],
      }],
      attachmentIds: [],
    }),
  };
}

const fixtures: Array<ReturnType<typeof createFixture>> = [];

function fixture(agentRunner?: FakeAgentRunner) {
  const created = createFixture(agentRunner);
  fixtures.push(created);
  return created;
}

function fixtureWithCredentialReader(
  credentialReader: { get(providerId: string): Promise<string | null> },
) {
  const created = createFixture(undefined, credentialReader);
  fixtures.push(created);
  return created;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const created of fixtures.splice(0)) {
    created.close();
  }
});

describe('Hono API', () => {
  it('returns a retryable broker-unavailable API error', async () => {
    const { app } = fixtureWithCredentialReader({
      get: async () => {
        throw new CredentialBrokerUnavailableError();
      },
    });

    const response = await authorizedRequest(app, '/api/models');

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: true,
    });
  });

  it('reports an unavailable Agent service as retryable in the chat stream', async () => {
    const agentClient = createAgentClient({
      baseURL: 'http://127.0.0.1:62687',
      token: 'test-agent-token',
      fetch: async () => {
        throw new TypeError('connection refused');
      },
    });
    const { app, conversations } = fixture(
      (request, options) => agentClient.stream(request, options),
    );
    const conversation = conversations.create('Unavailable Agent service');

    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id),
    );
    const stream = await response.text();

    expect(response.status).toBe(200);
    expect(stream).toContain('The Agent service is unavailable. Retry the request.');
    expect(stream).not.toContain('connection refused');
  });

  it('returnsConversationalReplyWithoutCreatingAnArtifactForGreeting', async () => {
    const reply = '你好！很高兴见到你。';
    const { app, conversations, artifactCount } = fixture(createFakeAgentRunner({
      output: { result: { type: 'chat', reply } },
      streamedText: reply,
    }));
    const conversation = conversations.create('Greeting');
    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id, randomUUID(), '你好'),
    );
    const stream = await response.text();

    expect(stream).toContain(reply);
    expect(stream).not.toContain('"type":"data-asset"');
    expect(stream).not.toContain('"type":"data-preference"');
    expect(artifactCount()).toBe(0);
    expect(conversations.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        status: 'complete',
        parts: [expect.objectContaining({ type: 'text', text: reply })],
      }),
    ]));
  });

  it('asksBeforeCreatingAnAssetFromAnImageOnlyTurn', async () => {
    const reply = '你希望我根据这张图片创作 3D 资产吗？';
    let agentRequest: AgentServiceRequest | undefined;
    const { app, conversations, preferences, artifactCount } = fixture(createFakeAgentRunner({
      output: { result: { type: 'chat', reply } },
      streamedText: reply,
      onRequest: (request) => {
        agentRequest = request;
      },
    }));
    const conversation = conversations.create('Image reference');
    preferences.upsert('visualStyle', 'faceted');
    const form = new FormData();
    form.set(
      'file',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'ref.png', {
        type: 'image/png',
      }),
    );
    const uploadResponse = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: form },
    );
    const { attachment: image } = await uploadResponse.json() as {
      attachment: { id: string; fileName: string; mediaType: string };
    };
    const documentForm = new FormData();
    documentForm.set('file', new File(['A carved stone vessel.'], 'notes.txt', {
      type: 'text/plain',
    }));
    const documentResponse = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: documentForm },
    );
    const { attachment: document } = await documentResponse.json() as {
      attachment: { id: string; fileName: string; mediaType: string };
    };
    const clientTurnId = randomUUID();
    const response = await authorizedRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId,
        messages: [{
          id: clientTurnId,
          role: 'user',
          parts: [image, document].map((attachment) => ({
            type: 'data-attachment',
            data: {
              id: attachment.id,
              fileName: attachment.fileName,
              mediaType: attachment.mediaType,
            },
          })),
        }],
        attachmentIds: [image.id, document.id],
      }),
    });
    const stream = await response.text();

    expect(stream).toContain(reply);
    expect(stream).not.toContain('"type":"data-asset"');
    expect(artifactCount()).toBe(0);
    expect(agentRequest).toMatchObject({
      model: resolvedModel,
      messages: [{ role: 'user', content: '' }],
      documents: [{
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        text: 'A carved stone vessel.',
      }],
      images: [{
        fileName: 'ref.png',
        mediaType: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      }],
      preferences: [{ key: 'visualStyle', value: 'faceted' }],
    });
  });

  it('streamsAiSdkUiMessageParts', async () => {
    const { app, conversations, artifacts, artifactCount } = fixture();
    const conversation = conversations.create('Bowl');
    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id),
    );
    const stream = await response.text();
    const chunks = stream.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .filter((data) => data !== '[DONE]')
      .map((data) => JSON.parse(data) as { type: string });

    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(chunks.map(({ type }) => type)).toEqual(expect.arrayContaining([
      'text-start',
      'text-delta',
      'reasoning-delta',
      'data-activity',
      'data-asset',
      'data-preference',
      'finish',
    ]));
    expect(stream).not.toContain('"type":"data-structured-output"');
    expect(stream).not.toContain('"input":');
    expect(conversations.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        status: 'complete',
        parts: expect.arrayContaining([
          expect.objectContaining({ type: 'asset' }),
          expect.objectContaining({ type: 'preference-proposal' }),
        ]),
      }),
    ]));
    expect(artifactCount()).toBe(1);
    const assetLine = stream.split('\n').find((line) => line.startsWith('data: ')
      && line.includes('"type":"data-asset"'));
    expect(assetLine).toBeDefined();
    const assetChunk = JSON.parse(assetLine!.slice(6)) as {
      data: { id: string; status: string };
    };
    expect(artifacts.get(assetChunk.data.id)?.status).toBe('pending');
  });

  it.each([
    ['missing', { includeStructuredOutput: false }],
    ['duplicate', { structuredOutputCount: 2 }],
    ['malformed', { output: { result: { type: 'chat', reply: 'Ready.' }, apiKey: 'secret' } }],
  ])('failsTheTurnWithoutCreatingAssetsWhenStructuredOutputIs%s', async (_case, options) => {
    const { app, conversations, artifactCount } = fixture(createFakeAgentRunner(options));
    const conversation = conversations.create('Invalid structured result');
    const response = await authorizedRequest(app, '/api/chat', chatRequest(conversation.id));
    const stream = await response.text();

    expect(stream).toContain('"type":"error"');
    expect(stream).not.toContain('"type":"data-asset"');
    expect(stream).not.toContain('secret');
    expect(artifactCount()).toBe(0);
    expect(conversations.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', status: 'error' }),
    ]));
  });

  it('rejectsContentAfterTheFinalStructuredOutput', async () => {
    const { app, conversations, artifactCount } = fixture(createFakeAgentRunner({
      textAfterStructuredOutput: true,
    }));
    const conversation = conversations.create('Output order');
    const response = await authorizedRequest(app, '/api/chat', chatRequest(conversation.id));
    const stream = await response.text();

    expect(stream).toContain('"type":"error"');
    expect(stream).not.toContain('"type":"data-asset"');
    expect(artifactCount()).toBe(0);
    expect(conversations.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', status: 'error' }),
    ]));
  });

  it('rejectsUnsafeBlenderScriptsBeforeCreatingArtifacts', async () => {
    const invalidOutput: AgentStructuredOutput = {
      result: {
        type: 'asset',
        brief: 'A shallow ceramic bowl.',
        script: 'import bpy\nimport subprocess',
        blenderVersion: '4.x',
        preferenceProposals: [],
      },
    };
    const { app, conversations, artifactCount } = fixture(createFakeAgentRunner({ output: invalidOutput }));
    const conversation = conversations.create('Unsafe script');
    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id),
    );
    const stream = await response.text();

    expect(stream).toContain('"type":"error"');
    expect(stream).not.toContain('"type":"data-asset"');
    expect(artifactCount()).toBe(0);
    expect(conversations.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', status: 'error' }),
    ]));
  });

  it('logsChatProviderFailuresWithoutExposingProviderErrorMessages', async () => {
    const { app, conversations, artifactCount } = fixture(createFakeAgentRunner({ shouldFail: true }));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const conversation = conversations.create('Provider failure');

    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id),
    );
    const stream = await response.text();

    expect(stream).toContain('"type":"error"');
    expect(logError).toHaveBeenCalledWith('Chat model request failed:', expect.objectContaining({
      providerId: resolvedModel.providerId,
      modelId: resolvedModel.modelId,
      phase: 'stream',
    }));
    expect(stream).not.toContain('The selected model could not complete the request.');
    expect(JSON.stringify(logError.mock.calls)).not.toContain('The selected model could not complete the request.');
    expect(stream).not.toContain('"type":"data-asset"');
    expect(artifactCount()).toBe(0);
  });

  it('allowsTheChatPostPreflightWithTheRendererHeaders', async () => {
    const { app } = fixture();
    const response = await authorizedRequest(app, '/api/chat', {
      method: 'OPTIONS',
      headers: {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-agent3d-token',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('abortedStreamDoesNotPersistSuccess', async () => {
    const { app, conversations, artifactCount } = fixture(createFakeAgentRunner({ waitForAbort: true }));
    const conversation = conversations.create('Abort');
    const requestController = new AbortController();
    const response = await app.fetch(new Request('http://localhost/api/chat', {
      ...chatRequest(conversation.id),
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'X-Agent3D-Token': token,
      },
      signal: requestController.signal,
    }));
    const reader = response.body?.getReader();
    await reader?.read();
    requestController.abort();
    await reader?.cancel();

    const assistantMessages = conversations.listMessages(conversation.id)
      .filter((message) => message.role === 'assistant');
    expect(assistantMessages.some((message) => message.status === 'complete')).toBe(false);
    expect(assistantMessages.some((message) => message.status === 'error')).toBe(true);
    expect(artifactCount()).toBe(0);
  });

  it('retryReusesClientTurnId', async () => {
    let runs = 0;
    const agentMessages: AgentServiceRequest['messages'][] = [];
    const { app, conversations, artifactCount } = fixture(async function* (agentRequest, options) {
      runs += 1;
      agentMessages.push(agentRequest.messages.map(({ role, content }) => ({ role, content })));
      yield* createFakeAgentRunner({ shouldFail: runs === 1 })(agentRequest, options);
    });
    const conversation = conversations.create('Retry');
    const request = chatRequest(conversation.id, randomUUID());

    const failedResponse = await authorizedRequest(app, '/api/chat', request);
    const failedStream = await failedResponse.text();
    expect(failedStream).not.toContain('The selected model could not complete the request.');
    await (await authorizedRequest(app, '/api/chat', request)).text();

    const messages = conversations.listMessages(conversation.id);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant' && message.status === 'complete'))
      .toHaveLength(1);
    expect(artifactCount()).toBe(1);
    expect(runs).toBe(2);
    expect(agentMessages).toEqual([
      [{ role: 'user', content: 'Create a small ceramic bowl.' }],
      [{ role: 'user', content: 'Create a small ceramic bowl.' }],
    ]);
  });

  it('rejectsMismatchedOrOversizedUploads', async () => {
    const { app, conversations } = fixture();
    const conversation = conversations.create('Uploads');

    const mismatched = new FormData();
    mismatched.set('file', new File(['not a png'], 'image.png', { type: 'image/png' }));
    const mismatchResponse = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: mismatched },
    );
    expect(mismatchResponse.status).toBe(400);
    expect(await mismatchResponse.json()).toMatchObject({ code: 'ATTACHMENT_INVALID' });

    const oversized = new FormData();
    oversized.set(
      'file',
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'large.txt', { type: 'text/plain' }),
    );
    const oversizedResponse = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: oversized },
    );
    expect(oversizedResponse.status).toBe(413);
  });

  it('rejectsMalformedPdf', async () => {
    const { app, conversations } = fixture();
    const conversation = conversations.create('PDF');
    const form = new FormData();
    form.set('file', new File(['%PDF-not valid'], 'notes.pdf', { type: 'application/pdf' }));

    const response = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: form },
    );
    expect(response.status).toBe(400);

    const invalidHeader = new FormData();
    invalidHeader.set('file', new File(['not a PDF'], 'notes.pdf', { type: 'application/pdf' }));
    const invalidHeaderResponse = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: invalidHeader },
    );
    expect(invalidHeaderResponse.status).toBe(400);
  });

  it('acceptsUploadedAttachmentReferencesFromTheRenderer', async () => {
    const { app, conversations } = fixture();
    const conversation = conversations.create('Uploaded reference');
    const form = new FormData();
    form.set(
      'file',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'ref.png', {
        type: 'image/png',
      }),
    );
    const uploadResponse = await authorizedRequest(
      app,
      `/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', body: form },
    );
    const { attachment } = await uploadResponse.json() as {
      attachment: { id: string; fileName: string; mediaType: string };
    };
    const clientTurnId = randomUUID();
    const response = await authorizedRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId,
        messages: [{
          id: clientTurnId,
          role: 'user',
          parts: [
            { type: 'text', text: 'Create a bowl inspired by this image.' },
            {
              type: 'data-attachment',
              id: attachment.id,
              data: {
                id: attachment.id,
                fileName: attachment.fileName,
                mediaType: attachment.mediaType,
              },
            },
          ],
        }],
        attachmentIds: [attachment.id],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(conversations.listMessages(conversation.id)[0]?.parts).toContainEqual(
      expect.objectContaining({ type: 'attachment', attachmentId: attachment.id }),
    );
  });

  it('rejectsUntrustedOriginOrToken', async () => {
    const { app } = fixture();
    const wrongOrigin = await app.request('/api/conversations', {
      headers: { Origin: 'https://attacker.example', 'X-Agent3D-Token': token },
    });
    const wrongToken = await app.request('/api/conversations', {
      headers: { Origin: origin, 'X-Agent3D-Token': 'incorrect-token' },
    });

    expect(wrongOrigin.status).toBe(403);
    expect(wrongToken.status).toBe(403);
  });

  it('rejectsStaleArtifactApproval', async () => {
    const { app, artifacts, conversations } = fixture();
    const conversation = conversations.create('Versioned');
    const artifact = artifacts.createPending({
      conversationId: conversation.id,
      brief: validOutput.result.type === 'asset' ? validOutput.result.brief : '',
      script: validOutput.result.type === 'asset' ? validOutput.result.script : '',
    });

    const response = await authorizedRequest(app, `/api/artifacts/${artifact.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: artifact.version + 1 }),
    });

    expect(response.status).toBe(409);
    expect(artifacts.get(artifact.id)?.status).toBe('pending');
  });

  it('keepsCredentialsOutOfModelResponsesAndRequiresPreferenceConfirmation', async () => {
    const { app, preferences } = fixture();
    const modelsResponse = await authorizedRequest(app, '/api/models');
    const modelBody = await modelsResponse.text();
    expect(modelsResponse.status).toBe(200);
    expect(modelBody).not.toContain('test-only-key');

    const credentialResponse = await authorizedRequest(
      app,
      '/api/models/credentials/openai',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: 'secret-that-must-not-return' }),
      },
    );
    expect(credentialResponse.status).toBe(200);
    expect(await credentialResponse.text()).not.toContain('secret-that-must-not-return');

    const preferenceResponse = await authorizedRequest(app, '/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'visualStyle', value: 'faceted' }),
    });
    expect(preferenceResponse.status).toBe(200);
    expect(preferences.list()).toEqual({ visualStyle: 'faceted' });

    const deleteResponse = await authorizedRequest(app, '/api/preferences', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'visualStyle' }),
    });
    expect(deleteResponse.status).toBe(204);
    expect(preferences.list()).toEqual({});
  });

  it('canReadModelSettingsAfterUpdatingThem', async () => {
    const { app } = fixture();
    const saveResponse = await authorizedRequest(app, '/api/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(DEFAULT_MODEL_SELECTION),
    });
    const readResponse = await authorizedRequest(app, '/api/models');

    expect(saveResponse.status).toBe(200);
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      selection: {
        chat: { ...DEFAULT_MODEL_SELECTION.chat, apiKeyConfigured: true },
        image: { ...DEFAULT_MODEL_SELECTION.image, apiKeyConfigured: true },
      },
    });
  });

  it('logsUnhandledRequestContextWithoutLoggingTheExceptionMessage', async () => {
    const { app } = fixtureWithCredentialReader({
      get: async () => {
        throw new Error('secret-bearing provider error');
      },
    });
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await authorizedRequest(app, '/api/models');

    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalledWith('Unhandled local API error:', {
      method: 'GET',
      path: '/api/models',
      status: 500,
      errorName: 'Error',
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret-bearing provider error');
  });

  it('blocksArtifactDownloadUntilTheCurrentVersionIsApproved', async () => {
    const { app, artifacts, conversations } = fixture();
    const conversation = conversations.create('Approval gate');
    const artifact = artifacts.createPending({
      conversationId: conversation.id,
      brief: validOutput.result.type === 'asset' ? validOutput.result.brief : '',
      script: validOutput.result.type === 'asset' ? validOutput.result.script : '',
    });

    const blocked = await authorizedRequest(app, `/api/artifacts/${artifact.id}/download`);
    expect(blocked.status).toBe(409);

    const approval = await authorizedRequest(app, `/api/artifacts/${artifact.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: artifact.version }),
    });
    expect(approval.status).toBe(200);
    const download = await authorizedRequest(app, `/api/artifacts/${artifact.id}/download`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(validOutput.result.type === 'asset' ? validOutput.result.script : '');
  });
});
