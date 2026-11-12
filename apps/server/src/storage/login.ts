import type { SqliteDatabase } from './database';

type User = {
  id: number;
  username: string;
  password: string;
  created_at: string;
};

/** 用户表与 Mastra 会话表共用同一个 SQLite 连接。 */
export function createLoginRepository(database: SqliteDatabase) {
  const get = (username: string): User | undefined => {
    return database.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  }
  return {
    get,
    create(username: string, password: string): void {
      const already = get(username);
      if (already) {
        throw new Error('User already exists');
      }
      database.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, password);
    },
    updatePassword(username: string, password: string): void {
      database.prepare('UPDATE users SET password = ? WHERE username = ?').run(password, username);
    },
  };
}
