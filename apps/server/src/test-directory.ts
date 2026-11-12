import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

export function createTestDirectory(prefix: string): string {
  const root = process.env.AGENT3D_TEST_DIRECTORY;
  if (!root) throw new Error('The Vitest temporary directory was not initialized.');
  return mkdtempSync(join(root, prefix));
}
