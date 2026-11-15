# Agent3D 项目交接摘要

本文供接手项目的 Agent 快速了解当前架构、关键约定、功能状态和待办事项。项目面向学习 Agent 开发，优先保持代码直接、易读，避免过度封装。不要把任何 API Key 或其他密钥写入本文、代码或提交记录。

## 项目目标

这是一个本地运行的 Agent 学习工作台。用户可通过文字、图片或文档与 Agent 对话；在用户明确要求创建 3D 资产时，Agent 生成 Blender 4.x Python 脚本。Server 会校验脚本并将资产放入待审批状态，应用本身不执行 Blender 脚本。

技术栈：

- pnpm workspace monorepo，当前 `pnpm@12.15.0`；Node.js `>=22.13`
- Agent：Mastra
- API Server：Hono
- 桌面端：Electron + React + Vite + Sass
- 流式聊天：Vercel AI SDK `useChat`
- 数据库：Mastra 与 Server 共用 SQLite
- 共享契约及校验：`packages/shared`，使用 Zod

## 应用结构与固定地址

```text
apps/agent/    Mastra Agent、原生 chatRoute、模型动态选择
apps/server/   Hono API、SQLite、登录、会话、附件、偏好、资产审批
apps/desktop/  Electron 主进程与 React renderer
packages/shared/  Agent/Server/客户端共享的 Zod 契约和校验
```

应用之间的本地调用关系：

```text
React renderer / Electron
  http://localhost:5173
          │
          ▼
Hono Server
  http://127.0.0.1:62586
          │
          ▼
Mastra Agent
  http://127.0.0.1:62687
```

端口固定，不要引入动态端口或额外服务发现。Electron 主进程只负责创建窗口和开发者工具，不托管 Agent 或 Server；开发时由 workspace 并行启动三个应用。打包运行时需另行保证 Agent 和 Server 已启动。

## 开发环境与数据

项目使用 pnpm，不要用 npm 安装依赖。

常用命令：

```powershell
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

Agent 的测试和类型检查需单独执行：

```powershell
pnpm --filter @agent3d/agent exec vitest run src/mastra
pnpm --filter @agent3d/agent exec tsc --noEmit -p tsconfig.json
pnpm --filter @agent3d/agent build
```

单应用验证：

```powershell
pnpm --filter @agent3d/server test
pnpm --filter @agent3d/server typecheck
pnpm --filter @agent3d/server build
pnpm --filter @agent3d/desktop test
pnpm --filter @agent3d/desktop typecheck
pnpm --filter @agent3d/desktop build
```

Agent 和 Server 必须连接同一个 SQLite 文件 `agent3d.sqlite`。`AGENT3D_DATA_DIR` 应设为绝对路径；数据库放在该目录根部，附件在 `data/attachments/`。不要把数据目录放进 Mastra `public`，构建时该目录会被复制。

**配置路径需要接手时优先核实：**当前 workspace 的 Agent、Server dev 命令都从仓库根目录读取 `../../.env`（Server 使用 Node `--env-file-if-exists`，Agent 使用 dotenv）；示例模板位于 `apps/agent/.env.example`，README 中也有“复制到 `apps/agent/.env`”的说明，和脚本读取位置可能不一致。修改配置流程前先以实际启动链路验证，不要覆盖现有根目录 `.env`。工作区存在本机 `.env`，不要读取、展示或提交其中的密钥。

仓库根目录 `pnpm test` 执行 smoke、shared、desktop 和 server 测试；Agent 需用上述单独命令。测试默认不调用真实计费模型。

## 当前功能与数据流

### 登录与用户数据

- 客户端启动时请求 `/api/login` 检查 username Cookie。
- 当前学习项目采用简化登录：不存在的用户名在登录时自动创建；登录与工作台均可修改密码。
- 会话、消息、偏好按 username 关联；模型选择配置在本机共享。
- 密码明文保存，Cookie 仅包含用户名。这只是学习实现，不具备生产环境的认证安全性，不要当作可部署的多用户认证方案。
- 用户和偏好迁移位于 `apps/server/src/storage/migrations/004-login.sql`、`005-user-preferences.sql`。

### 模型与 API Key

- 客户端的 React Context 管理模型选择和各模型 API Key；Key 使用 localStorage 保存，键按 provider/model 区分。
- API Key 不写入 Server 设置或业务数据库；发送聊天请求时随请求经 Server 转发给 Agent。
- Agent 根据 Mastra `requestContext` 中的本次请求配置动态选择模型。Mastra Studio 可走本地环境变量配置。
- localStorage 不加密，请只在可信设备使用。不要在日志或测试输出里打印密钥；测试应使用虚构 Key。
- 当前默认 Agnes；provider 和模型目录在 `apps/server/src/config/provider-catalog.ts`、`packages/shared/src/models.ts` 等位置。

### 聊天、会话与流式输出

- 会话和消息统一使用 Mastra 的 `mastra_threads`、`mastra_messages` 表。
- Server 为保证单轮消息与重试状态的事务性，直接读写当前版本 Mastra 建立的消息表。升级 Mastra 时要核查数据库格式是否兼容。
- Mastra Memory 连接共享存储，但当前聊天流程由 Server 显式读取历史，并不同时通过 Memory 自动读写，避免重复保存。
- Desktop 的 `ChatView.tsx` 通过 AI SDK `useChat` 连接 Hono。聊天请求只发送本轮最后一条用户消息；Server 从数据库读取最近的已完成历史消息后构造 Agent 上下文。
- `clientTurnId` 用于幂等与失败重试；已完成的重试会重放已保存回复，失败轮次允许复用该 ID 重试。
- Agent 返回 SSE。Server 会校验结构化输出，推理和工具活动实时转发；回复文本通过 `extractStreamedReply` 从结构化 JSON 的 `reply`/`brief` 字段提取并增量转发，不应透传原始结构化 JSON 或 Blender 脚本。
- Server 流式提取逻辑及其分片测试在 `apps/server/src/routes/chat.ts`、`apps/server/src/routes/api.test.ts`。目前测试用模拟 SSE 验证分片提取；真实模型端到端输出仍需实际确认。
- 最近的 Desktop 布局修改在 `apps/desktop/src/renderer/src/styles.scss`：桌面页面本身不滚动，消息区域独立滚动，输入框固定在聊天区底部；窄窗口改为内容区滚动。
- `ChatView.tsx` 在消息列表变化时将消息滚动到底部；流式输出期间如果用户向上查看历史，也会被拉回底部。

### 3D 资产、附件与偏好

- 图片和文档经 Server 上传并存储，Agent 的请求上下文获得提取后的文档文本、图片和用户偏好。
- 仅用户当前消息明确要求创建 3D 资产时，Agent 才进入资产生成流程；单纯问候、询问能力、上传附件或含糊表述不应自动生成。
- Agent 生成 Blender 脚本后，shared/Server 做静态校验；应用不执行脚本。
- 资产以待审批方式保存；用户可编辑、批准或拒绝。偏好建议需经用户确认后才持久化。
- 生图模型选择配置目前存在，但单独的生图请求流程尚未实现。

## 近期代码改动交接

最近几轮涉及的变更尚未提交，主要包括：

- 简化 Agent、Server、Desktop 结构和交互，移除旧 credential broker、preload bridge、旧数据目录封装及旧工具等实现；相关文件在 `git status` 中可见为大量修改、删除和新增。
- Desktop 模型设置与 Context/localStorage、聊天请求模型和 Key、Agent 动态模型。
- 登录界面与 Server 登录 API、用户关联数据。
- 聊天列表布局、自动滚动和请求仅携带当前用户消息。
- Server 结构化回复文本的 SSE 增量转发。
- README、测试、迁移和计划文档更新。

工作区当前处于**大量未提交改动**状态。接手时先查看 `git status --short` 与针对目标文件的 diff；不要运行 `git reset`、`git checkout`、`git clean` 或其他会丢弃改动的命令，也不要假设所有删除都是可恢复的旧代码。未经用户要求，不要提交。

## 当前待办与验证注意事项

仓库根目录已有 `TODO.md`，当前记录的调查事项：

1. 单独启动 Agent，比较正常记录的 Reply 与 Agent3D 保存的 Reply，调查 Mastra trace 失败原因。
2. 对比相同请求在 Mastra Studio 和 Agent3D 中的回复。

TODO 中提到重建数据库；操作任何数据库文件前应先确认路径并备份，优先使用隔离测试数据目录，不能直接删除用户数据库。

最近一次记录的验证情况（如继续修改，请重新运行对应命令）：

- Server 流式聊天相关测试：12 项通过，Server TypeScript 检查通过。
- Desktop 测试：4 项通过；类型检查与构建通过。
- Agent 动态模型和资产意图相关测试：21 项通过；Agent 类型检查、构建曾通过。
- Agent 另有 `src/mastra/index.test.ts` 配置测试失败：断言预期 `.env` 的错误提示，但测试环境收到 `AGENT3D_DATA_DIR in undefined`。这与模型设置功能无关，尚未处理。
- 全量验证曾受本机固定端口占用、并行 Vitest 缓存竞争等环境问题影响；遇到端口冲突不要擅自停止不明进程，可先确认监听 PID 和命令行，再隔离运行。
- Electron Vite 构建可能提示 `preload config is missing`；当前项目没有 preload，提示本身不一定影响构建退出码。

## 重要文件入口

- `README.md`：安装、配置、服务链路和功能说明；注意核对配置文件路径的说明是否与脚本一致。
- `TODO.md`：当前 Mastra Reply/trace 对比调查。
- `apps/agent/src/mastra/agents/agent.ts`：Agent instruction、工具、动态模型和 structured output。
- `apps/agent/src/mastra/index.ts`：Mastra 实例、共享 SQLite、固定端口、原生 chatRoute 和敏感数据过滤。
- `apps/server/src/index.ts`：Hono 启动、固定地址、共享数据库和仓库初始化。
- `apps/server/src/routes/chat.ts`：聊天请求校验、历史消息构造、重试幂等和 SSE 转发。
- `apps/server/src/storage/conversations.ts`：Mastra 会话/消息表的读取与事务性写入。
- `apps/desktop/src/renderer/src/App.tsx`：React 工作台及主要状态。
- `apps/desktop/src/renderer/src/features/chat/ChatView.tsx`：AI SDK 聊天、模型参数、请求与消息滚动。
- `apps/desktop/src/renderer/src/features/settings/ModelContext.tsx`：模型选择和本地 API Key 状态。
- `apps/desktop/src/renderer/src/styles.scss`：整体布局与样式。
- `packages/shared/src/`：跨应用契约、模型类型、消息结构和脚本校验。

## 给接手 Agent 的建议

先确认用户当前要继续的具体目标，不要顺手重构其他模块。开始改代码前查看相关实现、测试和工作区 diff；保持固定端口、Mastra 原生 chatRoute、Server 作为桌面端与 Agent 的中间层等既有约定。每个改动优先跑最小相关测试，再按需做类型检查和构建。涉及真实模型时由用户本地 Key 调用；不要在日志、文档、测试快照或答复中回显密钥。


## 2026-11-12 通信与展示调整

- Agent 使用普通文本流，不再配置 structuredOutput。工具参数仍由 Zod 声明，这是模型调用工具的必要描述，不用于重新包装聊天回复。
- Server 保留 AI SDK 原生文本、文件、工具事件。工具和图片事件以 ui-chunk 容器原样保存；Desktop 使用 readUIMessageStream 恢复历史工具状态。
- generate-blender-script 校验通过后的工具输出用于创建待审批资产；应用仍不执行 Blender。
- Studio 恢复建模工具，普通回复、代码、工具输出可用原生 trace 检查。
- Desktop 支持代码围栏（含尚未闭合的流式围栏）、Markdown 图片、原生 file 图片和工具输入/输出。用户上翻时停止自动滚到底部。
- 验证：Agent 21 项、Server API 11 项、Desktop 原有 4 项和新增消息展示 2 项通过。Agent 类型检查通过。Server/Desktop 完整类型检查仍有原有测试断言类型等错误。
- 尚未调用真实模型、运行 Blender 或在 Studio 界面确认 trace；不要把静态脚本校验当作 Blender 运行验证。


## 2026-11-12 最终验证

- pnpm typecheck 与 Agent 单独 tsc 均通过。之前的继承类型缺失来自受限执行环境对 pnpm 符号链接的解析；在正常权限下依赖与类型正常，无需改写业务 API 或屏蔽测试文件。
- 根测试 79 项通过（smoke 7、shared 16、server 50、desktop 6）；Agent 22 项另行通过，共 101 项。
- pnpm build 三个应用均构建成功。Electron 提示缺少 preload（工程未使用 preload）；Mastra 遥测证书提示不影响构建退出码。
- 实际 Studio 和 Desktop 均调用 Agnes 生成树木 Blender Python 脚本。Studio trace 详情正常，包含 analyze-input、build-asset-brief、generate-blender-script 工具 span，无浏览器异常和失败接口。
- Desktop 实际验证图片上传、图片加载、代码块、工具输入输出、待审阅资产，以及刷新后内容和顺序一致。图片预览接口校验会话归属，新增测试覆盖越权访问。
- 验证输出 .verification/generated-tree.py；截图与独立验证数据库位于 .verification/，已忽略，不提交浏览器状态或验证数据。未安装、调用 Blender。
- 本机 Node 默认信任库无法验证模型站点证书。真实验证通过在 PowerShell 中设置 $env:NODE_OPTIONS='--use-system-ca' 后启动 Agent 完成，没有关闭 TLS 校验。该环境设置仅作用于当前进程，不写入现有 .env。


## 2026-11-12 Three.js 预览与消息布局

- 默认生成 generate-three-scene 工具的 three-primitives-v1 场景数据，支持 box/sphere/cylinder/cone/torus，Y 轴朝上。ModelPreview.tsx 集中处理几何体、灯光、自动对焦、OrbitControls、尺寸变化和资源释放。
- 资产仍复用现有表和 script 内容字段（新资产保存 JSON）；旧 Blender 脚本继续可读、审批和下载，不重建数据库。旧 blender_version 字段为兼容旧数据库保留，界面根据内容显示 THREE.JS 或 BLENDER。
- 新资产可预览、旋转、缩放、编辑完整场景 JSON、审批并下载 .json。下载数据为本项目的基础几何体场景格式；如何转换为 Three.js Mesh 直接参考 ModelPreview.tsx，不是任意 HTML/JavaScript，也不是 GLB。
- 修改模型时把上一轮工具输出作为普通历史上下文发送，并开放修改意图，避免生成斑点时丢失原模型。聊天 SSE 保持原生透传。
- 修复 Grid/Flex min-width 导致的长文本和工具 JSON 横向溢出；代码块支持折行。submitted 阶段和空 assistant 消息分别显示连接提示/思考提示。
- 实际浏览器验证：生成白色小狗 → 添加黑色斑点 → 预览画布正常 → 刷新场景一致。验证消息区 scrollWidth 不超过 clientWidth，无浏览器异常。截图在 .verification/three-dog.png 和 .verification/three-dalmatian.png。


## 2026-11-12 脚本建模 → GLB（替代基础几何体 JSON 路线）

- Agent 默认使用 generate-three-model，source 为 JS/TS 函数体，THREE 已注入，返回 Group/Mesh；支持自定义顶点、曲面、拉伸、旋转成型、CanvasTexture。
- 实现集中于 apps/agent/src/mastra/tools/generate-three-model.ts：esbuild 转译与浏览器运行库打包；一次性 Chromium 页面禁止网络，无登录态，不暴露 Node；GLTFExporter 导出 GLB 至共享数据目录 models。执行错误返回给 Agent 修复，15 秒超时关闭浏览器。
- 流中只返回 {format: three-script-v1, source, modelId} 的资产描述，不传输 GLB 二进制，不改变 AI SDK 原生事件。
- Server 使用按会话鉴权的 /api/artifacts/:id/model 提供预览文件；批准后下载接口返回同一 GLB。不能单独编辑已执行脚本而继续引用旧文件，修改通过聊天重新执行生成。
- Desktop 的 ModelPreview.tsx 使用 GLTFLoader，不执行脚本，支持 OrbitControls、自动对焦和资源释放。
- 按用户明确要求清空现有资产：删除 1 条资产和 1 处消息资产引用，保留会话及普通消息。原数据库备份：.verification/before-clear-assets-1794494491881.sqlite。验证请求使用独立目录，未往已清空的实际资产库插入测试资产。
- 实测：TypeScript 自定义旋转曲面导出有效 GLB；脚本错误反馈；无限循环超时中止；Node 环境不可访问；真实 Agent 生成花瓶 → Desktop GLB 预览 → 批准 → 下载 → 刷新恢复全部通过。示例模型 .verification/generated-vase.glb，截图 .verification/glb-vase.png。

## Three.js 造型与材质

- 建模工具额外注入 `sculpt`（相交体积融合成连续曲面）、`taper`（截面沿曲线变化）和 `THREE.RoundedBoxGeometry`（硬表面倒角）。工具输入仍然是一个 `source` 函数体，导出文件可直接交给 GLTFLoader。
- 站姿短毛犬提供可读的程序化起点 `makeDog`，实现位于 `apps/agent/src/mastra/tools/dog-model.ts`。耳根和尾根是各部件的旋转中心；斑点用模型空间距离配合内嵌色带着色，变换观察角度时花纹随表面移动。
- Desktop 在本地生成环境光贴图，对模型最低点设置接影面，并按面板宽高取景。照明与地面只用于审阅。
- 用真实 Agent 生成了带红项圈的黑白斑点狗。将它给出的同一段脚本用最终工具导出，在 Desktop 的 ModelPreview 中检查了两个角度。示例为 `.verification/sculpt-dog.glb`，截图为 `.verification/sculpt-preview.png`。另行验证了通用曲面、变截面管和倒角机壳都能独立导出。
