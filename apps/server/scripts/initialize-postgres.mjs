import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { PostgresStore } from '@mastra/pg';

// 只在部署机执行。真实连接信息不提交 Git，初始化也不放进聊天请求里。
process.loadEnvFile(new URL('../../../.env.supabase', import.meta.url));
const require = createRequire(import.meta.resolve('@mastra/pg'));
const { Pool } = require('pg');
const url = new URL(process.env.DATABASE_URL);
url.port = '5432';
url.searchParams.delete('sslmode');
const ca = await readFile(new URL('../../../deploy/supabase-ca.crt', import.meta.url), 'utf8');
const pool = new Pool({
  connectionString: url.toString(),
  ssl: { ca, rejectUnauthorized: true },
  max: 2,
  connectionTimeoutMillis: 10000,
});
const storage = new PostgresStore({ id: 'agent3d-setup', pool, schemaName: 'agent3d' });
try {
  console.log('Initializing Mastra native tables (first run may take a few minutes)…');
  await storage.init();
  // 这部分只创建应用表。绝不自行重建 mastra_threads / mastra_messages / Trace 表。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent3d.users (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS agent3d.settings (username TEXT PRIMARY KEY,value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS agent3d.user_preferences (
      username TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(username,key)
    );
    CREATE TABLE IF NOT EXISTS agent3d.artifacts (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES agent3d.mastra_threads(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version>0),brief TEXT NOT NULL,script TEXT NOT NULL,
      blender_version TEXT NOT NULL DEFAULT '4.x',
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent3d.attachments (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES agent3d.mastra_threads(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,media_type TEXT NOT NULL,size BIGINT NOT NULL CHECK(size>0),
      kind TEXT NOT NULL CHECK(kind IN ('image','document')),created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent3d.chat_turns (
      conversation_id TEXT NOT NULL REFERENCES agent3d.mastra_threads(id) ON DELETE CASCADE,
      client_turn_id TEXT NOT NULL,user_message_id TEXT NOT NULL UNIQUE REFERENCES agent3d.mastra_messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT UNIQUE REFERENCES agent3d.mastra_messages(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('running','failed','complete')),updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(conversation_id,client_turn_id)
    );
    CREATE INDEX IF NOT EXISTS agent3d_attachments_conversation ON agent3d.attachments(conversation_id);
    CREATE INDEX IF NOT EXISTS agent3d_artifacts_conversation ON agent3d.artifacts(conversation_id);
  `);
  const base = process.env.SUPABASE_URL.replace(/\/$/, '') + '/storage/v1/bucket';
  const key = process.env.SUPABASE_SECRET_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'agent3d';
  const existing = await fetch(base + '/' + bucket, { headers: { apikey: key } });
  if (existing.ok) {
    if ((await existing.json()).public) throw Error('Storage bucket must be private.');
  } else if (existing.status === 400 || existing.status === 404) {
    const created = await fetch(base, {
      method: 'POST',
      headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    if (!created.ok) throw Error('Cannot create private storage bucket.');
  } else throw Error('Cannot verify storage bucket.');
  console.log('Mastra native tables, application tables and private storage are ready.');
} finally {
  await storage.close();
  await pool.end();
}
