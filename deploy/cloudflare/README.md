# Cloudflare 上的普通 Node 部署

这里是部署入口，不是另一套业务后端。`worker.ts` 只把 `/api/*` 转给容器，其余请求读取 Web 静态文件。容器内仍运行 apps/server 和 apps/agent 两个 Node 进程，Agent 仅监听回环地址。模型在用户浏览器 iframe 中执行并导出，不安装 Chromium。

## 费用与当前前提

Cloudflare Containers 要求 Workers Paid。2026-11-18 检查时，此账号仍为 Free，平台拒绝创建容器。Paid 最低每月 5 美元，容器超过包含额度另计费；这里不是已完成的线上部署。

配置使用 basic（1 GiB 内存）和一个固定名称的 Backend，空闲 5 分钟后休眠。Supabase 保持现有项目和私有存储桶。不要为迁移删除已有表或资产。

## 文件与验证

- 根目录 Dockerfile 的 backend 目标打包两个普通 Node 服务。
- deploy/start-backend.mjs 等待 Agent 端口就绪后启动 Server，并转发退出信号。
- wrangler.jsonc 指定独立的新站点 agent3d-node，不覆盖旧 agent3d 站点。
- .github/workflows/container-check.yml 在 codex/deploy-node 分支构建 Linux 镜像，实际启动两个服务；只使用临时 PostgreSQL、测试证书和虚拟 Storage 配置，不把生产密钥放入构建。Mastra 启动需要读取原生表，因此检查前会在临时数据库初始化原生表，不能只填一个不存在的数据库地址。

本地检查入口类型：

```sh
pnpm exec wrangler types --config deploy/cloudflare/wrangler.jsonc deploy/cloudflare/worker-configuration.d.ts
pnpm exec tsc -p deploy/cloudflare/tsconfig.json
```

## 发布步骤

1. 在 Cloudflare 账号开通 Workers Paid，明确接受基础月费及按量费用。
2. 在有 Docker 的机器或 CI 构建并推送镜像至 Cloudflare Registry。本机没有 Docker；当前 GitHub 工作流先验证构建与启动，不会自动发布。
3. 将 DATABASE_URL、SUPABASE_URL、SUPABASE_SECRET_KEY、SESSION_SECRET 写入新 Worker 的 secrets。只在运行时注入容器，不写进镜像、Git 或前端。数据库连接继续用已有 Supabase pooler；应用会选用 5432 session pooler。
4. 发布本配置中的新站点，检查登录、历史、SSE、手动确认、选项回答、iframe 导出与 Storage 保存，再决定是否替换旧入口。
5. 旧站点保持可用，验证完成前不删除其 Worker、Hyperdrive 和存储配置。

网关不解析消息或重放聊天请求；启动探针失败才重试。容器重启会丢失正在内存中等待的确认回调，数据库历史与已保存 GLB 不受影响。切换部署应避开正在进行的生成。

官方说明：[价格](https://developers.cloudflare.com/containers/platform/pricing/)、[部署与镜像构建](https://developers.cloudflare.com/containers/guides/deploy/)、[原生容器 API](https://developers.cloudflare.com/containers/api/durable-object-container/)。
