# 形构 Agent：3D 资产学习工作台

这是一个使用 Mastra 构建的本地 Agent 学习项目。用户可以通过对话、图片或文档描述需求。Agent 编写 Three.js 脚本，通过本地工具执行并导出 GLB，用户可以在桌面端旋转查看、批准和下载模型。

## 运行要求

- Windows 10/11
- Node.js `>=22.13`（可以使用 pnpm 管理的 Node runtime）
- pnpm `12.15.0`

项目使用 pnpm workspace，不要使用 npm 安装依赖。

## 快速开始

浏览器客户端可直接复用 Desktop 的 React 界面。运行 `pnpm --filter @agent3d/desktop dev:web` 开发，运行 `pnpm --filter @agent3d/desktop build:web` 导出到 `apps/desktop/out/web`。Docker 编排、HTTPS、持久化和免费托管选项见 [Web 与 Docker 部署说明](docs/web-deployment.md)。

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

详细的数据组装、SSE 和用户回答后的恢复流程见 [聊天数据流说明](docs/chat-data-flow.md)，其中包含时序图、字段用途和源码阅读顺序。

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

桌面端从仓库根目录的 `.env` 读取 `AGENT3D_SERVER_URL`，默认值为 `http://127.0.0.1:62586`。聊天、附件和 Markdown 图片的来源判断共用此地址。修改后重启桌面开发进程，发布版需重新构建。Hono 本身监听本机回环地址，通过固定 loopback URL 调用 Mastra。Hono 只接受开发 renderer 的 `http://localhost:5173` 和打包后 Electron `file:` 页面的 `null` 或缺省 Origin（需包含 Electron User-Agent）。

Hono 从数据库读取历史和偏好，并把本轮附件整理成文档文本或图片 data URL。对话和图片通过 `messages` 发送，模型配置、API Key、附件说明与偏好通过 `agent3d` 进入当前请求的 `requestContext`。Mastra 的敏感数据过滤器会在持久化追踪前隐藏 `apiKey` 字段。文本、推理和工具事件按 AI SDK 原生格式实时返回，工具成功生成模型后，Hono 创建待审阅资产并发送 `data-asset` 更新桌面面板。

Electron main 只负责桌面窗口和开发者工具菜单，不启动或监督 Agent、Server，也不实现 preload API bridge。打包运行时需要用户或外部进程管理器先启动 Agent 和 Hono。

Desktop 的 React 入口在 `apps/desktop/src/renderer/src/App.tsx`：它管理会话、消息与资产状态。各功能组件直接使用 `api/client.ts` 中的固定本地 API 对象；聊天流由 `ChatView.tsx` 中的 Vercel AI SDK `useChat` 处理，不经过 Electron 主进程。

## 项目功能

- 会话列表、历史消息和 SQLite 持久化。
- 文档与图片附件；具体图片输入能力取决于所选聊天模型。
- 显示 Agent reasoning 和工具活动，支持失败重试与停止生成。
- 用户提出创建 3D 资产后，可以分几轮回答类型、风格和材质的追问，生成后也能用“换成红色”“加宽口沿”等短句继续修改。建模工具在每轮可用，由 Agent 按完整对话判断是否执行。修改时读取历史源码并重新导出 GLB，工具成功后资产面板显示新版本。
- 资产审阅面板展示 GLB 模型和 Three.js 源码，可通过聊天继续修改，也可批准、下载或拒绝资产。
- 保存经用户确认的偏好建议。
- 需求不明确时，Agent 可调用 `ask-user`，展示一个问题和 2–4 个选项。用户也可输入自定义答案，提交后从暂停位置继续。提问在自动确认模式下仍等待回答，停止或关闭页面后当前问题结束。
- 输入框下方默认选中手动确认。每个工具执行前会展示名称和参数，选择允许或拒绝后继续。自动确认会先弹出风险提示，接受后该会话后续发出的请求可直接执行工具。切换会话后恢复手动确认，生成或等待确认时确认方式锁定。
- 等待工具确认时可停止生成。刷新或关闭页面会结束当前连接，已失效的确认按钮无法继续执行；重新发起请求会重新请求确认。
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


### Windows 模型请求的证书链

如果本机 Node 提示 unable to verify the first certificate，而证书已安装在 Windows 系统信任库，可在支持该选项的 Node 版本（本次验证为 Node 24）中使用系统证书：

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
pnpm dev
```

这不会关闭 TLS 校验。此设置只影响当前 PowerShell 启动的进程，不需要修改模型或 Agent 业务代码。

### Three.js 脚本生成 GLB

Agent 的 `generate-three-model` 工具接收 `source`：JavaScript 或 TypeScript 的函数体，直接使用注入的 `THREE`，最后返回 `THREE.Group` 或 `THREE.Mesh`。可使用自定义 BufferGeometry、曲线、轮廓拉伸、旋转曲面和 CanvasTexture，不再局限于基础几何体 JSON。

脚本还能直接使用以下建模函数。

- `sculpt([[x,y,z,rx,ry,rz], ...], blend = 0.35, resolution = 48)` 从相互重叠的椭球体提取一张连续表面。六个数字分别是中心位置与三个半轴长度。返回的几何体带平滑法线，可按顶点位置着色。融合度范围为 0 到 1，采样分辨率为 24 到 72。细长的小部件可以单独建模。
- `taper([[x,y,z,radiusA,radiusB], ...])` 沿一串控制点扫出逐渐变粗或变细的椭圆截面，适合尾巴、枝条、把手。它与 `sculpt` 都返回 `BufferGeometry`，可直接传给 `new THREE.Mesh(geometry, material)`。
- `THREE.RoundedBoxGeometry` 可给机壳、家具等硬边部件加倒角。
- `makeDog({coat, spots, spotColor, collar, slender})` 返回站姿短毛犬的 Group。可选的颜色参数使用 Three.js 颜色值，`spots` 控制斑纹，`slender` 调整躯干比例和收腹程度。例如下面这段就是斑点狗资产的完整工具输入脚本。犬体的比例、耳朵、腿和花纹算法集中在 `apps/agent/src/mastra/tools/dog-model.ts`，可以对照预览学习。

```js
return makeDog({ coat: '#f2eee4', spots: true, spotColor: '#211e1c', collar: '#af2232' });
```

工具集中在 `apps/agent/src/mastra/tools/generate-three-model.ts`：编译 TypeScript → 一次性 Chromium 页面执行 → GLTFExporter 导出 → 共享数据目录 `models/<UUID>.glb`。Desktop 使用 GLTFLoader 加载文件，不执行生成代码。聊天流只携带脚本和模型 ID，不携带二进制。

Windows 默认使用 `C:/Program Files/Google/Chrome/Application/chrome.exe`。Chrome 在其他位置时设置 `THREE_CHROME_PATH`；没有 Chrome 的环境可在 Agent 目录运行 `pnpm exec playwright install chromium`。

执行页面禁止联网、没有登录态，不暴露 Node 或磁盘 API。建模执行超时 15 秒，最多 1000 个网格、50 万顶点、GLB 20 MB。工具会把运行错误返回给 Agent，供它修复脚本。修改模型请通过聊天提出，工具会重新执行完整脚本并导出新文件；审阅面板的脚本仅供查看，审批后下载 `.glb`。
