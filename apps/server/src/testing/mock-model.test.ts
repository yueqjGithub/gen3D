import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { listenLocalApi, registerServerShutdown } from '../dev';
import { createMockModelAgent } from './mock-model';
import { createArtifactRepository } from '../storage/artifacts';
import { createAttachmentStore } from '../storage/attachments';
import { createConversationRepository } from '../storage/conversations';
import { createDatabase } from '../storage/database';
import { createPreferenceRepository } from '../storage/preferences';
import { createSettingsRepository } from '../config/settings-repository';

const token = 'mock-test-launch-token';
const origin = 'null';

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent3d-mock-'));
  const database = createDatabase(join(directory, 'app.sqlite'));
  const credentials = {
    get: async () => 'mock-only-key',
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
    resolveModel: async (selection) => ({
      providerId: selection.providerId,
      modelId: selection.modelId,
      baseURL: selection.baseURL,
      protocol: 'openai-compatible',
      supportsInlineImages: true,
      apiKey: 'mock-only-key',
    }),
    createAgent: () => createMockModelAgent(),
  });

  return {
    app,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function requestHeaders(withToken = true): Headers {
  const headers = new Headers({ Origin: origin });
  if (withToken) {
    headers.set('X-Agent3D-Token', token);
  }
  return headers;
}

const fixtures: Array<ReturnType<typeof createFixture>> = [];
const servers: Array<Awaited<ReturnType<typeof listenLocalApi>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
  fixtures.splice(0).forEach(({ close }) => close());
});

describe('local mock server', () => {
  it('bindsOnlyToLoopback', async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const server = await listenLocalApi(fixture.app);
    servers.push(server);

    expect(new URL(server.baseUrl).hostname).toBe('127.0.0.1');
    expect(new URL(server.baseUrl).port).not.toBe('');
  });

  it('rejectsRequestsWithoutLaunchToken', async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const server = await listenLocalApi(fixture.app);
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/api/conversations`, {
      headers: requestHeaders(false),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('closesLocalServerOnAppExit', async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const server = await listenLocalApi(fixture.app);
    servers.push(server);
    const lifecycle = new EventEmitter();
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    registerServerShutdown(
      lifecycle,
      () => server.close(),
      resolveExit,
    );
    const event = { preventDefault: vi.fn() };

    lifecycle.emit('before-quit', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await exited;
    await expect(fetch(`${server.baseUrl}/api/conversations`, {
      headers: requestHeaders(),
    })).rejects.toThrow();
  });

  it('completesMockConversationAndApprovalFlow', async () => {
    const fixture = createFixture();
    fixtures.push(fixture);
    const server = await listenLocalApi(fixture.app);
    servers.push(server);
    const headers = requestHeaders();
    headers.set('Content-Type', 'application/json');
    const createResponse = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Mock bowl' }),
    });
    const { conversation } = await createResponse.json() as {
      conversation: { id: string };
    };

    const form = new FormData();
    form.set('file', new File(['A small stoneware bowl'], 'notes.txt', { type: 'text/plain' }));
    const uploadHeaders = requestHeaders();
    const uploadResponse = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/attachments`,
      { method: 'POST', headers: uploadHeaders, body: form },
    );
    const { attachment } = await uploadResponse.json() as {
      attachment: { id: string; fileName: string; mediaType: string };
    };
    const clientTurnId = randomUUID();
    const chatHeaders = requestHeaders();
    chatHeaders.set('Content-Type', 'application/json');
    const chatResponse = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId,
        attachmentIds: [attachment.id],
        messages: [{
          id: clientTurnId,
          role: 'user',
          parts: [
            { type: 'text', text: 'Create a stoneware bowl.' },
            {
              type: 'data-attachment',
              data: {
                id: attachment.id,
                fileName: attachment.fileName,
                mediaType: attachment.mediaType,
              },
            },
          ],
        }],
      }),
    });
    const stream = await chatResponse.text();
    expect(chatResponse.status, stream).toBe(200);
    expect(stream).toContain('"type":"reasoning-start"');
    expect(stream).toContain('"type":"data-activity"');
    expect(stream).toContain('"type":"data-asset"');
    const artifactId = JSON.parse(
      stream.split('\n').find((line) => line.includes('"type":"data-asset"'))!
        .replace(/^data: /, ''),
    ).id as string;
    const updatedScript = 'import bpy\n# reviewed mock script';
    const editHeaders = requestHeaders();
    editHeaders.set('Content-Type', 'application/json');
    const editResponse = await fetch(`${server.baseUrl}/api/artifacts/${artifactId}`, {
      method: 'PATCH',
      headers: editHeaders,
      body: JSON.stringify({ expectedVersion: 1, script: updatedScript }),
    });
    const edited = await editResponse.json() as {
      artifact: { version: number; status: string };
    };
    expect(edited.artifact).toMatchObject({ version: 2, status: 'pending' });

    const approveHeaders = requestHeaders();
    approveHeaders.set('Content-Type', 'application/json');
    const approvalResponse = await fetch(
      `${server.baseUrl}/api/artifacts/${artifactId}/approve`,
      {
        method: 'POST',
        headers: approveHeaders,
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    );
    const approved = await approvalResponse.json() as {
      artifact: { status: string };
    };

    expect(approved.artifact.status).toBe('approved');
    const downloadResponse = await fetch(
      `${server.baseUrl}/api/artifacts/${artifactId}/download`,
      { headers: requestHeaders() },
    );
    expect(downloadResponse.status).toBe(200);
    expect(await downloadResponse.text()).toBe(updatedScript);
    const historyResponse = await fetch(
      `${server.baseUrl}/api/conversations/${conversation.id}/messages`,
      { headers: requestHeaders() },
    );
    const history = await historyResponse.json() as {
      messages: Array<{ role: string; parts: Array<{ type: string }> }>;
    };
    expect(history.messages.some((message) => (
      message.role === 'assistant'
      && message.parts.some((part) => part.type === 'asset')
    ))).toBe(true);
  });
});
