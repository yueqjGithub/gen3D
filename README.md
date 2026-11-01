# 形构 Agent：3D 资产学习工作台

这是一个面向前端工程师的本地 Agent 学习项目。它通过对话、图片和文档收集 3D 资产需求，生成可审阅的 Blender 4.x Python 脚本；脚本只做静态检查，不会由应用执行。

## 运行要求

- Windows 10/11
- Node.js `>=22.12`（可以继续使用 pnpm 管理的 Node runtime）
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
`.env.example` 默认开启确定性的 mock 模式。可在此模式演示会话、文档上传、流式回复、推理/工具活动、脚本审阅和审批。mock 产物只是学习用的演示脚本。

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
```

- `pnpm dev`：启动 Electron + Vite 开发环境。应用会先启动仅监听 `127.0.0.1` 的 Hono API，再打开 renderer。
- `pnpm test`：运行共享契约、存储、Agent、API、mock 集成和 renderer 交互测试。
- `pnpm typecheck`：检查所有 workspace TypeScript。
- `pnpm build`：构建 Electron 主进程、preload 和 renderer。生产构建不依赖 `.env`；首次运行仍需要在设置页配置凭据，或通过安全的运行时环境注入。

如需使用服务器包的环境变量示例，可参考 [`apps/server/.env.example`](./apps/server/.env.example)。桌面开发时以仓库根目录 `.env` 为准。

## 架构

```text
apps/desktop
  Electron main ─ safeStorage、SQLite、127.0.0.1 随机端口、每次启动随机 token
  preload      ─ 只向 renderer 暴露 API URL、token 和平台名
  React        ─ AI SDK useChat、会话、附件、资产审批和设置界面
apps/server
  Hono         ─ 会话、聊天流、附件、凭据/模型、偏好和资产 API
  Mastra       ─ 按请求解析的模型与资产 Agent / 工具
packages/shared
  Zod          ─ API、消息、模型和资产的共享契约
```

### 本地服务边界

- Hono 仅绑定 `127.0.0.1` 上由操作系统分配的随机端口，不监听局域网接口。
- 每次 Electron 启动都会生成新的高熵 API token。preload 通过 `contextBridge` 只公开本地 API 地址和 token；renderer 无 Node.js 集成。
- Hono 对 API 请求校验当前 renderer origin 和 token。生产 `file:` renderer 使用 `null` origin，并仍要求 token。
- 数据库、附件和 OS 加密凭据保存在 Electron 的 `userData` 目录。不要手动提交该目录内容。

### Agent 与流式生命周期

1. renderer 使用 Vercel AI SDK `useChat` 和 `DefaultChatTransport` 发送最后一条用户消息、会话 ID、幂等 turn ID 及附件引用。
2. Hono 校验所有输入；附件只从当前会话的本地存储读取，不会被上传到公开文件主机。
3. Agent 按所选 provider、模型和凭据创建 Mastra model adapter；模型凭据不写入全局环境变量。
4. Mastra 文本、provider 提供的 reasoning 和工具活动被转换为 AI SDK UI message stream。服务端先记录用户 turn，结束时只持久化一次 assistant turn；相同 turn ID 的重试不会重复创建用户消息。
5. 结构化结果通过共享 Zod schema 校验后创建 `pending` 资产。用户可编辑脚本；每次编辑增加版本并要求重新批准。
6. 已批准脚本可以明确下载为 `.py` 文件。静态检查只检测少量危险/明显错误模式，不保证脚本安全或 Blender API 兼容；运行前应在 Blender 中审阅。

模型仅在其配置允许 inline image 时接收本地图片字节生成的 `data:` URL。Agnes 文档说明接受公开可访问的图片 URL，但未说明支持内嵌 data URL；因此默认 Agnes 聊天模型会显式拒绝本地图片，而不会把图片公开上传或静默省略。可在模型设置中选择支持 inline image 的 provider。PDF、Markdown 和纯文本会在本地抽取并受上下文长度限制。

## 分阶段学习路径

1. **共享契约**：阅读 `packages/shared/src`，理解 Zod schema 如何约束 UI/API/storage 边界。
2. **持久化**：阅读 `apps/server/src/storage`，观察 SQLite migration、附件隔离和 turn 幂等。
3. **Agent 与工具**：从 `apps/server/src/agent/asset-agent.ts` 和 `tools/` 开始，跟踪 prompt、工具和结构化输出。
4. **API 与流**：阅读 `apps/server/src/routes/chat.ts` 和 `streaming/mastra-ui-stream.ts`，对照 AI SDK UI message stream。
5. **桌面安全边界**：阅读 `apps/desktop/src/main/index.ts`、`src/preload/index.ts` 和 `src/main/credentials.ts`。
6. **React 客户端**：从 renderer 的 `ChatView`、`Composer` 和 `MessageParts` 开始，运行 `pnpm --filter @agent3d/desktop exec vitest run src/renderer/src/features/ui.test.tsx`。
7. **扩展练习**：添加一个需要人工确认的新工具；先写失败测试，再实现共享输入/输出 schema、UI 审批和持久化。

## 安全与隐私说明

- 请勿提交 `.env`、真实 API Key、SQLite 数据库、附件或用户对话内容。
- `.env.example` 仅含开发配置占位值；生产主进程不读取 `.env` 文件。
- provider 错误会转成通用、可重试的用户提示；不会把 provider 原始响应体或 API Key 返回给 renderer。
- 不要把生成的 Blender 脚本直接执行。资产审批是用户对该版本的确认，不是安全审计。
