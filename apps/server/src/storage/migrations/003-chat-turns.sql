-- 记录每一轮对话的状态，用于失败重试和幂等：同一个 (会话, clientTurnId) 只会产生一次回复。
-- running：进行中；failed：失败，可用同一个 clientTurnId 重试；complete：已完成，重试时直接重放。
CREATE TABLE chat_turns (
  conversation_id TEXT NOT NULL REFERENCES mastra_threads(id) ON DELETE CASCADE,
  client_turn_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL UNIQUE REFERENCES mastra_messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT UNIQUE REFERENCES mastra_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'complete')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, client_turn_id)
);
