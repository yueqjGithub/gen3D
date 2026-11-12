import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { createArtifactRepository } from './artifacts';
import { createAttachmentStore } from './attachments';
import { createConversationRepository } from './conversations';
import { createDatabase } from './database';
import { databaseMigrations } from './migration-scripts';
import { createPreferenceRepository } from './preferences';
import { createTestDirectory } from '../test-directory';

describe('SQLite storage', () => {
  let directory: string;
  let databasePath: string;
  let database: Awaited<ReturnType<typeof createDatabase>>;

  beforeEach(async () => {
    directory = createTestDirectory('storage-');
    databasePath = join(directory, 'app.sqlite');
    database = await createDatabase(databasePath);
    database.connection.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('agent3d-local', 'test');
  });

  afterEach(() => {
    database.close();
  });

  it('embedsAllSqlMigrationsForBundledDesktopStartup', () => {
    expect(databaseMigrations.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5]);
    expect(databaseMigrations.map(({ sql }) => sql).join('\n')).toContain(
      'CREATE TABLE chat_turns',
    );
  });

  it('migrationIsIdempotent', async () => {
    database.close();
    database = await createDatabase(databasePath);
    database.close();
    database = await createDatabase(databasePath);

    expect(database.connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(createConversationRepository(database.connection).list('agent3d-local')).toEqual([]);
  });

  it('rejects a database with legacy conversation tables', async () => {
    database.connection.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY)');
    database.close();
    await expect(createDatabase(databasePath)).rejects.toThrow('Legacy conversation tables');
    database = await createDatabase(join(directory, 'fresh.sqlite'));
  });

  it('stores conversations and messages in Mastra memory tables', async () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Shared memory', 'agent3d-local');
    const message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Hello Mastra' }],
      createdAt: new Date().toISOString(),
      status: 'complete' as const,
    };
    conversations.appendMessage(message);
    expect(database.connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversations', 'messages')
    `).all()).toEqual([]);
    expect(database.connection.prepare('SELECT id FROM mastra_threads WHERE id = ?').get(conversation.id))
      .toEqual({ id: conversation.id });
    const row = database.connection.prepare('SELECT content FROM mastra_messages WHERE id = ?')
      .get(message.id) as { content: string };
    expect(JSON.parse(row.content)).toMatchObject({
      format: 2,
      parts: [{ type: 'text', text: 'Hello Mastra' }],
    });
    expect(conversations.listMessages(conversation.id)).toEqual([message]);
    const storage = new LibSQLStore({ id: 'memory-read-test', url: `file:${databasePath}` });
    try {
      const memory = await storage.getStore('memory');
      expect(memory).toBeDefined();
      const thread = await memory!.getThreadById({ threadId: conversation.id });
      expect(thread).toMatchObject({ id: conversation.id, title: 'Shared memory' });
      const result = await memory!.listMessages({
        threadId: conversation.id,
        resourceId: 'agent3d-local',
        perPage: false,
      });
      expect(result.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: message.id, content: expect.objectContaining({
          parts: [{ type: 'text', text: 'Hello Mastra' }],
        }) }),
      ]));
      const nativeId = randomUUID();
      const createdAt = new Date();
      await memory!.saveMessages({ messages: [{
        id: nativeId,
        threadId: conversation.id,
        resourceId: 'agent3d-local',
        role: 'assistant',
        createdAt,
        content: { format: 2, parts: [{ type: 'text', text: 'Hello from Mastra' }] },
      }] });
      expect(conversations.listMessages(conversation.id)).toContainEqual({
        id: nativeId,
        conversationId: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello from Mastra' }],
        createdAt: createdAt.toISOString(),
        status: 'complete',
      });
    } finally {
      await storage.close();
    }
  });

  it('conversationCrudPreservesMessageOrder', () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Stone sculpture', 'agent3d-local');

    conversations.appendMessage({
      id: '123e4567-e89b-42d3-a456-426614174001',
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'Make a stone sculpture.' }],
      createdAt: '2026-11-01T00:00:02.000Z',
      status: 'complete',
    });
    conversations.appendMessage({
      id: '123e4567-e89b-42d3-a456-426614174002',
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'What scale should it be?' }],
      createdAt: '2026-11-01T00:00:01.000Z',
      status: 'complete',
    });

    expect(conversations.listMessages(conversation.id).map((message) => message.id)).toEqual([
      '123e4567-e89b-42d3-a456-426614174002',
      '123e4567-e89b-42d3-a456-426614174001',
    ]);
    expect(conversations.rename(conversation.id, 'Faceted stone', 'agent3d-local')).toMatchObject({
      id: conversation.id,
      title: 'Faceted stone',
    });
  });

  it('chatTurnIdempotencyReusesFailedTurnWithoutDuplicatingMessages', () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Idempotent turn', 'agent3d-local');
    const clientTurnId = randomUUID();
    const userMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Create a stone bowl.' }],
      createdAt: new Date().toISOString(),
      status: 'complete' as const,
    };

    expect(conversations.beginTurn(conversation.id, clientTurnId, userMessage).state).toBe('created');
    conversations.failTurn(conversation.id, clientTurnId, {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'The model request failed.' }],
      createdAt: new Date().toISOString(),
      status: 'error',
    });

    const retry = conversations.beginTurn(conversation.id, clientTurnId, {
      ...userMessage,
      id: randomUUID(),
    });
    expect(retry.state).toBe('retry');
    expect(retry.userMessage.id).toBe(userMessage.id);

    const completed = conversations.completeTurn(conversation.id, clientTurnId, {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'A shallow stone bowl.' }],
      createdAt: new Date().toISOString(),
      status: 'complete',
    });
    expect(completed.status).toBe('complete');

    const replay = conversations.beginTurn(conversation.id, clientTurnId, {
      ...userMessage,
      id: randomUUID(),
    });
    expect(replay.state).toBe('complete');
    expect(replay.assistantMessage?.id).toBe(completed.id);
    expect(conversations.listMessages(conversation.id).filter(({ role }) => role === 'user'))
      .toHaveLength(1);
    expect(conversations.listMessages(conversation.id).filter(({ role }) => role === 'assistant'))
      .toHaveLength(1);
    expect(() => conversations.beginTurn(conversation.id, clientTurnId, {
      ...userMessage,
      parts: [{ type: 'text', text: 'Different content.' }],
    })).toThrow();
  });

  it('recoversInterruptedChatTurnsAsRetryableAfterRestart', async () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Interrupted turn', 'agent3d-local');
    const clientTurnId = randomUUID();
    const userMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Create a stone bowl.' }],
      createdAt: new Date().toISOString(),
      status: 'complete' as const,
    };

    conversations.beginTurn(conversation.id, clientTurnId, userMessage);
    database.close();
    database = await createDatabase(databasePath);

    const retry = createConversationRepository(database.connection).beginTurn(
      conversation.id,
      clientTurnId,
      { ...userMessage, id: randomUUID() },
    );
    expect(retry.state).toBe('retry');
  });

  it('deleteConversationCleansRelatedData', async () => {
    const conversations = createConversationRepository(database.connection);
    const artifacts = createArtifactRepository(database.connection);
    const attachments = createAttachmentStore(database.connection, join(directory, 'attachments'));
    const conversation = conversations.create('Temporary asset', 'agent3d-local');
    const artifact = artifacts.createPending({
      conversationId: conversation.id,
      brief: 'A temporary faceted asset.',
      script: 'import bpy',
    });
    const attachment = await attachments.save(
      conversation.id,
      'reference.png',
      'image/png',
      new Uint8Array([1, 2, 3]),
    );

    expect(conversations.delete(conversation.id, 'agent3d-local')).toBe(true);
    await attachments.deleteByConversation(conversation.id);

    expect(conversations.get(conversation.id, 'agent3d-local')).toBeNull();
    expect(conversations.listMessages(conversation.id)).toEqual([]);
    expect(artifacts.get(artifact.id)).toBeNull();
    expect(await attachments.read(attachment.id)).toBeNull();
  });

  it('preferenceRepositoryPersistsExplicitValues', () => {
    const preferences = createPreferenceRepository(database.connection);

    preferences.upsert('visualStyle', 'faceted', 'agent3d-local');

    expect(preferences.list('agent3d-local')).toEqual({ visualStyle: 'faceted' });
    expect(preferences.delete('visualStyle', 'agent3d-local')).toBe(true);
    expect(preferences.list('agent3d-local')).toEqual({});
  });

  it('artifactUpdateRequiresExpectedVersion', () => {
    const conversations = createConversationRepository(database.connection);
    const artifacts = createArtifactRepository(database.connection);
    const conversation = conversations.create('Versioned asset', 'agent3d-local');
    const artifact = artifacts.createPending({
      conversationId: conversation.id,
      brief: 'A faceted asset.',
      script: 'import bpy',
    });

    const edited = artifacts.updatePending(artifact.id, 1, 'import bpy\n# revised');
    expect(edited).toMatchObject({ version: 2, status: 'pending' });
    expect(() => artifacts.setStatus(artifact.id, 1, 'approved')).toThrow();
    expect(artifacts.setStatus(artifact.id, 2, 'approved').status).toBe('approved');
  });

  it('attachmentStoreRejectsPathTraversal', async () => {
    const conversations = createConversationRepository(database.connection);
    const attachments = createAttachmentStore(database.connection, join(directory, 'attachments'));
    const conversation = conversations.create('Path validation', 'agent3d-local');

    await expect(attachments.save(
      conversation.id,
      '..\\outside.png',
      'image/png',
      new Uint8Array([1]),
    )).rejects.toThrow();
  });
});
