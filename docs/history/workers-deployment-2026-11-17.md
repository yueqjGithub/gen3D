# 形构 Agent：项目结构、数据流与部署记录

记录日期：2026-11-17，Asia/Shanghai。本文对应当前工作区代码，以及当晚已经发布的 Cloudflare 版本。

这份文档按“先看全貌，再顺着一次请求读代码”的方式组织。示例中的 ID 和密钥占位符仅用于解释，不能直接用于请求。文档不包含数据库密码、数据库完整连接串、模型密钥或 Worker Secret 的值。

## 1. 当前状态与阅读导航

目前项目已经从“本机 Electron + Hono + Mastra”扩展为同时支持本地客户端和公网 Web 的工程。两种环境复用 React 界面、Hono 业务路由及 Agent 定义，分别使用适合运行环境的存储和建模工具。

正式 Web 地址：<https://agent3d.agent3d-workers-compatibility.workers.dev>。

| 要了解什么 | 阅读位置 |
| --- | --- |
| 各目录的用途、从哪里读代码 | 第 2 节 |
| 本地与线上分别运行在哪里 | 第 3 节 |
| 一条聊天消息经过哪些步骤 | 第 4 节 |
| HTTP、消息、工具和资产的数据结构 | 第 5 节 |
| 为什么回答问题的独立请求能让聊天继续 | 第 6 节 |
| Three.js 脚本怎样变成 GLB | 第 7 节 |
| 刷新、重试和幂等 | 第 8 节 |
| 数据表、文件和 Trace 保存在哪里 | 第 9 节 |
| 已部署的资源、配置与重新发布步骤 | 第 10–12 节 |
| 看日志、看数据库、排查问题 | 第 13 节 |
| 实际验证结果、免费额度与剩余限制 | 第 14–16 节 |

需要先明确当前完成程度：站点发布、登录与业务存储、原生暂停/恢复兼容性、托管浏览器生成 GLB、Web 预览和下载、刷新后重试均有验证记录；**不能把这些独立验证理解成“真实模型从需求到生成、再修改模型的整条线上链路已经全部验收”**。真实模型联调曾遇 Agnes 的 429 / Cloudflare 1015；后续线上记录已出现工具调用，但本次修复没有再次主动调用真实模型确认整条链路。详细边界见第 14 节。

旧的 `README.md`、`docs/cloudflare-compatibility.md` 和部分源码注释保留了早期阶段描述，例如仅使用本地 SQLite、原生工具消息尚不支持、Supabase 尚待配置、旧 Blender 下载流程。理解当前公网部署时，以本记录、当前源码和云端资源为准。

## 2. 项目组成

### 2.1 目录与职责

```text
D:/learn/
├─ apps/
│  ├─ desktop/                   Electron 外壳 + 共用 React 界面
│  │  ├─ src/main/               Electron 窗口入口
│  │  ├─ src/renderer/src/       Web/Desktop 共用的界面和 API 调用
│  │  ├─ vite.web.config.ts      单独构建浏览器版本
│  │  └─ out/web/                Web 构建产物，忽略提交
│  ├─ server/                    Hono 业务 API、本地存储及公共聊天编排
│  │  └─ src/
│  │     ├─ app.ts               注册来源校验、登录、归属校验和业务路由
│  │     ├─ routes/              聊天、会话、附件、资产、设置、登录等 API
│  │     ├─ agent-client.ts      发送 Agent 请求、消费 SSE、处理暂停与恢复
│  │     ├─ attachments/         图片转 data URL、文档提取
│  │     └─ storage/             SQLite 仓库、原生消息读取及业务表管理
│  ├─ agent/                     Mastra Agent 定义及本地运行入口
│  │  └─ src/mastra/
│  │     ├─ index.ts             本地 Mastra / Studio、存储、Trace 与 chatRoute
│  │     ├─ agents/agent.ts      提示词、动态模型、工具、审批策略
│  │     └─ tools/
│  │        ├─ generate-three-model.ts  本地 Playwright 执行和导出
│  │        ├─ model-runtime.ts         共用浏览器建模运行库
│  │        └─ dog-model.ts             内置狗模型的几何和花纹实现
│  └─ cloudflare/                公网环境的运行入口和部署配置
│     ├─ src/index.ts           Web 网关、AppSession DO、复用 Hono 与 Mastra
│     ├─ src/model-worker.ts    私有建模 Worker、ModelJob DO、托管浏览器
│     ├─ src/storage.ts         PostgreSQL 仓库与 Supabase 私有文件读写
│     ├─ scripts/               运行库构建、数据库初始化、Secret 文件准备
│     ├─ certs/supabase-ca.crt   公开的 Supabase CA 证书，不是私钥
│     ├─ wrangler.jsonc         主 Worker 配置
│     ├─ wrangler.model.jsonc   建模 Worker 配置
│     └─ generated/             构建出的浏览器运行库，忽略提交
├─ packages/shared/             两端共用类型、Zod 入参校验和模型格式校验
├─ scripts/cloudflare-compatibility/  独立兼容性探针，非正式站点入口
├─ deploy/                      Supabase 配置模板、容器辅助文件
├─ docs/                        之前的数据流与部署说明
├─ Dockerfile / compose.yaml    另一条常驻服务器部署路线，当前线上未使用
├─ .verification/               本机验证脚本、截图和临时状态，忽略提交
├─ .env                         本地运行配置，忽略提交
├─ .env.supabase                本机云数据库/Storage 配置，忽略提交
├─ .env.cloudflare              会话签名与内部服务密钥，忽略提交
└─ deploy-record.md             本文
```

### 2.2 几个容易混淆的名字

- **Desktop**：Electron 窗口和其中的 React 页面。聊天请求由 React 直接发往 API，不经过 Electron 主进程。
- **Web**：同一套 React 页面经 Vite 单独构建的浏览器版本，并非另写了一套前端。
- **Server**：`apps/server` 中的业务逻辑。它在本地以 Node HTTP 服务运行，在线上被导入 Worker 的 Durable Object 中运行。
- **Agent**：`createAssetAgent(...)` 创建的 Mastra Agent。它负责选择工具和生成脚本，不负责登录、会话归属或资产审批记录。
- **模型服务商**：例如 Agnes，提供大语言模型 API；它与导出 GLB 的“建模服务”是两个不同的服务。
- **建模运行库**：Three.js、GLTFExporter、`sculpt`、`taper`、`makeDog` 等代码。它执行模型写出的 JS/TS 函数体，输出实际模型文件。
- **Studio**：Mastra 的开发和追踪查看界面。当前通过本机启动读取云数据库，没有把 Studio 管理界面公开到公网。

### 2.3 关键依赖版本

以下来自当前工程清单，用于将来查文档、升级和排查兼容性，不代表应立即升级：

| 依赖 | 当前声明版本 |
| --- | --- |
| pnpm | 12.15.0 |
| Node.js | 工程要求 >= 22.13.0，本次部署机使用 Node 24 |
| `@mastra/core` | 1.83.0 |
| `@mastra/ai-sdk` | 1.12.0 |
| `@mastra/pg` | 1.36.0 |
| `ai` | 7.0.159 |
| `@ai-sdk/react` | 4.0.163 |
| React | 19.3.1 |
| Three.js | 0.187.0 |
| Hono | 4.13.14 |
| Wrangler | 4.162.0 |
| `@cloudflare/playwright` | 1.4.0 |

部分 `package.json` 使用 `^`，实际安装结果还应结合 `pnpm-lock.yaml`。Mastra 升级尤其要检查原生消息表结构、工具暂停协议、存储适配器与 Trace 格式。

## 3. 本地与线上运行结构

### 3.1 本地开发

```text
Electron 中的 React 页面 / Web 开发页面
        │ HTTP，开发页面通常为 localhost:5173
        ▼
Hono Node Server：127.0.0.1:62586
        │ HTTP POST /chat/asset-creation-agent
        ▼
本地 Mastra：127.0.0.1:62687
        ├─ 调用 Agnes 等模型 API
        └─ 调用本机 Playwright + Chromium 生成 GLB

Hono 和 Mastra：共用 AGENT3D_DATA_DIR 下的 SQLite
附件和 GLB：保存在本机数据目录
```

`pnpm dev` 启动 Agent、Server 和 Electron 三个开发进程。Electron 主进程只负责窗口，不替用户启动、监督另外两个后端。

桌面客户端的 API 地址来自根目录 `.env` 中的 `AGENT3D_SERVER_URL`，默认是 `http://127.0.0.1:62586`。Web 开发版通过 Vite 的 `/api` 代理访问本地 Server。

普通本地数据目录必须是绝对路径。若单独给 Studio 加载 `DATABASE_URL`，该 Mastra 进程会改用 PostgreSQL；这不等于本地 Hono Server 也切到了云数据库。不要把“本地 SQLite Hono + 云数据库 Studio”当作一套共用会话的完整开发环境。

### 3.2 当前公网结构

```text
用户浏览器
  │ HTTPS：同一个站点域名
  ▼
Cloudflare 主 Worker：agent3d
  ├─ 静态页面、JS、CSS → ASSETS
  └─ /api/* → 网关检查登录签名 → SESSIONS
                                  │ 按用户名定位
                                  ▼
                           AppSession Durable Object
                             ├─ Hono createApp：业务 API 与聊天编排
                             ├─ Mastra：Agent、工具、暂停/恢复、Trace
                             ├─ Agnes 等外部模型 API
                             ├─ DATABASE / Hyperdrive → Supabase PostgreSQL
                             ├─ Supabase Storage HTTPS API → 私有附件与 GLB
                             └─ MODEL_SERVICE：私有 Service Binding
                                         ▼
                              Worker：agent3d-model
                                └─ MODEL_JOBS → ModelJob DO
                                      ├─ 全站单任务执行与每日次数计数
                                      └─ BROWSER → Cloudflare 托管 Chromium
                                           执行 JS/TS → 导出 GLB
```

线上没有单独监听 `62586`、`62687` 的 Node 服务，也没有把 SQLite 文件上传到 Worker。`apps/cloudflare` 直接导入 Hono 路由和 Agent 工厂：**代码仍分目录，运行时合在同一个 AppSession 中**。

主 Worker 同时托管静态 Web 资源，所以当前没有另外创建 Cloudflare Pages 项目。浏览器调用同域 `/api`，无需知道 Supabase Secret、Hyperdrive 地址或私有建模服务地址。

### 3.3 Durable Object 在这里的用途

`AppSession` 的名字是 `user:<用户名>`。同一用户的聊天、工具确认和问题回答会进入同一个对象，从而访问同一组等待中的 Map 和 Promise。未带用户名的登录请求使用 `auth` 对象；初始化逻辑只合并初始化过程，不锁住整次聊天。

`ModelJob` 使用固定名字 `model-jobs`，因此当前所有用户共用一个建模任务执行槽和一份每日计数。另一个任务到来时返回忙碌提示，**当前没有排队系统**。

DO 配置使用 `new_sqlite_classes` 是为了使用 Cloudflare 支持的 SQLite-backed Durable Object。当前只有建模每日计数通过 DO Storage 持久化；聊天正文、用户信息和 Trace 的主存储仍是 Supabase，不能把这两个 SQLite/PostgreSQL 概念混为一谈。

## 4. 一次聊天请求的完整路线

下面按真实执行顺序说明。除特别注明外，Desktop 与 Web 共享这些逻辑。

### 4.1 输入与附件上传

1. `Composer.tsx` 收集输入文字、拖拽文件和粘贴文件。
2. 待发送附件先在输入框中显示预览，用户可移除。
3. 点击发送后，前端逐个调用附件上传 API，取得附件 ID 和元数据。
4. `ChatView.sendMessage` 为这一轮生成 `clientTurnId`，把文字和 `data-attachment` 片段交给 `useChat`。

上传成功只代表附件已保存，尚不代表模型已阅读该附件。真正提供给模型的内容在服务端准备。

### 4.2 前端只发送本轮消息

`DefaultChatTransport.prepareSendMessagesRequest` 组装 `POST /api/chat`。它只发送最后一条用户消息，不把整个聊天窗口原样发送。

这样做有三个用途：请求体不随历史持续增长；历史由服务端已保存的数据决定；服务端可以校验附件属于当前会话。模型设置、API Key 和确认方式通过 ref 读取当前值，避免 transport 闭包一直使用创建时的旧配置。

### 4.3 网关、登录与归属检查

线上先到 `apps/cloudflare/src/index.ts`：网关读取 Cookie，检查签名，将请求转到用户对应的 AppSession。Hono 随后检查请求来源、用户是否存在、会话或资产是否属于当前用户。

本项目的用户存放在自己的 `users` 业务表，**当前没有使用 Supabase Auth**。Supabase 在这里承担数据库与文件存储。

### 4.4 Server 为 Agent 准备上下文

`routes/chat.ts` 执行以下工作：

| 工作 | 意义 |
| --- | --- |
| 校验当前消息及附件引用 | 防止空消息、超长输入、引用其他会话附件 |
| 查询 `chat_turns` | 判断新请求、失败重试、仍在执行或已完成 |
| 校验所选模型 | 使用服务端允许的 provider/model 列表 |
| 读取本轮附件字节 | 模型不能直接访问依赖浏览器 Cookie 的私有预览地址 |
| 图片转 data URL，文档提取为文本 | 把“文件引用”变成模型可消费的内容 |
| 读取已完成历史 | 构建连续对话上下文，排除失败回复和重试时的重复用户消息 |
| 从历史工具输出取源码与答案 | 支持“换成红色”等修改，以及沿用已回答的需求 |
| 读取用户偏好 | 为 `analyze-input` 提供上下文 |
| 登记本轮开始 | 用户消息与轮次状态在事务中写入 |

当前整理最近 39 条已完成且有上下文内容的历史，再加本轮用户消息，最多 40 条。失败回复不当作已完成上下文送给模型。

这里的 Server 并非完全透明的 TCP 代理：登录、附件、历史、幂等和资产是应用自己的职责。需要避免的是重写 Mastra/AI SDK 原生工具协议，而不是去掉必要的业务准备。

### 4.5 调用 Mastra

`agent-client.ts` 将准备好的 `role/content` 组织为原生 UIMessage 的 `role/parts`，图片放进本轮用户消息的 `file` part，应用配置放进 `agent3d`。

- 本地：真正通过 HTTP 请求本地 Mastra `chatRoute`。
- 云端：注入的 `agentFetch` 在同一 AppSession 内调用原生 `handleChatStream`，无需绕一圈公网 HTTP。

云端仍保留请求/响应及流的边界，复用同一个 `streamAgent` 循环。区别只在于它如何调用 Agent，不是维护两份 Agent 流程。

### 4.6 模型选择与工具调用

`createAssetAgent` 根据本次 RequestContext 创建模型连接，Agent 根据提示词和完整上下文选择工具：

| 工具 | 职责 |
| --- | --- |
| `analyze-input` | 返回本轮需求、文档、图片说明和偏好 |
| `ask-user` | 需求不清楚时提供问题和 2–4 个选项，暂停等待回答 |
| `build-asset-brief` | 明确轮廓、比例、结构、材质和风格 |
| `generate-three-model` | 接收完整 JS/TS 函数体，执行并导出 GLB |
| `update-preferences` | 返回偏好建议，由用户确认后保存 |

工具集合在每轮保持可用。默认最多 8 个步骤，工具调用并发数为 1。识别到明确的已有模型修改需求时，首步会要求调用建模工具，降低只回复操作建议而没有重新生成的概率。

### 4.7 SSE 返回与界面展示

`streamAgent` 解析上游 SSE，Hono 将原生文本、推理和工具事件写入浏览器最初的聊天响应。`useChat` 接收事件并更新 `messages`，React 随状态变化重新渲染。

Server 会统一整轮的 `start/finish`，因为一次人工确认可能让 Mastra 产生多段上游响应，但用户应看到同一条助手消息。

成功的建模工具输出还会触发业务步骤：创建 `pending` 资产记录、发送 `data-asset`、更新右侧资产面板。**助手文字中说“已完成”不会自动创建资产**，必须有成功且通过校验的建模工具结果。

等待阶段由前端的 `submitted/streaming` 状态显示 Loading；工具活动与推理使用较小、较浅的文字；正文、Markdown、代码块和图片由 `MessageParts.tsx` 展示。等待人工回答时每 15 秒发送一次 transient 心跳，心跳不进入消息历史。

## 5. 主要数据结构：每层分别携带什么

### 5.1 Desktop/Web → Server

以下是教学用结构示意，UUID 和模型配置需要使用实际合法值：

```json
{
  "conversationId": "会话 UUID",
  "clientTurnId": "本轮 UUID，重试时保持相同",
  "messages": [{
    "id": "客户端消息 ID",
    "role": "user",
    "parts": [
      { "type": "text", "text": "创建一个白色陶瓷花瓶" },
      {
        "type": "data-attachment",
        "data": {
          "id": "附件 UUID",
          "fileName": "reference.png",
          "mediaType": "image/png",
          "url": "/api/conversations/.../attachments/..."
        }
      }
    ]
  }],
  "attachmentIds": ["附件 UUID"],
  "model": {
    "providerId": "agnes",
    "modelId": "agnes/agnes-3.0-flash",
    "baseURL": "https://apihub.agnes-ai.com/v1"
  },
  "apiKey": "仅本轮传递，本文不记录真实值",
  "toolApproval": "manual"
}
```

`data-attachment` 是界面展示需要的文件信息；`attachmentIds` 是服务端查找真实文件的索引，两者用途不同。这里的图片 URL 不是模型访问文件的凭证。

### 5.2 Server 内部的 AgentServiceRequest

```text
conversationId / resourceId     服务端确认过的会话和用户
messages[]                     role + content：已整理的历史与本轮文字
documents[]                    fileName + mediaType + 提取后的 text
images[]                       fileName + mediaType + dataUrl
preferences[]                  key + value
model / apiKey / toolApproval   本轮调用配置
```

这个对象只是服务端为 Agent 收集的调用输入，不是另一种返回流协议。

### 5.3 Server → Mastra

```text
messages[]
  └─ 原生 UIMessage：id、role、parts
       ├─ text：对话文字
       └─ file：本轮图片的 data URL 与 MIME 类型

agent3d
  └─ model、apiKey、toolApproval、latestUserText、documents、images 元数据、preferences

memory
  └─ thread、resource、options: { lastMessages: false, readOnly: true }

恢复时另外携带
  └─ runId、toolCallId、resumeData，或 approval-responded 工具 part
```

`messages` 是模型对话内容；`agent3d` 是应用代码使用的请求配置。RequestContext 本身不会把所有字段自动变成用户提示词，例如文档通过 `analyze-input` 工具结果交给模型。

`lastMessages: false` 只关闭 Memory 自动加载历史，**并不关闭自动保存消息**；`readOnly: true` 才阻止这条业务链路重复保存内部用户/工具消息。应用仍把会话和消息写进 Mastra 原生表，thread/resource 继续关联 Trace 和运行。这里不是开启了另一份会话数据库，也不能依赖这条链路自动更新工作记忆。

### 5.4 返回事件

| 事件 | 用途 |
| --- | --- |
| `start` / `finish` | 本轮助手消息开始与结束 |
| `text-*` | 增量正文 |
| `reasoning-*` | 增量推理展示 |
| `tool-input-*` / `tool-output-*` | 工具入参、执行结果与错误 |
| `tool-approval-request` | 等待允许或拒绝 |
| `data-tool-call-suspended` | 展示待回答的问题 |
| `data-turn` | 告知本轮 `clientTurnId` |
| `data-asset` | 告知新资产记录，联动资产面板 |
| `data-heartbeat` | 保持等待中的连接活跃，不存历史 |
| `error` | 本轮失败提示 |

Zod 继续用于 HTTP 输入、附件限制和业务对象校验；没有为每个原生工具事件另建一套重命名协议。历史读取时的转换发生在存储边界，不修改原生数据库记录和实时事件正文。

### 5.5 资产描述和文件

```json
{
  "format": "three-script-v1",
  "source": "const root = new THREE.Group(); /* ... */ return root;",
  "modelId": "模型文件 UUID"
}
```

上面这个对象被 JSON 序列化后保存在资产的 `script` 字段中。它保存源码及文件索引，**没有把整个 GLB 塞进聊天消息**。

GLB 是二进制文件，可以被 Three.js 的 GLTFLoader 加载。HTML 只是预览页面，不是当前生成模型的交付格式；浏览器预览 GLB 时无需重新执行 Agent 生成的脚本。

## 6. 人工确认、多选项提问为什么能继续原聊天

### 6.1 同时存在一个长响应和一个短请求

```text
请求 A：POST /api/chat
  └─ 响应保持打开，useChat 持续读取
      ├─ 收到问题卡片
      ├─ 暂时等待
      └─ 用户回答后继续收到工具结果和正文

请求 B：POST /api/chat/answer
  └─ 提交 questionId 和 answer
      └─ 服务端调用原等待 Promise 的 resolve，返回 204
```

聊天不是靠轮询“答案有没有变化”来继续，也不是请求 B 的响应流接替请求 A。Server 中原来的异步函数还没结束，`await` 只是让它等待，运行环境仍然可以接收其他 HTTP 请求。

### 6.2 提问恢复的逐步过程

1. Agent 调用 `ask-user`，工具首次进入时没有 `run.resumeData`。
2. 工具 `return run.suspend(question)`，Mastra 保存暂停状态，发出含 `runId/toolCallId` 的暂停事件。
3. Server 先在 `pendingQuestions` Map 登记回调，创建待完成的 Promise，再把问题事件发给前端。
4. 一段上游流结束后，`streamAgent` 执行 `await question.answer`；浏览器的原聊天响应仍保持打开。
5. 用户选择某个选项或自定义输入。两者最终都变成一个 `answer` 字符串。
6. `POST /api/chat/answer` 校验会话归属，删除 Map 登记项，然后调用保存的 `resolve`。
7. 原来的 `await` 获得答案，下一次上游请求带上 `runId/toolCallId/resumeData`。
8. Mastra 恢复运行，再次进入工具时已有 `run.resumeData`，工具直接返回答案。
9. 模型看到工具结果后继续推理或建模，后续事件仍写入请求 A。

`questionId` 当前由 `runId + '::' + toolCallId` 构成。204 只代表答案已接收，不代表模型生成已经成功。

### 6.3 工具审批

审批使用类似的 `pendingApprovals` Map 和 Promise，但提交的是：

```json
{ "approvalId": "Mastra 给出的审批 ID", "approved": true }
```

恢复时通过原生 `dynamic-tool`、`state: approval-responded` 和 `approval` 信息交回 Mastra。

默认 `manual` 要求工具执行前确认；选择 `auto` 会先显示风险提示。`ask-user` 本身不需要再审批一次，但自动确认模式下它仍然等待答案。资产最终的批准/拒绝又是另一层业务审阅，不等于工具执行许可。

### 6.4 为什么云端需要按用户进入同一个 DO

Map 中保存的是 JavaScript 函数引用，不能写入 PostgreSQL 后原样取回来执行。若聊天请求和回答请求落到两个不同的普通 Worker 实例，第二个实例可能找不到第一个实例中的 `resolve`。

AppSession 将同一用户的请求固定到同一个对象，解决当前运行期间的回调关联。初始化只被一个 Promise 保护，整条聊天没有放进排他的初始化锁，否则回答请求会一直进不来。

**这还不是跨刷新、跨重启的永久恢复机制。** Mastra 原生快照保存运行状态，Map 保存当前连接的唤醒函数，两者不是一回事。页面停止、连接中断、DO 被回收或重新部署后，旧回调可能失效；历史问题可以回显，但不能保证旧审批按钮继续可用。应重试本轮，而不是把历史卡片当作新连接的活跃任务。

## 7. 从脚本到 GLB，再到资产审阅

### 7.1 当前使用 Three.js 路线

不依赖 Blender，也没有额外接入收费的专门 3D 生成 API。语言模型负责写程序，建模工具负责执行程序并导出模型。几何质量取决于模型生成的代码、提示词和已有运行库，不能保证达到专业建模或专用生成服务的水平。

脚本是一个同步函数体，可直接使用 `THREE`、`sculpt`、`taper`、`makeDog`，最后返回 Group 或 Mesh。不允许用户脚本 import/export、require、联网或加载外部文件。

### 7.2 构建阶段与请求阶段

```text
构建机：build-model-runtime.ts
  共用 model-runtime.ts + Three.js + GLTFExporter + Sucrase
      └─ esbuild 打包、压缩
          └─ generated/model-runtime.txt
              └─ 作为文本资源随私有建模 Worker 发布

请求阶段：ModelJob
  Agent 的 source
      └─ 托管浏览器加载预构建运行库
          └─ Sucrase 去掉 TS 类型语法
              └─ 执行函数体，得到 Three.js 对象
                  └─ GLTFExporter 输出 GLB
```

原生 esbuild 只在构建机运行，不在 Worker 请求中启动本机二进制程序。`.txt` 扩展名是 Worker 的文本模块载体，内容是打包后的 JS，不是模型提示词。

### 7.3 建模执行与上传

1. 主 Worker 内的建模工具通过 `MODEL_SERVICE` 调用私有 `agent3d-model`。
2. 内部请求使用 `MODEL_TOKEN`，建模 Worker 没有公网 workers.dev 地址。
3. ModelJob 检查是否忙碌、源码长度与当天建模次数。
4. 托管 Chromium 创建干净页面，禁止网络请求和 Service Worker。
5. 注入构建好的运行库，执行脚本并检查网格、顶点和导出大小。
6. 浏览器中先通过 FileReader 得到 Base64；Worker 再解码为二进制 Response，避免数百万个数字经过 CDP JSON 序列化导致内存膨胀。
7. 主 Worker 接收 GLB 响应，通过服务端 Secret 上传 Supabase 私有 bucket。
8. 工具返回 `script/modelId/meshes/vertices/validation` 等结果，聊天路由据此创建资产记录。

Base64 是建模执行内部的传输方式，不作为完整模型数据推送给聊天前端。浏览器最终经 `/api/artifacts/:id/model` 读取 GLB。

### 7.4 当前执行限制

| 限制 | 数值或行为 |
| --- | --- |
| 输入源码 | 非空，最多 100 × 1024 字符，ASCII 脚本约为 100 KiB |
| 脚本执行计时 | 15 秒，计时在运行库注入完成后开始，并非整个浏览器生命周期只有 15 秒 |
| 网格数 | 1–1000 |
| 顶点数 | 最多 500,000 |
| 云端 GLB 大小 | 最多 8 MiB |
| 本地默认 GLB 大小 | 最多 20 MiB |
| 线上同时建模 | 1 个任务，忙碌时返回 409，不排队 |
| 线上每日建模尝试 | 默认 20 次，全站共用，按 UTC 日期计数 |

每日计数在启动浏览器前增加，失败尝试也会占一次。20 次只是应用层保护，不保证一定不会用尽托管浏览器免费时长。Agent 的部分通用提示词仍写着 20 MB，应以线上实际运行库的 8 MiB 限制为准。

### 7.5 审阅与修改

新资产状态为 `pending`，可以预览；批准后状态变为 `approved`，允许下载 `.glb`；拒绝变为 `rejected`。

`expectedVersion` 用来避免两个操作覆盖同一资产的版本。聊天要求修改时，会重新生成完整脚本并导出一个新模型文件，再创建新的待审阅资产；这不是直接修改旧 GLB。当前 UI 中源码供查看，脚本模型不支持通过 PATCH 只改文本而跳过重新导出。

`blenderVersion` 字段以及部分 Blender 命名、错误提示仍属于早期结构遗留。它们不表示当前云端安装或调用了 Blender。

## 8. 刷新、重试和本次线上错误的修复

### 8.1 ID 的分工

| ID | 作用 |
| --- | --- |
| `conversationId` | 一整段会话，关联消息、附件和资产 |
| `clientTurnId` | 一次发送及其重试，防止重复保存或重复调用 |
| `messageId` | 一条用户/助手消息 |
| `runId` | Mastra 的一次运行，查找暂停状态 |
| `toolCallId` | 一次工具调用，关联入参、输出和暂停 |
| `modelId` | 一个实际 GLB 文件 |
| `artifactId` | 一条可审批的业务资产记录，内部脚本再引用 modelId |

`clientTurnId` 不是 runId。失败重试是重新尝试这一轮业务请求；人工回答后的 resume 是恢复 Mastra 暂停位置。

### 8.2 服务端的轮次状态

| 已保存状态 | 再次收到同一 clientTurnId 的处理 |
| --- | --- |
| 不存在 | 保存本轮用户消息并开始执行 |
| `running` | 返回冲突，不再开启第二次并行生成 |
| `failed` | 检查用户输入一致，复用原用户消息，重新尝试 |
| `complete` | 检查用户输入一致，直接重放已保存回复，不再次调用模型 |

同一个轮次 ID 配上不同的正文/附件，会被认为是冲突。事务和会话锁用于避免并发请求同时创建轮次。这里防止的是同一轮请求的重复提交，不是对所有相似文字做全局去重。

### 8.3 刷新后如何恢复

普通 React ref 会随刷新清空，因此不能只依赖前端内存。

现在历史查询通过 `chat_turns` 关联出消息的 `clientTurnId`，前端将其放入消息 metadata。点击重试时恢复原用户消息、轮次 ID 和附件 ID，再让 `chat.regenerate({ messageId })` 从对应用户消息重新发送。持久化的失败助手消息会显示重试入口，即使新的 `useChat` 实例本身还没有 `chat.error`。

### 8.4 “The request did not match the expected format.” 的具体原因

2026-11-17 线上记录中，Mastra 曾自动保存包含 `tool-invocation`、`step-start` 的原生消息。应用历史读取仍只接受自己的持久化片段格式，读取这些内部工具记录时抛出 ZodError，最终被统一转换成通用 400。**所以这个提示不一定说明浏览器发错了 JSON，也可能是服务端读取历史数据失败。**

本次修复包含：

1. 在 `storage/conversations.ts` 的 `readStoredMessage` 统一读取应用 metadata 和已有原生工具片段；SQLite、PostgreSQL 共用这一读取边界。
2. 将原生工具记录转换为历史展示需要的输入/输出事件，不改原数据库正文、不删除原会话。
3. 业务 Agent 调用增加 Memory `readOnly: true`，停止重复保存内部消息；已有记录保留。
4. 历史 API 返回可恢复的轮次 ID，前端恢复附件与原用户消息并重试。
5. 完成轮次直接重放结果，避免因用户未收到最终响应而再次扣模型额度。

旧的未完成审批不会被还原成一个保证可提交的活跃按钮；这是连接生命周期的限制，不是只靠重放界面就能恢复的执行状态。

## 9. 数据存在哪里

### 9.1 PostgreSQL 中的正式 schema

Supabase 项目：`gsgrdwtisfgcjybgkucg`。正式应用 schema：**`agent3d`**。

```text
Supabase PostgreSQL
└─ agent3d
   ├─ Mastra 原生表
   │  ├─ mastra_threads             会话，resourceId 对应用户
   │  ├─ mastra_messages            消息，thread_id 关联会话
   │  ├─ mastra_ai_spans            Trace / Span
   │  ├─ mastra_workflow_snapshot   原生运行快照相关存储
   │  └─ 其他由 Mastra 自动初始化的表
   └─ 应用业务表
      ├─ users                     用户、密码哈希
      ├─ settings                  每个用户的模型选择，不含模型 API Key
      ├─ user_preferences          每个用户的偏好
      ├─ attachments               附件元数据，不是文件内容
      ├─ artifacts                 资产、源码描述、审批状态和版本
      └─ chat_turns                一轮请求的幂等状态与消息 ID
```

以上表名已通过正式数据库的 information_schema 只读核对。Mastra 自动初始化了数据集、实验、Workspace 等其他表，出现这些表不代表工程已经实现了对应产品功能。不要为“看起来没用”就手动删除框架表。

会话和消息没有再放回另建的 `threads/messages` 自有表。应用为了将消息与 `chat_turns` 放在同一个事务里，会按当前 Mastra 版本的格式直接写原生表，这也是将来升级时必须核对结构的原因。

### 9.2 原生消息的保存形状

```json
{
  "format": 2,
  "parts": [{ "type": "text", "text": "供原生消息格式使用的正文" }],
  "metadata": {
    "agent3d": {
      "parts": [
        { "type": "text", "text": "回复正文" },
        { "type": "ui-chunk", "chunk": { "type": "tool-output-available" } }
      ],
      "status": "complete"
    }
  }
}
```

上面只是字段布局示意，实际工具事件还有 toolCallId/output 等字段。正文放在原生 content.parts，应用重放 UI 需要的事件、附件与资产引用放在 metadata.agent3d，二者用途不同。消息的完成/失败状态和 `chat_turns` 的运行状态也不是同一字段。

### 9.3 私有文件

```text
Supabase Storage
└─ private bucket：agent3d
   ├─ attachments/<conversationId>/<attachmentId>
   └─ models/<modelId>.glb
```

浏览器不能拿数据库中的 modelId 就匿名下载 Storage。它访问应用 API，应用检查会话归属，再用服务端 Secret 读取私有文件。批准下载和预览是两个端点：待审批可预览，下载要求 approved。

删除会话会先根据附件、资产记录删除相应 Storage 文件，再删除原生消息、会话和关联业务记录。当前没有面向所有孤立文件的周期清理任务；例如文件上传成功但后续资产创建失败，可能留下需要单独排查的文件。

### 9.4 Trace、日志和历史分别是什么

| 内容 | 保存位置 | 主要用途 |
| --- | --- | --- |
| 聊天消息 | `agent3d.mastra_messages` | 历史回显、下一轮上下文 |
| 轮次状态 | `agent3d.chat_turns` | 重试与防重复 |
| Trace / Span | Mastra PostgreSQL 原生可观测性存储 | Agent、模型、工具的调用链 |
| HTTP 运行日志、未捕获错误 | Cloudflare Observability | 请求失败、运行时错误、CPU/资源问题 |
| 暂停期间的回调 | 当前 AppSession 内存 Map | 唤醒当前聊天请求 |
| 每日建模次数 | ModelJob 的 DO Storage | 重启后仍保留当天计数 |

### 9.5 模型密钥与登录密码

模型 API Key 保存在客户端该站点的 localStorage 中，随每次聊天传给服务端。它不是加密保险箱，也不会自动同步到另一台电脑或另一个域名。

HTTP 入口在 RequestContext 的可序列化配置中放占位符，通过请求期 `getAgentApiKey` 闭包向动态模型提供真实值，避免原生快照从这份配置再保存明文密钥；Trace 另外配置 `SensitiveDataFilter`。这不是让 API Key 进入用户消息。调试时也不应打印整个请求体。

云端用户密码通过 PBKDF2-SHA256、100,000 次迭代和随机盐保存哈希。本地 SQLite 学习版登录实现仍有明文比较逻辑，不能把云端的密码保护能力自动等同于本地实现。

## 10. 已部署资源清单

| 资源 | 当前标识 | 用途 |
| --- | --- | --- |
| 主 Worker | `agent3d` | Web 静态文件、API 网关、AppSession |
| 主站域名 | `agent3d.agent3d-workers-compatibility.workers.dev` | 正式用户入口 |
| 主 Worker 当前版本 | `69a8b274-1fa8-40a3-94ab-8428fec7669b` | 2026-11-17 22:56 左右发布的重试修复 |
| 私有建模 Worker | `agent3d-model` | ModelJob 与托管浏览器 |
| 建模 Worker 当前版本 | `82e7f390-3375-4cfc-8cea-b8c13a45c5cf` | 2026-11-17 21:28 左右的有效版本，含 Secret 更新 |
| 主 DO 类 / Binding | `AppSession` / `SESSIONS` | 按用户定位运行实例 |
| 建模 DO 类 / Binding | `ModelJob` / `MODEL_JOBS` | 全站建模执行和限额 |
| 私有服务 Binding | `MODEL_SERVICE` | 主 Worker 调用 agent3d-model |
| Browser Binding | `BROWSER` | 调用 Cloudflare 托管浏览器 |
| Hyperdrive 名称 | `agent3d-supabase` | 数据库连接池入口 |
| Hyperdrive ID | `66ef8688a43b4b199b7781eee4bc4406` | `DATABASE` Binding 使用的资源 |
| 上传的公开 CA 资源 ID | `c6ef62cb-ccc4-4aef-8ab9-e19f286c052e` | Hyperdrive 验证数据库 TLS 证书 |
| Supabase 项目 | `gsgrdwtisfgcjybgkucg` | PostgreSQL 与 Storage |
| 正式 schema / bucket | `agent3d` / `agent3d` | 名称相同，但分别是数据库命名空间和文件桶 |

版本通过 Cloudflare `deployments list` 只读核对。资源 ID 和项目 URL 是定位信息，不能代替登录凭证。

之前还创建过 `agent3d-compatibility`、`agent3d-model-compatibility` 探针，以及 `agent3d_compat`、`agent3d_local_compat` 验证 schema。这些不属于正式业务入口。Hyperdrive 虽在兼容性阶段创建，现在已被正式 Worker 使用，不能连同探针随手删除。

### 10.1 数据库连接路线与 TLS

```text
Worker PostgresStore
  → env.DATABASE.connectionString
  → Cloudflare Hyperdrive
  → Supabase Session pooler：5432
  → PostgreSQL 中的 agent3d schema
```

主 Worker 的 PostgresStore 设置 `max: 2`、`disableInit: true`。Hyperdrive 的源连接上限为 5，查询缓存已关闭，避免状态变更后又读取到旧的聊天/审批数据。

本机 `.env.supabase` 保存的是 Transaction pooler 的 6543 连接串；初始化脚本和 Hyperdrive 配置脚本将端口改为 Session pooler 的 5432。两个端口不是抄写错误，使用位置不同。

本机需要公开 CA 证书和 `rejectUnauthorized: true`；Hyperdrive 上传同一公开 CA 并使用 `verify-full`。没有通过关闭 TLS 校验解决连接问题。

CA 来源：<https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt>。本机正式工程副本为 `apps/cloudflare/certs/supabase-ca.crt`。该证书不是数据库密码，不需要当作 Secret 保存。

### 10.2 目前未部署的东西

没有部署 Docker 容器、独立 VPS、Supabase Edge Functions 或另一个 Cloudflare Pages 前端。没有构建或发布 Windows 安装包，因此 Web 暂时没有桌面安装包下载链接。GitHub 仓库已存在，但本次使用本机 Wrangler 发布，**没有配置 GitHub push 自动构建部署**；推送代码不会自动让线上更新。

## 11. 配置文件与密钥的边界

| 文件 / 位置 | 内容 | 是否提交 |
| --- | --- | --- |
| 根 `.env` | 本地数据目录、Desktop API 地址、本地 Studio 等配置 | 否 |
| 根 `.env.supabase` | Supabase URL、Secret key、数据库连接串、bucket、CA 绝对路径 | 否 |
| 根 `.env.cloudflare` | SESSION_SECRET、MODEL_TOKEN | 否 |
| `deploy/supabase.env.example` | 不含真实凭据的填写模板 | 是 |
| `apps/cloudflare/main-secrets.json` | 待上传的主 Worker Secrets | 否 |
| `apps/cloudflare/model-secrets.json` | 待上传的私有建模 Worker Secret | 否 |
| Wrangler 的 `vars` | 站点来源、Supabase 公共 URL、bucket、每日次数等 | 是 |
| Cloudflare Worker Secrets | 实际运行的服务端凭据 | 保存在 Cloudflare，不写前端 |
| 浏览器 localStorage | 当前用户填写的模型 API Key | 不属于 Git 文件 |

主 Worker Secrets：`SESSION_SECRET`、`MODEL_TOKEN`、`SUPABASE_SECRET_KEY`。建模 Worker 只需要 `MODEL_TOKEN`，不需要拿到数据库密码或模型服务商密钥。

数据库凭据由 Hyperdrive 源连接配置持有，不能将真实连接串写入 Wrangler 的公开 vars。改变模型服务商密钥与改变 Supabase Secret 是两件不同的事。

`prepare-secrets.mjs` 仅在 `.env.cloudflare` 不存在时生成随机值，之后沿用已有值。不要为了重新发布就删除该文件：更换 SESSION_SECRET 会让原登录签名失效；更换 MODEL_TOKEN 时两个 Worker 必须一致。

当前登录签名 Cookie 有效期是 7 天，用户名 Cookie 是 400 天；两者使用 HttpOnly、Secure，当前 SameSite 为 None。来源校验仍限制 API 来源，用户名 Cookie 单独存在不等于有权限。首次输入不存在的用户名会注册新用户，这是学习项目当前的开放注册行为。

真实数据库密码和服务端密钥之前曾在聊天中提供。本记录不重复保存；后续应在控制台轮换，并同步更新本机配置、Hyperdrive 或 Worker Secrets，再验证连接。

## 12. 发布步骤与构建说明

### 12.1 当前资源上重新发布

以下命令在 `D:/learn` 执行，逐条运行，上一条成功后再继续。只改文档不需要发布；只改前端/API 通常也不需要重新初始化数据库或重新上传 Secret。

```powershell
# 首次准备或锁文件变化时安装依赖；不构建桌面端时可跳过 Electron runtime 下载。
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
pnpm install --frozen-lockfile

# 构建共用 Three.js 运行库 + Web 静态文件。
pnpm --filter @agent3d/cloudflare build

# 检查类型。
pnpm --filter @agent3d/desktop typecheck
pnpm --filter @agent3d/server typecheck
pnpm --filter @agent3d/cloudflare typecheck

# 修改了建模运行库或建模 Worker 时，先发布私有服务。
pnpm --filter @agent3d/cloudflare deploy:model

# 发布主 Worker 和 Web 静态文件。
pnpm --filter @agent3d/cloudflare deploy:web
```

`deploy:model` 和 `deploy:web` 使用各自 Wrangler 配置，且开启压缩。若只修改前端，也可以只执行 `pnpm --filter @agent3d/desktop build:web` 再 `deploy:web`。若修改共用运行库而漏发建模 Worker，线上几何实现不会更新。

根目录 `pnpm build` 包含更多 workspace 的构建，不是此次只发布 Web 的最小步骤。

### 12.2 首次初始化和 Secret 上传

以下步骤已经对当前项目执行过。迁移到新账号/新项目时才需要重新准备资源；不要在每次聊天或普通重发版时运行数据库建表。

1. 创建 Supabase 项目，将 `deploy/supabase.env.example` 复制到根 `.env.supabase` 并填写。
2. 确认 `.env.supabase` 的 Project URL 是根 URL，不带 `/rest/v1/`。
3. 填写私有 bucket 名称和公开 CA 绝对路径；密码中 `@` 等特殊字符要 URL 编码。
4. 用初始化脚本先调用官方 PostgresStore 初始化原生表，再建立业务表与私有 bucket。
5. 创建 Hyperdrive，上传公开 CA，设置 verify-full、关闭缓存，并将新 ID 填入主 Worker 配置。
6. 准备 Secret 文件，构建并创建两个 Worker，再分别上传 Secrets，之后验证站点。

```powershell
# 首次建库：不会把线上消息迁移成本地文件，也不是清库脚本。
pnpm --filter @agent3d/cloudflare exec node scripts/initialize-postgres.mjs

# 从未提交的配置生成未提交的 Secret JSON，不在终端显示实际值。
pnpm --filter @agent3d/cloudflare exec node scripts/prepare-secrets.mjs

# Worker 存在后分别上传；配置文件路径以 apps/cloudflare 为工作目录解析。
pnpm --filter @agent3d/cloudflare exec wrangler secret bulk model-secrets.json --config wrangler.model.jsonc
pnpm --filter @agent3d/cloudflare exec wrangler secret bulk main-secrets.json --config wrangler.jsonc
```

首次创建 Worker 时，Secret 上传完成前暂不可用是可预期的。主 Worker 会检查所需 Secrets，缺失时返回服务暂不可用。新账号还需确认可用的 Browser Run、SQLite-backed DO 和 Hyperdrive 权限。

当前 Hyperdrive 创建的辅助代码位于 `scripts/cloudflare-compatibility/create-hyperdrive.mjs`，属于这次验证阶段的工具，不是一个通用的一键部署脚本；它有固定资源名称和工作目录假设。迁到新账号时应核对控制台与 Wrangler 当前参数，不能直接照搬现有账号 ID。

### 12.3 如何确认新版本生效

```powershell
pnpm --filter @agent3d/cloudflare exec wrangler deployments list --config wrangler.jsonc
pnpm --filter @agent3d/cloudflare exec wrangler deployments list --config wrangler.model.jsonc
```

发布完成会输出正式 URL、Version ID 和 Worker Startup Time。应同时检查版本列表和网页实际行为，不能只看到“静态资源上传成功”就认定整个 Worker 已部署。

2026-11-17 最近一次主 Worker 打包约 9,949.58 KiB，gzip 约 2,696.06 KiB，启动时间实测 852 ms；这是当次构建数据，不是长期性能保证。依赖继续增大时需要关注启动限制。

### 12.4 本次发布中的网络问题

通过本机代理上传新 Worker 版本时，请求停在 versions 上传阶段，静态资源虽已上传，正式站点仍是旧版本。只读版本查询确认未切换后，停止该次发布进程；验证 Cloudflare 管理 API 直连可用，再仅为发布子进程清空代理变量，重发成功。

必要时可在一个单独 PowerShell 窗口使用以下设置；关闭窗口即结束该环境，不修改系统代理。只有直连已确认可用时再使用：

```powershell
$env:HTTPS_PROXY = ''
$env:HTTP_PROXY = ''
$env:ALL_PROXY = ''
$env:NODE_OPTIONS = '--use-system-ca'
pnpm --filter @agent3d/cloudflare deploy:web
```

`--use-system-ca` 使用系统信任库，不关闭证书验证；需使用支持该参数的 Node 版本。这个处理只针对部署网络问题，不能用来绕过模型服务商的限流。

本机验证脚本曾为新域名的 TLS/代理问题使用临时连接代理；它只在 `.verification` 的测试进程中生效，不是正式站点的运行依赖。

### 12.5 Git 与回滚

远端仓库：<https://github.com/yueqjGithub/gen3D>。截至本记录，本次云端改造及修复仍包含未提交的工作区修改；没有替用户自动 commit/push。**线上发布与 Git 提交是独立动作**，以后应将确认过的源码提交，才能可靠追溯版本。

需要回滚主站时，可在 Cloudflare 中选择已知版本，或用相应 Wrangler 回滚命令。回滚代码不会回滚 PostgreSQL 数据和 Storage 文件；若以后增加破坏性数据迁移，不能把 Worker 回滚当作数据库恢复方案。重新部署也会影响正在等待用户回答的内存回调，尽量避开活跃任务。

## 13. 日常查看与排障入口

### 13.1 Cloudflare 日志

打开 <https://dash.cloudflare.com/> → Workers & Pages → 选择 Worker → Observability / Logs。

- `agent3d`：聊天入口、模型请求、数据库与 Storage、Trace 导出等。
- `agent3d-model`：浏览器启动、源码执行、超时、网格/文件限制和建模额度。

实时日志应先打开，再去网页重现问题。当前已配置 `observability.enabled: true`。不是每个业务 400/404/409 都会额外 console.error：公共 API 错误处理目前主要记录未预期的 500，所以还要看浏览器 Network 的状态码与响应体。

```powershell
# 分别在两个终端运行，Ctrl+C 结束查看。
pnpm --filter @agent3d/cloudflare exec wrangler tail --config wrangler.jsonc
pnpm --filter @agent3d/cloudflare exec wrangler tail --config wrangler.model.jsonc
```

官方入口说明：[Workers 实时日志](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)。日志保留时长与查询能力受当前方案影响，不把实时 tail 当成永久备份。

### 13.2 Supabase 数据库

打开 [正式项目 Table Editor](https://supabase.com/dashboard/project/gsgrdwtisfgcjybgkucg/editor)，将 schema 从默认 `public` 改为 **`agent3d`**。

常见查看顺序：`mastra_threads` 找会话 → `mastra_messages.thread_id` 找消息 → `chat_turns` 找运行状态 → `artifacts` 找资产与 modelId。Trace 首选 Studio 查看，不必一开始直接展开原始 Span JSON。

SQL Editor 中可以先运行这些只读查询：

```sql
-- 找到正式 schema 中的表。
select table_name
from information_schema.tables
where table_schema = 'agent3d' and table_type = 'BASE TABLE'
order by table_name;

-- 最近的轮次状态，不读取消息正文和密钥。
select conversation_id, client_turn_id, status, updated_at
from agent3d.chat_turns
order by updated_at desc
limit 20;

-- 最近的资产状态。
select id, conversation_id, version, status, created_at
from agent3d.artifacts
order by created_at desc
limit 20;
```

不要通过手动改 `running → failed` 来抢占一个仍在执行的任务；先检查日志和连接。修改轮次状态时要考虑原任务随后写回与文件是否已经生成，当前没有通用的管理员“强制恢复”接口。

### 13.3 Supabase 文件

打开 [Storage Buckets](https://supabase.com/dashboard/project/gsgrdwtisfgcjybgkucg/storage/buckets) → `agent3d`，查看 `attachments` 与 `models`。

Storage 中的对象与数据库记录共同组成一份可用资产。只备份 PostgreSQL 不会备份 GLB 字节，反过来也一样；当前没有配置本项目专用的自动备份或文件保留策略。

### 13.4 本机 Studio 查看云端 Trace

```powershell
# 在 D:/learn 运行，加载根 .env 与 .env.supabase。
pnpm --filter @agent3d/agent dev:studio:cloud
```

打开终端输出地址，当前为 <http://127.0.0.1:62687>，进入 Traces。前提是数据库已初始化，`SUPABASE_CA_PATH` 为有效绝对路径，且本机可以连接 Supabase。

这只是在本机启动一个读写云端 Mastra 存储的开发入口，不是从线上 Worker 反向代理 Studio。工作台发送的请求是线上环境；Studio 内主动发起的新请求则运行在本机 Agent 中，建模也使用本机浏览器。

普通 `pnpm --filter @agent3d/agent dev` 不加载 `.env.supabase`，通常继续使用本地 SQLite，看到的 Trace 可能不同。

### 13.5 从现象定位到哪一层

| 现象 | 先查什么 |
| --- | --- |
| 页面打不开、TLS 失败 | 域名、浏览器网络、代理；与 Supabase 数据表无直接关系 |
| 登录失败或 API 401 | 签名 Cookie、过期时间、SESSION_SECRET、用户记录 |
| API 403 | Origin/Host 与 AGENT3D_WEB_ORIGIN 是否匹配 |
| “请求格式不符合要求” | 浏览器请求与历史解析；本次原生工具记录问题已修复 |
| 重试返回运行冲突 | 同一 clientTurnId 是否仍在 running |
| 工具找不到、ToolNotFound | Agent 工具注册键、工具名、恢复时使用的工具集合 |
| Agnes 429 / 1015 | 模型服务商限流，保留错误时间和 Trace，联系服务商 |
| 工具忙碌 409 | 全站 ModelJob 已有任务执行，不是模型 API 格式问题 |
| 建模次数 429 | 站内每日尝试上限，和 Agnes 的 429 分开判断 |
| 模型不出现在资产面板 | 建模输出 validation、GLB 上传、资产记录、data-asset 事件 |
| 预览或下载 404 | 资产中的 modelId、Storage 对象是否存在 |
| 能预览不能下载 | 是否已经批准，资产版本是否一致 |
| 页面刷新后旧问题提交失败 | 原请求的 Map 回调已失效，应重试本轮 |
| Studio Trace 报错 | 云端/本地存储是否选对、适配器版本、原生 Span 格式和 Trace flush |

## 14. 已验证的范围与不能混淆的结果

| 项目 | 已有结果 | 边界 |
| --- | --- | --- |
| 当前 Mastra / AI SDK / PG / Observability 打包 | 通过 | 已实际部署，不只是 tsc 通过 |
| 原生 SSE 文本 | 本地及云端探针通过 | 固定模型响应，不是 Agnes 真调用成功证明 |
| 人工允许/拒绝后恢复 | 本地及云端原生探针通过 | 使用真实暂停/恢复协议，非完整生产模型任务验收 |
| 多选项回答后恢复 | 本地及云端探针通过 | 包含 PostgreSQL 新实例恢复验证；不保证 UI 跨 DO 重启恢复 |
| PostgreSQL 原生消息与 Trace | 通过 | 正式 schema 已初始化且能读写 |
| Supabase 私有 GLB 上传/下载 | 通过 | 验证过二进制一致性和临时文件清理 |
| 托管浏览器 JS/TS → GLB | 通过 | 私有服务可实际执行，完整狗模型 4,066,156 字节、31 网格、92,716 顶点 |
| 正式 Web 登录、签名、伪造 Cookie 拒绝 | 通过 | 公网真实接口 |
| 会话创建、列表、重命名、图片与偏好 API | 通过 | 真实云数据库和 Storage |
| Chrome 中 GLB 预览、批准、下载与刷新 | 通过 | 使用明确标注的无 LLM 资产验证记录，不冒充 Agent 自主生成 |
| 粘贴/拖拽图片、缩略图、移除与自动确认警告 | 通过 | 实际浏览器界面验证 |
| Studio 云端 Trace 列表 | 通过 | 本机 Studio 连接正式 Supabase；light API 200，页面无先前 stored.trim 报错 |
| 原生工具历史与刷新重试 | 通过 | 已有线上记录只读解析通过，正式网页刷新后重试返回 200、结果回显、消息不重复 |
| 完成请求重试不再调用模型 | 通过 | 线上专用测试会话模拟后台完成，实际 HTTP 重放，无真实模型调用，测试会话已清理 |
| 最近服务端回归 | 54 项通过 | 运行时排除了 bootstrap.test.ts，不宣称整个根测试命令已完整通过 |
| 最近 Desktop/Web 回归 | 14 项通过 | 共用客户端全部 6 个测试文件 |
| 前后端与 Cloudflare 类型检查 | 通过 | 修复后的代码检查结果 |
| Agent 测试 | 之前一轮 13 项通过 | 与最近 68 项回归分开记录，未因本次纯文档任务重复执行 |
| 真实 Agnes 需求 → 审批 → GLB → 再修改的完整线上链路 | 尚未完成统一验收 | 早前 429/1015，后续用户遇中断/重试问题；不能据此写成所有真实建模已成功 |
| 云端 PDF 提取 | 未单独验证 | 有代码路径和本地测试，不等于 PDF.js 在 Worker 中全部兼容 |
| Windows 安装包、GitHub 自动部署 | 未执行/未配置 | 本次按 Web 优先发布 |

验证截图和脚本在忽略提交的 `.verification/` 中，例如 `cloud-web-review.png`、`studio-cloud-traces.png`、`cloud-retry-fixed.png`。这些是本机证据文件，不是公网产品依赖，也不会随 Git 自动保存。

## 15. 这次部署遇到的关键问题与处理

| 问题 | 原因或观察 | 处理 |
| --- | --- | --- |
| 原本 Node + SQLite + Chromium 无法直接搬到 Worker | 常驻进程、本地数据库文件与原生执行环境不匹配 | 复用业务代码，替换运行入口、PostgreSQL/Storage 仓库及浏览器工具 |
| 普通 Worker 建模 exceededCpu | 请求 CPU 限制不适合该路径 | 将会话与建模运行放入 DO；仍需遵守 DO 和浏览器额度 |
| 大 GLB 导出超过内存 | CDP 中把 Uint8Array 转成数百万个 JSON 数字 | 浏览器 FileReader → Base64 → Worker 二进制解码，云端限 8 MiB |
| Mastra 和 Playwright 放一起启动过重 | 曾超过 Worker 启动上限 | 拆主业务 Worker 与私有建模 Worker，Agent 工厂注入执行方法 |
| Worker 不能现场运行原生 esbuild | 运行环境不同 | 本机构建时打包，浏览器用 Sucrase 做 TS 语法转换 |
| Supabase 证书链失败 | 需要明确的公开 CA 信任 | 本机配置 CA；Hyperdrive 上传 CA 并 verify-full，没有关闭 TLS |
| 数据库状态读到旧值的风险 | Hyperdrive 查询缓存适合部分读取，不适合当前即时状态 | 关闭该配置的查询缓存，保留连接池 |
| 回答请求找不到等待函数的风险 | 普通无状态 Worker 请求可能落不同实例 | 同一用户请求进入同一个 AppSession |
| 模型密钥可能进入序列化请求上下文 | 原生暂停快照可能保存请求期配置 | 可序列化字段用占位符，真实值通过请求闭包提供，Trace 过滤敏感字段 |
| Agnes 返回 429 / Cloudflare 1015 | 上游服务商限制 | 停止自动重试，按用户选择保留 Agnes，等待服务商确认 |
| 刷新后格式错误、重试信息丢失 | 原生工具片段与应用历史格式不一致，ref 不持久 | 统一历史读取边界、Memory readOnly、关联返回轮次 ID、恢复附件并重试 |
| 代理下版本上传长时间无响应 | 资源上传成功但版本未切换 | 查版本确认后停止该进程，用已验证的 API 直连重发 |
| 本机防护软件提示某个构建文本异常 | 没有拿到足以确定原因的检测记录 | 不把它定性为误报；未修改防护设置或添加排除项，运行库使用标准压缩构建 |

## 16. 免费额度、当前限制与后续工作

### 16.1 免费不是无限使用

本次没有主动开通新的付费套餐，代码采用较小连接池、云端 GLB 大小限制、全站单建模任务和每日次数保护。实际用量仍应以两个平台控制台为准，模型服务商的费用单独计算。

| 资源 | 本记录核对时的免费方案说明 |
| --- | --- |
| Browser Run | 每日 10 分钟浏览器时长；浏览器启动、注入、执行与关闭均需要时间 |
| Workers | 免费请求和 CPU 配额受平台限制；不能用 Node 服务器的无限常驻假设理解它 |
| SQLite-backed DO | 可用于 Free 方案，但请求、执行和存储仍有配额 |
| Hyperdrive | 连接池与查询有方案额度，需查看当前账号 Usage |
| Supabase PostgreSQL | Free 项目数据库额度 500 MB |
| Supabase Storage | Free 方案文件存储额度 1 GB，出站流量另受限制 |
| Supabase 项目活跃度 | 低活跃 Free 项目可能在约 7 天后被暂停，需在控制台恢复 |

额度核对日期为 2026-11-17。官方参考：[Browser Run 价格](https://developers.cloudflare.com/browser-run/pricing/)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[DO 限制](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Hyperdrive 价格](https://developers.cloudflare.com/hyperdrive/platform/pricing/)、[Supabase 价格](https://supabase.com/pricing)、[Supabase 暂停规则](https://supabase.com/docs/guides/platform/free-project-pausing)。未来规则变化时应重新核对，不能把本文的数字当作永久承诺。

模型可能在工具失败后重试，每次建模尝试都可能消耗模型和浏览器资源。生成多个模型也会积累 Storage 与下载流量；目前没有自动清除旧资产的保留策略。Trace 会占 PostgreSQL 空间，需要观察大小；目前也没有配置应用专属的定期清理任务。

### 16.2 当前仍有的实现边界

1. 人工确认和回答依赖原连接及内存回调，跨重启/DO 回收恢复尚未做成持久化的产品流程；`running` 轮次也没有自动租约过期与接管机制。
2. 真实模型端到端创建与修改尚需继续验收，不能以固定模型探针替代。
3. 上传到私有 Storage 的 GLB 已经验证，但“真实 Agent 调用 → 主 Worker 流式上传 → 自动资产通知”仍需在完整模型联调中一起确认。
4. 云端 PDF 提取、长历史和多用户负载没有完成专项验收。当前是学习规模，不是压测后的多租户服务。
5. 源码工具允许约 100 KiB，而历史服务消息单条 content 上限为 50,000 字符，复杂脚本可能遇到长度边界；需要之后统一上下文策略，不应靠悄悄截断完整建模源码解决。
6. 自动注册尚未增加邀请机制或注册频率限制，每日建模上限是全站共用。当前也没有每用户费用预算界面。
7. 登录改密不会自动轮换全站签名密钥，也没有完整的会话撤销管理；本地学习版认证与云端安全实现不同。
8. 没有 Windows 安装包、下载按钮、自动发布流水线、应用级自动备份或孤立文件回收任务。
9. PostgreSQL 可观测性曾提示部分批量 metrics 存储能力不支持。Trace light 和 Studio 已验证可用，不等于所有指标、成本统计都已验收。
10. 部分历史文档、Blender 字段和注释仍需之后统一整理，本次只新增部署记录，没有为写文档改动业务行为。

### 16.3 明早建议的阅读与验证顺序

先看第 3 节的本地/线上两条路线，再读第 4–6 节和对应的 `ChatView.tsx → routes/chat.ts → agent-client.ts → Agent`。随后打开 Supabase 的 `agent3d` schema，把一条会话、用户消息、轮次与资产记录对应起来。

如果准备继续验收模型功能，先开 Cloudflare 两个 Worker 的日志，再做一轮简单创建、人工确认、预览、批准下载，最后要求“改成另一种颜色”。确认每次都有实际工具输出、新 GLB 和新资产，而不是只看助手文字。若再次出现上游 429/1015，应保留时间与 Trace 并联系服务商，不连续重试消耗额度。

发布复核已经通过的站点可直接使用；需要继续的重点是上述真实模型完整链路，以及重启恢复、费用边界和长期数据维护。
