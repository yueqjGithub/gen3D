import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('loads the shared directory from the Mastra project root even when the working directory changes', async () => {
  const project = mkdtempSync(join(tmpdir(), 'agent3d-agent-config-'));
  const publicDirectory = join(project, 'public');
  const previousDirectory = process.cwd();
  const previousRoot = process.env.MASTRA_PROJECT_ROOT;
  mkdirSync(publicDirectory);
  writeFileSync(join(project, '.env'), 'AGENT3D_DATA_DIR=relative-path\n');
  process.env.MASTRA_PROJECT_ROOT = project;
  process.chdir(publicDirectory);
  try {
    await expect(import('./index')).rejects.toThrow(
      'AGENT3D_DATA_DIR in apps/agent/.env must be an absolute path.',
    );
  } finally {
    process.chdir(previousDirectory);
    if (previousRoot === undefined) delete process.env.MASTRA_PROJECT_ROOT;
    else process.env.MASTRA_PROJECT_ROOT = previousRoot;
    rmSync(project, { recursive: true, force: true });
  }
});
