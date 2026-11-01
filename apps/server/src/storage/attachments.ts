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
  rootPath: string,
): AttachmentStore {
  const root = resolve(rootPath);

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

      const reserve = database.transaction(() => {
        const conversation = database.prepare('SELECT 1 FROM conversations WHERE id = ?')
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
