import { randomUUID } from 'node:crypto';
import { assetArtifactSchema, type AssetArtifact } from '@agent3d/shared';
import type { SqliteDatabase } from './database';

interface ArtifactRow {
  id: string;
  conversation_id: string;
  version: number;
  brief: string;
  script: string;
  blender_version: '4.x';
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

/** 资产版本冲突：资产已不是 pending 状态，或版本号与调用方预期不一致（乐观锁）。 */
export class ArtifactVersionConflictError extends Error {
  constructor(id: string) {
    super(`Artifact is no longer pending at the expected version: ${id}`);
    this.name = 'ArtifactVersionConflictError';
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(id: string) {
    super(`Artifact not found: ${id}`);
    this.name = 'ArtifactNotFoundError';
  }
}

/**
 * 资产（Blender 脚本）仓库。每次编辑 version 加 1；
 * 更新和审批都带 expectedVersion，并在事务内校验，防止覆盖别人刚做的修改（乐观锁）。
 */
export function createArtifactRepository(database: SqliteDatabase) {
  // 数据库列名是下划线风格，这里转成共享契约里的驼峰字段，并用 zod 再校验一次
  const get =  (id: string): AssetArtifact | null => {
    const row = database.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | ArtifactRow
      | undefined;
    if (!row) {
      return null;
    }

    return assetArtifactSchema.parse({
      id: row.id,
      conversationId: row.conversation_id,
      version: row.version,
      brief: row.brief,
      script: row.script,
      blenderVersion: row.blender_version,
      status: row.status,
      createdAt: row.created_at,
    });
  };

  return {
    /** 新建资产：初始版本为 1，状态为 pending，等待用户审批。 */
    createPending(input: Pick<AssetArtifact, 'conversationId' | 'brief' | 'script'>): AssetArtifact {
      const artifact = assetArtifactSchema.parse({
        id: randomUUID(),
        conversationId: input.conversationId,
        version: 1,
        brief: input.brief,
        script: input.script,
        blenderVersion: '4.x',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      database.prepare(`
        INSERT INTO artifacts (
          id, conversation_id, version, brief, script, blender_version, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.conversationId,
        artifact.version,
        artifact.brief,
        artifact.script,
        artifact.blenderVersion,
        artifact.status,
        artifact.createdAt,
      );
      return artifact;
    },

    get,

    /** 编辑待审批资产的脚本：只允许 pending 状态，版本号 +1。immediate() 让事务一开始就加写锁。 */
    updatePending(id: string, expectedVersion: number, script: string): AssetArtifact {
      const update = database.transaction(() => {
        const current = get(id);
        if (!current) {
          throw new ArtifactNotFoundError(id);
        }
        if (current.status !== 'pending' || current.version !== expectedVersion) {
          throw new ArtifactVersionConflictError(id);
        }

        const version = expectedVersion + 1;
        const validScript = assetArtifactSchema.shape.script.parse(script);
        database.prepare(`
          UPDATE artifacts SET script = ?, version = ?
          WHERE id = ? AND version = ? AND status = 'pending'
        `).run(validScript, version, id, expectedVersion);

        return get(id)!;
      });
      return update.immediate();
    },

    /** 审批（approved）或拒绝（rejected）；已处理过的资产不能再次改变状态。 */
    setStatus(
      id: string,
      expectedVersion: number,
      status: 'approved' | 'rejected',
    ): AssetArtifact {
      const update = database.transaction(() => {
        const current = get(id);
        if (!current) {
          throw new ArtifactNotFoundError(id);
        }
        if (current.status !== 'pending' || current.version !== expectedVersion) {
          throw new ArtifactVersionConflictError(id);
        }

        database.prepare(`
          UPDATE artifacts SET status = ?
          WHERE id = ? AND version = ? AND status = 'pending'
        `).run(status, id, expectedVersion);

        return get(id)!;
      });
      return update.immediate();
    },
  };
}
