import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
  uploadMetadataSchema,
  type UploadMetadata,
} from '@agent3d/shared';
import type { SqliteDatabase } from './database';

interface AttachmentRow {
  id: string;
  conversation_id: string;
  file_name: string;
  media_type: string;
  size: number;
  kind: 'image' | 'document';
  created_at: string;
}

/** 数据库列（下划线）→ 共享契约（驼峰）的转换，同时用 zod 校验数据库里的数据。 */
function toMetadata(row: AttachmentRow): UploadMetadata {
  return uploadMetadataSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    fileName: row.file_name,
    mediaType: row.media_type,
    size: row.size,
    kind: row.kind,
    createdAt: row.created_at,
  });
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** 附件存储：元数据保存在 SQLite，文件内容保存在磁盘 <根目录>/<会话id>/<附件id>.blob。 */
export interface AttachmentStore {
  save(
    conversationId: string,
    fileName: string,
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<UploadMetadata>;
  read(id: string): Promise<Uint8Array | null>;
  listByConversation(conversationId: string): UploadMetadata[];
  deleteByConversation(conversationId: string): Promise<void>;
}

export function createAttachmentStore(
  database: SqliteDatabase,
  rootPath?: string,
): AttachmentStore {
  // 调用方可传独立目录用于测试/部署。进程环境由启动命令加载，构建产物无需依赖源码旁的 .env。
  const root = resolve(rootPath ?? process.env.AGENT3D_ATTACHMENT_DIR ?? 'data/attachments');

  // 磁盘文件名只使用 UUID，不使用用户上传的文件名，避免路径穿越
  function filePath(conversationId: string, attachmentId: string): string {
    return resolve(root, conversationId, `${attachmentId}.blob`);
  }

  return {
    async save(
      conversationId: string,
      fileName: string,
      mediaType: string,
      bytes: Uint8Array,
    ): Promise<UploadMetadata> {
      // 展示用的文件名不能包含路径分隔符
      if (basename(fileName) !== fileName || fileName.includes('\\') || fileName.includes('/')) {
        throw new TypeError('Attachment file name cannot contain a path.');
      }
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new RangeError(`Attachment size must be between 1 and ${MAX_ATTACHMENT_BYTES} bytes.`);
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const kind = mediaType.startsWith('image/') ? 'image' : 'document';
      const metadata = uploadMetadataSchema.parse({
        id,
        conversationId,
        fileName,
        mediaType,
        size: bytes.byteLength,
        kind,
        createdAt,
      });

      // 第一步：在事务里检查会话存在和累计大小上限，并先写入元数据记录（占位）
      const reserve = database.transaction(() => {
        const conversation = database.prepare('SELECT 1 FROM mastra_threads WHERE id = ?')
          .get(conversationId);
        if (!conversation) {
          throw new Error(`Conversation not found: ${conversationId}`);
        }

        const totals = database.prepare(`
          SELECT COALESCE(SUM(size), 0) AS size
          FROM attachments WHERE conversation_id = ?
        `).get(conversationId) as { size: number };
        if (totals.size + metadata.size > MAX_CONVERSATION_ATTACHMENT_BYTES) {
          throw new RangeError(`Conversation attachments exceed ${MAX_CONVERSATION_ATTACHMENT_BYTES} bytes.`);
        }

        database.prepare(`
          INSERT INTO attachments (id, conversation_id, file_name, media_type, size, kind, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          metadata.id,
          metadata.conversationId,
          metadata.fileName,
          metadata.mediaType,
          metadata.size,
          metadata.kind,
          metadata.createdAt,
        );
      });
      reserve.immediate();

      // 第二步：写文件；失败则回滚刚插入的记录，保证数据库与磁盘一致
      const directory = resolve(root, conversationId);
      const path = filePath(conversationId, id);
      try {
        await mkdir(directory, { recursive: true });
        await writeFile(path, bytes, { flag: 'wx' });
      } catch (error) {
        database.prepare('DELETE FROM attachments WHERE id = ?').run(id);
        await rm(path, { force: true });
        throw error;
      }

      return metadata;
    },

    async read(id: string): Promise<Uint8Array | null> {
      const row = database.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
        | AttachmentRow
        | undefined;
      if (!row) {
        return null;
      }

      const metadata = toMetadata(row);
      try {
        const bytes = await readFile(filePath(metadata.conversationId, metadata.id));
        return new Uint8Array(bytes);
      } catch (error) {
        if (missingPath(error)) {
          throw new Error(`Attachment data is missing for record ${id}.`, { cause: error });
        }
        throw error;
      }
    },

    listByConversation(conversationId: string): UploadMetadata[] {
      const rows = database.prepare(`
        SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at ASC, id ASC
      `).all(conversationId) as AttachmentRow[];
      return rows.map(toMetadata);
    },

    /** 删除会话的全部附件：先把目录改名成临时“墓碑”，数据库删除成功后再真正删除；失败则改名还原。 */
    async deleteByConversation(conversationId: string): Promise<void> {
      const directory = resolve(root, conversationId);
      const tombstone = resolve(root, `.deleted-${conversationId}-${randomUUID()}`);
      let movedDirectory = false;

      try {
        try {
          await rename(directory, tombstone);
          movedDirectory = true;
        } catch (error) {
          if (!missingPath(error)) {
            throw error;
          }
        }

        const removeRecords = database.transaction(() => {
          database.prepare('DELETE FROM attachments WHERE conversation_id = ?').run(conversationId);
        });
        removeRecords.immediate();

        if (movedDirectory) {
          await rm(tombstone, { recursive: true, force: true });
        }
      } catch (error) {
        if (movedDirectory && existsSync(tombstone) && !existsSync(directory)) {
          try {
            await rename(tombstone, directory);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `Attachment cleanup failed and the files could not be restored for ${conversationId}.`,
            );
          }
        }
        throw error;
      }
    },
  };
}
