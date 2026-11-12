import { createMiddleware } from 'hono/factory';
import { apiErrorSchema } from '@agent3d/shared';

// 开发模式下 Electron 渲染进程由 Vite 在该地址提供
const developmentOrigin = 'http://localhost:5173';

/**
 * 本地 API 的来源边界：这个服务只给自己的桌面端用，所以只放行两类来源，
 * 同时在这里直接写入 CORS 响应头（没有使用额外的 cors 中间件）。
 *  1. 开发环境的渲染进程：Origin 为 http://localhost:5173
 *  2. 打包后的 Electron：页面通过 file:// 加载，Origin 可能为 'null' 或省略；
 *     同时要求 User-Agent 含 Electron，避免普通网页借 opaque origin 访问本地 API。
 */
export function createLocalOriginMiddleware() {
  return createMiddleware(async (context, next) => {
    const origin = context.req.header('Origin');
    const isPackagedElectron = (origin === 'null' || origin === undefined)
      && context.req.header('User-Agent')?.includes('Electron/');
    if (origin !== developmentOrigin && !isPackagedElectron) {
      return context.json(apiErrorSchema.parse({
        code: 'UNAUTHORIZED',
        message: 'This local API origin is not allowed.',
        retryable: false,
      }), 403);
    }

    const setCorsHeaders = () => {
      context.header('Access-Control-Allow-Origin', origin ?? 'null');
      context.header('Access-Control-Allow-Credentials', 'true');
      context.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      context.header('Access-Control-Allow-Headers', 'Content-Type');
      context.header('Vary', 'Origin');
      context.header('Cache-Control', 'no-store');
    };
    setCorsHeaders();

    // 浏览器跨域请求前会先发 OPTIONS 预检，这里直接返回 204 表示允许
    if (context.req.method === 'OPTIONS') {
      return context.body(null, 204);
    }

    await next();
    // 路由可能重建了响应对象，因此执行完后再补一次响应头
    setCorsHeaders();
  });
}
