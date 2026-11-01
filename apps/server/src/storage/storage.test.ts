import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactRepository } from './artifacts';
import { createAttachmentStore } from './attachments';
import { createConversationRepository } from './conversations';
import { createDatabase } from './database';
import { databaseMigrations } from './migration-scripts';
import { createPreferenceRepository } from './preferences';

describe('SQLite storage', () => {
  let directory: string;
  let databasePath: string;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'agent3d-storage-'));
    databasePath = join(directory, 'app.sqlite');
    database = createDatabase(databasePath);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('embedsAllSqlMigrationsForBundledDesktopStartup', () => {
    expect(databaseMigrations.map(({ version }) => version)).toEqual([1, 2, 3]);
    expect(databaseMigrations.map(({ sql }) => sql).join('\n')).toContain(
      'CREATE TABLE chat_turns',
    );
  });

  it('migrationIsIdempotent', () => {
    database.close();
    database = createDatabase(databasePath);
    database.close();
    database = createDatabase(databasePath);

    expect(database.connection.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(createConversationRepository(database.connection).list()).toEqual([]);
  });

  it('conversationCrudPreservesMessageOrder', () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Stone sculpture');

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
    expect(conversations.rename(conversation.id, 'Faceted stone')).toMatchObject({
      id: conversation.id,
      title: 'Faceted stone',
    });
  });

  it('chatTurnIdempotencyReusesFailedTurnWithoutDuplicatingMessages', () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Idempotent turn');
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

  it('recoversInterruptedChatTurnsAsRetryableAfterRestart', () => {
    const conversations = createConversationRepository(database.connection);
    const conversation = conversations.create('Interrupted turn');
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
    database = createDatabase(databasePath);

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
    const conversation = conversations.create('Temporary asset');
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

    expect(conversations.delete(conversation.id)).toBe(true);
    await attachments.deleteByConversation(conversation.id);

    expect(conversations.get(conversation.id)).toBeNull();
    expect(conversations.listMessages(conversation.id)).toEqual([]);
    expect(artifacts.get(artifact.id)).toBeNull();
    expect(await attachments.read(attachment.id)).toBeNull();
  });

  it('preferenceRepositoryPersistsExplicitValues', () => {
    const preferences = createPreferenceRepository(database.connection);

    preferences.upsert('visualStyle', 'faceted');

    expect(preferences.list()).toEqual({ visualStyle: 'faceted' });
    expect(preferences.delete('visualStyle')).toBe(true);
    expect(preferences.list()).toEqual({});
  });

  it('artifactUpdateRequiresExpectedVersion', () => {
    const conversations = createConversationRepository(database.connection);
    const artifacts = createArtifactRepository(database.connection);
    const conversation = conversations.create('Versioned asset');
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
    const conversation = conversations.create('Path validation');

    await expect(attachments.save(
      conversation.id,
      '..\\outside.png',
      'image/png',
      new Uint8Array([1]),
    )).rejects.toThrow();
  });
});
