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

it('requires explicit Supabase configuration instead of silently creating a local database', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await expect(import('./index')).rejects.toThrow('Missing DATABASE_URL.');
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
