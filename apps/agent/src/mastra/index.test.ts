import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SpanType } from '@mastra/core/observability';
import { LibSQLStore } from '@mastra/libsql';

it('keeps JSON-looking trace previews as text in the Studio list and detail', async () => {
  const storage = new LibSQLStore({ id: 'trace-preview-test', url: ':memory:' });
  try {
    await storage.init();
    const traces = await storage.getStore('observability');
    if (!traces) throw new Error('Missing observability store');
    const previews = { inputPreview: '[1, 2]', outputPreview: '{"kind":"model"}', errorPreview: '{}' };
    await traces.createSpan({ span: {
      traceId: 'test-trace', spanId: 'root', name: 'test', spanType: SpanType.AGENT_RUN,
      isEvent: false, startedAt: new Date(), ...previews,
    } });
    expect((await traces.listTracesLight({})).spans[0]).toMatchObject(previews);
    expect((await traces.getTraceLight({ traceId: 'test-trace' }))?.spans[0]).toMatchObject(previews);
  } finally {
    await storage.close();
  }
});

it('loads the shared directory from the Mastra project root even when the working directory changes', async () => {
  const project = mkdtempSync(join(tmpdir(), 'agent3d-agent-config-'));
  const publicDirectory = join(project, 'public');
  const previousDirectory = process.cwd();
  const previousRoot = process.env.MASTRA_PROJECT_ROOT;
  const previousDataDirectory = process.env.AGENT3D_DATA_DIR;
  process.env.AGENT3D_DATA_DIR = 'relative-path';
  mkdirSync(publicDirectory);
  writeFileSync(join(project, '.env'), 'AGENT3D_DATA_DIR=relative-path\n');
  process.env.MASTRA_PROJECT_ROOT = project;
  process.chdir(publicDirectory);
  try {
    await expect(import('./index')).rejects.toThrow(
      'AGENT3D_DATA_DIR must be an absolute path.',
    );
  } finally {
    process.chdir(previousDirectory);
    if (previousDataDirectory === undefined) delete process.env.AGENT3D_DATA_DIR;
    else process.env.AGENT3D_DATA_DIR = previousDataDirectory;
    if (previousRoot === undefined) delete process.env.MASTRA_PROJECT_ROOT;
    else process.env.MASTRA_PROJECT_ROOT = previousRoot;
    rmSync(project, { recursive: true, force: true });
  }
});
