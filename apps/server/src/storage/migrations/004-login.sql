CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mastra_threads_new (
  "id" TEXT NOT NULL PRIMARY KEY,
  "resourceId" TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
  "title" TEXT NOT NULL,
  "metadata" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

INSERT INTO mastra_threads_new
  ("id", "resourceId", "title", "metadata", "createdAt", "updatedAt")
SELECT
  "id", "resourceId", "title", "metadata", "createdAt", "updatedAt"
FROM mastra_threads;

DROP TABLE mastra_threads;
ALTER TABLE mastra_threads_new RENAME TO mastra_threads;

PRAGMA foreign_key_check;