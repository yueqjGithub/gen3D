import { Hono } from 'hono';
import {
  modelSelectionSchema,
  type CredentialStore,
  type ModelConfig,
  type ModelSelection,
} from '@agent3d/shared';
import { z } from 'zod';
import { providerCatalog, providerOptions } from '../config/provider-catalog';
import type { createSettingsRepository } from '../config/settings-repository';
import type { PreferenceRepository } from '../storage/preferences';
import { HttpError } from '../http-errors';

type SettingsRepository = ReturnType<typeof createSettingsRepository>;

const preferenceRequestSchema = z.object({
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(500),
}).strict();

const credentialRequestSchema = z.object({
  apiKey: z.string().trim().min(1).max(4096),
}).strict();
const deletePreferenceRequestSchema = z.object({
  key: z.string().trim().min(1).max(80),
}).strict();

function assertProviderSelections(selection: ModelSelection): void {
  for (const role of ['chat', 'image'] as const) {
    const config: ModelConfig = selection[role];
    const provider = Object.values(providerCatalog).find(({ id }) => id === config.providerId);
    const supportedModels: readonly string[] = provider?.models[role] ?? [];
    if (!provider || !supportedModels.includes(config.modelId)) {
      throw new HttpError(400, 'VALIDATION_FAILED', `The selected ${role} provider or model is unsupported.`);
    }
  }
}

export interface SettingsRouteDependencies {
  settings: SettingsRepository;
  credentials: CredentialStore;
  preferences: PreferenceRepository;
}

export function createModelSettingsRoutes({
  settings,
  credentials,
  preferences,
}: SettingsRouteDependencies) {
  const routes = new Hono();

  routes.get('/models', async (context) => context.json({
    providers: providerOptions,
    selection: await settings.getModelSelection(),
  }));

  routes.patch('/models', async (context) => {
    const selection = modelSelectionSchema.parse(await context.req.json());
    assertProviderSelections(selection);
    settings.saveModelSelection(selection);
    return context.json({ selection: await settings.getModelSelection() });
  });

  routes.put('/models/credentials/:providerId', async (context) => {
    const providerId = context.req.param('providerId');
    if (!Object.values(providerCatalog).some(({ id }) => id === providerId)) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested model provider does not exist.');
    }
    const body = credentialRequestSchema.parse(await context.req.json());
    await credentials.set(providerId, body.apiKey);
    return context.json({ providerId, configured: true });
  });

  routes.delete('/models/credentials/:providerId', async (context) => {
    const providerId = context.req.param('providerId');
    if (!Object.values(providerCatalog).some(({ id }) => id === providerId)) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested model provider does not exist.');
    }
    await credentials.delete(providerId);
    return context.body(null, 204);
  });

  routes.get('/preferences', (context) => context.json({ preferences: preferences.list() }));

  routes.put('/preferences', async (context) => {
    const body = preferenceRequestSchema.parse(await context.req.json());
    preferences.upsert(body.key, body.value);
    return context.json({ preferences: preferences.list() });
  });

  routes.delete('/preferences', async (context) => {
    const { key } = deletePreferenceRequestSchema.parse(await context.req.json());
    if (!preferences.delete(key)) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested preference does not exist.');
    }
    return context.body(null, 204);
  });

  return routes;
}
