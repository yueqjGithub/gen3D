# 形构 Agent：3D 资产学习工作台

这是一个使用 Mastra 构建的本地 Agent 学习项目。用户可以通过对话、图片或文档描述需求；Agent 根据明确的创作意图生成 Blender 4.x Python 脚本，Hono 将结果保存为待审阅资产。脚本只做静态校验，不会由应用执行。

## 运行要求

- Windows 10/11
- Node.js `>=22.13`（可以使用 pnpm 管理的 Node runtime）
- pnpm `12.15.0`

项目使用 pnpm workspace，不要使用 npm 安装依赖。

## 快速开始

首次安装依赖并准备 Electron runtime：

```powershell
pnpm install
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
pnpm --filter @agent3d/desktop exec install-electron
```

Electron npm 包和 Electron runtime 是分开下载的。若默认 Electron 下载地址不可访问，可设置上面的镜像；pnpm registry 镜像则单独设置，例如：

```powershell
pnpm config set registry https://mirrors.cloud.tencent.com/npm/
```

将 Agent 示例配置复制到本地文件：

```powershell
if (-not (Test-Path apps\agent\.env)) { Copy-Item apps\agent\.env.example apps\agent\.env }
```

在工作台的模型设置中选择模型并填写 API Key。密钥按服务商和模型保存在 Electron 客户端的 localStorage 中，不写入服务端设置；发送聊天请求时随请求传给 Server 和 Agent。localStorage 并非加密存储，请仅在可信设备上使用，不要将真实密钥提交到代码仓库。直接使用 Mastra Studio 时仍可在 `apps/agent/.env` 配置 `AGNES_API_KEY`。

启动前，Agent 和 Server 必须使用同一个 SQLite 文件。在 `apps/agent/.env` 中设置共享数据目录的**绝对路径**，例如：

```dotenv
AGENT3D_DATA_DIR=D:\Agent3D\data
```

两个应用都从 `apps/agent/.env` 读取此目录。数据库位于该目录下的 `agent3d.sqlite`，附件位于其 `data/attachments/` 子目录。不要将真实密钥提交到仓库。
不要把数据目录放在 `apps/agent/src/mastra/public`：Mastra 构建时会复制该目录中的文件。

启动 Agent、Server 和 Electron：

```powershell
pnpm dev
```

客户端启动时会先请求 `/api/login`，检查浏览器保存的 `username` Cookie 是否对应已有用户。未登录时输入用户名和密码即可登录；用户名不存在时自动创建用户。登录页面和工作台顶部均可使用用户名、旧密码和新密码修改密码。

Cookie 使用 400 天的有效期（浏览器不支持真正永久有效的 Cookie），登录时重新设置。会话、消息和偏好按用户名关联；模型选择目前仍由本机共享。用户表中的密码为明文，Cookie 也仅包含用户名，二者都只是便于学习的简化实现，不适用于生产环境或多用户安全隔离。

用户表与会话表的外键由 `004-login.sql` 创建；旧版 `agent3d-local` 会话不会自动分配给新用户，已有旧数据可能导致该迁移因外键失败。按本项目当前开发流程使用新数据库；重新建库前请先备份需要保留的数据，不要直接删除有用的库文件。原有的全局偏好表也会保留，但不会自动分配给新用户。

会话和消息使用 Mastra 初始化的 `mastra_threads`、`mastra_messages` 表；附件、资产和重试轮次仍由 Server 的业务表管理。Server 为了把一轮对话的消息和重试状态放在同一个 SQLite 事务中，按当前版本的 Mastra 消息格式直接写入其表，并在聊天时从这些表读取历史、转发给 Agent。Agent 的 Memory 也连接同一数据库，但当前聊天流程不通过 Memory 自动加载或写入消息，避免重复写入。

Server 能读取 Mastra 原生写入的文本和推理片段；尚不能转换的其他原生片段会明确报错，不会静默丢弃。直接操作 Mastra 表依赖当前版本的数据库结构，升级 Mastra 时需要检查兼容性。旧版自建会话表不会自动迁移，检测到旧表时 Server 会拒绝启动；重新建库前请先备份需要保留的文件。

## 服务调用链

```text
Electron / React renderer
  http://localhost:5173
        │ Hono API（无 API token）
        ▼
Hono Server
  http://127.0.0.1:62586
        │ Mastra chatRoute（传模型选择、API Key、消息和请求上下文）
        ▼
Mastra Agent
  http://127.0.0.1:62687
```

三个端口固定，不支持通过环境变量覆盖。桌面 renderer 只访问 Hono；Hono 通过固定 loopback URL 调用 Mastra。Hono 只接受开发 renderer 的 `http://localhost:5173` 和打包后 Electron `file:` 页面的 `null` 或缺省 Origin（需包含 Electron User-Agent），并且只绑定本机回环地址。

Hono 将模型选择、API Key、附件和偏好放在请求体的 `agent3d` 字段；Mastra 聊天路由的中间件将其写入当前请求的 `requestContext`，Agent 按当前请求创建模型。Mastra 的敏感数据过滤器会在持久化追踪前隐藏 `apiKey` 字段。Agent 返回结构化结果，Hono 校验后再展示回复或创建待审批资产；推理和工具活动仍实时显示，最终回复文本在校验完成后显示。

Electron main 只负责桌面窗口和开发者工具菜单，不启动或监督 Agent、Server，也不实现 preload API bridge。打包运行时需要用户或外部进程管理器先启动 Agent 和 Hono。

Desktop 的 React 入口在 `apps/desktop/src/renderer/src/App.tsx`：它管理会话、消息与资产状态。各功能组件直接使用 `api/client.ts` 中的固定本地 API 对象；聊天流由 `ChatView.tsx` 中的 Vercel AI SDK `useChat` 处理，不经过 Electron 主进程。

## 项目功能

- 会话列表、历史消息和 SQLite 持久化。
- 文档与图片附件；具体图片输入能力取决于所选聊天模型。
- 显示 Agent reasoning 和工具活动，支持失败重试与停止生成。
- Agent 只在用户当前消息明确要求创建 3D 资产时才进入资产生成流程；问候、能力咨询、含糊请求或仅上传附件都不会自动生成。
- Blender 脚本经过静态安全校验后，以待审阅资产展示；用户可编辑、批准或拒绝，应用不执行脚本。
- 保存经用户确认的偏好建议。
- 工作台可分别选择聊天模型和生图模型。生图模型选择目前仅保存配置，尚未实现单独的生图请求流程。

## 常用命令

```powershell
pnpm dev
pnpm test
pnpm typecheck
pnpm build

pnpm --filter @agent3d/agent exec vitest run src/mastra
pnpm --filter @agent3d/agent exec tsc --noEmit -p tsconfig.json
pnpm --filter @agent3d/agent build

pnpm --filter @agent3d/server test
pnpm --filter @agent3d/server typecheck
pnpm --filter @agent3d/server build

pnpm --filter @agent3d/desktop test
pnpm --filter @agent3d/desktop typecheck
pnpm --filter @agent3d/desktop build
```

根目录 `pnpm test` 运行 workspace smoke、共享契约和 Server 测试；不会调用计费模型。Agent 测试通过上方的 Vitest 命令运行，Agent 类型检查也需单独执行。三端开发服务器的输出可在各自启动终端查看；Electron 开发版可用 `F12` 打开开发者工具。

## 目录结构

```text
apps/
  agent/    Mastra Agent、直接定义的 instruction/tools、原生 chatRoute
  server/   Hono API、SQLite、附件、会话、偏好和资产审批
  desktop/  Electron 窗口、React renderer 和 Vercel AI SDK useChat
packages/
  shared/   Zod 契约、消息/模型配置和 Blender 脚本静态校验
```
