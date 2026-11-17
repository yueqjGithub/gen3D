# syntax=docker/dockerfile:1
# 三个目标共用构建阶段。构建上下文必须是仓库根目录，才能解析 workspace:*。
FROM node:24-bookworm-slim AS build
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV AGENT3D_DATA_DIR=/tmp/agent3d-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agent3d/desktop build:web
RUN pnpm --filter @agent3d/server build
RUN pnpm --filter @agent3d/agent build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
ENV AGENT3D_DATA_DIR=/data
USER node

# Server 只在 Docker 私网监听，外部浏览器经 Web 容器的 /api 访问它。
FROM runtime AS server
ENV HOST=0.0.0.0
ENV PORT=62586
ENV AGENT_URL=http://agent:62687/chat/asset-creation-agent
CMD ["node", "apps/server/dist/index.js"]

# Chromium 在非 root 用户下运行，保留生成工具已有的 Chromium 沙箱。
# compose.yaml 额外使用 Playwright 官方 seccomp 配置，允许创建用户命名空间。
FROM runtime AS agent
USER root
RUN apt-get update && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV THREE_CHROME_PATH=/usr/bin/chromium
ENV AGENT3D_AGENT_HOST=0.0.0.0
USER node
WORKDIR /app/apps/agent/.mastra/output
CMD ["node", "index.mjs"]

# Web 产物与 Electron 的窗口代码无关，Caddy 负责静态文件、HTTPS 和流式反代。
FROM caddy:2-alpine AS web
COPY --from=build /app/apps/desktop/out/web /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
