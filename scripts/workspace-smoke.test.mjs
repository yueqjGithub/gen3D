import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8');
}

function readPackage(relativePath) {
  return JSON.parse(read(relativePath));
}

test('root package uses pnpm 12 and preserves the workspace commands', () => {
  const packageJson = readPackage('package.json');
  assert.match(packageJson.packageManager, /^pnpm@12\./);
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ['build', 'dev', 'test', 'typecheck']);
  assert.equal(
    packageJson.scripts.dev,
    'pnpm --parallel --filter @agent3d/agent --filter @agent3d/server --filter @agent3d/desktop dev',
  );
  assert.match(packageJson.engines?.node ?? '', />=22\.13\.0/);
});

test('Mastra owns the fixed Agent port and reads provider keys from its local environment', () => {
  const packageJson = readPackage('apps/agent/package.json');
  const environmentExample = read('apps/agent/.env.example');
  const entrypoint = read('apps/agent/src/mastra/index.ts');
  const agent = read('apps/agent/src/mastra/agents/agent.ts');

  assert.equal(packageJson.name, '@agent3d/agent');
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ['build', 'dev', 'start']);
  assert.equal(packageJson.scripts.dev, 'pnpm dotenv run -f ../../.env mastra dev');
  assert.equal(packageJson.devDependencies?.hono, undefined);
  assert.deepEqual(environmentExample.match(/^[A-Z_]+=.*$/gm), [
    'AGNES_API_KEY=',
    'OPENAI_API_KEY=',
    'ANTHROPIC_API_KEY=',
  ]);
  assert.match(entrypoint, /host:\s*process\.env\.AGENT3D_AGENT_HOST\s*\?\?\s*'127\.0\.0\.1'/);
  assert.match(entrypoint, /port:\s*62687/);
  assert.match(entrypoint, /path:\s*'\/chat\/:agentId'/);
  assert.match(entrypoint, /version:\s*'v7'/);
  assert.match(entrypoint, /sendReasoning:\s*true/);
  assert.match(entrypoint, /context\.get\('requestContext'\)\.set\('agent3d', agent3d\)/);
  assert.match(agent, /instructions:\s*`/);
  assert.match(agent, /tools:\s*\(\{\s*requestContext\s*\}\)\s*=>\s*\{/);
  assert.match(agent, /process\.env\.AGNES_API_KEY/);
});

test('Hono binds the fixed local address and calls the native Agent endpoint', () => {
  const packageJson = readPackage('apps/server/package.json');
  const server = read('apps/server/src/index.ts');
  const originMiddleware = read('apps/server/src/middleware/local-origin.ts');

  for (const command of ['dev', 'test', 'typecheck', 'build']) {
    assert.ok(packageJson.scripts?.[command], `missing server script: ${command}`);
  }
  assert.match(server, /hostname:\s*process\.env\.HOST\s*\?\?\s*'127\.0\.0\.1'/);
  assert.match(server, /port:\s*Number\(process\.env\.PORT\s*\?\?\s*62586\)/);
  assert.match(read('apps/server/src/agent-client.ts'), /http:\/\/127\.0\.0\.1:62687\/chat\/asset-creation-agent/);
  assert.match(originMiddleware, /http:\/\/localhost:5173/);
  assert.match(originMiddleware, /'null'/);
  assert.doesNotMatch(server, /process\.env\.(?:AGENT3D_SERVER|AGENT3D_AGENT)_/);
  assert.equal(existsSync(join(root, 'apps/server/.env.example')), false);
});

test('Electron only creates the window and renderer calls Hono directly', () => {
  const packageJson = readPackage('apps/desktop/package.json');
  const main = read('apps/desktop/src/main/index.ts');
  const client = read('apps/desktop/src/renderer/src/api/client.ts');
  const rendererConfig = read('apps/desktop/electron.vite.config.ts');

  assert.equal(packageJson.main, 'out/main/index.js');
  assert.equal(packageJson.dependencies?.hono, undefined);
  assert.equal(packageJson.dependencies?.['@hono/node-server'], undefined);
  assert.match(main, /new BrowserWindow/);
  assert.match(main, /accelerator:\s*'F12'/);
  assert.doesNotMatch(main, /safeStorage|credential|token|createApp|createDatabase/i);
  assert.match(client, /http:\/\/127\.0\.0\.1:62586/);
  assert.doesNotMatch(client, /token|authHeaders|saveCredential|removeCredential/i);
  assert.match(rendererConfig, /port:\s*5173/);
  assert.match(rendererConfig, /strictPort:\s*true/);
  assert.equal(existsSync(join(root, 'apps/desktop/src/preload/index.ts')), false);
});

test('desktop components use the shared local API directly without an injected client factory', () => {
  const client = read('apps/desktop/src/renderer/src/api/client.ts');
  assert.match(client, /export const api\s*=/);
  assert.doesNotMatch(client, /createApiClient/);
  for (const file of [
    'App.tsx',
    'features/chat/ChatView.tsx',
    'features/assets/AssetPanel.tsx',
    'features/settings/ModelSettings.tsx',
    'features/settings/PreferenceSettings.tsx',
  ]) {
    const component = read(`apps/desktop/src/renderer/src/${file}`);
    assert.match(component, /import \{ api \} from/);
    assert.doesNotMatch(component, /api:\s*ApiClient|api=\{api\}/);
  }
});

test('Agent environment example documents the shared data directory and credentials', () => {
  const agentEnvironment = read('apps/agent/.env.example');
  const documented = read('README.md');

  assert.equal(existsSync(join(root, '.env.example')), false);
  assert.deepEqual(agentEnvironment.match(/^[A-Z0-9_]+=.*$/gm), [
    'AGENT3D_DATA_DIR=',
    'AGNES_API_KEY=',
    'OPENAI_API_KEY=',
    'ANTHROPIC_API_KEY=',
  ]);
  assert.match(documented, /AGNES_API_KEY/);
  assert.match(documented, /apps\/agent\/\.env/);
  for (const port of ['5173', '62586', '62687']) {
    assert.ok(documented.includes(port), `README is missing fixed port ${port}`);
  }
});

test('workspace keeps the shared packages and renderer entrypoint', () => {
  const workspace = read('pnpm-workspace.yaml');
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
  assert.ok(existsSync(join(root, 'apps/desktop/src/renderer/src/main.tsx')));
});
