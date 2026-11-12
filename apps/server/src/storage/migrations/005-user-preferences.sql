-- 按用户名保存偏好，旧的全局偏好表保留，不自动归属给任何用户。
CREATE TABLE user_preferences (
  username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (username, key)
);
