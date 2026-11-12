import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { createLoginRepository } from '../storage/login';
import { createLoginRoute } from './login';

const database = new Database(':memory:');
database.exec(`CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
const app = createLoginRoute(createLoginRepository(database));

afterEach(() => database.exec('DELETE FROM users'));

it('creates an account, sets a username cookie, and checks it on startup', async () => {
  expect((await app.request('/login')).status).toBe(401);
  const response = await app.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'secret' }),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('username=alice');
  expect((await app.request('/login', { headers: { Cookie: 'username=alice' } })).status).toBe(200);
  expect((await app.request('/login', { headers: { Cookie: 'username=missing' } })).status).toBe(401);
});

it('rejects wrong passwords and requires the old password to change them', async () => {
  const post = (path: string, body: object) => app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await post('/login', { username: 'alice', password: 'old' });
  expect((await post('/login', { username: 'alice', password: 'wrong' })).status).toBe(401);
  expect((await post('/login/password', { username: 'alice', oldPassword: 'wrong', newPassword: 'new' })).status).toBe(401);
  expect((await post('/login/password', { username: 'alice', oldPassword: 'old', newPassword: 'new' })).status).toBe(200);
  expect((await post('/login', { username: 'alice', password: 'old' })).status).toBe(401);
  expect((await post('/login', { username: 'alice', password: 'new' })).status).toBe(200);
});
