-- 通用设置表（目前保存用户选择的对话模型 / 生图模型）
CREATE TABLE settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
