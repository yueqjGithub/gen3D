import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('migration scripts in the Node development runtime', () => {
  it('loads SQL migrations without a Vite-only raw import loader', () => {
    const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
    const output = execFileSync(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import('./src/storage/migration-scripts.ts').then(({ databaseMigrations }) => console.log(databaseMigrations.length))",
    ], {
      cwd: serverRoot,
      encoding: 'utf8',
    });

    expect(output.trim()).toBe('3');
  });
});
