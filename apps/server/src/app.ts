import type { Repository } from './storage/repository';
import { Hono } from 'hono';
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
import { toApiErrorResponse } from './http-errors';
import { createLocalOriginMiddleware } from './middleware/local-origin';
import { getCookie, getSignedCookie } from 'hono/cookie';
import { createLoginRoute, type LoginRepository } from './routes/login';
import type { createLoginRepository } from './storage/login';

/**
 * Hono 应用的依赖：index.ts 创建 PostgreSQL 和私有 Storage 仓库后交给这里。
 * 测试保留独立 SQLite fixture，不连接用户的正式数据库。
 */
export interface CreateAppDependencies {
  conversations: Repository<ReturnType<typeof createConversationRepository>>;
  artifacts: Repository<ReturnType<typeof createArtifactRepository>>;
  attachments: Repository<AttachmentStore>;
  preferences: Repository<PreferenceRepository>;
  settings: Repository<ReturnType<typeof createSettingsRepository>>;
  users: LoginRepository;
  /** 仅公网部署配置；用于签发和验证登录凭证，不能放进前端构建。 */
  sessionSecret?: string;
}

/**
 * 组装 Hono 应用：先挂载来源校验中间件，再挂载各业务路由，最后注册统一的错误和 404 处理。
 */
export function createApp(dependencies: CreateAppDependencies) {
  const app = new Hono();
  // 所有 /api 请求都先经过来源校验（同时负责 CORS 响应头）
  app.use('/api/*', createLocalOriginMiddleware());
  app.route('/api', createLoginRoute(dependencies.users, dependencies.sessionSecret));

  // 除登录与修改密码以外的接口均要求 Cookie 指向一个已存在的用户。
  app.use('/api/*', async (context, next) => {
    const username = getCookie(context, 'username');
    if (!username || !await dependencies.users.get(username)
      || (dependencies.sessionSecret && await getSignedCookie(context, dependencies.sessionSecret, 'session') !== username)) {
      return context.json({ code: 'UNAUTHORIZED', message: '请先登录。', retryable: false }, 401);
    }
    // 资产使用独立 ID 访问，检查资产对应的会话是否属于当前用户。
    const match = /^\/api\/artifacts\/([^/]+)/.exec(context.req.path);
    if (match) {
      const artifact = await dependencies.artifacts.get(decodeURIComponent(match[1]!));
      if (!artifact || !await dependencies.conversations.get(artifact.conversationId, username)) {
        return context.json({ code: 'NOT_FOUND', message: '资产不存在。', retryable: false }, 404);
      }
    }
    await next();
  });

  // 每个路由模块只负责一类资源，最终都挂在 /api 前缀下

  /** 会话管理：列表、创建、重命名、删除，以及读取某个会话的历史消息。 */
  app.route('/api', createConversationRoutes(dependencies));
  /**
 * 附件上传：POST /api/conversations/:id/attachments（multipart/form-data，字段名 file）。
 * 校验顺序：会话存在 → 体积 → 类型白名单 → 文件头 → 文档可读，全部通过后才保存。
 */
  app.route('/api', createAttachmentRoutes(dependencies));
  /** 模型设置与用户偏好两组接口：都很小，所以放在同一个路由文件里。 */
  app.route('/api', createModelSettingsRoutes(dependencies));
  /**
   * 3D 资产（Blender 脚本）的审批流程，对应 Human-in-the-loop：
   * Agent 生成的资产状态为 pending → 用户可编辑脚本 → 批准(approved) 或 拒绝(rejected) → 只有批准后才能下载。
   */
  app.route('/api', createArtifactRoutes(dependencies.artifacts));
  /**
   * 聊天路由：POST /api/chat。完整流程：
   *  1. 校验请求，确认会话存在
   *  2. 幂等检查：同一 clientTurnId 已完成则重放，正在运行则返回冲突
   *  3. 读取当前选择的对话模型，准备附件（文档文本 / 图片）
   *  4. 记录本轮开始（beginTurn），调用 Agent 并把流转发给渲染进程
   *  5. 流结束后保存助手消息；失败则记录失败状态，允许用户重试
   */
  app.route('/api', createChatRoutes(dependencies));

  // 路由里抛出的任何异常都会到这里，统一转换为 { code, message, retryable } 结构
  app.onError((error, context) => {
    const response = toApiErrorResponse(error);
    // 只有未预期的 500 错误才打印日志，业务错误（400/404/409 等）属于正常返回
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
