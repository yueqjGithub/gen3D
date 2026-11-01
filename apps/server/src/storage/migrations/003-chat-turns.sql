CREATE TABLE chat_turns (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  client_turn_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'failed', 'complete')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, client_turn_id)
);
