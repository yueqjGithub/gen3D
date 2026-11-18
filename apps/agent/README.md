# 独立 Mastra Agent

端口 62687。提示词和工具在 src/mastra/agents/agent.ts，注册、原生 chatRoute、PostgreSQL 和 Trace 在 src/mastra/index.ts。Server 经 HTTP /chat/asset-creation-agent 调用。

```powershell
pnpm --filter @agent3d/agent dev
pnpm --filter @agent3d/agent build
```

读取根 .env 与 .env.supabase，Studio 在 http://127.0.0.1:62687，使用云数据库 agent3d schema。Studio 可选密钥 AGNES_API_KEY 放根 .env；工作台密钥由用户在界面填写。

Agent 的 generate-three-model 只做语法转换与脚本准备，不启动 Chromium。Web/Desktop 的隔离 iframe 执行源码、导出 GLB，再经 Server 上传 Supabase。工具成功不等于 GLB 已保存，资产面板负责显示构建与上传状态。

整体结构和部署状态见 [部署记录](../../deploy-record.md)。
