import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => ({
  // main 编译 Electron 主进程，renderer 编译 React 页面。
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@agent3d/shared'] })],
  },
  renderer: {
    // dev 和 build 都从仓库根目录读取 .env，只把公开的 Hono 地址注入渲染进程。
    define: {
      'import.meta.env.AGENT3D_SERVER_URL': JSON.stringify(
        loadEnv(mode, resolve(appRoot, '../..'), 'AGENT3D_SERVER_URL').AGENT3D_SERVER_URL?.trim() || 'http://127.0.0.1:62586',
      ),
    },
    server: {
      // 与 Server 的来源校验保持一致；端口被占用时直接报错，不自动换端口。
      host: 'localhost',
      port: 5173,
      strictPort: true,
      origin: 'http://localhost:5173',
    },
    resolve: {
      alias: {
        '@renderer': resolve(appRoot, 'src/renderer/src'),
      },
    },
    plugins: [react()],
  },
}));
