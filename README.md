# 形构 Agent：3D 资产学习工作台

这是一个面向前端工程师的本地 Agent 学习项目。它通过对话、图片和文档收集 3D 资产需求，生成可审阅的 Blender 4.x Python 脚本；脚本只做静态检查，不会由应用执行。

## 运行要求

- Windows 10/11
- Node.js `>=22.13`（可以继续使用 pnpm 管理的 Node runtime）
- pnpm `12.15.0`
- 首次安装依赖需要可访问 pnpm 配置的 registry

项目使用 pnpm workspace；不要用 npm 安装依赖。

## 快速开始（无需 API Key）

```powershell
pnpm install
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
pnpm --filter @agent3d/desktop exec install-electron
Copy-Item .env.example .env
pnpm dev
```

The Electron npm package and its runtime binary are downloaded separately. The command above uses an Electron-specific mirror for the runtime; use the Tencent npm registry independently if needed with `pnpm config set registry https://mirrors.cloud.tencent.com/npm/`. `install-electron` downloads the runtime binary once; its archive must be reachable from the local network.
根目录 `.env.example` 默认开启 mock 模式，并提供 Hono、Mastra Agent 和 Electron credential broker 的稳定 loopback URL/端口与独立 token。可在此模式演示会话、文档上传、流式回复、推理/工具活动、脚本审阅和审批，无需任何模型 API Key。示例 token 仅供本机开发；共享机器前请替换。`AGENT3D_DATA_DIR` 可留空使用平台默认目录，也可设置统一的数据根目录；相对路径相对于当前用户的 home 目录。

`pnpm dev` 通过 pnpm workspace 并行启动三个独立进程：Mastra Agent (`127.0.0.1:62687`)、Hono API (`127.0.0.1:62586`) 和 Electron + Vite（renderer 固定为 `http://localhost:5173`）。Electron main 另外托管只绑定 `127.0.0.1:62588` 的安全凭据 broker。三个 workspace 脚本会各自读取根目录 `.env`；它们不互相启动或监督。若 Hono 在 Agent/broker 之前接到请求，会返回可重试的上游不可用错误。

如需使用真实聊天模型，把 `.env` 中的 `AGENT3D_MOCK_MODE` 改为 `false`，然后任选一种凭据配置方式：

1. 在工作台的「模型设置」中选择聊天模型并保存 API Key。凭据使用 Electron `safeStorage` 加密后保存在当前操作系统的用户数据目录；SQLite 和 renderer 中都不保存明文密钥。
2. 在本机 `.env` 中设置 `AGENT3D_CHAT_API_KEY`，然后重启应用。环境密钥仅作为 Agnes 凭据的开发期备用值；删除 UI 中的已保存密钥后，环境密钥会在本次运行中被禁用，重启后按环境配置再次生效。

默认聊天模型为 `agnes/agnes-3.0-flash`，默认 Base URL 为 `https://apihub.agnes-ai.com/v1`。默认生图模型为 `agnes-image-2.5-flash`；当前项目提供生图模型配置 UI，但尚未实现单独的生图请求流程。不要把真实密钥写入代码、测试数据或提交文件。

## 常用命令

```powershell
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm --filter @agent3d/agent dev
pnpm --filter @agent3d/agent test
pnpm --filter @agent3d/agent typecheck
pnpm --filter @agent3d/agent build
pnpm --filter @agent3d/server dev
pnpm --filter @agent3d/server test
pnpm --filter @agent3d/server typecheck
pnpm --filter @agent3d/server build
pnpm --filter @agent3d/desktop dev
pnpm --filter @agent3d/desktop test
pnpm --filter @agent3d/desktop typecheck
pnpm --filter @agent3d/desktop build
```

- `pnpm dev`：并行启动 Agent、Hono 和 Electron + Vite；使用 `Ctrl+C` 结束 pnpm 管理的进程。
- `pnpm test`：运行共享契约、存储、Agent、API、mock 集成和 renderer 交互测试。
- `pnpm typecheck`：检查所有 workspace TypeScript。
- `pnpm build`：分别构建 Mastra Agent、可直接由 Node ESM 运行的 Hono server，以及 Electron 主进程、preload 和 renderer。
- Agent dev 命令运行 Mastra CLI 默认的 `src/mastra/index.ts` 入口，并加载根目录 `.env`；开发时 Mastra Studio/API 位于 `http://127.0.0.1:62687`。
- 如需在独立终端调试某个进程，可运行对应 workspace 的 `dev` 命令；三个进程始终共用根目录 `.env`。`AGENT3D_AGENT_URL` 必须与 `AGENT3D_AGENT_PORT` 对齐，Hono、Agent 和 credential broker token 必须分别一致。
- 桌面应用仅连接配置好的 Hono URL，不再内嵌启动 Hono/SQLite。打包后的 Electron 不监督或启动 Agent/Hono；部署时必须由外部进程管理器先启动这些 loopback 服务。

更完整的环境字段见根目录 [`.env.example`](./.env.example)；[`apps/server/.env.example`](./apps/server/.env.example) 仅作字段参考，日常应从根目录模板创建单一 `.env`。

## Monorepo 结构与职责

```text
apps/desktop
  Electron main ─ BrowserWindow、renderer API token handoff、safeStorage broker
  preload       ─ 只向 renderer 暴露 Hono URL、Hono token 和平台名
  React         ─ AI SDK useChat、会话、附件、资产审批和设置界面
apps/server
  Hono          ─ renderer 唯一 API 网关；拥有 SQLite、附件、偏好和资产持久化
  agent-client  ─ 通过 loopback HTTP 和 Mastra 原生 UI-message SSE 调用 Agent
apps/agent
  Mastra        ─ 原生 server、Agent、工具、模型适配和请求级流式运行
  chatRoute     ─ /chat/:agentId，接收 AI SDK UI messages 并发送 reasoning
packages/shared
  Zod           ─ Hono 与 Agent 共用的 DTO、消息和资产契约及 Blender 静态校验
```

### 本地服务边界

- Hono (`AGENT3D_SERVER_URL`) 和 Mastra (`AGENT3D_AGENT_URL`/`AGENT3D_AGENT_PORT`) 都只绑定 `127.0.0.1`，不监听局域网接口；Electron main 的 credential broker 也只绑定 `127.0.0.1`。
- renderer 只连接 Hono。Electron main 把配置的 Hono URL/token 经 preload `contextBridge` 暴露给 renderer；Agent token 和 broker token 不会传给 renderer。
- Hono 校验配置的 renderer origin 和 `AGENT3D_SERVER_TOKEN`。开发 origin 固定为 `http://localhost:5173`；打包使用 `file:` renderer 时将 `AGENT3D_RENDERER_ORIGIN` 设为 `null`。
- Hono 到 Agent 的 `AGENT3D_AGENT_TOKEN`、Hono 到 Electron broker 的 `AGENT3D_CREDENTIAL_BROKER_TOKEN`、模型 API Key 和附件内容都不会传给 renderer。
- Hono 进程独占 SQLite、附件和会话/偏好/资产 repository；Agent 只处理 Hono 准备好的请求上下文，不访问数据库或桌面存储。
- Electron main 独占 OS `safeStorage` 加密凭据。数据库位于 `<userData>/data/agent3d.sqlite`，附件位于 `<userData>/data/attachments`，加密凭据文件位于 `<userData>/credentials.json`。两进程使用相同平台路径规则；Electron 启动前会验证 `app.getPath('userData')`，路径不匹配会明确失败，不会静默创建第二份数据库。
- 设置 `AGENT3D_DATA_DIR` 可覆盖共享的 `userData` 根目录；目录布局仍为 `data/agent3d.sqlite`、`data/attachments/` 和 `credentials.json`。桌面端与 Hono 都读取同一根目录 `.env`。不要手动提交其中的数据库、附件或凭据。

### Agent 与流式生命周期

以一次 `你好` 对话为例，沿着以下顺序追踪代码：

1. renderer 中的 `useChat`/`DefaultChatTransport` 把最后一条用户消息、会话 ID、幂等 turn ID 和附件引用发给 Hono `/api/chat`。
2. [`apps/server/src/routes/chat.ts`](./apps/server/src/routes/chat.ts) 校验输入并从当前会话的本地附件存储准备文档、图片和偏好；Hono 解析所选模型与凭据。
3. [`apps/server/src/agent-client.ts`](./apps/server/src/agent-client.ts) 把共享请求发送到 `http://127.0.0.1:62687/chat/asset-creation-agent`，附带仅供进程间使用的 Agent token，并使用 Mastra 原生 AI SDK v7 UI-message SSE。
4. Mastra 原生 [`chatRoute()`](./apps/agent/src/mastra/index.ts) 将消息与请求上下文交给 Agent；[`apps/agent/src/asset-agent.ts`](./apps/agent/src/asset-agent.ts)、`prompts/` 与 `tools/` 定义决策、上下文和静态脚本校验。普通问候返回 `chat` 结果，不创建资产。
5. Hono 将安全文本、reasoning 和工具活动适配为 Vercel AI SDK UI message chunks；工具参数/输出不会被转发。Agent 断开时，聊天流明确报告可重试的上游不可用错误。
6. Hono 必须收到唯一且有效的最终结构化结果；只有 `asset` 结果且 Blender 脚本通过共享静态校验时，才创建 `pending` 资产。用户可编辑脚本；每次编辑增加版本并要求重新批准。聊天结果（如 `你好`）不会创建资产。
7. 已批准脚本可以明确下载为 `.py` 文件。静态检查只检测少量危险/明显错误模式，不保证脚本安全或 Blender API 兼容；运行前应在 Blender 中审阅。

模型仅在其配置允许 inline image 时接收本地图片字节生成的 `data:` URL。Agnes 文档说明接受公开可访问的图片 URL，但未说明支持内嵌 data URL；因此默认 Agnes 聊天模型会显式拒绝本地图片，而不会把图片公开上传或静默省略。可在模型设置中选择支持 inline image 的 provider。PDF、Markdown 和纯文本会在 Hono 中本地抽取并受上下文长度限制。

## 分阶段学习路径

1. **共享契约**：阅读 `packages/shared/src`，理解 Zod schema 如何约束 UI/API/storage 边界。
2. **持久化**：阅读 `apps/server/src/storage`，观察 SQLite migration、附件隔离和 turn 幂等。
3. **Agent 与工具**：从 `apps/agent/src/asset-agent.ts`、`runner.ts`、`prompts/` 和 `tools/` 开始，跟踪 prompt、工具、模型适配和结构化输出。
4. **API 与流**：阅读 `apps/server/src/routes/chat.ts`、`apps/server/src/agent-client.ts`、`apps/server/src/streaming/agent-ui-stream.ts` 和 `apps/agent/src/mastra/index.ts`，跟踪 Mastra 原生 UI-message SSE 如何被 Hono 安全适配。
5. **桌面安全边界**：阅读 `apps/desktop/src/main/index.ts`、`src/preload/index.ts` 和 `src/main/credentials.ts`。
6. **React 客户端**：从 renderer 的 `ChatView`、`Composer` 和 `MessageParts` 开始，运行 `pnpm --filter @agent3d/desktop exec vitest run src/renderer/src/features/ui.test.tsx`。
7. **扩展练习**：添加一个需要人工确认的新工具；先写失败测试，再实现共享输入/输出 schema、UI 审批和持久化。

## 安全与隐私说明

- 请勿提交 `.env`、真实 API Key、SQLite 数据库、附件或用户对话内容。
- `.env.example` 仅含本机开发配置占位值；生产主进程不读取 `.env` 文件。
- provider 错误会转成通用、可重试的用户提示；不会把 provider 原始响应体或 API Key 返回给 renderer。
- `AGENT3D_SERVER_TOKEN` 只供 renderer 与 Hono API 验证；`AGENT3D_AGENT_TOKEN` 只供 Agent/Hono 进程共享，`AGENT3D_CREDENTIAL_BROKER_TOKEN` 只供 Electron/Hono 进程共享。
- 不要把生成的 Blender 脚本直接执行。资产审批是用户对该版本的确认，不是安全审计。
