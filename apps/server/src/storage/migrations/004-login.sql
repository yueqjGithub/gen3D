-- 只创建应用自己的登录表，不重建 Mastra 管理的 mastra_threads。
-- 旧会话和 Studio 会话的 resourceId 不一定对应 users.username。
-- 会话归属由业务查询按 resourceId 检查；不能在迁移时强加用户外键，
-- 更不能 DROP 父表，否则可能级联删除消息、资产和附件。
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
