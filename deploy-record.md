# 当前结构与部署记录

更新：2026-11-18。本记录对应本次精简后的 Node + Supabase 工程。2026-11-17 的 Workers 部署经过保存在 [历史记录](docs/history/workers-deployment-2026-11-17.md)，不再作为当前工程的启动方式。

### 2026-11-18 发布准备

当前线上仍为原 agent3d Worker，新 Node 版本尚未切换。新增 deploy/cloudflare 的薄入口，将普通 Node Server/Agent 放在同一个 Cloudflare Container，Web 由静态资源绑定提供，Supabase 继续使用已有项目。它不是新增的业务 workspace package。详细配置见 [容器部署说明](deploy/cloudflare/README.md)。

Cloudflare 账号目前为 Free，Containers API 明确要求 Workers Paid；尚未开通订阅或产生容器费用。本机没有 Docker，因此通过 GitHub Actions 验证 Linux 镜像构建与两个进程启动。工作流只使用虚拟配置，不包含生产密钥。新站点名称为 agent3d-node，验证通过前保留旧站点。

## 1. 当前项目组成

| 目录 | 职责 |
| --- | --- |
| apps/desktop | Electron 外壳、Web/Desktop 共用的 React 界面、iframe 建模与 GLB 导出 |
| apps/server | 普通 Node Hono 服务、鉴权、历史/附件/资产、SSE 编排、GLB 上传 |
| apps/agent | 独立 Node Mastra 服务、提示词、工具、生成 JS/TS、暂停恢复和 Trace |
| packages/shared | HTTP 业务输入、消息和资产类型、模型格式校验 |
| deploy | Docker/Caddy 配置、公开 CA 和环境模板 |

已移出 apps/cloudflare 和兼容性探针。原文件暂放忽略提交的 .verification/retired-workers，便于核对；工作区不再包含 Workers/DO/托管浏览器业务实现。

SQLite 仓库暂留给既有离线测试 fixture。实际 Server 和 Agent 启动只使用 Supabase，不自动新建本地业务 SQLite。没有清空线上已有会话和资产。

## 2. 运行结构

```text
Web / Desktop（同一套 React）
       │ HTTP / SSE
       ▼
Node Hono Server :62586
       │ HTTP /chat/asset-creation-agent
       ▼
独立 Node Mastra Agent :62687
       │
       └─ 模型 API：生成 Three.js 源码

Server + Agent → Supabase PostgreSQL（agent3d schema）
Server → Supabase 私有 Storage（附件和 GLB）

客户端 iframe
  ├─ 执行源码、预览 Three.js
  ├─ GLTFExporter 导出 GLB
  └─ 主页面经 Server 上传 GLB → Supabase
```

不再由 Agent 启动 Chromium，也没有服务端 Playwright 或托管浏览器。Electron 本身提供浏览器渲染能力；Web 使用访问者的浏览器，均不要求用户另外安装建模用 Chromium。

## 3. 从一次输入到模型文件

1. Composer 接收文字、拖拽/粘贴附件，显示缩略图和移除按钮。
2. 发送时先上传附件，取得附件 ID。ChatView 为本轮生成 clientTurnId。
3. POST /api/chat 只携带本轮 UIMessage、attachmentIds、conversationId、模型/API Key 和确认方式。
4. Server 验证登录、来源、会话归属、附件引用和轮次状态。
5. Server 从 Supabase 补齐历史、偏好、文档文本和图片 data URL，发给独立 Mastra HTTP 路由。
6. Agent 通过 RequestContext 选择模型和工具；原生 SSE 文本、推理和工具事件实时返回。
7. generate-three-model 只做 TypeScript 语法转换和脚本准备，返回 source 与预分配的 modelId。工具的 validation=passed 代表源码准备成功，不代表 GLB 已存在。
8. Server 创建 pending 资产，推送 data-asset。React 打开资产面板。
9. 资产面板先请求已保存 GLB；存在则直接预览，不重新执行源码。
10. 若不存在且资产仍 pending，固定 HTML iframe 执行源码，显示模型，再导出二进制 GLB。
11. 主页面收到 GLB 后，POST /api/artifacts/:id/model?expectedVersion=N。iframe 不直接访问 Supabase。
12. Server 校验资产归属、版本、状态、20 MiB 大小、GLB 2.0 头与 JSON 数据块，上传私有 Storage。
13. 保存成功才允许批准；批准后可下载 GLB。刷新或换设备优先读取已保存文件。

修改模型沿用同一路线：历史提供上一版源码，Agent 输出修改后的完整脚本，创建新资产、客户端构建新 GLB。旧模型不被原地覆盖。

## 4. 数据结构及其意义

### 前端提交

```text
conversationId          整段会话
clientTurnId            本轮及其重试；刷新后从历史 metadata 恢复
messages[0]             本轮用户的原生 UIMessage：id、role、parts
attachmentIds           服务端查真实文件的索引
data-attachment part    给界面显示名称、类型、预览地址
model / apiKey          本轮模型配置与凭据
toolApproval            manual 或 auto
```

Server 不把客户端伪造的整段历史直接当真。历史从数据库读取，最多选取最近 39 条有内容的已完成历史，再加本轮消息。失败回复不作为已完成上下文。

### Server 发给 Agent

messages 保持原生 UIMessage，文本在 text part，本轮图片在 file part。agent3d 是应用配置：模型、确认方式、当前文本、文档、图片说明与偏好，进入本次 RequestContext。

模型密钥在可序列化 RequestContext 配置中用占位符替代，真实值经请求期闭包提供；Trace 使用 SensitiveDataFilter。模型密钥不写入模型设置表，也不应打印整个请求体。

Memory 使用 thread/resource 关联会话与用户，设置 lastMessages:false 与 readOnly:true：历史已由 Server 准备，消息已由应用事务写入原生表，不再让 Memory 重复保存内部消息。lastMessages:false 单独使用不会关闭保存。

### 资产描述

```json
{
  "format": "three-script-v1",
  "source": "return makeDog({spots:true});",
  "modelId": "实际文件 UUID"
}
```

该描述被序列化到 artifacts.script。GLB 二进制另存 Storage，不塞进消息、Trace 或 SSE。modelId 标识文件，artifactId 标识待审批的业务资产，二者不同。

源码在 Agent 处由 esbuild 去掉 TS 类型，客户端执行转换后的 JS 函数体。iframe 固定提供 THREE、sculpt、taper、makeDog，不让 Agent 输出任意整页 HTML。

## 5. iframe 执行边界

- build-preview.ts 在前端构建时将 Three.js、几何工具、GLTFExporter 和固定预览代码打成独立 HTML，不依赖外部 CDN。
- iframe sandbox 只开启 allow-scripts，不开启 allow-same-origin、弹窗、表单、下载或 Electron Node 能力。
- 主页面通过 MessageChannel 传源码或 GLB；结果通过私有端口返回。iframe 不接收 API Key、Cookie、Storage Secret。
- CSP 禁止普通外部资源和连接；GLTFLoader 也拒绝外部资源 URL。
- HTML 内的 unsafe-eval 只用于执行生成的 JS，不代表主页面也开启同等权限。
- 导出限制为 1–1000 个网格、最多 50 万顶点、20 MiB GLB。
- 页面关闭或切走资产会销毁 iframe。当前采用客户端超时提示，不保证 iframe 的死循环不会影响浏览器线程；它不是独立操作系统进程的资源配额。
- 执行失败显示错误，用户可把错误交给 Agent 修正。当前没有“客户端错误自动恢复同一次 Agent 工具调用”的隐藏回调链，避免又引入一层复杂编排。

## 6. 人工确认和回答为什么能继续

POST /api/chat 是长响应；POST /api/chat/answer 或 /tool-approval 是独立短请求。

Server 在 pendingQuestions/pendingApprovals Map 保存等待 Promise 的 resolve。短请求校验会话归属、取出回调并调用 resolve，原 streamAgent 的 await 获得结果，再通过 Mastra 原生 resume/approval 协议继续。后续事件仍写入最初的 chat 响应，useChat 不需要重新轮询。

Mastra 快照保存运行状态，Map 保存当前进程中的唤醒函数，两者不是一回事。Server 重启或原连接结束后旧回调可能失效，不能仅凭历史卡片恢复。学习项目当前只运行一个 Server 实例，不直接扩容多副本。

## 7. 刷新和重试

clientTurnId 是业务轮次，不是 Mastra runId。chat_turns 处理：不存在则创建；running 返回冲突；failed 复用原用户消息重试；complete 重放已保存结果，不再调用模型。同一轮次使用不同正文/附件会冲突。

历史查询关联 clientTurnId，前端恢复原用户消息和附件 ID。原生 tool-invocation / step-start 在读取边界转换为历史展示事件，避免之前刷新后 Zod 格式错误。没有通过删除用户历史解决该错误。

客户端 GLB 构建不等于 Agent SSE：聊天可能已经返回“脚本已准备”，资产面板仍在执行或上传，两个状态分别展示。刷新后若 GLB 尚未保存，待审阅资产会重新构建；已保存则直接加载。

## 8. 数据位置

Supabase 项目为 gsgrdwtisfgcjybgkucg；正式 schema 为 agent3d，私有 bucket 也叫 agent3d。

| 数据 | 位置 |
| --- | --- |
| 会话 | Mastra 原生 mastra_threads |
| 消息及原生 UI 历史 | mastra_messages，应用片段放 metadata.agent3d |
| Trace | Mastra PostgreSQL 原生 observability 表，如 mastra_ai_spans |
| 轮次、用户、模型选择、偏好 | chat_turns、users、settings、user_preferences |
| 资产、附件元数据 | artifacts、attachments |
| 上传附件 | Storage attachments/<conversationId>/<attachmentId> |
| GLB 文件 | Storage models/<modelId>.glb |

删除会话先清理相关文件，再删除消息和会话。数据库和文件应分别备份，当前没有定期备份、孤立文件回收或 Trace 自动清理任务。

## 9. 配置和启动

| 实际文件，均忽略提交 | 用途 | 模板 |
| --- | --- | --- |
| 根 .env | 本地 API 地址、Agent 地址、Studio 可选 AGNES_API_KEY | .env.example |
| 根 .env.supabase | 数据库、Storage、公开 CA 绝对路径 | deploy/supabase.env.example |
| 根 .env.server | 登录签名 SESSION_SECRET | deploy/server.env.example |

已有签名密钥已沿用到 .env.server。公开 CA 移至 deploy/supabase-ca.crt，本机配置已更新。Server/Agent 使用 Session pooler 的 5432，少量连接，disableInit:true，TLS 验证不关闭。

```powershell
pnpm install --frozen-lockfile
# 新数据库才需要；当前数据库已经初始化，不必重复执行。
pnpm --filter @agent3d/server db:init

# Electron 模式
pnpm dev

# 或 Web 模式，下面两条在不同终端运行
pnpm --parallel --filter @agent3d/agent --filter @agent3d/server dev
pnpm --filter @agent3d/desktop dev:web
```

Web localhost:5173，Server 127.0.0.1:62586，Agent/Studio 127.0.0.1:62687。Web 与 Electron 开发共用 5173，应选择一种。普通 Agent dev 现在直接使用 Supabase，无需另一个 dev:studio:cloud 命令。

当前机器已把所需 Node 24 代理/证书选项保存在忽略提交的后端配置中，普通启动命令即可使用；下面是新机器可按需设置的终端方式：

```powershell
$env:NODE_OPTIONS='--use-system-ca --use-env-proxy'
$env:NO_PROXY='localhost,127.0.0.1,::1'
```

服务器不要复制本机代理地址。此设置保留 TLS 验证，不能用来绕过模型服务商限流。

## 10. 部署结构与当前迁移状态

当前代码适合普通 Node / Docker，Dockerfile 提供 web、server、agent 三个目标。Compose 使用 Supabase，不再有共享 SQLite 数据卷，也没有 Chromium 安装和浏览器沙箱配置。

```text
HTTPS / Caddy + Web
      → Server:62586
          → Agent:62687
两后端 → Supabase
```

本机尚未安装 Docker，因此不能声称 docker build 或 compose 已验证通过。普通 Node 和 Web 可独立构建验证。

旧站点 https://agent3d.agent3d-workers-compatibility.workers.dev 仍是之前的 Workers 版本，本次没有删除 Worker、Hyperdrive、数据库或切换流量。本地修改不等于线上已更新。

如果继续在 Cloudflare 上运行普通 Node，应选择 Containers，而不是将 Workers 的 Node API 兼容当作完整 Linux Node。Containers 要求 Workers Paid，并有容器用量费用；部署入口仍需少量平台路由配置，但无需重新复制业务逻辑。目前没有开通付费套餐、创建 Container 或配置自动发布。

新部署验证后再处理旧 Worker。GitHub 已有远端，但没有配置 push 自动上线；当前代码修改也尚未自动提交或推送。

## 11. 日志、数据库入口与验证

本地日志看各进程终端；未来容器运行后用 docker compose logs -f server agent。Studio 通过普通 Agent dev 查看同一个云数据库的 Trace。

- [Supabase Table Editor](https://supabase.com/dashboard/project/gsgrdwtisfgcjybgkucg/editor)：schema 选 agent3d。
- [Supabase Storage](https://supabase.com/dashboard/project/gsgrdwtisfgcjybgkucg/storage/buckets)：选私有 agent3d bucket。
- 旧线上日志仍在 Cloudflare 的 agent3d、agent3d-model；不能据本机日志认定旧站点已切换。

本次实际验证结果：

- Node Server 和独立 Mastra 的生产构建已实际启动，Agent API 与云端 Trace light 均为 HTTP 200。
- Node Server、Agent、Web 与 Electron 均构建通过；Electron 是构建产物，不是 Windows 安装包，也未宣称完成 Electron 窗口的专项验收。
- 真实 Chrome：TS 函数体 → sandbox iframe → 犬模型预览 → GLB 导出 → 实际 Supabase 保存 → 批准 → 浏览器下载 → 刷新后复用文件，全部断言通过。GLB 为 4,066,156 字节。
- 同次验证确认 iframe 无法读取父页面 DOM，也没有 Node require；sandbox 只有 allow-scripts。
- 刷新没有再次执行和上传脚本。保存后重新加载服务端 GLB，预览与跨设备文件一致。
- 单独验证了 iframe 内嵌纹理重载：CSP 允许 data/blob 内存资源，仍禁止 HTTP 外部连接。
- 新上传 API 的归属、版本冲突、无效二进制与正常上传回归通过。
- 最终检查：smoke 7、shared 20、Server 55、Desktop/Web 14、Agent 14，共 110 项通过；工作区与 Agent 类型检查通过。实际生产 `/api/agents` 返回 200 和完整的 5 个工具，工具发现不再因缺少 agent3d 而报错，真实模型调用仍要求请求配置。
- 验证记录使用专用账号/会话。最后清理曾遇一次 TLS 连接重置，随后已补做清理，没有修改真实用户会话或旧线上资产。

还修复了真实 Web 开发代理问题：不保活时，同一个 4,066,156 字节 GLB 经过 Vite 代理被截断，界面等待响应结束；加入 Node HTTP Agent keepAlive 后，Node 直连和 Web 代理均完整读取。原本临时怀疑的下载 Blob URL 时序改动已撤回，没有为测试留下未经验证的业务补丁。

Node 打包也做了实际启动校验：共享 workspace TypeScript 必须编译进 Server，不能将所有包都 external 后直接交给普通 Node。修复后的 dist/index.js 已直接运行。

真实模型端到端链路仍与这些确定性验证分开。早前 Agnes 有 429/1015，用户选择保留服务商；本轮验证不主动调用模型消耗额度。

仍需后续处理的边界：客户端无限循环不具有进程级资源隔离；错误目前需用户反馈给 Agent；Server 重启后旧人工回调不能永久恢复；复杂源码的历史上下文长度仍有限；没有自动备份和 Trace/孤立文件清理任务。新线上部署、Docker 运行和付费方案均未执行。

可观测性补充：普通 `/api/agents` 在完全没有请求配置时会尝试推断动态模型，当前严格模型校验仍会产生 LLM 配置警告；工具列表本身已能返回全部 5 个工具。真实聊天由入口提供配置，未为了消除这个发现阶段的警告而给业务请求偷偷使用环境密钥。PostgreSQL 适配器也会提示不支持批量 logs，Trace light 的 HTTP 200 与这些非致命日志分别记录。

参考：[Cloudflare Containers](https://developers.cloudflare.com/containers/)、[Workers Node 兼容](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)、[GLTFExporter](https://threejs.org/docs/pages/GLTFExporter.html)、[iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)。
