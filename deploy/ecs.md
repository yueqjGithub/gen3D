# 阿里云 ECS 发布

目标机器：47.109.49.110，Alibaba Cloud Linux 3，2 核 / 2 GiB，截图显示已安装 Docker。尚未取得 SSH 登录方式，不能把端口连通当作已经登录或发布成功。

## 运行方式

```text
浏览器 HTTPS → ECS Caddy（Web 静态文件、/api 流式反代）
                         → Node Server → Node Mastra Agent
                              ↓               ↓
                         Supabase PostgreSQL / 私有 Storage
```

Agent 和 Server 在 backend 镜像中是两个独立进程。Agent 仅监听回环地址；Server 只对 Docker 网络开放。公网仅开放 Web 的 80/443。保留 SSH 管理端口，不开放数据库或 Agent 管理 API。ECS 控制台预装的 PostgreSQL 暂不使用，也不删除，现有数据仍使用 Supabase。

Web/Desktop 的 iframe 继续执行 Three.js 并导出 GLB，经 Server 保存到 Supabase。ECS 不安装 Chromium。这里使用 deploy/ecs.compose.yaml，不需要 deploy/cloudflare 入口，也不需要开通 Workers Paid。

## 构建与上传

GitHub Actions 在 codex/deploy-node 分支构建并验证 backend 镜像，再构建 web 镜像，产出 agent3d-ecs-images。产物包含两个镜像的 tar.gz 与 SHA256 校验文件，保留 3 天；不含生产密钥。由部署机器下载并用 SSH 上传，避免 2 GiB ECS 现场编译。

服务器专用目录需包含镜像归档、deploy/ecs.compose.yaml、deploy/.env、根目录 .env.supabase 与 .env.server。服务器配置只复制必需变量，不复制本机 Windows CA 路径、代理或开发地址。配置文件限制为部署用户可读，不提交 Git。

```sh
sha256sum -c agent3d-images.sha256
docker load -i agent3d-images.tar.gz
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml ps
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml logs --tail=100 -f server web
```

## 发布前仍需取得的信息

- SSH 用户名、登录方式；使用私钥时只提供本机文件路径，不把私钥写进聊天或 Git。
- 公开 HTTPS 入口域名及 DNS 配置。应用登录 Cookie 使用 Secure，不能用裸 HTTP 验收登录功能。
- 登录服务器后核对现有服务、端口、磁盘、Docker/Compose 版本以及 Supabase 连通性；不覆盖已有站点或数据库。

上线后检查登录、历史会话、SSE、手动工具确认、选项回答、iframe 预览/导出及刷新后重新读取 GLB，再记录最终域名和版本。旧 Cloudflare 站点在新站点验证完成前保留。
