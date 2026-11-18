# Web 与 Node 部署

最新结构、数据流、iframe 导出和迁移状态见 [deploy-record.md](../deploy-record.md)。

React Web 与 Desktop 共用代码。后端使用普通 Node Server → 独立 Mastra Agent，数据和文件共用 Supabase。生成脚本在客户端隔离 iframe 执行，Agent 不需要 Chromium。

## 本地 Web

```powershell
pnpm --parallel --filter @agent3d/agent --filter @agent3d/server dev
# 另一个终端
pnpm --filter @agent3d/desktop dev:web
```

访问 http://localhost:5173。Web 生产构建在 apps/desktop/out/web，同域 /api 由反向代理交给 Server。

## Docker

准备根 .env.supabase 与 .env.server（当前机器已配置，不要覆盖）。从 deploy/.env.example 准备 deploy/.env，设置 SITE_ADDRESS、PUBLIC_ORIGIN。生产使用 HTTPS。Caddy 不设置额外入口密码，直接进入应用登录页；业务 API 由 Server 鉴权。

```powershell
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env build
docker compose --env-file deploy/.env up -d
docker compose --env-file deploy/.env logs -f server agent
```

Compose 将 CA 路径覆盖为 /app/deploy/supabase-ca.crt，不把 Windows 路径复制到 Linux。Server/Agent 只在 Docker 私网开放端口，外部仅访问 Caddy Web。没有业务数据卷和 Chromium 依赖。

当前只有单 Server 进程处理人工回答回调，不直接扩为多副本。本机没有 Docker；后端镜像已在 GitHub Actions 构建并实际启动验证。阿里云 ECS 采用预构建镜像的双容器编排，具体部署与当前外网访问前提见 [ECS 部署记录](../deploy/ecs.md)，不要把 CI 通过等同于线上流程验收。

## Cloudflare

当前新站点已运行在阿里云 ECS，旧 Workers 站点保留。ECS 部署不依赖 Cloudflare Containers，也没有开通 Workers Paid；deploy/cloudflare 仅保留此前容器方案配置，不参与当前站点的请求链路。
