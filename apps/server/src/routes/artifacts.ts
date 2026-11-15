import { Hono } from 'hono';
import {
  artifactApprovalSchema,
  assetArtifactSchema,
  validateAssetScript,
  readThreeScene,
  readThreeModel,
} from '@agent3d/shared';
import { z } from 'zod';
import type { createArtifactRepository } from '../storage/artifacts';
import { HttpError } from '../http-errors';

type ArtifactRepository = ReturnType<typeof createArtifactRepository>;

// 编辑资产时需要带上 expectedVersion（乐观锁）：如果版本已变化，说明别处修改过，更新会被拒绝
const editArtifactSchema = z.object({
  expectedVersion: z.number().int().positive(),
  script: assetArtifactSchema.shape.script,
}).strict();

/**
 * 3D 资产（Blender 脚本）的审批流程，对应 Human-in-the-loop：
 * Agent 生成的资产状态为 pending → 用户可编辑脚本 → 批准(approved) 或 拒绝(rejected) → 只有批准后才能下载。
 */
export function createArtifactRoutes(artifacts: ArtifactRepository) {
  const routes = new Hono();

  // 读取资产，同时返回脚本的静态校验结果，界面据此提示用户脚本是否安全
  // 待审批资产也可预览；下载仍要求批准。会话归属由 app.ts 的中间件统一验证。
  routes.get('/artifacts/:id/model', async (context) => {
    const bytes = await artifacts.readModel(context.req.param('id'));
    if (!bytes) throw new HttpError(404, 'NOT_FOUND', 'GLB file not found.');
    return new Response(bytes as BodyInit, { headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-store' } });
  });
  routes.get('/artifacts/:id', (context) => {
    const artifact = artifacts.get(context.req.param('id'));
    if (!artifact) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested artifact does not exist.');
    }
    return context.json({
      artifact,
      scriptValidation: validateAssetScript(artifact.script),
    });
  });

  routes.patch('/artifacts/:id', async (context) => {
    const body = editArtifactSchema.parse(await context.req.json());
    const current = artifacts.get(context.req.param('id'));
    if (current && readThreeModel(current.script)) throw new HttpError(409, 'CONFLICT', '请在聊天中修改模型，以重新执行脚本并导出 GLB。');
    const artifact = artifacts.updatePending(
      context.req.param('id'),
      body.expectedVersion,
      body.script,
    );
    return context.json({
      artifact,
      scriptValidation: validateAssetScript(artifact.script),
    });
  });

  // 批准前必须再次通过脚本校验，避免用户编辑后批准了不合规的脚本
  routes.post('/artifacts/:id/approve', async (context) => {
    const { expectedVersion } = artifactApprovalSchema.parse(await context.req.json());
    const current = artifacts.get(context.req.param('id'));
    if (!current) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested artifact does not exist.');
    }
    if (readThreeModel(current.script) && !await artifacts.readModel(current.id)) throw new HttpError(422, 'VALIDATION_FAILED', 'GLB 文件不存在，请重新生成。');
    const validation = validateAssetScript(current.script);
    if (!validation.ok) {
      throw new HttpError(
        422,
        'VALIDATION_FAILED',
        `The Blender script must be corrected before approval (${validation.code}).`,
      );
    }
    return context.json({
      artifact: artifacts.setStatus(current.id, expectedVersion, 'approved'),
    });
  });

  routes.post('/artifacts/:id/reject', async (context) => {
    const { expectedVersion } = artifactApprovalSchema.parse(await context.req.json());
    return context.json({
      artifact: artifacts.setStatus(context.req.param('id'), expectedVersion, 'rejected'),
    });
  });

  // 下载：只有已批准的资产才能下载，以 .py 文件形式返回，用户自行在 Blender 里运行
  routes.get('/artifacts/:id/download', async (context) => {
    const artifact = artifacts.get(context.req.param('id'));
    if (!artifact) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested artifact does not exist.');
    }
    if (artifact.status !== 'approved') {
      throw new HttpError(409, 'CONFLICT', 'Only approved assets can be downloaded.');
    }

    const model = readThreeModel(artifact.script);
    const body = model ? await artifacts.readModel(artifact.id) : artifact.script;
    if (!body) throw new HttpError(404, 'NOT_FOUND', 'GLB file not found.');
    return new Response(body as BodyInit, {
      headers: {
        'Content-Type': model ? 'model/gltf-binary' : readThreeScene(artifact.script) ? 'application/json; charset=utf-8' : 'text/x-python; charset=utf-8',
        'Content-Disposition': `attachment; filename="asset-${artifact.id}-v${artifact.version}.${model ? 'glb' : readThreeScene(artifact.script) ? 'json' : 'py'}"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  return routes;
}
