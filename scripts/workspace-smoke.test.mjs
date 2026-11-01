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
