import { randomUUID } from 'node:crypto';
import { chatMessageSchema, conversationSchema, type ChatMessage, type Conversation } from '@agent3d/shared';
import { z } from 'zod';
import type { SqliteDatabase } from './database';

interface ThreadRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  clientTurnId?: string | null;
}

/**
 * 两种写入者共用 Mastra 原生消息表：应用保存 UI 流，Mastra 保存原生 parts。
 * 不能把原生 tool-invocation 当成本项目的 ui-chunk 直接校验，否则一旦有工具调用，
 * 刷新、读取历史和重试都会失败。这里只在“读取历史”的边界转换，不改数据库原文。
 */
export function readStoredMessage(row: MessageRow): ChatMessage {
  const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  const saved = content.metadata?.agent3d;
  const parts: ChatMessage['parts'] = [];
  if (!saved) for (const part of content.parts) {
    if (part.type === 'text' || part.type === 'reasoning') {
      parts.push({ type: part.type, text: part.text });
    } else if (part.type === 'step-start') {
      parts.push({ type: 'ui-chunk', chunk: { type: 'start-step' } });
    } else if (part.type === 'tool-invocation') {
      const tool = part.toolInvocation;
      parts.push({ type: 'ui-chunk', chunk: {
        type: 'tool-input-available', toolCallId: tool.toolCallId,
        toolName: tool.toolName, input: tool.args ?? {},
      } });
      if (tool.state === 'result' && !tool.isError) {
        parts.push({ type: 'ui-chunk', chunk: {
          type: 'tool-output-available', toolCallId: tool.toolCallId, output: tool.result,
        } });
      } else if (tool.state === 'output-error' || tool.isError) {
        parts.push({ type: 'ui-chunk', chunk: {
          type: 'tool-output-error', toolCallId: tool.toolCallId,
          errorText: '此工具调用未完成。',
        } });
      } else {
        // 旧请求的审批回调已不在当前连接中，不重建一个无法提交的审批按钮。
        parts.push({ type: 'ui-chunk', chunk: {
          type: 'tool-output-error', toolCallId: tool.toolCallId,
          errorText: '上次工具调用已中断，请重试本轮请求。',
        } });
      }
    } else if (part.type === 'file') {
      parts.push({ type: 'ui-chunk', chunk: {
        type: 'file', url: part.data ?? part.url, mediaType: part.mimeType ?? part.mediaType,
      } });
    } else if (part.type === 'error') {
      parts.push({ type: 'text', text: '上次生成未完成，请重试。' });
    } else {
      // 仍然校验未知片段，避免悄悄吞掉将来新增的内容。
      parts.push(...chatMessageSchema.shape.parts.parse([part]));
    }
  }
  return chatMessageSchema.parse({
    id: row.id, conversationId: row.thread_id, role: row.role,
    parts: saved?.parts ?? parts, createdAt: row.createdAt,
    status: saved?.status ?? 'complete',
    ...(row.clientTurnId ? { clientTurnId: row.clientTurnId } : {}),
  });
}

interface TurnRow {
  user_message_id: string;
  assistant_message_id: string | null;
  status: 'running' | 'failed' | 'complete';
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

/**
 * 会话和消息使用 Mastra 初始化的表。这里直接操作这两张表，
 * 是为了和应用自己的 chat_turns 在同一个 SQLite 事务中完成写入。
 * 供模型读取的文本放在 Mastra 标准 content.parts；界面专用片段和状态放在 metadata。
 */
export function createConversationRepository(database: SqliteDatabase) {
  const toMessage = readStoredMessage;

  const saveMessage = (message: ChatMessage) => {
    const valid = chatMessageSchema.parse(message);
    const content = JSON.stringify({
      format: 2,
      parts: valid.parts.filter((part) => part.type === 'text'),
      metadata: { agent3d: { parts: valid.parts, status: valid.status } },
    });
    const thread = database.prepare('SELECT "resourceId" FROM mastra_threads WHERE id = ?')
      .get(valid.conversationId) as { resourceId: string } | undefined;
    if (!thread) throw new Error(`Conversation not found: ${valid.conversationId}`);
    database.prepare(`
      INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
      VALUES (?, ?, ?, ?, 'v2', ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, "createdAt" = excluded."createdAt"
    `).run(valid.id, valid.conversationId, content, valid.role, valid.createdAt, thread.resourceId);
  };

  const getMessage = (id: string): ChatMessage | null => {
    const row = database.prepare('SELECT * FROM mastra_messages WHERE id = ?').get(id) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  };

  const getTurn = (conversationId: string, clientTurnId: string): ChatTurnResult | null => {
    const row = database.prepare(
      'SELECT * FROM chat_turns WHERE conversation_id = ? AND client_turn_id = ?',
    ).get(conversationId, clientTurnId) as TurnRow | undefined;
    if (!row) return null;
    const userMessage = getMessage(row.user_message_id);
    if (!userMessage) throw new Error(`The user message for turn ${clientTurnId} is missing.`);
    return {
      state: row.status,
      userMessage,
      assistantMessage: row.assistant_message_id ? getMessage(row.assistant_message_id) : null,
    };
  };

  const finishTurn = (
    conversationId: string,
    clientTurnId: string,
    message: ChatMessage,
    status: 'failed' | 'complete',
  ): ChatMessage => {
    const valid = chatMessageSchema.parse(message);
    if (valid.conversationId !== conversationId || valid.role !== 'assistant'
      || valid.status !== (status === 'complete' ? 'complete' : 'error')) {
      throw new TypeError('Invalid assistant message for chat turn.');
    }
    return database.transaction(() => {
      const current = getTurn(conversationId, clientTurnId);
      if (!current) throw new Error(`Chat turn not found: ${clientTurnId}`);
      if (current.state !== 'running') throw new ChatTurnConflictError(clientTurnId);
      const saved = { ...valid, id: current.assistantMessage?.id ?? valid.id };
      saveMessage(saved);
      database.prepare(`
        UPDATE chat_turns SET assistant_message_id = ?, status = ?, updated_at = ?
        WHERE conversation_id = ? AND client_turn_id = ?
      `).run(saved.id, status, new Date().toISOString(), conversationId, clientTurnId);
      database.prepare('UPDATE mastra_threads SET "updatedAt" = ? WHERE id = ?')
        .run(new Date().toISOString(), conversationId);
      return saved;
    }).immediate();
  };

  const get = (id: string, username: string): Conversation | null => {
    const row = database.prepare('SELECT id, title, "createdAt", "updatedAt" FROM mastra_threads WHERE id = ? AND "resourceId" = ?')
      .get(id, username) as ThreadRow | undefined;
    return row ? conversationSchema.parse(row) : null;
  };

  return {
    list(username: string): Conversation[] {
      const rows = database.prepare(`
        SELECT id, title, "createdAt", "updatedAt" FROM mastra_threads
        WHERE "resourceId" = ? ORDER BY "updatedAt" DESC, id ASC
      `).all(username) as ThreadRow[];
      return rows.map((row) => conversationSchema.parse(row));
    },
    create(title: string, username: string): Conversation {
      const now = new Date().toISOString();
      const conversation = conversationSchema.parse({ id: randomUUID(), title, createdAt: now, updatedAt: now });
      database.prepare(`
        INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
        VALUES (?, ?, ?, NULL, ?, ?)
      `).run(conversation.id, username, conversation.title, now, now);
      return conversation;
    },
    get,
    rename(id: string, title: string, username: string): Conversation {
      const result = database.prepare(`
        UPDATE mastra_threads SET title = ?, "updatedAt" = ? WHERE id = ? AND "resourceId" = ?
      `).run(conversationSchema.shape.title.parse(title), new Date().toISOString(), id, username);
      if (result.changes !== 1) throw new Error(`Conversation not found: ${id}`);
      return get(id, username)!;
    },
    delete(id: string, username: string): boolean {
      return database.transaction(() => {
        if (!get(id, username)) return false;
        database.prepare('DELETE FROM mastra_messages WHERE thread_id = ?').run(id);
        return database.prepare('DELETE FROM mastra_threads WHERE id = ?').run(id).changes === 1;
      }).immediate();
    },
    appendMessage(message: ChatMessage): void {
      database.transaction(() => {
        saveMessage(message);
        database.prepare('UPDATE mastra_threads SET "updatedAt" = ? WHERE id = ?')
          .run(new Date().toISOString(), message.conversationId);
      }).immediate();
    },
    beginTurn(conversationId: string, clientTurnId: string, userMessage: ChatMessage): ChatTurnResult {
      const validTurnId = z.uuid().parse(clientTurnId);
      const valid = chatMessageSchema.parse(userMessage);
      if (valid.conversationId !== conversationId || valid.role !== 'user') {
        throw new TypeError('A chat turn must begin with a user message in the same conversation.');
      }
      return database.transaction(() => {
        const existing = getTurn(conversationId, validTurnId);
        if (existing) {
          if (JSON.stringify(existing.userMessage.parts) !== JSON.stringify(valid.parts)) {
            throw new ChatTurnPayloadConflictError(validTurnId);
          }
          if (existing.state !== 'failed') return existing;
          database.prepare(`
            UPDATE chat_turns SET status = 'running', updated_at = ?
            WHERE conversation_id = ? AND client_turn_id = ?
          `).run(new Date().toISOString(), conversationId, validTurnId);
          return { ...existing, state: 'retry' as const };
        }
        saveMessage(valid);
        const updatedAt = new Date().toISOString();
        database.prepare('UPDATE mastra_threads SET "updatedAt" = ? WHERE id = ?')
          .run(updatedAt, conversationId);
        database.prepare(`
          INSERT INTO chat_turns (conversation_id, client_turn_id, user_message_id, assistant_message_id, status, updated_at)
          VALUES (?, ?, ?, NULL, 'running', ?)
        `).run(conversationId, validTurnId, valid.id, updatedAt);
        return { state: 'created' as const, userMessage: valid, assistantMessage: null };
      }).immediate();
    },
    getTurn,
    completeTurn(conversationId: string, clientTurnId: string, message: ChatMessage): ChatMessage {
      return finishTurn(conversationId, clientTurnId, message, 'complete');
    },
    failTurn(conversationId: string, clientTurnId: string, message: ChatMessage): ChatMessage {
      return finishTurn(conversationId, clientTurnId, message, 'failed');
    },
    listMessages(conversationId: string): ChatMessage[] {
      const rows = database.prepare(`
        SELECT m.*, t.client_turn_id AS clientTurnId FROM mastra_messages m
        LEFT JOIN chat_turns t ON t.user_message_id = m.id OR t.assistant_message_id = m.id
        WHERE m.thread_id = ? ORDER BY m."createdAt" ASC, m.id ASC
      `).all(conversationId) as MessageRow[];
      return rows.map(toMessage);
    },
  };
}
