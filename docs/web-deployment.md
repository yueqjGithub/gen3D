# Web 客户端与 Docker 部署

核对免费平台条款的日期为 2026-11-16。这个工程需要常驻的 Node 进程、SQLite 持久目录以及用于导出 GLB 的 Chromium。模型 API 的费用由所选服务商决定。

## Web 复用 Desktop

React 界面位于 `apps/desktop/src/renderer`，既由 Electron 加载，也可以由浏览器加载。Web 新增一个 Vite 配置，使用相同的聊天、选项提问、工具审批、附件和 GLB 预览组件。

```powershell
# 启动 Agent 和 Server
pnpm --parallel --filter @agent3d/agent --filter @agent3d/server dev

# 另开终端，只启动浏览器客户端
pnpm --filter @agent3d/desktop dev:web

# 生成静态 Web 文件
pnpm --filter @agent3d/desktop build:web
```

开发访问 `http://localhost:5173`。`dev:web` 与 Electron 开发模式共用 5173 端口，启动时选择一种客户端模式。`out/web` 是 Web 产物目录，Electron 仍使用 `out/renderer`。Web 构建将 API 地址设为当前站点 origin，开发时由 Vite 代理 `/api`，部署后由 Caddy 代理。

## 容器结构

```mermaid
flowchart LR
    B[浏览器] -->|HTTPS 和访问密码| W[Caddy + Web 静态文件]
    W -->|同域 /api 和 SSE| S[Hono Server]
    S -->|Docker 私网| A[Mastra Agent + Chromium]
    S --> V[(app-data 数据卷)]
    A --> V
```

| 服务 | 工作内容 | 访问范围 |
|---|---|---|
| web | 静态页面、访问密码、HTTPS、SSE 反代 | 外部入口 |
| server | 登录、会话、附件、资产、审批及答案回调 | Docker 私网 62586 |
| agent | 调用模型、暂停恢复、执行建模、导出 GLB | Docker 私网 62687 |

一个多阶段 Dockerfile 提供 web/server/agent 三个目标，Compose 负责启动。Agent 与 Server 使用同一个本机数据卷，SQLite 的 WAL、Mastra 快照和 GLB 才能保持一致。Server 等 Agent 健康后启动，Web 再等 Server。

当前确认回调存在 Server 内存中，这套 Compose 按单实例部署。服务重启会结束正在等待的问题或审批，已经保存的会话、模型和 trace 留在卷里。

## 首次运行

在仓库根目录执行，准备 Docker Engine 与 Compose。

```powershell
Copy-Item deploy/.env.example deploy/.env
docker run --rm -it caddy:2-alpine caddy hash-password
```

按提示输入访问密码，将输出的 bcrypt 哈希填入 `deploy/.env` 的 `DEPLOY_PASSWORD_HASH`。哈希含有 `$`，使用单引号包住整个值，避免 Compose 对内容做变量替换。此处保存哈希，网关启动无需保存原始密码。

```dotenv
SITE_ADDRESS=:8080
PUBLIC_ORIGIN=http://localhost:8080
HTTP_BIND=127.0.0.1
DEPLOY_USER=owner
# 填入刚才生成的完整哈希
DEPLOY_PASSWORD_HASH='你的完整bcrypt哈希'
```

```powershell
docker compose --env-file deploy/.env config --quiet
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env ps
docker compose --env-file deploy/.env logs -f
```

本机访问 `http://localhost:8080`，先输入网关用户名和原始访问密码，再进入项目已有的登录页。对话模型及 API Key 继续在界面里配置，按浏览器和站点保存。

根目录开发用 `.env`、本地数据库、附件及验证文件会被 `.dockerignore` 排除。Compose 的运行配置来自 `--env-file deploy/.env`，不会自动把整个开发环境文件注入容器。

## 配置公网 HTTPS

将域名解析到服务器，开放 TCP 80/443，再修改 `deploy/.env`。

```dotenv
SITE_ADDRESS=model.example.com
PUBLIC_ORIGIN=https://model.example.com
HTTP_BIND=0.0.0.0
DEPLOY_USER=owner
DEPLOY_PASSWORD_HASH='你的完整bcrypt哈希'
```

重新运行 `docker compose --env-file deploy/.env up -d`。Caddy 为域名申请并续期证书，证书和配置保存在自己的命名卷中。公网入口使用 HTTPS，登录 Cookie 带 Secure。

PUBLIC_ORIGIN 必须匹配浏览器实际地址的协议、域名和端口。Server 根据它允许 Web 来源，也处理同域图片 GET 省略 Origin 的情况。Server 与 Agent 的端口保持在 Docker 私网，公网只经过 Web 网关。

这套默认部署用于拥有者及可信访问者的学习工作台。现有应用登录仍使用明文密码和用户名 Cookie，网关密码承担外网访问边界。持有同一网关密码的人不能被视作已相互隔离的租户。若要开放注册给陌生用户，需要进一步改造密码哈希、服务端会话和用户隔离。

## Chromium 与运行资源

Agent 镜像安装 Debian Chromium，并使用非 root 的 node 用户。工具继续开启 Chromium 沙箱；Compose 加载 Playwright 官方 seccomp 配置，允许沙箱所需的用户命名空间调用。来源和许可证保存在 deploy/NOTICE 与 deploy/playwright-LICENSE。

宿主机需要支持非特权用户命名空间。受限 PaaS 若禁止这些系统调用，即使支持 Docker，也可能无法运行当前建模工具。浏览器出错时先检查 Agent 日志与宿主机限制。依据是 Playwright 官方容器运行说明。[Playwright Docker](https://playwright.dev/docs/docker)

个人学习环境可以先按至少 2 核、4 GB 内存规划，实际峰值随脚本复杂度和并发量增加。构建时还会消耗编译器、Node 依赖和 Mastra 打包所需的内存与磁盘，这一数值是工程配置建议，未作为云端实测容量。

当前 Dockerfile 为便于学习共用构建阶段和 workspace 依赖，最终 Node 镜像会包含较多依赖。可先完成部署，再按实际镜像体积决定是否进一步裁剪。

## 流式回复和人工等待

Caddy 对 `/api` 采用即时 flush。Server 每 15 秒发送一个 AI SDK 瞬时心跳，帮助中间代理保持等待用户输入的连接。心跳不会保存到消息历史。代理自身若有强制的请求总时长限制，仍以平台规则为准。[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

## 持久化与升级

app-data 卷里包含这些内容。

- `/data/agent3d.sqlite` 及其 WAL 文件，保存会话、资产记录、用户、偏好、Mastra 快照和 trace。
- `/data/data/attachments` 保存附件文件。
- `/data/models` 保存实际 GLB 文件。

升级代码后重新构建并启动，命名卷会复用。

```powershell
docker compose --env-file deploy/.env up -d --build
# 暂停应用并保留命名卷
docker compose --env-file deploy/.env down
```

数据库、附件和 GLB 需要一起备份。可在停服后备份整个 app-data 卷，以避免漏掉 SQLite WAL 中未检查点的数据。迁移现有本地数据时，把数据库、实际附件目录及 models 一起放到同一卷的对应位置。

## 可免费使用的部署路径

| 路径 | 对当前工程的适合程度 | 免费条件和限制 |
|---|---|---|
| Oracle Cloud Always Free VM | 最贴近当前 Compose，需要可用配额和支持 Chromium 沙箱的宿主机 | A1 免费租户当前为合计 2 OCPU、12 GB 内存，Always Free 块存储合计 200 GB。区域容量可能不足，闲置实例可能被回收 |
| 已有电脑或服务器 + Cloudflare 命名隧道 | 复用已有算力及磁盘，通过隧道访问 Web 网关 | 需要机器持续运行和可用网络。Tunnel 本身可免费使用，固定自有域名需已持有域名或另计域名费用 |
| Cloudflare Pages 托管 Web 静态文件 | 适合前端预览，完整工作台还需部署后端 | Free 计划有 500 次构建/月。当前 Web 使用同域 `/api`，放到纯静态平台时还需配置同域 API 代理及其后端 |

Oracle 额度、区域和闲置回收规则以账户控制台与官方说明为准。当前选择 VM 的原因是本项目依赖同机持久卷、常驻 Node 和 Chromium，以上是按工程需求作出的适配判断。[Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Cloudflare 命名隧道可将自己的服务映射到域名。保留 SITE_ADDRESS=:8080、HTTP_BIND=127.0.0.1，让隧道连接本机 http://localhost:8080，同时将 PUBLIC_ORIGIN 设成外部 HTTPS 地址。配置固定命名隧道需要 Cloudflare 账户和域名设置。[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)

使用 Tunnel 路径时保留网关认证，也可按官方 Access 方案设置额外的身份访问策略。Cloudflare 提供免费 Zero Trust 计划，具体可用配额以账户控制台为准。[Cloudflare 计划](https://www.cloudflare.com/plans/zero-trust-services/)

Pages 可以免费承载生成的静态 Web 文件，它的免费额度与后端运行能力分开计算。当前仓库提供的完整部署仍是上面的 Compose。[Pages 限制](https://developers.cloudflare.com/pages/platform/limits/)

### 不宜直接照旧教程选择的方案

- Render 免费 Web 实例没有持久磁盘，重启、重新部署或休眠会丢失本地文件，空闲 15 分钟会休眠。当前 SQLite、附件和 GLB 依赖本地卷，直接放上去会丢数据。[Render 免费实例](https://render.com/docs/free)
- Cloudflare Quick Tunnel 的 trycloudflare.com 临时地址不支持 SSE，本工程应选择命名隧道。[Quick Tunnel 限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- Hugging Face 当前文档要求付费计划才能创建 Docker Spaces。CPU Basic 标注每小时免费，创建 Docker Space 仍受计划要求约束。[Spaces 官方说明](https://huggingface.co/docs/hub/spaces-overview)

## 验证范围

本次实现包含 Web/桌面构建、来源与附件路径回归、网关配置检查，以及本机浏览器验证。当前工作环境没有 Docker Engine 和可用 WSL，因此 Linux 镜像构建、Compose 启动、Chromium 用户命名空间及云端部署还需在目标 Linux 主机上验证。此限制不应被当作云端部署成功。
