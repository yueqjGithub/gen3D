-- 会话和消息由 Mastra 创建的 mastra_threads / mastra_messages 表保存。
CREATE TABLE preferences (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 资产：每次编辑 version 递增；status 为 pending（待审批）/ approved / rejected
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  brief TEXT NOT NULL,
  script TEXT NOT NULL,
  blender_version TEXT NOT NULL CHECK (blender_version = '4.x'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL
);

-- 附件元数据；文件内容保存在磁盘上，不放进数据库
CREATE TABLE attachments (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'document')),
  created_at TEXT NOT NULL
);
