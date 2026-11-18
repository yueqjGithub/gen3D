import type { Repository } from '../storage/repository';
import { Hono } from 'hono';
import { modelSelectionSchema } from '@agent3d/shared';
import { z } from 'zod';
import { providerCatalog, providerOptions } from '../config/provider-catalog';
import type { createSettingsRepository } from '../config/settings-repository';
import type { PreferenceRepository } from '../storage/preferences';
import { HttpError } from '../http-errors';
import { getCookie } from 'hono/cookie';

type SettingsRepository = Repository<ReturnType<typeof createSettingsRepository>>;

const preferenceRequestSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(500),
}).strict();

const deletePreferenceRequestSchema = z.object({
  key: z.string().trim().min(1).max(80),
}).strict();

export interface SettingsRouteDependencies {
  settings: SettingsRepository;
  preferences: Repository<PreferenceRepository>;
}

/** 模型设置与用户偏好两组接口：都很小，所以放在同一个路由文件里。 */
export function createModelSettingsRoutes({ settings, preferences }: SettingsRouteDependencies) {
  const routes = new Hono();

  // 返回可选的提供商列表和当前选择，设置页面据此渲染
  routes.get('/models', async (context) => context.json({
    providers: providerOptions,
    selection: (await settings.getModelSelection(getCookie(context, 'username')!)),
  }));

  // 保存模型选择：先用 zod 校验结构，再逐个角色（chat / image）确认模型存在于目录中
  routes.patch('/models', async (context) => {
    const selection = modelSelectionSchema.parse(await context.req.json());
    for (const role of ['chat', 'image'] as const) {
      const config = selection[role];
      const provider = Object.values(providerCatalog).find(({ id }) => id === config.providerId);
      const supportedModels: readonly string[] = provider?.models[role] ?? [];
      if (!supportedModels.includes(config.modelId)) {
        throw new HttpError(400, 'PROVIDER_ERROR', `The selected ${role} provider or model is unsupported.`);
      }
    }
    (await settings.saveModelSelection(selection, getCookie(context, 'username')!));
    return context.json({ selection: (await settings.getModelSelection(getCookie(context, 'username')!)) });
  });

  // 用户偏好：Agent 会读取它们作为上下文；新增/修改由用户在界面确认后才会调用这里
  routes.get('/preferences', async (context) => context.json({ preferences: (await preferences.list(getCookie(context, 'username')!)) }));

  routes.put('/preferences', async (context) => {
    const body = preferenceRequestSchema.parse(await context.req.json());
    (await preferences.upsert(body.key, body.value, getCookie(context, 'username')!));
    return context.json({ preferences: (await preferences.list(getCookie(context, 'username')!)) });
  });

  routes.delete('/preferences', async (context) => {
    const { key } = deletePreferenceRequestSchema.parse(await context.req.json());
    if (!(await preferences.delete(key, getCookie(context, 'username')!))) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested preference does not exist.');
    }
    return context.body(null, 204);
  });

  return routes;
}
