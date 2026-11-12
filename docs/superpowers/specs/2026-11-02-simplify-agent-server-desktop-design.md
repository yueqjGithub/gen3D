# 简化 Agent、Server 和 Desktop 设计

## 目标

这是一个 Agent 学习项目。用清晰、可直接阅读的代码展示三段调用关系：Desktop 调用 Hono Server，Server 再通过固定 URL 调用 Mastra Agent。移除伪模型、凭据代理和为隐藏 API key 增加的存储与转发层。

## 保留的功能

- 会话、附件、用户偏好、模型选择、流式对话和资产审批。
- Agent 只在用户明确提出资产创作要求时生成资产。
- Hono 是 Desktop 与 Agent 之间唯一的应用 API 中间层。
- 多 provider/model 选项继续保留。聊天模型所需的 provider key 由 Agent 直接从 `apps/agent/.env` 读取；设置界面只选择模型，不收集、加密或存储 API key。

## 明确不做

- 不增加通用配置抽象、环境配置解析框架、凭据代理或额外服务。
- 不在 Desktop 或 Hono 的数据库中保存 API key，也不通过请求上下文或 renderer 传递 API key。
- 不添加运行时 mock provider、Mock mode、测试模型或伪 Agent 响应。
- 不为 instruction 增加提示词构造器；instruction 直接写在 Agent 定义中。
- 不更改任何 package scripts。

## 过度封装清理规则

清理范围覆盖 `apps/agent`、`apps/server` 和 `apps/desktop` 的生产代码，不限于 prompt 或 tools：

- 先追踪每个 helper、工厂、wrapper 和单独模块的实际调用点；只有一个生产调用点且不提供清楚的领域边界时，直接内联。
- 删除只把参数传给下一层、只为创建一次对象、或仅仅改名后再转发的函数和文件。
- 业务流程按 Desktop → Hono → Mastra 直接可追踪；请求字段不在多个 DTO/helper 中重复包装、解包和转换。
- 只保留真正被多处使用的共享逻辑、网络/输入边界校验、存储和 UI 的清楚职责边界，以及框架自身要求的适配代码。
- 不为减少文件数量而把所有内容塞入单个大文件；删除的是无价值的调用层，不是有明确职责的业务代码。

## 服务边界和固定地址

- Electron/Vite renderer 固定为 `http://localhost:5173`，Vite 使用 `strictPort`。
- Hono 固定监听 `127.0.0.1:62586`。
- Mastra 固定监听 `127.0.0.1:62687`，保留 Mastra 原生 `chatRoute`。
- Desktop renderer 仅访问 Hono；Hono 使用固定 Agent URL `http://127.0.0.1:62687` 调用 Agent。
- Electron main 只创建桌面窗口，不启动 Hono、Agent 或凭据 HTTP broker。
- 删除用于选择运行端口、URL 或开发 Mock mode 的环境变量。固定值在各服务入口中直接可读。
- 移除 Desktop→Hono 和 Hono→Agent 的共享 token 传递；服务仅绑定 loopback，Hono 继续校验 renderer origin。

## API key 和模型选择

- Agnes key 放在 `apps/agent/.env` 的 `AGNES_API_KEY`；Agent 调用 Agnes provider 时直接读取 `process.env.AGNES_API_KEY`。
- 对仍保留的其他 provider，Agent `.env.example` 列出相应的 provider key 变量；缺少所选 provider 的 key 时清楚报错。
- Hono 只持久化模型 provider、model ID 和 base URL 等非秘密选择值，不读取、不存储、不返回 key。
- 删除 UI key 输入/状态、凭据 CRUD API、Electron safeStorage 凭据存储和 broker。
- 删除 Agent 请求契约里的 API key 字段。Hono→Agent 请求只含消息、附件、偏好和选择的模型信息。

## Agent instruction

Agent 的指令直接以普通中文字符串写在 `new Agent({ instructions: ... })` 中。保持生成意图门控和输出结构的行为，但删除只为拼接 instruction 而创建的函数。只保留确实有多处调用的共享逻辑；单次使用的薄封装内联到调用处。

## RequestContext 和 tools

- Hono 在调用 Mastra 时只构造并发送一份 request context。Mastra 从 `chatRoute` 请求体创建 Agent 的 `RequestContext`；不再使用额外 middleware 解析、复制、剥除或重新挂载同一份 context。
- Agent 的 `instructions`、`model`、`tools` 和 `defaultOptions` 直接从同一个 `requestContext.get('agent3d')` 读取需要的字段；删除 `parseAgentChatRequestContext`、`getAgentRequestContext` 等单次转手层。
- 工具在 `Agent` 的 `tools` 配置中以一个对象字面量就地声明。该对象直接闭包读取当前 request context，按明确生成意图限制资产工具；不再由 `createAgentTools` 函数返回另一层工具对象。
- 工具的必要 `createTool` 调用和每个工具自己的执行逻辑保留；不把 Mastra 工具 API 本身再包装成自建框架。

## 进程运行范围

- `pnpm dev` 启动 Agent、Server 和 Electron renderer；三者使用上述固定端口。
- Electron main 不启动或监督 Agent/Server。已有的 Electron 构建仍保留，但打包运行时需用户/外部进程管理器先启动固定地址的 Agent 与 Server；本次不增加安装器或服务监督器。

## 测试策略

- 所有运行时 mock 路径和 mock 模型测试均删除；不再通过假模型或伪 SSE 证明 Agent 成功。
- 不用 `vi.mock`、假 Agent 响应或 mock fetch 替代跨进程调用。需要跨层验证时使用固定 loopback URL 和真实 Hono/Mastra 服务。
- 不在默认自动测试中调用计费的外部模型。真实模型调用作为需要本地 API key 的手动 smoke 测试；默认验证以纯逻辑测试、真实本地服务测试、类型检查和构建为主。
- 测试不可绑定临时随机端口；使用与应用相同的固定端口，且需在启动时明确报告端口冲突。

## 实施范围

- 清理根 `.env.example`、`apps/agent/.env.example`、README 与 smoke test 中的 mock、broker、token 和可配置端口说明。
- 移除 credential broker、credential client、safeStorage 凭据文件流程及其专属路由、状态、契约和测试。
- 简化 Agent/Server 的模型与请求上下文契约，固定监听地址。
- 将 requestContext 直通 Mastra 原生 chatRoute；Agent 指令和工具就地定义，删除只转发一次的上下文、模型和工具 helper。
- 按上方规则检查三端生产代码，内联单处调用的 helper/wrapper，删除只作转发的模块；保留真实共享或边界逻辑。
- 简化 Desktop preload 参数，仅传 Server 固定 URL（如果 renderer 可以直接使用同一固定 URL，则移除不必要的 URL 注入）；去掉 API token 参数。
- 保留 Hono 的会话、附件、偏好、审批和模型选择流程。

## 考虑过的做法

1. **保留模型选项、缩短服务链路（选定）**：移除 broker、API key UI/存储、mock、tokens 和端口/URL override，但保留已有产品能力和三段结构。选它是因为用户明确希望项目用于学习 Agent，同时已有功能需求不要求删除模型选择。
2. **只保留 Agnes**：进一步删除 provider/model 选择，代码最少，但会丢失已有的模型选择功能，因此不采用。

## 实施者的决定

- 保留本地 origin 校验，作为浏览器访问 Hono 的最小边界；删除 API token 本身。
- 如果某测试依赖 mock 才能验证纯功能，将测试改为直接验证真实实现或删除该 mock 专属用例，不以接入在线模型作为默认测试前提。
