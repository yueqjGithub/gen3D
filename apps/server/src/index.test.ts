import { createServer as createTcpServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './storage/database';

interface StandaloneServerHandle {
  baseURL: string;
  databasePath: string;
  close(): Promise<void>;
}

interface StandaloneServerModule {
  startServer(options: {
    source: Record<string, string | undefined>;
    platform: NodeJS.Platform;
    homeDirectory: string;
    appName: string;
  }): Promise<StandaloneServerHandle>;
}

let standaloneServerModule: StandaloneServerModule | undefined;
const servers: StandaloneServerHandle[] = [];
const directories: string[] = [];

beforeAll(async () => {
  const module = await import('./index').catch(() => null);
  expect(module).not.toBeNull();
  if (!module) {
    throw new Error('Standalone Hono server entrypoint is missing.');
  }
  standaloneServerModule = module as StandaloneServerModule;
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve a free TCP port for the server test.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  return address.port;
}

function moduleUnderTest(): StandaloneServerModule {
  if (!standaloneServerModule) {
    throw new Error('Standalone server entrypoint did not load.');
  }
  return standaloneServerModule;
}

describe('standalone Hono server', () => {
  it('binds loopback, shares the configured database, and closes cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-server-'));
    directories.push(directory);
    const dataDirectory = join(directory, 'user-data');
    const serverPort = await unusedPort();
    const agentPort = await unusedPort();
    const brokerPort = await unusedPort();
    const databasePath = join(dataDirectory, 'data', 'agent3d.sqlite');
    const seededDatabase = createDatabase(databasePath);
    seededDatabase.connection.exec('CREATE TABLE preserved_data (value TEXT NOT NULL)');
    seededDatabase.connection.prepare(
      'INSERT INTO preserved_data (value) VALUES (?)',
    ).run('keep-existing-data');
    seededDatabase.close();

    const server = await moduleUnderTest().startServer({
      source: {
        AGENT3D_MOCK_MODE: 'true',
        AGENT3D_DATA_DIR: dataDirectory,
        AGENT3D_SERVER_URL: `http://127.0.0.1:${serverPort}`,
        AGENT3D_SERVER_TOKEN: 'test-server-token',
        AGENT3D_AGENT_URL: `http://127.0.0.1:${agentPort}`,
        AGENT3D_AGENT_TOKEN: 'test-agent-token',
        AGENT3D_CREDENTIAL_BROKER_PORT: String(brokerPort),
        AGENT3D_CREDENTIAL_BROKER_TOKEN: 'test-broker-token',
      },
      platform: process.platform,
      homeDirectory: tmpdir(),
      appName: '@agent3d/desktop',
    });
    servers.push(server);

    expect(server.baseURL).toBe(`http://127.0.0.1:${serverPort}`);
    expect(server.databasePath).toBe(databasePath);

    const headers = {
      'Content-Type': 'application/json',
      'Origin': 'http://localhost:5173',
      'X-Agent3D-Token': 'test-server-token',
    };
    const createResponse = await fetch(`${server.baseURL}/api/conversations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Persisted through the standalone server' }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      conversation: { id: string; title: string };
    };
    const listResponse = await fetch(`${server.baseURL}/api/conversations`, {
      headers,
    });
    const list = await listResponse.json() as {
      conversations: Array<{ id: string; title: string }>;
    };
    expect(list.conversations).toContainEqual(created.conversation);

    const modelsResponse = await fetch(`${server.baseURL}/api/models`, { headers });
    expect(modelsResponse.status).toBe(502);
    await expect(modelsResponse.json()).resolves.toMatchObject({ retryable: true });

    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const reopenedDatabase = createDatabase(databasePath);
    try {
      expect(reopenedDatabase.connection.prepare(
        'SELECT value FROM preserved_data',
      ).get()).toEqual({ value: 'keep-existing-data' });
    } finally {
      reopenedDatabase.close();
    }
  });

  it('rejects invalid ports and missing required tokens before opening user data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-server-invalid-'));
    directories.push(directory);
    const dataDirectory = join(directory, 'user-data');
    const validSource = {
      AGENT3D_SERVER_URL: 'http://127.0.0.1:62686',
      AGENT3D_SERVER_TOKEN: 'test-server-token',
      AGENT3D_AGENT_URL: 'http://127.0.0.1:62687',
      AGENT3D_AGENT_TOKEN: 'test-agent-token',
      AGENT3D_CREDENTIAL_BROKER_TOKEN: 'test-broker-token',
      AGENT3D_DATA_DIR: dataDirectory,
    };

    await expect(moduleUnderTest().startServer({
      source: { ...validSource, AGENT3D_SERVER_URL: 'http://127.0.0.1:70000' },
      platform: process.platform,
      homeDirectory: tmpdir(),
      appName: '@agent3d/desktop',
    })).rejects.toThrow('AGENT3D_SERVER_URL');
    await expect(moduleUnderTest().startServer({
      source: { ...validSource, AGENT3D_SERVER_TOKEN: '' },
      platform: process.platform,
      homeDirectory: tmpdir(),
      appName: '@agent3d/desktop',
    })).rejects.toThrow('AGENT3D_SERVER_TOKEN');

    expect(existsSync(dataDirectory)).toBe(false);
  });
});
