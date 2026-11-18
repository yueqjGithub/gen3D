import { DurableObject } from 'cloudflare:workers';

interface Env {
  BACKEND: DurableObjectNamespace<Backend>;
  ASSETS: Fetcher;
  PUBLIC_ORIGIN: string;
  DATABASE_URL: string;
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  SESSION_SECRET: string;
}

/** 仅负责启动 Linux 容器并透传 HTTP，不包含 Agent、SQL 或消息格式转换。 */
export class Backend extends DurableObject<Env> {
  private starting?: Promise<void>;
  private async ensureReady() {
    const container = this.ctx.container!;
    if (!container.running) container.start({
      image: container.images.base, instance: 'basic', enableInternet: true,
      env: {
        DATABASE_URL: this.env.DATABASE_URL,
        SUPABASE_URL: this.env.SUPABASE_URL,
        SUPABASE_SECRET_KEY: this.env.SUPABASE_SECRET_KEY,
        SUPABASE_STORAGE_BUCKET: 'agent3d',
        SESSION_SECRET: this.env.SESSION_SECRET,
        SUPABASE_CA_PATH: '/app/deploy/supabase-ca.crt',
        AGENT3D_WEB_ORIGIN: this.env.PUBLIC_ORIGIN,
      },
    });
    // 只在真正空闲后休眠。聊天的响应流和回答请求仍进同一个固定容器。
    await container.setInactivityTimeout(5 * 60 * 1000);
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const server = await container.getTcpPort(62586).fetch('http://container/api/login', {
          headers: { Origin: this.env.PUBLIC_ORIGIN }, signal: AbortSignal.timeout(1000),
        });
        await server.body?.cancel();
        // 容器启动脚本确认 Agent 的回环端口就绪后才启动 Server。
        // Agent 不对容器网络开放，网关也不需要访问它的管理 API。
        if (server.status === 401) return;
      } catch { /* 只重试启动探针，绝不自动重发用户的聊天/上传请求。 */ }
      await scheduler.wait(200);
    }
    throw Error('Node backend startup timed out.');
  }
  async fetch(request: Request) {
    this.starting ??= this.ensureReady().finally(() => { this.starting = undefined; });
    await this.starting;
    const url = new URL(request.url);
    url.protocol = 'http:'; // Cloudflare 已终止 HTTPS，容器内部使用 HTTP。
    // 保留公开 Host，Server 才能识别省略 Origin 的同域图片/GLB GET 请求。
    return this.ctx.container!.getTcpPort(62586).fetch(new Request(url, request));
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path === '/api' || path.startsWith('/api/')) {
      try { return await env.BACKEND.getByName('backend').fetch(request); }
      catch {
        return Response.json({ code: 'INTERNAL_ERROR', message: '后端正在启动或暂不可用，请稍后重试。', retryable: true }, { status: 503 });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
