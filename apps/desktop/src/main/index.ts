import { app, BrowserWindow, dialog, Menu, safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CredentialStore } from '@agent3d/shared';
import { createApp } from '../../../server/src/app.js';
import { createMastra } from '../../../server/src/agent/mastra.js';
import { createMastraModel } from '../../../server/src/agent/model-adapter.js';
import { createMockModelAgent } from '../../../server/src/testing/mock-model.js';
import { readServerEnvironment } from '../../../server/src/config/env.js';
import { resolveModel } from '../../../server/src/config/model-resolver.js';
import { createSettingsRepository } from '../../../server/src/config/settings-repository.js';
import { createArtifactRepository } from '../../../server/src/storage/artifacts.js';
import { createAttachmentStore } from '../../../server/src/storage/attachments.js';
import { createConversationRepository } from '../../../server/src/storage/conversations.js';
import { createDatabase } from '../../../server/src/storage/database.js';
import { createPreferenceRepository } from '../../../server/src/storage/preferences.js';
import { listenLocalApi, registerServerShutdown } from '../../../server/src/dev.js';
import { createSafeStorageCredentialStore } from './credentials.js';
import { createApplicationMenuTemplate } from './devtools.js';
import { createWindowOwner } from './window-owner.js';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const mainWindowOwner = createWindowOwner<BrowserWindow>();

function createWindow(apiBaseUrl: string, apiToken: string): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f5f4f1',
    webPreferences: {
      preload: resolve(appRoot, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      additionalArguments: [
        `--agent3d-api-base-url=${apiBaseUrl}`,
        `--agent3d-api-token=${apiToken}`,
      ],
    },
  });
  mainWindowOwner.retain(window);

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(resolve(appRoot, '../renderer/index.html'));
  }
}

async function startDesktopApplication(): Promise<void> {
  const menuTemplate = createApplicationMenuTemplate(app.isPackaged, () => {
    const window = mainWindowOwner.current;
    if (!window) {
      return;
    }
    if (window.webContents.isDevToolsOpened()) {
      window.webContents.closeDevTools();
    } else {
      window.webContents.openDevTools({ mode: 'detach' });
    }
  });
  Menu.setApplicationMenu(menuTemplate ? Menu.buildFromTemplate(menuTemplate) : null);

  const environment = readServerEnvironment();
  const userDataDirectory = app.getPath('userData');
  const dataDirectory = join(userDataDirectory, 'data');
  mkdirSync(dataDirectory, { recursive: true });

  const database = createDatabase(join(dataDirectory, 'agent3d.sqlite'));
  const secureCredentials = createSafeStorageCredentialStore(safeStorage, userDataDirectory);
  const disabledEnvironmentProviders = new Set<string>();
  const credentials: CredentialStore = {
    async get(providerId) {
      const saved = await secureCredentials.get(providerId);
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
      await secureCredentials.set(providerId, secret);
    },
    async delete(providerId) {
      disabledEnvironmentProviders.add(providerId);
      await secureCredentials.delete(providerId);
    },
  };
  const conversations = createConversationRepository(database.connection);
  const artifacts = createArtifactRepository(database.connection);
  const attachments = createAttachmentStore(
    database.connection,
    join(dataDirectory, 'attachments'),
  );
  const preferences = createPreferenceRepository(database.connection);
  const settings = createSettingsRepository(database.connection, credentials);
  const token = randomBytes(32).toString('base64url');
  const rendererOrigin = process.env.ELECTRON_RENDERER_URL
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : 'null';
  const api = createApp({
    auth: { allowedOrigin: rendererOrigin, token },
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
    createAgent: (model) => {
      if (environment.mockMode) {
        return createMockModelAgent();
      }
      return createMastra({
        model: createMastraModel(model),
        preferences,
        attachments,
        supportsInlineImages: model.supportsInlineImages,
      }).getAgent('assetAgent');
    },
  });

  let server: Awaited<ReturnType<typeof listenLocalApi>>;
  try {
    server = await listenLocalApi(api);
  } catch (error) {
    database.close();
    throw error;
  }
  if (!app.isPackaged) {
    console.info('Local API listening at', server.baseUrl);
  }
  let shutdown: Promise<void> | null = null;
  registerServerShutdown(app, () => {
    shutdown ??= server.close().then(() => database.close());
    return shutdown;
  }, () => app.quit());

  createWindow(server.baseUrl, token);

  app.on('activate', () => {
    if (mainWindowOwner.current === null) {
      createWindow(server.baseUrl, token);
    }
  });
}

app.whenReady().then(startDesktopApplication).catch((error: unknown) => {
  console.error('Failed to start the desktop application.', error);
  dialog.showErrorBox(
    '应用启动失败',
    '本地 Agent 服务未能启动。请检查应用数据目录和运行时配置后重试。',
  );
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
