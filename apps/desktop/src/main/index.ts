import { app, BrowserWindow, dialog, Menu, safeStorage } from 'electron';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDataDirectoryMatches,
  resolveDataDirectory,
} from '../../../server/src/config/data-directory.js';
import { createSafeStorageCredentialStore } from './credentials.js';
import { startCredentialBroker } from './credential-broker.js';
import { createApplicationMenuTemplate } from './devtools.js';
import {
  createRendererArguments,
  readRendererServerConfig,
} from './renderer-arguments.js';
import { createWindowOwner } from './window-owner.js';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const mainWindowOwner = createWindowOwner<BrowserWindow>();

function readCredentialBrokerConfig(source: Record<string, string | undefined>) {
  const port = source.AGENT3D_CREDENTIAL_BROKER_PORT === undefined
    ? 62588
    : Number(source.AGENT3D_CREDENTIAL_BROKER_PORT.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('AGENT3D_CREDENTIAL_BROKER_PORT must be a valid TCP port.');
  }
  const token = source.AGENT3D_CREDENTIAL_BROKER_TOKEN?.trim();
  if (!token) {
    throw new TypeError('AGENT3D_CREDENTIAL_BROKER_TOKEN must be configured.');
  }
  return { port, token };
}

function registerCredentialBrokerShutdown(
  close: () => Promise<void>,
  quit: () => void,
): void {
  let stopping = false;
  let finished = false;
  app.on('before-quit', (event) => {
    if (finished) {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    void close().then(() => {
      finished = true;
      quit();
    }).catch((error: unknown) => {
      console.error('Failed to close the credential broker cleanly.', error);
      finished = true;
      quit();
    });
  });
}

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
      additionalArguments: createRendererArguments(apiBaseUrl, apiToken),
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

  const rendererServer = readRendererServerConfig();
  const credentialBrokerConfig = readCredentialBrokerConfig(process.env);
  const configuredUserDataDirectory = resolveDataDirectory(
    process.env,
    process.platform,
    app.getPath('home'),
    app.getName(),
  );
  if (process.env.AGENT3D_DATA_DIR?.trim()) {
    app.setPath('userData', configuredUserDataDirectory);
  }
  const userDataDirectory = app.getPath('userData');
  assertDataDirectoryMatches(configuredUserDataDirectory, userDataDirectory);
  const secureCredentials = createSafeStorageCredentialStore(safeStorage, userDataDirectory);
  const credentialBroker = await startCredentialBroker({
    store: secureCredentials,
    token: credentialBrokerConfig.token,
    port: credentialBrokerConfig.port,
  });
  if (!app.isPackaged) {
    console.info('Credential broker listening at', credentialBroker.baseURL);
  }
  registerCredentialBrokerShutdown(() => credentialBroker.close(), () => app.quit());

  createWindow(
    rendererServer.serverUrl,
    rendererServer.serverToken,
  );

  app.on('activate', () => {
    if (mainWindowOwner.current === null) {
      createWindow(rendererServer.serverUrl, rendererServer.serverToken);
    }
  });
}

app.whenReady().then(startDesktopApplication).catch((error: unknown) => {
  console.error('Failed to start the desktop application.', error);
  dialog.showErrorBox(
    '应用启动失败',
    '桌面应用未能启动。请检查本地数据目录和运行时配置后重试。',
  );
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
