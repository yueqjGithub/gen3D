import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

test('root package uses pnpm 12 and defines required commands', () => {
  const packagePath = join(root, 'package.json');
  assert.ok(existsSync(packagePath), 'root package.json must exist');

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.match(packageJson.packageManager, /^pnpm@12\./);
  for (const command of ['dev', 'build', 'test', 'typecheck']) {
    assert.ok(packageJson.scripts?.[command], `missing root script: ${command}`);
  }
  assert.equal(
    packageJson.scripts.dev,
    'pnpm --parallel --filter @agent3d/agent --filter @agent3d/server --filter @agent3d/desktop dev',
  );
  assert.match(packageJson.engines?.node ?? '', />=22\.13\.0/);
});

test('Mastra Agent has an independent workspace and project commands', () => {
  const packagePath = join(root, 'apps', 'agent', 'package.json');
  assert.ok(existsSync(packagePath), 'Agent package.json must exist');

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  assert.equal(packageJson.name, '@agent3d/agent');
  assert.ok(existsSync(join(root, 'apps', 'agent', 'src', 'mastra', 'index.ts')));
  for (const command of ['dev', 'test', 'typecheck', 'build']) {
    assert.ok(packageJson.scripts?.[command], `missing Agent script: ${command}`);
  }
  assert.match(packageJson.scripts.dev, /--env-file-if-exists=\.\.\/\.\.\/\.env/);
  assert.match(packageJson.scripts.dev, /mastra.*dev/);
  assert.ok(packageJson.dependencies?.['@mastra/ai-sdk']);
  assert.ok(packageJson.dependencies?.['@mastra/core']);
  assert.ok(packageJson.devDependencies?.mastra, 'Mastra CLI must be a development dependency');
});

test('Hono server has standalone root-env development and Node ESM build commands', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'apps', 'server', 'package.json'), 'utf8'));

  for (const command of ['dev', 'test', 'typecheck', 'build']) {
    assert.ok(packageJson.scripts?.[command], `missing server script: ${command}`);
  }
  assert.match(packageJson.scripts.dev, /--env-file-if-exists=\.\.\/\.\.\/\.env/);
  assert.match(packageJson.scripts.dev, /tsx/);
  assert.match(packageJson.scripts.build, /esbuild/);
  assert.match(packageJson.scripts.build, /--format=esm/);
});

test('Electron main does not construct Hono or own backend storage', () => {
  const desktopPackage = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
  const mainSource = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'index.ts'), 'utf8');

  assert.doesNotMatch(
    mainSource,
    /import.*\b(?:createApp|createDatabase|listenLocalApi|createAgentClient)\b|createApp\s*\(/,
  );
  assert.equal(desktopPackage.dependencies?.['better-sqlite3'], undefined);
  assert.equal(desktopPackage.dependencies?.['pdfjs-dist'], undefined);
  assert.ok(desktopPackage.dependencies?.hono, 'Electron still hosts the safeStorage credential broker');
});

test('root environment example documents stable loopback service configuration', () => {
  const example = readFileSync(join(root, '.env.example'), 'utf8');

  for (const setting of [
    'AGENT3D_SERVER_URL=http://127.0.0.1:62586',
    'AGENT3D_SERVER_TOKEN=',
    'AGENT3D_RENDERER_ORIGIN=http://localhost:5173',
    'AGENT3D_AGENT_URL=http://127.0.0.1:62687',
    'AGENT3D_AGENT_TOKEN=',
    'AGENT3D_CREDENTIAL_BROKER_PORT=62588',
    'AGENT3D_CREDENTIAL_BROKER_TOKEN=',
    'AGENT3D_MOCK_MODE=true',
    'AGENT3D_DATA_DIR=',
  ]) {
    assert.ok(example.includes(setting), `missing environment example: ${setting}`);
  }
});

test('pnpm workspace includes app and package directories', () => {
  const workspacePath = join(root, 'pnpm-workspace.yaml');
  assert.ok(existsSync(workspacePath), 'pnpm-workspace.yaml must exist');

  const workspace = readFileSync(workspacePath, 'utf8');
  assert.match(workspace, /apps\/\*/);
  assert.match(workspace, /packages\/\*/);
});

test('Electron renderer has a React entrypoint', () => {
  assert.ok(
    existsSync(join(root, 'apps', 'desktop', 'src', 'renderer', 'src', 'main.tsx')),
    'React renderer entrypoint must exist',
  );
});

test('Electron package points at the built main entrypoint', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
  assert.equal(packageJson.main, 'out/main/index.js');
});
