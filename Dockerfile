# syntax=docker/dockerfile:1
# 三个目标共用构建阶段。构建上下文必须是仓库根目录，才能解析 workspace:*。
FROM node:24-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY deploy/supabase-ca.crt ./deploy/supabase-ca.crt
COPY deploy/start-backend.mjs ./deploy/start-backend.mjs
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent3d/desktop build:web
RUN pnpm --filter @agent3d/server build
RUN pnpm --filter @agent3d/agent build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
USER node

# Server 只在 Docker 私网监听，外部浏览器经 Web 容器的 /api 访问它。
FROM runtime AS server
ENV HOST=0.0.0.0
ENV PORT=62586
ENV AGENT_URL=http://agent:62687/chat/asset-creation-agent
CMD ["node", "apps/server/dist/index.js"]

# Agent 只生成脚本；Three.js 执行和 GLB 导出在 Web/Desktop iframe 中完成。
FROM runtime AS agent
ENV AGENT3D_AGENT_HOST=0.0.0.0
WORKDIR /app/apps/agent/.mastra/output
CMD ["node", "index.mjs"]

# Web 产物与 Electron 的窗口代码无关，Caddy 负责静态文件、HTTPS 和流式反代。
FROM caddy:2-alpine AS web
COPY --from=build /app/apps/desktop/out/web /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# Cloudflare Containers：一个容器运行两个独立 Node 进程，Agent 只监听回环地址。
# 这是部署组合，不改变 Server -> Agent 的 HTTP 边界；不安装 Chromium。
FROM runtime AS backend
USER root
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER node
ENV HOST=0.0.0.0 PORT=62586
ENV AGENT3D_AGENT_HOST=127.0.0.1
ENV AGENT_URL=http://127.0.0.1:62687/chat/asset-creation-agent
ENV SUPABASE_CA_PATH=/app/deploy/supabase-ca.crt
EXPOSE 62586
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "deploy/start-backend.mjs"]
