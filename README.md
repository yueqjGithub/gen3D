# 形构 Agent：3D 资产学习工程

当前采用清晰的三层结构：Web/Desktop → Node Hono Server → 独立 Mastra Agent。Server 和 Agent 共用 Supabase PostgreSQL，附件及模型文件保存在 Supabase 私有 Storage。工程不再包含 Workers 专用业务工作区。

详细结构、数据流和迁移状态见 [部署记录](deploy-record.md)。原 Workers 部署记录保存在 [历史文档](docs/history/workers-deployment-2026-11-17.md)，不作为当前启动说明。

## 本地启动

建议 Node 24、pnpm 12.15.0。

1. 根目录 .env 配置本地 API 地址及 Studio 可选的 AGNES_API_KEY，模板为 .env.example。
2. 根目录 .env.supabase 保存数据库和 Storage 配置，模板为 deploy/supabase.env.example。
3. 根目录 .env.server 保存 SESSION_SECRET，模板为 deploy/server.env.example。
4. 实际配置不提交 Git。当前机器已经配置好，无需覆盖或重新生成密钥。

首次准备：

```powershell
pnpm install --frozen-lockfile
# 新数据库才需要执行；当前 Supabase 已初始化，不要每次启动都建表。
pnpm --filter @agent3d/server db:init
```

桌面模式：

```powershell
pnpm dev
```

浏览器模式，分别在两个终端运行：

```powershell
pnpm --parallel --filter @agent3d/agent --filter @agent3d/server dev
pnpm --filter @agent3d/desktop dev:web
```

Web 开发页为 http://localhost:5173，Server 为 http://127.0.0.1:62586，Agent/Studio 为 http://127.0.0.1:62687。Web 与 Electron 开发模式共用 5173 端口，应选择一种启动。

浏览器 Web 构建请求同域 /api；Desktop 的地址来自根 .env 的 AGENT3D_SERVER_URL。上传图片、文本、工具审批、多选项提问、历史和资产审阅共用同一套 React 组件。

## 目录

- apps/desktop：Electron 窗口、Web/Desktop 共用 React 界面。
- apps/server：Hono HTTP 路由、聊天编排、PostgreSQL 与私有 Storage。
- apps/agent：独立 Mastra、提示词、工具、原生暂停恢复、Trace。
- packages/shared：类型、业务输入和模型格式校验。
- deploy：Docker/HTTPS 配置、Supabase 证书和配置模板。

会话与消息继续使用 Mastra 原生 mastra_threads / mastra_messages 表，正式 schema 为 agent3d。SQLite 仓库仍用于既有离线测试 fixture，当前实际启动入口不再创建本地 SQLite。

## 部署与检查

当前已部署到阿里云 ECS：[https://47.109.49.110](https://47.109.49.110)，使用 Caddy + 普通 Node Server/Agent + Supabase。运行、日志、HTTPS 和访问凭据说明见 [ECS 部署记录](deploy/ecs.md)，其他 Docker 启动方式见 [Web 部署](docs/web-deployment.md)。旧 Workers 站点保留，不作为当前推荐入口。

```powershell
pnpm --filter @agent3d/server build
pnpm --filter @agent3d/agent build
pnpm --filter @agent3d/desktop build:web
pnpm test
pnpm typecheck
```

模型密钥由工作台用户输入并保存在该客户端 localStorage，随聊天请求发送，不写入模型设置表。Studio 的环境变量密钥配置在根目录 .env。

如本机网络必须使用现有代理，可在启动命令的终端中使用 Node 24 支持的设置；服务器不需要本机代理地址：

当前机器已在后端的未提交配置中保存这些选项，无需每次重新输入。下面供新机器按需使用。

```powershell
$env:NODE_OPTIONS='--use-system-ca --use-env-proxy'
$env:NO_PROXY='localhost,127.0.0.1,::1'
```

这不会关闭 TLS 校验。Supabase PostgreSQL 另外使用 deploy/supabase-ca.crt 验证证书。
