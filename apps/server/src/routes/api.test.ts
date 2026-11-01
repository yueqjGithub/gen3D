import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ATTACHMENT_BYTES, type AgentStructuredOutput } from '@agent3d/shared';
import { createApp } from '../app';
import { createArtifactRepository } from '../storage/artifacts';
import { createAttachmentStore } from '../storage/attachments';
import { createConversationRepository } from '../storage/conversations';
import { createDatabase } from '../storage/database';
import { createPreferenceRepository } from '../storage/preferences';
import { createSettingsRepository } from '../config/settings-repository';
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
  output?: AgentStructuredOutput;
  streamedText?: string;
  onMessages?: (messages: unknown[]) => void;
}

function createFakeAgent({
  shouldFail = false,
  waitForAbort = false,
  output = validOutput,
  streamedText = 'Designing the asset.',
  onMessages,
}: FakeStreamOptions = {}) {
  return {
    async stream(messages: unknown[], options: { abortSignal?: AbortSignal }) {
      onMessages?.(messages);
      const fullStream = (async function* () {
        yield { type: 'text-start', payload: { id: 'asset-brief' } };
        yield { type: 'text-delta', payload: { id: 'asset-brief', text: streamedText } };
        if (waitForAbort) {
          await new Promise<void>((resolve, reject) => {
            if (options.abortSignal?.aborted) {
              reject(new DOMException('Request aborted.', 'AbortError'));
              return;
            }
            options.abortSignal?.addEventListener('abort', () => {
              reject(new DOMException('Request aborted.', 'AbortError'));
            }, { once: true });
          });
        }
        if (shouldFail) {
          throw new Error('Private provider error body must not reach the client.');
        }
        yield { type: 'text-end', payload: { id: 'asset-brief' } };
        yield { type: 'finish', payload: { finishReason: 'stop' } };
      })();
      return {
        fullStream,
        object: Promise.resolve(output),
      };
    },
  };
}

function createFixture(
  agentFactory = () => createFakeAgent(),
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
    createAgent: agentFactory,
  });

  return {
    app,
    conversations,
    artifacts,
    attachments,
    preferences,
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

function fixture(agentFactory?: () => ReturnType<typeof createFakeAgent>) {
  const created = createFixture(agentFactory);
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
  it('returnsConversationalReplyWithoutCreatingAnArtifactForGreeting', async () => {
    const reply = '你好！很高兴见到你。';
    const { app, conversations } = fixture(() => createFakeAgent({
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
    let modelMessages: unknown[] = [];
    const { app, conversations } = fixture(() => createFakeAgent({
      output: { result: { type: 'chat', reply } },
      streamedText: reply,
      onMessages: (messages) => {
        modelMessages = messages;
      },
    }));
    const conversation = conversations.create('Image reference');
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
          parts: [{
            type: 'data-attachment',
            id: attachment.id,
            data: {
              id: attachment.id,
              fileName: attachment.fileName,
              mediaType: attachment.mediaType,
            },
          }],
        }],
        attachmentIds: [attachment.id],
      }),
    });
    const stream = await response.text();
    const inputText = JSON.stringify(modelMessages);

    expect(stream).toContain(reply);
    expect(stream).not.toContain('"type":"data-asset"');
    expect(inputText).toContain('Reference image');
    expect(inputText).not.toContain('Please create an asset from the attached images.');
  });

  it('streamsAiSdkUiMessageParts', async () => {
    const { app, conversations } = fixture();
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
      'data-asset',
      'data-preference',
      'finish',
    ]));
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
    const { app, conversations } = fixture(() => createFakeAgent({ output: invalidOutput }));
    const conversation = conversations.create('Unsafe script');
    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id),
    );
    const stream = await response.text();

    expect(stream).toContain('"type":"error"');
    expect(stream).not.toContain('"type":"data-asset"');
    expect(conversations.listMessages(conversation.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', status: 'error' }),
    ]));
  });

  it('logsChatProviderFailuresWithoutExposingProviderErrorMessages', async () => {
    const { app, conversations } = fixture(() => ({
      async stream() {
        return {
          fullStream: (async function* () {
            throw Object.assign(new Error('provider response contains a secret value'), {
              statusCode: 401,
            });
          })(),
          object: Promise.resolve(validOutput),
        };
      },
    }));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const conversation = conversations.create('Provider failure');

    const response = await authorizedRequest(
      app,
      '/api/chat',
      chatRequest(conversation.id),
    );
    const stream = await response.text();

    expect(stream).toContain('"type":"error"');
    expect(logError).toHaveBeenCalledWith('Chat model request failed:', {
      providerId: resolvedModel.providerId,
      modelId: resolvedModel.modelId,
      phase: 'stream',
      errorName: 'Error',
      statusCode: 401,
    });
    expect(JSON.stringify(logError.mock.calls)).not.toContain('secret value');
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
    const { app, conversations } = fixture(() => createFakeAgent({ waitForAbort: true }));
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
  });

  it('retryReusesClientTurnId', async () => {
    let runs = 0;
    const { app, conversations } = fixture(() => {
      runs += 1;
      return createFakeAgent({ shouldFail: runs === 1 });
    });
    const conversation = conversations.create('Retry');
    const request = chatRequest(conversation.id, randomUUID());

    const failedResponse = await authorizedRequest(app, '/api/chat', request);
    const failedStream = await failedResponse.text();
    expect(failedStream).not.toContain('Private provider error body must not reach the client.');
    await (await authorizedRequest(app, '/api/chat', request)).text();

    const messages = conversations.listMessages(conversation.id);
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant' && message.status === 'complete'))
      .toHaveLength(1);
    expect(runs).toBe(2);
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
