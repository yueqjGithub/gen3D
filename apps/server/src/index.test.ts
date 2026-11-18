import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { startServer, type StandaloneServer } from './index';

const closePool = vi.hoisted(() => vi.fn(async () => {}));
// 启动测试只替换数据库连接，不修改生产入口，也不连接真实 Supabase。
vi.mock('@mastra/pg', () => ({ PostgresStore: class {
  db = {};
  close = closePool;
} }));
const servers: StandaloneServer[] = [];
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/postgres');
  vi.stubEnv('SUPABASE_CA_PATH', fileURLToPath(new URL('../../../deploy/supabase-ca.crt', import.meta.url)));
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'test-secret');
  vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  vi.stubEnv('PORT', '62885');
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.unstubAllEnvs();
});
describe('Node Hono server', () => {
  it('serves the API on a real HTTP socket and closes its PostgreSQL pool', async () => {
    const server = await startServer();
    const response = await fetch('http://127.0.0.1:62885/api/login', { headers: { Origin: 'http://localhost:5173' } });
    expect(response.status).toBe(401);
    await server.close();
    expect(closePool).toHaveBeenCalled();
  });
  it('releases the new pool when the configured port is already in use', async () => {
    servers.push(await startServer());
    await expect(startServer()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
