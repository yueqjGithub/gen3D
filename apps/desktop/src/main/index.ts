import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import debug from 'electron-debug'

if (!app.isPackaged) {
  debug();
}

const appRoot = fileURLToPath(new URL('.', import.meta.url));
let mainWindow: BrowserWindow | null = null;

// Electron 主进程只管理窗口；React 界面和 Hono API 分别运行在独立进程中。
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f5f4f1',
    webPreferences: {
      // 页面不直接使用 Node API，也没有 preload 桥接；界面通过 HTTP 访问本地 Hono。
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = window;
  mainWindow.once('ready-to-show', () => {
    mainWindow?.webContents.openDevTools()
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  // 开发时加载 Vite 地址，打包后加载构建出的本地 HTML。
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(resolve(appRoot, '../renderer/index.html'));
  }
}

// 等待 Electron 初始化后创建菜单和窗口；开发版 F12 可切换开发者工具。
app.whenReady().then(() => {
  const menu: MenuItemConstructorOptions[] = [{
    label: '查看',
    submenu: [{
      label: '开发者工具',
      accelerator: 'F12',
      click: () => {
        if (!mainWindow) {
          return;
        }
        if (mainWindow.webContents.isDevToolsOpened()) {
          mainWindow.webContents.closeDevTools();
        } else {
          mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
      },
    }],
  }];
  Menu.setApplicationMenu(app.isPackaged ? null : Menu.buildFromTemplate(menu));

  createWindow();
  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });
}).catch((error: unknown) => {
  console.error('Failed to start the desktop application.', error);
  dialog.showErrorBox(
    '应用启动失败',
    '桌面应用未能启动。请检查运行时配置后重试。',
  );
  app.quit();
});

// macOS 习惯保留应用进程；其他系统关闭最后一个窗口时退出。
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
