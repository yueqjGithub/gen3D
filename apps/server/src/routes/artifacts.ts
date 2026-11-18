import type { Repository } from '../storage/repository';
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
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';

type ArtifactRepository = Repository<ReturnType<typeof createArtifactRepository>>;

// 编辑资产时需要带上 expectedVersion（乐观锁）：如果版本已变化，说明别处修改过，更新会被拒绝
const editArtifactSchema = z.object({
  expectedVersion: z.number().int().positive(),
  script: assetArtifactSchema.shape.script,
}).strict();

/**
 * 资产审阅是工具执行许可之外的另一步：客户端构建并保存 GLB 后，
 * pending → approved / rejected；待审阅可以预览，只有批准后才能下载。
 */
export function createArtifactRoutes(artifacts: ArtifactRepository) {
  const routes = new Hono();

  // app.ts 已验证登录签名。这里只使用服务端确认的用户身份查询列表；
  // 单个资产的预览和下载仍走原接口，并继续检查原会话的归属。
  routes.get('/artifacts', async context => context.json({
    artifacts: await artifacts.listApproved(getCookie(context, 'username')!),
  }));

  // GLB 由 Web/Desktop 的隔离 iframe 导出。凭据留在 Server，客户端只能上传
  // 自己会话中的待审阅资产；modelId 从已保存源码中读取，不能指定任意 Storage 路径。
  routes.post('/artifacts/:id/model', bodyLimit({ maxSize: 20 * 1024 * 1024 }), async context => {
    const artifact = await artifacts.get(context.req.param('id'));
    if (!artifact) throw new HttpError(404, 'NOT_FOUND', '资产不存在。');
    const version = z.coerce.number().int().positive().parse(context.req.query('expectedVersion'));
    if (artifact.version !== version || artifact.status !== 'pending') throw new HttpError(409, 'CONFLICT', '资产版本或状态已变化，请刷新。');
    const model = readThreeModel(artifact.script);
    if (!model) throw new HttpError(422, 'VALIDATION_FAILED', '资产不是 Three.js 脚本。');
    const bytes = await context.req.arrayBuffer();
    const view = new DataView(bytes);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength)
      throw new HttpError(422, 'VALIDATION_FAILED', '请上传有效的 GLB 2.0 二进制文件。');
    const jsonLength = view.getUint32(12, true);
    if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength % 4 !== 0 || jsonLength + 20 > bytes.byteLength)
      throw new HttpError(422, 'VALIDATION_FAILED', 'GLB 缺少有效 JSON 数据块。');
    try {
      const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
      if (gltf.asset?.version !== '2.0') throw Error('Invalid glTF version');
    } catch {
      throw new HttpError(422, 'VALIDATION_FAILED', 'GLB 的 glTF JSON 格式无效。');
    }
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!base || !key) throw new HttpError(500, 'INTERNAL_ERROR', '尚未配置私有 Storage。');
    const upload = await fetch(`${base}/storage/v1/object/${process.env.SUPABASE_STORAGE_BUCKET || 'agent3d'}/models/${model.modelId}.glb`, {
      method: 'POST', headers: { apikey: key, 'content-type': 'model/gltf-binary' }, body: bytes,
    });
    // 不覆盖已经生成的同一个文件。多客户端同时构建时，先保存成功的结果为准。
    if (!upload.ok && !(await artifacts.readModel(artifact.id)))
      throw new HttpError(502, 'INTERNAL_ERROR', 'GLB 保存失败，请检查网络或 Storage 额度。', true);
    return context.body(null, 204);
  });

  // 读取资产，同时返回脚本的静态校验结果，界面据此提示用户脚本是否安全
  // 待审批资产也可预览；下载仍要求批准。会话归属由 app.ts 的中间件统一验证。
  routes.get('/artifacts/:id/model', async (context) => {
    const bytes = await artifacts.readModel(context.req.param('id'));
    if (!bytes) throw new HttpError(404, 'NOT_FOUND', 'GLB file not found.');
    return new Response(bytes as BodyInit, { headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'no-store' } });
  });
  routes.get('/artifacts/:id', async (context) => {
    const artifact = (await artifacts.get(context.req.param('id')));
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
    const current = (await artifacts.get(context.req.param('id')));
    if (current && readThreeModel(current.script)) throw new HttpError(409, 'CONFLICT', '请在聊天中修改模型，以重新执行脚本并导出 GLB。');
    const artifact = (await artifacts.updatePending(
      context.req.param('id'),
      body.expectedVersion,
      body.script,
    ));
    return context.json({
      artifact,
      scriptValidation: validateAssetScript(artifact.script),
    });
  });

  // 批准前必须再次通过脚本校验，避免用户编辑后批准了不合规的脚本
  routes.post('/artifacts/:id/approve', async (context) => {
    const { expectedVersion } = artifactApprovalSchema.parse(await context.req.json());
    const current = (await artifacts.get(context.req.param('id')));
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
      artifact: (await artifacts.setStatus(current.id, expectedVersion, 'approved')),
    });
  });

  routes.post('/artifacts/:id/reject', async (context) => {
    const { expectedVersion } = artifactApprovalSchema.parse(await context.req.json());
    return context.json({
      artifact: (await artifacts.setStatus(context.req.param('id'), expectedVersion, 'rejected')),
    });
  });

  // 当前主流程下载已批准的 GLB；旧格式的分支保留，不能据字段名推断当前使用 Blender。
  routes.get('/artifacts/:id/download', async (context) => {
    const artifact = (await artifacts.get(context.req.param('id')));
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
