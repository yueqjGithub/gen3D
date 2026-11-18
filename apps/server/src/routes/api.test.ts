import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { createTestDirectory } from '../test-directory';
import { DEFAULT_MODEL_SELECTION } from '../config/provider-catalog';
import { createArtifactRepository } from '../storage/artifacts';
import { createAttachmentStore } from '../storage/attachments';
import { createConversationRepository } from '../storage/conversations';
import { createDatabase } from '../storage/database';
import { createPreferenceRepository } from '../storage/preferences';
import { createSettingsRepository } from '../config/settings-repository';
import { createLoginRepository } from '../storage/login';

const rendererOrigin = 'http://localhost:5173';
const fixtures: Array<{ close(): Promise<void> }> = [];

async function createFixture() {
  const directory = createTestDirectory('api-');
  const database = await createDatabase(join(directory, 'app.sqlite'));
  const conversations = createConversationRepository(database.connection);
  const artifacts = createArtifactRepository(database.connection);
  const attachments = createAttachmentStore(database.connection, join(directory, 'attachments'));
  const preferences = createPreferenceRepository(database.connection);
  const settings = createSettingsRepository(database.connection);
  const users = createLoginRepository(database.connection);
  users.create('agent3d-local', 'test');
  const app = createApp({
    conversations,
    artifacts,
    attachments,
    preferences,
    settings,
    users,
  });
  const fixture = {
    app,
    artifacts,
    database,
    async close() {
      database.close();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function rendererRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Origin', rendererOrigin);
  if (!headers.has('Cookie')) headers.set('Cookie', 'username=agent3d-local');
  return Promise.resolve(app.request(path, { ...init, headers }));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
}, 60000);

describe('Hono API', () => {
  it('validates client-exported GLB ownership, version and binary header before private upload', async () => {
    const { app, artifacts, database } = await createFixture();
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Client export', 'agent3d-local');
    const modelId = randomUUID();
    const artifact = artifacts.createPending({ conversationId: conversation.id, brief: 'Client GLB',
      script: JSON.stringify({ format: 'three-script-v1', source: 'return new THREE.Mesh();', modelId }) });
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'storage-test-key');
    vi.stubEnv('SUPABASE_STORAGE_BUCKET', 'agent3d');
    const upload = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upload);
    const jsonText = '{"asset":{"version":"2.0"}}';
    const json = new TextEncoder().encode(jsonText.padEnd(Math.ceil(jsonText.length / 4) * 4, ' '));
    const bytes = new ArrayBuffer(20 + json.length); const header = new DataView(bytes);
    header.setUint32(0, 0x46546c67, true); header.setUint32(4, 2, true); header.setUint32(8, bytes.byteLength, true);
    header.setUint32(12, json.length, true); header.setUint32(16, 0x4e4f534a, true);
    new Uint8Array(bytes, 20).set(json);
    const path = `/api/artifacts/${artifact.id}/model`;
    const unauthorized = await rendererRequest(app, path + '?expectedVersion=1', { method: 'POST', body: bytes, headers: { Cookie: 'username=other-user' } });
    expect(unauthorized.status).toBe(401);
    const stale = await rendererRequest(app, path + '?expectedVersion=2', { method: 'POST', body: bytes });
    expect(stale.status).toBe(409);
    const invalid = await rendererRequest(app, path + '?expectedVersion=1', { method: 'POST', body: new ArrayBuffer(20) });
    expect(invalid.status).toBe(422);
    expect(upload).not.toHaveBeenCalled();
    const saved = await rendererRequest(app, path + '?expectedVersion=1', { method: 'POST', body: bytes });
    expect(saved.status).toBe(204);
    expect(upload).toHaveBeenCalledExactlyOnceWith(`https://example.supabase.co/storage/v1/object/agent3d/models/${modelId}.glb`, expect.objectContaining({ method: 'POST', body: bytes }));
  });
  it('reads native tool history and retries the persisted failed turn without duplicating its user message', async () => {
    const { app, database } = await createFixture();
    const repository = createConversationRepository(database.connection);
    const conversation = repository.create('Retry after reload', 'agent3d-local');
    const clientTurnId = randomUUID();
    const user = { id: randomUUID(), conversationId: conversation.id, role: 'user' as const,
      parts: [{ type: 'text' as const, text: '创建花瓶' }], status: 'complete' as const,
      createdAt: new Date().toISOString() };
    repository.beginTurn(conversation.id, clientTurnId, user);
    // 模拟中断前 Mastra 原生写入的工具记录，而不是用应用格式伪装原生记录。
    database.connection.prepare('INSERT INTO mastra_messages (id,thread_id,role,content,type,"createdAt","resourceId") VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), conversation.id, 'assistant', JSON.stringify({ format: 2, parts: [
        { type: 'step-start' }, { type: 'tool-invocation', toolInvocation: {
          state: 'result', toolCallId: 'analyze', toolName: 'analyze-input', args: {}, result: { latestUserText: '创建花瓶' },
        } },
      ] }), 'v2', new Date().toISOString(), 'agent3d-local');
    repository.failTurn(conversation.id, clientTurnId, { id: randomUUID(), conversationId: conversation.id,
      role: 'assistant', parts: [{ type: 'text', text: '连接中断' }], status: 'error', createdAt: new Date().toISOString() });
    const historyResponse = await rendererRequest(app, `/api/conversations/${conversation.id}/messages`);
    expect(historyResponse.status).toBe(200);
    const history = await historyResponse.json();
    const restored = history.messages.find((message: { id: string }) => message.id === user.id);
    expect(restored.clientTurnId).toBe(clientTurnId);
    expect(JSON.stringify(history)).toContain('tool-output-available');
    const upstream = vi.fn(async () => new Response('data: {"type":"finish"}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', upstream);
    const response = await rendererRequest(app, '/api/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: conversation.id,
        clientTurnId, messages: [{ id: restored.id, role: restored.role, parts: restored.parts }],
        attachmentIds: [], model: DEFAULT_MODEL_SELECTION.chat, apiKey: 'test-key',
      }) });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('"type":"error"');
    const forwarded = JSON.parse(String((upstream.mock.calls as unknown as [string, RequestInit][])[0]![1].body));
    expect(forwarded.memory.options).toEqual({ lastMessages: false, readOnly: true });
    expect(repository.listMessages(conversation.id).filter(message => message.role === 'user')).toHaveLength(1);
    expect(repository.getTurn(conversation.id, clientTurnId)?.state).toBe('complete');
  });
  it('previews pending GLB and downloads the same binary after approval', async () => {
    const { app, artifacts, database } = await createFixture();
    const created = await rendererRequest(app, '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { conversation } = await created.json();
    const modelId = randomUUID();
    const artifact = artifacts.createPending({ conversationId: conversation.id, brief: 'Script model', script: JSON.stringify({ format: 'three-script-v1', source: 'return new THREE.Group();', modelId }) });
    const directory = join(dirname(database.connection.name), 'models');
    await mkdir(directory, { recursive: true });
    const bytes = new Uint8Array([103,108,84,70,2,0,0,0]);
    await writeFile(join(directory, modelId + '.glb'), bytes);
    const preview = await rendererRequest(app, '/api/artifacts/' + artifact.id + '/model');
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Type')).toBe('model/gltf-binary');
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(bytes);
    expect((await rendererRequest(app, '/api/artifacts/' + artifact.id + '/download')).status).toBe(409);
    const approved = await rendererRequest(app, '/api/artifacts/' + artifact.id + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }) });
    expect(approved.status).toBe(200);
    const downloaded = await rendererRequest(app, '/api/artifacts/' + artifact.id + '/download');
    expect(downloaded.headers.get('Content-Disposition')).toContain('.glb');
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });
  it('serves image previews only to their conversation owner', async () => {
    const { app } = await createFixture();
    const created = await rendererRequest(app, '/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const { conversation } = await created.json();
    const form = new FormData();
    const png = Uint8Array.from([137,80,78,71,13,10,26,10]);
    form.set('file', new File([png], 'reference.png', { type: 'image/png' }));
    const upload = await rendererRequest(app, '/api/conversations/' + conversation.id + '/attachments', { method: 'POST', body: form });
    const { attachment } = await upload.json();
    const path = '/api/conversations/' + conversation.id + '/attachments/' + attachment.id;
    const preview = await rendererRequest(app, path);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(png);
    await rendererRequest(app, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'other', password: 'test' }) });
    expect((await rendererRequest(app, path, { headers: { Cookie: 'username=other' } })).status).toBe(404);
  });
  it('rejects a chat request without an API key', async () => {
    const { app } = await createFixture();
    const created = await rendererRequest(app, '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No key' }),
    });
    const { conversation } = await created.json() as { conversation: { id: string } };
    const response = await rendererRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '你好' }] }],
        attachmentIds: [],
        model: DEFAULT_MODEL_SELECTION.chat,
        apiKey: ' ',
      }),
    });
    expect(response.status).toBe(400);
    const history = await rendererRequest(app, `/api/conversations/${conversation.id}/messages`);
    expect(await history.json()).toEqual({ messages: [] });
  });

  it('rejects a chat request that carries more than the current user message', async () => {
    const { app } = await createFixture();
    const created = await rendererRequest(app, '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'History' }),
    });
    const { conversation } = await created.json() as { conversation: { id: string } };
    const message = { id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '你好' }] };
    const response = await rendererRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId: randomUUID(),
        messages: [message, message],
        attachmentIds: [],
        model: DEFAULT_MODEL_SELECTION.chat,
        apiKey: 'test-key',
      }),
    });
    expect(response.status).toBe(400);
  });

  it('requires login and separates user conversations and assets', async () => {
    const { app, artifacts } = await createFixture();
    const anonymous = await rendererRequest(app, '/api/conversations', { headers: { Cookie: '' } });
    expect(anonymous.status).toBe(401);
    const login = async (username: string) => rendererRequest(app, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: '' },
      body: JSON.stringify({ username, password: 'test' }),
    });
    expect((await login('alice')).status).toBe(200);
    expect((await login('bob')).status).toBe(200);
    const aliceHeaders = { Cookie: 'username=alice', 'Content-Type': 'application/json' };
    const bobHeaders = { Cookie: 'username=bob' };
    const response = await rendererRequest(app, '/api/conversations', {
      method: 'POST', headers: aliceHeaders, body: JSON.stringify({ title: 'Private' }),
    });
    expect(response.status).toBe(201);
    const { conversation } = await response.json() as { conversation: { id: string } };
    const asset = artifacts.createPending({ conversationId: conversation.id, brief: 'test', script: 'import bpy' });
    const list = await rendererRequest(app, '/api/conversations', { headers: bobHeaders });
    expect(await list.json()).toEqual({ conversations: [] });
    expect((await rendererRequest(app, `/api/conversations/${conversation.id}`, { headers: bobHeaders })).status).toBe(404);
    expect((await rendererRequest(app, `/api/conversations/${conversation.id}/messages`, { headers: bobHeaders })).status).toBe(404);
    expect((await rendererRequest(app, `/api/artifacts/${asset.id}`, { headers: bobHeaders })).status).toBe(404);
    expect((await rendererRequest(app, `/api/artifacts/${asset.id}/reject`, {
      method: 'POST', headers: { ...bobHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1 }),
    })).status).toBe(404);
    expect((await rendererRequest(app, `/api/artifacts/${asset.id}`, { headers: aliceHeaders })).status).toBe(200);
  });

  it('displays and stores the validated reply rather than streamed structured JSON', async () => {
    const { app, database } = await createFixture();
    const selectedModel = { providerId: 'openai', modelId: 'openai/gpt-4.1-mini', baseURL: 'https://api.openai.com/v1' };
    const createdResponse = await rendererRequest(app, '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Structured chat' }),
    });
    const { conversation } = await createdResponse.json() as { conversation: { id: string } };
    const result = { result: { type: 'chat', reply: '你好' } };
    const chunks = [
      { type: 'text-start', id: 'text' },
      { type: 'text-delta', id: 'text', delta: '你好' },
      { type: 'text-end', id: 'text' },
      { type: 'finish' },
    ];
    const fetchSpy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    vi.stubGlobal('fetch', fetchSpy);
    const response = await rendererRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '你好' }] }],
        attachmentIds: [],
        model: selectedModel,
        apiKey: 'example-test-key',
      }),
    });
    const stream = await response.text();
    const forwarded = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(forwarded.agent3d.model).toEqual(selectedModel);
    expect(forwarded.agent3d.apiKey).toBe('example-test-key');
    const tables = database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const rows = tables.flatMap(({ name }) => database.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all());
    expect(JSON.stringify(rows).includes('example-test-key')).toBe(false);
    expect(stream).toContain('"delta":"你好"');
    expect(stream).not.toContain('\\"result\\"');
    const history = await rendererRequest(app, `/api/conversations/${conversation.id}/messages`);
    const data = await history.json();
    expect(data).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', parts: expect.arrayContaining([{ type: 'text', text: '你好' }]) }),
    ]) });
  });

  it('forwards the reply text incrementally while the structured JSON streams in', async () => {
    const { app } = await createFixture();
    const createdResponse = await rendererRequest(app, '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Streaming chat' }),
    });
    const { conversation } = await createdResponse.json() as { conversation: { id: string } };
    const result = { result: { type: 'chat', reply: '第一段\n第二段' } };
    const fragments = ['第一', '段\n', '第二', '段'];
    const chunks = [
      { type: 'text-start', id: 'text' },
      ...fragments.map((delta) => ({ type: 'text-delta', id: 'text', delta })),
      { type: 'text-end', id: 'text' },
      { type: 'finish' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    )));
    const response = await rendererRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '你好' }] }],
        attachmentIds: [],
        model: DEFAULT_MODEL_SELECTION.chat,
        apiKey: 'example-test-key',
      }),
    });
    const stream = await response.text();
    const deltas = stream.split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { type?: string; id?: string; delta?: string })
      .filter((chunk) => chunk.type === 'text-delta' && chunk.id === 'text')
      .map((chunk) => chunk.delta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('第一段\n第二段');
    expect(stream).not.toContain('\\"result\\"');
  });

  it('creates a pending asset from a validated structured result', async () => {
    const { app } = await createFixture();
    const createdResponse = await rendererRequest(app, '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Asset chat' }),
    });
    const { conversation } = await createdResponse.json() as { conversation: { id: string } };
    const result = {
      result: { type: 'asset', brief: '低多边形树木', script: 'import bpy', blenderVersion: '4.x', preferenceProposals: [] },
    };
    const chunk = { type: 'tool-output-available', toolCallId: 'script', output: { script: 'import bpy', validation: 'passed' } };
    const inputChunk = { type: 'tool-input-available', toolCallId: 'script', toolName: 'generate-three-model', input: { script: 'import bpy' } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(inputChunk)}\n\ndata: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    })));
    const response = await rendererRequest(app, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversation.id,
        clientTurnId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', parts: [{ type: 'text', text: '请生成一个树木模型' }] }],
        attachmentIds: [],
        model: DEFAULT_MODEL_SELECTION.chat,
        apiKey: 'example-test-key',
      }),
    });
    const stream = await response.text();
    expect(stream).toContain('"type":"data-asset"');
    expect(stream).toContain('"status":"pending"');
    expect(stream).toContain('"toolName":"generate-three-model"');
  });

  it('creates and lists conversations through SQLite', async () => {
    const { app } = await createFixture();
    const createResponse = await rendererRequest(app, '/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A real local conversation' }),
    });

    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversation: { id: string; title: string };
    };
    const listResponse = await rendererRequest(app, '/api/conversations');
    const list = await listResponse.json() as {
      conversations: Array<{ id: string; title: string }>;
    };

    expect(list.conversations).toContainEqual(created.conversation);
  });

  it('reads and updates model selections using non-secret values', async () => {
    const { app } = await createFixture();
    const selection = {
      chat: {
        providerId: 'openai',
        modelId: 'openai/gpt-4.1-mini',
        baseURL: 'https://api.openai.com/v1',
      },
      image: DEFAULT_MODEL_SELECTION.image,
    };
    const updateResponse = await rendererRequest(app, '/api/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection),
    });

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({ selection });

    const readResponse = await rendererRequest(app, '/api/models');
    const models = await readResponse.json() as {
      selection: {
        chat: Record<string, unknown>;
      };
    };
    expect(models).toMatchObject({ selection });
    expect(Object.keys(models.selection.chat)).toEqual(['providerId', 'modelId', 'baseURL']);
  });

  it('rejects unsupported provider and model selections', async () => {
    const { app } = await createFixture();
    const response = await rendererRequest(app, '/api/models', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...DEFAULT_MODEL_SELECTION,
        chat: {
          providerId: 'agnes',
          modelId: 'agnes/not-a-model',
          baseURL: 'https://apihub.agnes-ai.com/v1',
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: false,
    });
  });

  it('stores and deletes user preferences through SQLite', async () => {
    const { app } = await createFixture();
    const updateResponse = await rendererRequest(app, '/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'asset.style', value: 'low-poly' }),
    });

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      preferences: { 'asset.style': 'low-poly' },
    });

    const deleteResponse = await rendererRequest(app, '/api/preferences', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'asset.style' }),
    });
    expect(deleteResponse.status).toBe(204);
  });

  it('rejects browser requests from an unexpected origin', async () => {
    const { app } = await createFixture();
    const response = await app.request('/api/conversations', {
      headers: { Origin: 'https://example.com' },
    });

    expect(response.status).toBe(403);
  });
});
