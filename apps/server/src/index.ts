import { serve, type ServerType } from '@hono/node-server';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CredentialStore } from '@agent3d/shared';
import { createAgentClient } from './agent-client';
import { createCredentialClient } from './config/credential-client';
import {
  electronApplicationName,
  resolveDataDirectory,
} from './config/data-directory';
import { readServerEnvironment, type ServerEnvironment } from './config/env';
import { resolveModel } from './config/model-resolver';
import { createSettingsRepository } from './config/settings-repository';
import { createApp } from './app';
import { createArtifactRepository } from './storage/artifacts';
import { createAttachmentStore } from './storage/attachments';
import { createConversationRepository } from './storage/conversations';
import { createDatabase } from './storage/database';
import { createPreferenceRepository } from './storage/preferences';

export interface StartServerOptions {
  source?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  appName?: string;
}

export interface StandaloneServer {
  baseURL: string;
  databasePath: string;
  close(): Promise<void>;
}

function listen(app: ReturnType<typeof createApp>, port: number): Promise<ServerType> {
  const server = serve({
    fetch: (request) => app.fetch(request),
    hostname: '127.0.0.1',
    port,
  });

  return new Promise((resolveServer, rejectServer) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      rejectServer(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectServer(new Error('The Hono server did not bind to a TCP address.'));
        return;
      }
      if (address.port !== port) {
        rejectServer(new Error('The Hono server did not bind to its configured port.'));
        return;
      }
      resolveServer(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
  });
}

function closeListener(server: ServerType): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    });
  });
}

function createCredentials(
  environment: ServerEnvironment,
  brokerCredentials: CredentialStore,
): CredentialStore {
  const disabledEnvironmentProviders = new Set<string>();
  return {
    async get(providerId) {
      const saved = await brokerCredentials.get(providerId);
      if (saved) {
        return saved;
      }
      if (providerId === 'agnes' && !disabledEnvironmentProviders.has(providerId)) {
        return environment.chatApiKey;
      }
      return null;
    },
    async set(providerId, secret) {
      disabledEnvironmentProviders.delete(providerId);
      await brokerCredentials.set(providerId, secret);
    },
    async delete(providerId) {
      disabledEnvironmentProviders.add(providerId);
      await brokerCredentials.delete(providerId);
    },
  };
}

export async function startServer(options: StartServerOptions = {}): Promise<StandaloneServer> {
  const source = options.source ?? process.env;
  const environment = readServerEnvironment(source);
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const appName = options.appName ?? electronApplicationName;
  const userDataDirectory = resolveDataDirectory(
    source,
    platform,
    homeDirectory,
    appName,
  );
  const databasePath = join(userDataDirectory, 'data', 'agent3d.sqlite');
  const database = createDatabase(databasePath);

  try {
    const brokerCredentials = createCredentialClient({
      baseURL: `http://127.0.0.1:${environment.credentialBrokerPort}`,
      token: environment.credentialBrokerToken,
    });
    const credentials = createCredentials(environment, brokerCredentials);
    const conversations = createConversationRepository(database.connection);
    const artifacts = createArtifactRepository(database.connection);
    const attachments = createAttachmentStore(
      database.connection,
      join(userDataDirectory, 'data', 'attachments'),
    );
    const preferences = createPreferenceRepository(database.connection);
    const settings = createSettingsRepository(database.connection, credentials);
    const app = createApp({
      auth: {
        allowedOrigin: environment.rendererOrigin,
        token: environment.serverToken,
      },
      conversations,
      artifacts,
      attachments,
      preferences,
      settings,
      credentials,
      resolveModel: (selection, role) => environment.mockMode
        ? Promise.resolve({
          providerId: 'mock',
          modelId: 'mock/model',
          baseURL: 'http://127.0.0.1',
          protocol: 'openai-compatible',
          supportsInlineImages: true,
          apiKey: 'mock-only-key',
        })
        : resolveModel(selection, role, credentials),
      agentClient: createAgentClient({
        baseURL: environment.agentServiceUrl,
        token: environment.agentServiceToken,
      }),
    });
    const server = await listen(app, environment.serverPort);

    let closing: Promise<void> | null = null;
    return {
      baseURL: environment.serverUrl,
      databasePath,
      close() {
        if (closing) {
          return closing;
        }
        closing = closeListener(server).then(
          () => database.close(),
          (serverError: unknown) => {
            try {
              database.close();
            } catch (databaseError) {
              throw new AggregateError(
                [serverError, databaseError],
                'The Hono server and database did not close cleanly.',
              );
            }
            throw serverError;
          },
        );
        return closing;
      },
    };
  } catch (error) {
    try {
      database.close();
    } catch (databaseError) {
      throw new AggregateError(
        [error, databaseError],
        'The Hono server failed to start and its database could not close.',
      );
    }
    throw error;
  }
}

async function runServer(): Promise<void> {
  const server = await startServer();
  console.info(`Hono API listening at ${server.baseURL}`);
  let stopping: Promise<void> | null = null;
  const shutdown = () => {
    stopping ??= server.close().catch((error: unknown) => {
      console.error('Failed to shut down the Hono API cleanly.', error);
      process.exitCode = 1;
    });
    return stopping;
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  void runServer().catch((error: unknown) => {
    console.error('Failed to start the Hono API.', error);
    process.exitCode = 1;
  });
}
