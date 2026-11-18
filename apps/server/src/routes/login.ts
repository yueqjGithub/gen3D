import type { Repository } from '../storage/repository';
import { Hono } from 'hono';
import { getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import type { createLoginRepository } from '../storage/login';

const credentials = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
}).strict();
const passwordChange = z.object({
  username: credentials.shape.username,
  oldPassword: credentials.shape.password,
  newPassword: credentials.shape.password,
}).strict();

/** 登录页与启动检查共用同一组路由；首次输入的用户名会自动创建。 */
export type LoginRepository = Repository<ReturnType<typeof createLoginRepository>> & {
  /** 云端存储密码哈希；本地学习版仓库未提供此方法时仍沿用原有比较方式。 */
  verifyPassword?(password: string, stored: string): Promise<boolean>;
};

export function createLoginRoute(users: LoginRepository, sessionSecret?: string) {
  const routes = new Hono();

  routes.get('/login', async (context) => {
    const username = getCookie(context, 'username');
    if (!username || !(await users.get(username))
      || (sessionSecret && await getSignedCookie(context, sessionSecret, 'session') !== username)) {
      return context.json({ code: 'UNAUTHORIZED', message: '请先登录。', retryable: false }, 401);
    }
    return context.json({ username });
  });

  routes.post('/login', async (context) => {
    const parsed = credentials.safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json({ code: 'VALIDATION_FAILED', message: '请输入用户名和密码。', retryable: false }, 400);
    }
    const { username, password } = parsed.data;
    const user = (await users.get(username));
    if (user && !(users.verifyPassword ? await users.verifyPassword(password, user.password) : user.password === password)) {
      return context.json({ code: 'UNAUTHORIZED', message: '密码不正确。', retryable: false }, 401);
    }
    if (!user) (await users.create(username, password));
    // 浏览器没有真正永久的 Cookie；这里设置为 400 天，登录时重新续期。
    setCookie(context, 'username', username, {
      path: '/', httpOnly: true, sameSite: 'None', secure: true, maxAge: 400 * 24 * 60 * 60,
    });
    // 公网部署不能只相信可伪造的用户名 Cookie。签名凭证只由服务端密钥签发，浏览器无法修改。
    if (sessionSecret) await setSignedCookie(context, 'session', username, sessionSecret, {
      // Electron 的 file:// 页面访问远端 API 时属于跨站请求，需要 None；来源仍由中间件校验。
      path: '/', httpOnly: true, sameSite: 'None', secure: true, maxAge: 7 * 24 * 60 * 60,
    });
    return context.json({ username });
  });

  routes.post('/login/password', async (context) => {
    const parsed = passwordChange.safeParse(await context.req.json());
    if (!parsed.success) {
      return context.json({ code: 'VALIDATION_FAILED', message: '请填写用户名、旧密码和新密码。', retryable: false }, 400);
    }
    const { username, oldPassword, newPassword } = parsed.data;
    const user = (await users.get(username));
    if (!user || !(users.verifyPassword ? await users.verifyPassword(oldPassword, user.password) : user.password === oldPassword)) {
      return context.json({ code: 'UNAUTHORIZED', message: '用户名或旧密码不正确。', retryable: false }, 401);
    }
    (await users.updatePassword(username, newPassword));
    return context.json({ username });
  });
  return routes;
}
