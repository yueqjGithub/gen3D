import type { PostgresStore, TxClient } from '@mastra/pg';
import { Buffer } from 'node:buffer';
import {
  assetArtifactSchema,
  chatMessageSchema,
  conversationSchema,
  modelSelectionSchema,
  uploadMetadataSchema,
  readThreeModel,
  MAX_ATTACHMENT_BYTES,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  type ChatMessage,
  type AssetArtifact,
  type ModelSelection,
} from '@agent3d/shared';
import type { CreateAppDependencies } from '../app';
import { DEFAULT_MODEL_SELECTION } from '../config/provider-catalog';
import {
  ChatTurnConflictError,
  ChatTurnPayloadConflictError,
  readStoredMessage,
} from './conversations';
import {
  ArtifactNotFoundError,
  ArtifactVersionConflictError,
} from './artifacts';

/** 所有 SQL 都在这个文件。会话、消息继续用 Mastra 原生表；其余是应用自己的表。 */
export function createPostgresRepositories(
  storage: PostgresStore,
  env: SupabaseConfig,
): CreateAppDependencies {
  const db = storage.db;
  const date = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);
  const toConversation = (row: any) =>
    row
      ? conversationSchema.parse({
          ...row,
          createdAt: date(row.createdAt),
          updatedAt: date(row.updatedAt),
        })
      : null;
  const toArtifact = (row: any) =>
    row
      ? assetArtifactSchema.parse({
          id: row.id,
          conversationId: row.conversation_id,
          version: row.version,
          brief: row.brief,
          script: row.script,
          blenderVersion: row.blender_version,
          status: row.status,
          createdAt: date(row.created_at),
        })
      : null;
  const toAttachment = (row: any) =>
    uploadMetadataSchema.parse({
      id: row.id,
      conversationId: row.conversation_id,
      fileName: row.file_name,
      mediaType: row.media_type,
      size: Number(row.size),
      kind: row.kind,
      createdAt: date(row.created_at),
    });
  function toMessage(row: any): ChatMessage | null {
    if (!row) return null;
    return readStoredMessage({ ...row, createdAt: date(row.createdAt) });
  }

  // Secret key 只在服务端发送，Storage bucket 始终为 private。浏览器访问应用自己的鉴权接口。
  async function objectRequest(key: string, method = 'GET', body?: Uint8Array) {
    const url =
      env.SUPABASE_URL +
      '/storage/v1/object/' +
      (method === 'GET' ? 'authenticated/' : '') +
      env.SUPABASE_STORAGE_BUCKET +
      '/' +
      key;
    return fetch(url, {
      method,
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        ...(body ? { 'content-type': 'application/octet-stream' } : {}),
      },
      body: body as BodyInit | undefined,
    });
  }
  async function readObject(key: string): Promise<Uint8Array | null> {
    const response = await objectRequest(key);
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw Error('Private file read failed: ' + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }
  async function deleteObjects(keys: string[]) {
    if (!keys.length) return;
    const response = await fetch(
      env.SUPABASE_URL + '/storage/v1/object/' + env.SUPABASE_STORAGE_BUCKET,
      {
        method: 'DELETE',
        headers: { apikey: env.SUPABASE_SECRET_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ prefixes: keys }),
      },
    );
    if (!response.ok) throw Error('Private file deletion failed: ' + response.status);
  }
  async function saveMessage(tx: TxClient, message: ChatMessage) {
    const valid = chatMessageSchema.parse(message);
    const thread = await tx.one('SELECT "resourceId" FROM agent3d.mastra_threads WHERE id=$1', [
      valid.conversationId,
    ]);
    // 与本地版本使用同一个原生 content 格式。UI 专用数据只放 metadata，不污染 Trace。
    const content = JSON.stringify({
      format: 2,
      parts: valid.parts.filter((p) => p.type === 'text'),
      metadata: { agent3d: { parts: valid.parts, status: valid.status } },
    });
    await tx.none(
      `INSERT INTO agent3d.mastra_messages (id,thread_id,content,role,type,"createdAt","resourceId") VALUES ($1,$2,$3,$4,'v2',$5,$6)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content,"createdAt"=excluded."createdAt"`,
      [valid.id, valid.conversationId, content, valid.role, valid.createdAt, thread.resourceId],
    );
  }
  async function getTurn(conversationId: string, clientTurnId: string) {
    const row = await db.oneOrNone(
      'SELECT * FROM agent3d.chat_turns WHERE conversation_id=$1 AND client_turn_id=$2',
      [conversationId, clientTurnId],
    );
    if (!row) return null;
    const userMessage = toMessage(
      await db.one('SELECT * FROM agent3d.mastra_messages WHERE id=$1', [row.user_message_id]),
    )!;
    const assistantMessage = row.assistant_message_id
      ? toMessage(
          await db.oneOrNone('SELECT * FROM agent3d.mastra_messages WHERE id=$1', [
            row.assistant_message_id,
          ]),
        )
      : null;
    return {
      state: row.status as 'running' | 'failed' | 'complete',
      userMessage,
      assistantMessage,
    };
  }
  async function finishTurn(
    conversationId: string,
    clientTurnId: string,
    message: ChatMessage,
    status: 'complete' | 'failed',
  ) {
    const valid = chatMessageSchema.parse(message);
    if (
      valid.conversationId !== conversationId ||
      valid.role !== 'assistant' ||
      valid.status !== (status === 'complete' ? 'complete' : 'error')
    )
      throw TypeError('Invalid assistant message.');
    return db.tx(async (tx) => {
      const turn = await tx.one(
        'SELECT * FROM agent3d.chat_turns WHERE conversation_id=$1 AND client_turn_id=$2 FOR UPDATE',
        [conversationId, clientTurnId],
      );
      if (turn.status !== 'running') throw new ChatTurnConflictError(clientTurnId);
      const saved = { ...valid, id: turn.assistant_message_id ?? valid.id };
      await saveMessage(tx, saved);
      await tx.none(
        'UPDATE agent3d.chat_turns SET assistant_message_id=$1,status=$2,updated_at=$3 WHERE conversation_id=$4 AND client_turn_id=$5',
        [saved.id, status, new Date().toISOString(), conversationId, clientTurnId],
      );
      await tx.none('UPDATE agent3d.mastra_threads SET "updatedAt"=$1 WHERE id=$2', [
        new Date().toISOString(),
        conversationId,
      ]);
      return saved;
    });
  }

  const conversations: CreateAppDependencies['conversations'] = {
    async list(owner) {
      return (
        await db.any(
          'SELECT id,title,"createdAt","updatedAt" FROM agent3d.mastra_threads WHERE "resourceId"=$1 ORDER BY "updatedAt" DESC,id ASC',
          [owner],
        )
      ).map((row) => toConversation(row)!);
    },
    async create(title, owner) {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      await db.none(
        'INSERT INTO agent3d.mastra_threads (id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES ($1,$2,$3,NULL,$4,$4)',
        [id, owner, title, now],
      );
      return conversationSchema.parse({ id, title, createdAt: now, updatedAt: now });
    },
    async get(id, owner) {
      return toConversation(
        await db.oneOrNone(
          'SELECT id,title,"createdAt","updatedAt" FROM agent3d.mastra_threads WHERE id=$1 AND "resourceId"=$2',
          [id, owner],
        ),
      );
    },
    async rename(id, title, owner) {
      const row = await db.oneOrNone(
        'UPDATE agent3d.mastra_threads SET title=$1,"updatedAt"=$2 WHERE id=$3 AND "resourceId"=$4 RETURNING id,title,"createdAt","updatedAt"',
        [title, new Date().toISOString(), id, owner],
      );
      if (!row) throw Error('Conversation not found.');
      return toConversation(row)!;
    },
    async delete(id, owner) {
      return db.tx(async (tx) => {
        const row = await tx.oneOrNone(
          'SELECT id FROM agent3d.mastra_threads WHERE id=$1 AND "resourceId"=$2 FOR UPDATE',
          [id, owner],
        );
        if (!row) return false;
        await tx.none('DELETE FROM agent3d.mastra_messages WHERE thread_id=$1', [id]);
        await tx.none('DELETE FROM agent3d.mastra_threads WHERE id=$1', [id]);
        return true;
      });
    },
    async appendMessage(message) {
      await db.tx(async (tx) => {
        await saveMessage(tx, message);
        await tx.none('UPDATE agent3d.mastra_threads SET "updatedAt"=$1 WHERE id=$2', [
          new Date().toISOString(),
          message.conversationId,
        ]);
      });
    },
    async beginTurn(conversationId, clientTurnId, userMessage) {
      const valid = chatMessageSchema.parse(userMessage);
      if (valid.role !== 'user' || valid.conversationId !== conversationId)
        throw TypeError('Invalid turn user message.');
      return db.tx(async (tx) => {
        // 锁定会话后，同一会话的两个并发请求不能同时创建同一个轮次。
        await tx.one('SELECT id FROM agent3d.mastra_threads WHERE id=$1 FOR UPDATE', [
          conversationId,
        ]);
        const row = await tx.oneOrNone(
          'SELECT * FROM agent3d.chat_turns WHERE conversation_id=$1 AND client_turn_id=$2',
          [conversationId, clientTurnId],
        );
        if (row) {
          const previous = toMessage(
            await tx.one('SELECT * FROM agent3d.mastra_messages WHERE id=$1', [
              row.user_message_id,
            ]),
          )!;
          if (JSON.stringify(previous.parts) !== JSON.stringify(valid.parts))
            throw new ChatTurnPayloadConflictError(clientTurnId);
          const assistant = row.assistant_message_id
            ? toMessage(
                await tx.oneOrNone('SELECT * FROM agent3d.mastra_messages WHERE id=$1', [
                  row.assistant_message_id,
                ]),
              )
            : null;
          if (row.status !== 'failed')
            return {
              state: row.status as 'running' | 'complete',
              userMessage: previous,
              assistantMessage: assistant,
            };
          await tx.none(
            "UPDATE agent3d.chat_turns SET status='running',updated_at=$1 WHERE conversation_id=$2 AND client_turn_id=$3",
            [new Date().toISOString(), conversationId, clientTurnId],
          );
          return { state: 'retry' as const, userMessage: previous, assistantMessage: assistant };
        }
        await saveMessage(tx, valid);
        await tx.none(
          "INSERT INTO agent3d.chat_turns (conversation_id,client_turn_id,user_message_id,status,updated_at) VALUES ($1,$2,$3,'running',$4)",
          [conversationId, clientTurnId, valid.id, new Date().toISOString()],
        );
        await tx.none('UPDATE agent3d.mastra_threads SET "updatedAt"=$1 WHERE id=$2', [
          new Date().toISOString(),
          conversationId,
        ]);
        return { state: 'created' as const, userMessage: valid, assistantMessage: null };
      });
    },
    getTurn,
    completeTurn: (id, turn, message) => finishTurn(id, turn, message, 'complete'),
    failTurn: (id, turn, message) => finishTurn(id, turn, message, 'failed'),
    async listMessages(id) {
      return (
        await db.any(
          'SELECT m.*, t.client_turn_id AS "clientTurnId" FROM agent3d.mastra_messages m LEFT JOIN agent3d.chat_turns t ON t.user_message_id=m.id OR t.assistant_message_id=m.id WHERE m.thread_id=$1 ORDER BY m."createdAt" ASC,m.id ASC',
          [id],
        )
      ).map((row) => toMessage(row)!);
    },
  };
  const getArtifact = async (id: string) =>
    toArtifact(await db.oneOrNone('SELECT * FROM agent3d.artifacts WHERE id=$1', [id]));
  const artifacts: CreateAppDependencies['artifacts'] = {
    get: getArtifact,
    async createPending(input) {
      const artifact = assetArtifactSchema.parse({
        ...input,
        id: crypto.randomUUID(),
        version: 1,
        blenderVersion: '4.x',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      await db.none(
        'INSERT INTO agent3d.artifacts (id,conversation_id,version,brief,script,blender_version,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          artifact.id,
          artifact.conversationId,
          artifact.version,
          artifact.brief,
          artifact.script,
          artifact.blenderVersion,
          artifact.status,
          artifact.createdAt,
        ],
      );
      return artifact;
    },
    async readModel(id) {
      const artifact = await getArtifact(id);
      const model = artifact && readThreeModel(artifact.script);
      return model ? readObject('models/' + model.modelId + '.glb') : null;
    },
    async updatePending(id, expectedVersion, script) {
      const row = await db.oneOrNone(
        "UPDATE agent3d.artifacts SET script=$1,version=version+1 WHERE id=$2 AND version=$3 AND status='pending' RETURNING *",
        [script, id, expectedVersion],
      );
      if (!row) {
        if (!(await getArtifact(id))) throw new ArtifactNotFoundError(id);
        throw new ArtifactVersionConflictError(id);
      }
      return toArtifact(row)!;
    },
    async setStatus(id, expectedVersion, status) {
      const row = await db.oneOrNone(
        "UPDATE agent3d.artifacts SET status=$1 WHERE id=$2 AND version=$3 AND status='pending' RETURNING *",
        [status, id, expectedVersion],
      );
      if (!row) {
        if (!(await getArtifact(id))) throw new ArtifactNotFoundError(id);
        throw new ArtifactVersionConflictError(id);
      }
      return toArtifact(row)!;
    },
  };
  const attachments: CreateAppDependencies['attachments'] = {
    async listByConversation(id) {
      return (
        await db.any(
          'SELECT * FROM agent3d.attachments WHERE conversation_id=$1 ORDER BY created_at,id',
          [id],
        )
      ).map(toAttachment);
    },
    async save(conversationId, fileName, mediaType, bytes) {
      if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES)
        throw TypeError('Invalid attachment size.');
      const id = crypto.randomUUID();
      const key = 'attachments/' + conversationId + '/' + id;
      const upload = await objectRequest(key, 'POST', bytes);
      if (!upload.ok) throw Error('Attachment upload failed.');
      try {
        return await db.tx(async (tx) => {
          await tx.one('SELECT id FROM agent3d.mastra_threads WHERE id=$1 FOR UPDATE', [
            conversationId,
          ]);
          const total = await tx.one(
            'SELECT COALESCE(SUM(size),0)::bigint AS size FROM agent3d.attachments WHERE conversation_id=$1',
            [conversationId],
          );
          if (Number(total.size) + bytes.byteLength > MAX_CONVERSATION_ATTACHMENT_BYTES)
            throw TypeError('Conversation attachment limit exceeded.');
          const kind = mediaType.startsWith('image/') ? 'image' : 'document';
          const now = new Date().toISOString();
          await tx.none(
            'INSERT INTO agent3d.attachments (id,conversation_id,file_name,media_type,size,kind,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [id, conversationId, fileName, mediaType, bytes.byteLength, kind, now],
          );
          return uploadMetadataSchema.parse({
            id,
            conversationId,
            fileName,
            mediaType,
            size: bytes.byteLength,
            kind,
            createdAt: now,
          });
        });
      } catch (error) {
        await deleteObjects([key]);
        throw error;
      }
    },
    async read(id) {
      const row = await db.oneOrNone(
        'SELECT conversation_id FROM agent3d.attachments WHERE id=$1',
        [id],
      );
      return row ? readObject('attachments/' + row.conversation_id + '/' + id) : null;
    },
    async deleteByConversation(id) {
      const rows = await db.any('SELECT id FROM agent3d.attachments WHERE conversation_id=$1', [
        id,
      ]);
      const models = await db.any('SELECT script FROM agent3d.artifacts WHERE conversation_id=$1', [
        id,
      ]);
      const keys = [
        ...rows.map((row) => 'attachments/' + id + '/' + row.id),
        ...models.flatMap((row) => {
          const model = readThreeModel(row.script);
          return model ? ['models/' + model.modelId + '.glb'] : [];
        }),
      ];
      await deleteObjects(keys);
    },
  };

  // PBKDF2 使用 Web Crypto，不把用户登录密码以明文存入公网数据库。
  async function passwordHash(password: string, salt: string = crypto.randomUUID()) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 },
      key,
      256,
    );
    return 'pbkdf2:' + salt + ':' + Buffer.from(bits).toString('hex');
  }
  const users: CreateAppDependencies['users'] = {
    async get(name) {
      return (
        (await db.oneOrNone(
          'SELECT id,username,password,created_at FROM agent3d.users WHERE username=$1',
          [name],
        )) ?? undefined
      );
    },
    async create(name, password) {
      await db.none('INSERT INTO agent3d.users (username,password) VALUES ($1,$2)', [
        name,
        await passwordHash(password),
      ]);
    },
    async updatePassword(name, password) {
      await db.none('UPDATE agent3d.users SET password=$1 WHERE username=$2', [
        await passwordHash(password),
        name,
      ]);
    },
    async verifyPassword(password, stored) {
      const salt = stored.split(':')[1];
      if (!salt) return false;
      const expected = await passwordHash(password, salt);
      const a = Buffer.from(expected);
      const b = Buffer.from(stored);
      if (a.length !== b.length) return false;
      let difference = 0;
      for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
      return difference === 0;
    },
  };
  return {
    conversations,
    artifacts,
    attachments,
    users,
    sessionSecret: env.SESSION_SECRET,
    settings: {
      async getModelSelection(username?: string) {
        const row = await db.oneOrNone('SELECT value FROM agent3d.settings WHERE username=$1', [
          username,
        ]);
        return row
          ? modelSelectionSchema.parse(
              typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
            )
          : DEFAULT_MODEL_SELECTION;
      },
      async saveModelSelection(selection: ModelSelection, username?: string) {
        await db.none(
          'INSERT INTO agent3d.settings (username,value) VALUES ($1,$2) ON CONFLICT(username) DO UPDATE SET value=excluded.value',
          [username, JSON.stringify(modelSelectionSchema.parse(selection))],
        );
      },
    },
    preferences: {
      async list(owner) {
        return Object.fromEntries(
          (
            await db.any(
              'SELECT key,value FROM agent3d.user_preferences WHERE username=$1 ORDER BY key',
              [owner],
            )
          ).map((row) => [row.key, row.value]),
        );
      },
      async upsert(key, value, owner) {
        await db.none(
          'INSERT INTO agent3d.user_preferences (username,key,value) VALUES ($1,$2,$3) ON CONFLICT(username,key) DO UPDATE SET value=excluded.value',
          [owner, key, value],
        );
      },
      async delete(key, owner) {
        return !!(await db.oneOrNone(
          'DELETE FROM agent3d.user_preferences WHERE username=$1 AND key=$2 RETURNING key',
          [owner, key],
        ));
      },
    },
  };
}

export interface SupabaseConfig {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  SUPABASE_STORAGE_BUCKET: string;
  SESSION_SECRET: string;
}
