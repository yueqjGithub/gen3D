import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type StandaloneServer } from './index';
import { createTestDirectory } from './test-directory';

const serverURL = 'http://127.0.0.1:62586';
const servers: StandaloneServer[] = [];

function createDataDirectory(): string {
  return createTestDirectory('server-');
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe('Hono server', () => {
  it('serves the real API on its fixed loopback port and preserves its database', async () => {
    const dataDirectory = createDataDirectory();
    const server = await startServer(dataDirectory);
    servers.push(server);

    expect(server.databasePath).toBe(join(dataDirectory, 'agent3d.sqlite'));

    const origin = { Origin: 'http://localhost:5173' };
    const login = await fetch(`${serverURL}/api/login`, {
      method: 'POST',
      headers: { ...origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'test-user', password: 'test' }),
    });
    expect(login.status).toBe(200);
    const headers = { ...origin, Cookie: 'username=test-user' };
    const createResponse = await fetch(`${serverURL}/api/conversations`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Saved by Hono' }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversation: { id: string; title: string };
    };

    const listResponse = await fetch(`${serverURL}/api/conversations`, { headers });
    const list = await listResponse.json() as {
      conversations: Array<{ id: string; title: string }>;
    };
    expect(list.conversations).toContainEqual(created.conversation);

    const modelsResponse = await fetch(`${serverURL}/api/models`, { headers });
    expect(modelsResponse.status).toBe(200);
    await expect(modelsResponse.json()).resolves.toMatchObject({
      selection: {
        chat: {
          providerId: 'agnes',
          modelId: 'agnes/agnes-3.0-flash',
        },
      },
    });
  });

  it('fails visibly when the fixed port is already in use', async () => {
    const first = await startServer(createDataDirectory());
    servers.push(first);

    await expect(startServer(createDataDirectory())).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});
