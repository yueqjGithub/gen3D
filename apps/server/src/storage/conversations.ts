import { randomUUID } from 'node:crypto';
import {
  chatMessageSchema,
  conversationSchema,
  type ChatMessage,
  type Conversation,
} from '@agent3d/shared';
import { z } from 'zod';
import type { SqliteDatabase } from './database';

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  parts_json: string;
  created_at: string;
  status: 'complete' | 'error';
}

interface ChatTurnRow {
  conversation_id: string;
  client_turn_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  status: 'running' | 'failed' | 'complete';
  updated_at: string;
}

export class ChatTurnPayloadConflictError extends Error {
  constructor(clientTurnId: string) {
    super(`The client turn ID was already used with different content: ${clientTurnId}`);
    this.name = 'ChatTurnPayloadConflictError';
  }
}

export class ChatTurnConflictError extends Error {
  constructor(clientTurnId: string) {
    super(`The chat turn is already being processed or is no longer writable: ${clientTurnId}`);
    this.name = 'ChatTurnConflictError';
  }
}

export interface ChatTurnResult {
  state: 'created' | 'retry' | 'running' | 'failed' | 'complete';
  userMessage: ChatMessage;
  assistantMessage: ChatMessage | null;
}

export function createConversationRepository(database: SqliteDatabase) {
  const toMessage = (row: MessageRow): ChatMessage => chatMessageSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    parts: JSON.parse(row.parts_json),
    createdAt: row.created_at,
    status: row.status,
  });

  const getMessage = (id: string): ChatMessage | null => {
    const row = database.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined;
    return row ? toMessage(row) : null;
  };

  const getTurn = (conversationId: string, clientTurnId: string): ChatTurnResult | null => {
    const row = database.prepare(`
      SELECT * FROM chat_turns WHERE conversation_id = ? AND client_turn_id = ?
    `).get(conversationId, clientTurnId) as ChatTurnRow | undefined;
    if (!row) {
      return null;
    }

    const userMessage = getMessage(row.user_message_id);
    if (!userMessage) {
      throw new Error(`The user message for turn ${clientTurnId} is missing.`);
    }
    return {
      state: row.status,
      userMessage,
      assistantMessage: row.assistant_message_id
        ? getMessage(row.assistant_message_id)
        : null,
    };
  };

  const finishTurn = (
    conversationId: string,
    clientTurnId: string,
    message: ChatMessage,
    status: 'failed' | 'complete',
  ): ChatMessage => {
    const validMessage = chatMessageSchema.parse(message);
    if (validMessage.conversationId !== conversationId || validMessage.role !== 'assistant') {
      throw new TypeError('A chat turn can only be completed with its assistant message.');
    }
    const expectedMessageStatus = status === 'complete' ? 'complete' : 'error';
    if (validMessage.status !== expectedMessageStatus) {
      throw new TypeError(`Assistant message status must be ${expectedMessageStatus}.`);
    }

    const finish = database.transaction(() => {
      const current = database.prepare(`
        SELECT * FROM chat_turns WHERE conversation_id = ? AND client_turn_id = ?
      `).get(conversationId, clientTurnId) as ChatTurnRow | undefined;
      if (!current) {
        throw new Error(`Chat turn not found: ${clientTurnId}`);
      }
      if (current.status !== 'running') {
        throw new ChatTurnConflictError(clientTurnId);
      }

      if (current.assistant_message_id) {
        database.prepare(`
          UPDATE messages SET parts_json = ?, created_at = ?, status = ?
          WHERE id = ? AND conversation_id = ? AND role = 'assistant'
        `).run(
          JSON.stringify(validMessage.parts),
          validMessage.createdAt,
          validMessage.status,
          current.assistant_message_id,
          conversationId,
        );
      } else {
        database.prepare(`
          INSERT INTO messages (id, conversation_id, role, parts_json, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          validMessage.id,
          validMessage.conversationId,
          validMessage.role,
          JSON.stringify(validMessage.parts),
          validMessage.createdAt,
          validMessage.status,
        );
      }

      const messageId = current.assistant_message_id ?? validMessage.id;
      database.prepare(`
        UPDATE chat_turns SET assistant_message_id = ?, status = ?, updated_at = ?
        WHERE conversation_id = ? AND client_turn_id = ? AND status = 'running'
      `).run(messageId, status, new Date().toISOString(), conversationId, clientTurnId);
      database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), conversationId);
      return getMessage(messageId);
    });

    const savedMessage = finish.immediate();
    if (!savedMessage) {
      throw new Error(`Assistant message was not saved for turn ${clientTurnId}.`);
    }
    return savedMessage;
  };

  const get = (id: string): Conversation | null => {
    const row = database.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
    if (!row) {
      return null;
    }

    return conversationSchema.parse({
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  };

  return {
    list(): Conversation[] {
      const rows = database
        .prepare('SELECT * FROM conversations ORDER BY updated_at DESC, id ASC')
        .all() as ConversationRow[];
      return rows.map((row) => conversationSchema.parse({
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    create(title: string): Conversation {
      const now = new Date().toISOString();
      const conversation = conversationSchema.parse({
        id: randomUUID(),
        title,
        createdAt: now,
        updatedAt: now,
      });
      database
        .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt);
      return conversation;
    },

    get,

    rename(id: string, title: string): Conversation {
      const updatedAt = new Date().toISOString();
      const result = database
        .prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?')
        .run(conversationSchema.shape.title.parse(title), updatedAt, id);
      if (result.changes !== 1) {
        throw new Error(`Conversation not found: ${id}`);
      }

      return get(id)!;
    },

    delete(id: string): boolean {
      return database.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes === 1;
    },

    appendMessage(message: ChatMessage): void {
      const validMessage = chatMessageSchema.parse(message);
      database.prepare(`
        INSERT INTO messages (id, conversation_id, role, parts_json, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        validMessage.id,
        validMessage.conversationId,
        validMessage.role,
        JSON.stringify(validMessage.parts),
        validMessage.createdAt,
        validMessage.status,
      );
      database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), validMessage.conversationId);
    },

    beginTurn(conversationId: string, clientTurnId: string, userMessage: ChatMessage): ChatTurnResult {
      const validTurnId = z.uuid().parse(clientTurnId);
      const validMessage = chatMessageSchema.parse(userMessage);
      if (validMessage.conversationId !== conversationId || validMessage.role !== 'user') {
        throw new TypeError('A chat turn must begin with a user message in the same conversation.');
      }

      const begin = database.transaction(() => {
        const existing = getTurn(conversationId, validTurnId);
        if (existing) {
          if (JSON.stringify(existing.userMessage.parts) !== JSON.stringify(validMessage.parts)) {
            throw new ChatTurnPayloadConflictError(validTurnId);
          }
          if (existing.state === 'complete' || existing.state === 'running') {
            return existing;
          }

          database.prepare(`
            UPDATE chat_turns SET status = 'running', updated_at = ?
            WHERE conversation_id = ? AND client_turn_id = ? AND status = 'failed'
          `).run(new Date().toISOString(), conversationId, validTurnId);
          return {
            ...existing,
            state: 'retry' as const,
          };
        }

        database.prepare(`
          INSERT INTO messages (id, conversation_id, role, parts_json, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          validMessage.id,
          validMessage.conversationId,
          validMessage.role,
          JSON.stringify(validMessage.parts),
          validMessage.createdAt,
          validMessage.status,
        );
        const updatedAt = new Date().toISOString();
        database.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
          .run(updatedAt, conversationId);
        database.prepare(`
          INSERT INTO chat_turns (
            conversation_id, client_turn_id, user_message_id, assistant_message_id, status, updated_at
          ) VALUES (?, ?, ?, NULL, 'running', ?)
        `).run(conversationId, validTurnId, validMessage.id, updatedAt);
        return {
          state: 'created' as const,
          userMessage: validMessage,
          assistantMessage: null,
        };
      });

      return begin.immediate();
    },

    getTurn,

    completeTurn(conversationId: string, clientTurnId: string, assistantMessage: ChatMessage): ChatMessage {
      return finishTurn(conversationId, clientTurnId, assistantMessage, 'complete');
    },

    failTurn(conversationId: string, clientTurnId: string, assistantMessage: ChatMessage): ChatMessage {
      return finishTurn(conversationId, clientTurnId, assistantMessage, 'failed');
    },

    listMessages(conversationId: string): ChatMessage[] {
      const rows = database
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC')
        .all(conversationId) as MessageRow[];
      return rows.map(toMessage);
    },
  };
}
