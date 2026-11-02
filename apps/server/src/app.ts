import { Hono } from 'hono';
import type { CredentialStore, ModelConfig } from '@agent3d/shared';
import type { ResolvedModelConfig } from './config/model-resolver';
import { createConversationRoutes } from './routes/conversations';
import { createAttachmentRoutes } from './routes/attachments';
import { createModelSettingsRoutes } from './routes/models';
import { createArtifactRoutes } from './routes/artifacts';
import { createChatRoutes } from './routes/chat';
import type { AttachmentStore } from './storage/attachments';
import type { createArtifactRepository } from './storage/artifacts';
import type { createConversationRepository } from './storage/conversations';
import type { PreferenceRepository } from './storage/preferences';
import type { createSettingsRepository } from './config/settings-repository';
import type { AgentClient } from './agent-client';
import { toApiErrorResponse } from './http-errors';
import { createLocalOriginMiddleware, type LocalOriginOptions } from './middleware/local-origin';

export interface CreateAppDependencies {
  auth: LocalOriginOptions;
  conversations: ReturnType<typeof createConversationRepository>;
  artifacts: ReturnType<typeof createArtifactRepository>;
  attachments: AttachmentStore;
  preferences: PreferenceRepository;
  settings: ReturnType<typeof createSettingsRepository>;
  credentials: CredentialStore;
  resolveModel: (
    selection: ModelConfig,
    role: 'chat',
  ) => Promise<ResolvedModelConfig>;
  agentClient: AgentClient;
}

export function createApp(dependencies: CreateAppDependencies) {
  const app = new Hono();
  app.use('/api/*', createLocalOriginMiddleware(dependencies.auth));

  app.route('/api', createConversationRoutes(dependencies));
  app.route('/api', createAttachmentRoutes(dependencies));
  app.route('/api', createModelSettingsRoutes(dependencies));
  app.route('/api', createArtifactRoutes(dependencies.artifacts));
  app.route('/api', createChatRoutes(dependencies));

  app.onError((error, context) => {
    const response = toApiErrorResponse(error);
    if (response.status === 500) {
      console.error('Unhandled local API error:', {
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: response.status,
        errorName: error instanceof Error ? error.name : 'unknown error',
      });
    }
    return context.json(response.body, response.status);
  });

  app.notFound((context) => context.json({
    code: 'NOT_FOUND',
    message: 'The requested API route does not exist.',
    retryable: false,
  }, 404));

  return app;
}
