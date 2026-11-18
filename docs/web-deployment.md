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

准备根 .env.supabase 与 .env.server（当前机器已配置，不要覆盖）。从 deploy/.env.example 准备 deploy/.env，设置 SITE_ADDRESS、PUBLIC_ORIGIN 和站点访问密码哈希。生产使用 HTTPS。

```powershell
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env build
docker compose --env-file deploy/.env up -d
docker compose --env-file deploy/.env logs -f server agent
```

Compose 将 CA 路径覆盖为 /app/deploy/supabase-ca.crt，不把 Windows 路径复制到 Linux。Server/Agent 只在 Docker 私网开放端口，外部仅访问 Caddy Web。没有业务数据卷和 Chromium 依赖。

当前只有单 Server 进程处理人工回答回调，不直接扩为多副本。本机未安装 Docker，上述镜像与编排尚未实际构建运行，不能作为已通过的验收记录。

## Cloudflare

当前旧公网站点尚未切换。Workers 不是完整的 Node 常驻服务；若选择 Cloudflare Containers，需 Paid 方案及容器用量费用，还需要配置平台入口。没有为本次结构调整自动开通付费服务或删除旧站点。
