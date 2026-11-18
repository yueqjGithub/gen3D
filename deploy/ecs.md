# 阿里云 ECS 发布

目标机器：47.109.49.110，Alibaba Cloud Linux 3，2 核 / 2 GiB，Docker 26.1.3、Compose 2.27.0。已通过 SSH 上传并导入镜像，在 /opt/agent3d 启动 Node 后端，健康检查通过。后端镜像在 ECS 解包后约 1.29 GB，Web 镜像约 67 MB。

当前状态：Server、独立 Mastra Agent、Supabase 严格 TLS 数据库连接、原生会话/消息表与私有存储桶检查均已通过。外部 TCP 80/443 超时，ACME 证书挑战也报告连接超时；主机 firewalld 未启用，需控制台放行安全组。等待期间已暂停 Web，防止重复失败证书申请；后端保持运行。尚未完成可信 HTTPS 和浏览器端全流程验收。

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

服务器专用目录包含镜像归档、deploy/ecs.compose.yaml、deploy/Caddyfile.ecs、deploy/.env、根目录 .env.supabase 与 .env.server。服务器配置只复制必需变量，不复制本机 Windows CA 路径、代理或开发地址。配置文件权限为 600，部署目录权限为 700，不提交 Git。

```sh
sha256sum -c agent3d-images.sha256
docker load -i agent3d-images.tar.gz
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml ps
docker compose --env-file deploy/.env -f deploy/ecs.compose.yaml logs --tail=100 -f server web
```

## 发布前仍需取得的信息

用户暂无域名，因此使用 https://47.109.49.110。deploy/Caddyfile.ecs 显式设置 Let's Encrypt ACME shortlived profile，申请公网 IP 证书，Caddy 持久卷保存证书并自动续期。无需改成自签证书或去掉登录 Cookie 的 Secure 属性。参考 [Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。

安全组入方向需允许 TCP 80 和 TCP 443，来源 0.0.0.0/0；保留原 SSH 规则，不开放全部端口。控制台修改完成后在服务器 /opt/agent3d 执行上面的 up -d 命令即可恢复 Web 和证书申请，再验证浏览器信任链。

本次没有覆盖既有服务或删除数据库。普通业务不使用 root SSH 密码：站点入口另有随机生成的 owner 访问密码，保存在本机忽略提交的 .verification/ecs-access.txt；通过入口后继续使用应用原有账户。不要把这个文件或服务器环境文件提交到 Git。

上线后检查登录、历史会话、SSE、手动工具确认、选项回答、iframe 预览/导出及刷新后重新读取 GLB，再记录最终域名和版本。旧 Cloudflare 站点在新站点验证完成前保留。
