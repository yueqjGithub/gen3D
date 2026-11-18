# 阿里云 ECS 发布

## 新域名接入进度（2026-11-18）

用户新购域名 mymaster3d.online，已实名认证，尚未完成 ICP 备案。当前已检查 Google 与 Cloudflare 公共 DNS，根域名和 www 均未解析，NS 委派也暂不可见（NXDOMAIN）；控制台截图仅有 www 的 A 记录指向 47.109.49.110。需要补充 @ 的 A 记录，并在域名注册管理页确认 DNS 服务器为该域名实际分配的 dns15.hichina.com、dns16.hichina.com；如果已经一致，则等待新注册域名的委派同步，不能仅凭提示认定 NS 一定填错。

当前 IP 站点与 ECS 服务均正常，未为了接入尚未解析的新域名重启后端或停用 IP 入口。DNS 正常后，还需配置 Caddy 的域名站点/证书以及 Server 的允许来源，才能保证 HTTPS、登录、图片/GLB 和 SSE 均使用新地址。域名尚未配置为正式入口。

ECS 位于成都，域名在该实例上对外提供网站服务需完成 ICP 备案。实名认证不等于备案。参考：[阿里云网站部署说明](https://www.alibabacloud.com/help/en/ecs/user-guide/build-a-website/)、[新注册域名与 DNS 同步](https://help.aliyun.com/zh/dws/getting-started)。

目标机器：47.109.49.110，Alibaba Cloud Linux 3，2 核 / 2 GiB，Docker 26.1.3、Compose 2.27.0。已通过 SSH 上传并导入镜像，在 /opt/agent3d 启动 Node 后端，健康检查通过。后端镜像在 ECS 解包后约 1.29 GB，Web 镜像约 67 MB。

当前状态：已上线，入口为 [https://47.109.49.110](https://47.109.49.110)。安全组已放行 80/443，两个容器持续运行。HTTP 自动跳转 HTTPS，直接展示应用登录页；未登录访问业务 API 仍返回 401。

已用真实 Chrome 验证登录、新建会话、Agnes SSE、选项提问、自定义回答恢复、手动工具确认、Three.js iframe 生成、Supabase 保存、批准、下载与刷新读取；继续要求修改花瓶颜色时，Agent 重新调用生成工具，产生新的深蓝色模型和 GLB。首次下载 515272 字节，修改后 515276 字节，均校验 GLB 2.0 头和长度。刷新未再次执行上传。测试使用独立账号，不修改用户已有会话。

Studio 使用的原生 /api/observability/traces/light 接口返回 200，能够读取 Supabase Trace，没有 stored.trim 报错。Agent 管理接口仍只在容器内开放。

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

## HTTPS 与应用登录

用户暂无域名，因此使用 https://47.109.49.110。deploy/Caddyfile.ecs 显式设置 Let's Encrypt ACME shortlived profile，申请公网 IP 证书，Caddy 持久卷保存证书并自动续期。无需改成自签证书或去掉登录 Cookie 的 Secure 属性。参考 [Let's Encrypt IP 证书说明](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)。

本次实际证书签发机构为 Let's Encrypt YE2，SAN 为 IP Address:47.109.49.110，首次证书到期时间为 2026-11-24 20:31:54 UTC。Caddy 已取得续期窗口信息并自动管理续期；此日期不是需要用户手工更新的部署截止日期。不要删除 caddy-data 卷，保持 80/443 开放。

浏览器访问裸 IP 通常不发送 SNI，而 Docker 容器看到的本地地址是私网地址。因此全局 default_sni 显式选用 SITE_ADDRESS 对应的公网证书；缺少它时会出现证书已经签发但浏览器 SSL_PROTOCOL_ERROR 的现象。本次通过配置修复，没有关闭证书校验。ECS 容器内部和本机真实浏览器均已验证可信连接。

安全组入方向已允许 TCP 80 和 TCP 443，来源 0.0.0.0/0；保留原 SSH 规则，不开放全部端口。最初因安全组未放行，证书挑战超时，曾暂停 Web 防止重复失败申请；该问题已解决，Web 已恢复。

按用户要求已移除 Caddy 的 Basic Auth 入口验证，不再需要 owner 账号或额外的站点密码，只需使用应用原有账户登录。Server 的签名 Cookie、密码校验和资源归属检查继续生效。服务器运行配置不再需要 DEPLOY_USER、DEPLOY_PASSWORD_HASH；此前本机 ecs-access.txt 中的入口密码已失效。

移除后已用未设置任何 HTTP 认证凭据的新浏览器会话验证：首页直接返回 200 并展示登录表单，未登录的会话 API 仍返回 401，应用账户登录后会话 API 返回 200，已有 GLB 预览正常。

模型 API Key 保存在浏览器 localStorage，按站点来源隔离。原 Cloudflare 地址中的 Key 不会自动出现在新 IP 地址的页面，首次使用需在新页面的模型设置中重新填写；应用账户、会话与资产仍来自同一个 Supabase。最终空闲检查：后端约 304 MiB、Web 约 33 MiB，Docker 开机启动已启用，两个服务均设置 unless-stopped 重启策略。

镜像由 [GitHub Actions](https://github.com/yueqjGithub/gen3D/actions/runs/44241672091) 从 be12437 构建；部署入口配置位于 codex/deploy-node 最新提交，Caddyfile 通过只读挂载更新，无需为网关配置修改重新打包业务镜像。旧 Cloudflare 站点未删除，当前推荐使用 ECS 新入口。未构建 Windows 安装包。
