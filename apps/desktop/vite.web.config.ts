import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));

/** Web 与 Electron 使用同一套 React 源码。Web 始终通过同域 /api 访问 Server。 */
export default defineConfig({
  root: resolve(appRoot, 'src/renderer'),
  plugins: [react()],
  define: {
    'import.meta.env.AGENT3D_SERVER_URL': JSON.stringify(''),
  },
  resolve: { alias: { '@renderer': resolve(appRoot, 'src/renderer/src') } },
  server: {
    host: 'localhost', port: 5173, strictPort: true,
    // 同域 GET 通常不带 Origin；本地开发代理明确标识自己，供 Server 来源校验。
    proxy: { '/api': {
      target: 'http://127.0.0.1:62586', changeOrigin: false,
      headers: { Origin: 'http://localhost:5173' },
      // 保持代理到 Node 的上游连接；本机实测不保活时大 GLB 最后一段会被截断。
      agent: new Agent({ keepAlive: true }),
    } },
  },
  build: { outDir: resolve(appRoot, 'out/web'), emptyOutDir: true },
});
