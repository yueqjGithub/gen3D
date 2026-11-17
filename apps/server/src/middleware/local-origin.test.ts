import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createLocalOriginMiddleware } from './local-origin';

const app = new Hono();
app.use('*', createLocalOriginMiddleware());
app.get('/', (context) => context.text('ok'));

describe('local renderer origin boundary', () => {
  it('accepts the configured Web origin and same-site images while rejecting cross-site writes', async () => {
    vi.stubEnv('AGENT3D_WEB_ORIGIN', 'https://workbench.example.com');
    try {
      const web = new Hono();
      web.use('*', createLocalOriginMiddleware());
      web.all('/', context => context.text('ok'));
      expect((await web.request('/', { headers: { Origin: 'https://workbench.example.com' } })).status).toBe(200);
      expect((await web.request('/', { headers: { Host: 'workbench.example.com' } })).status).toBe(200);
      expect((await web.request('/', { method: 'POST', headers: { Host: 'workbench.example.com' } })).status).toBe(403);
      expect((await web.request('/', { headers: { Origin: 'https://other.example.com', Host: 'workbench.example.com' } })).status).toBe(403);
      expect((await web.request('/', { headers: { Host: 'other.example.com' } })).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('allows the fixed development renderer without an API token', async () => {
    const response = await app.request('/', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('allows the packaged file origin', async () => {
    const response = await app.request('/', {
      headers: {
        Origin: 'null',
        'User-Agent': 'Mozilla/5.0 Electron/45.2.1',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('null');
  });

  it('allows packaged Electron requests that omit Origin', async () => {
    const response = await app.request('/', {
      headers: { 'User-Agent': 'Mozilla/5.0 Electron/45.2.1' },
    });
    expect(response.status).toBe(200);
  });

  it('rejects opaque origins from ordinary browsers', async () => {
    const response = await app.request('/', {
      headers: {
        Origin: 'null',
        'User-Agent': 'Mozilla/5.0 Chrome/140.0.0.0',
      },
    });

    expect(response.status).toBe(403);
  });

  it('rejects unexpected browser origins', async () => {
    const response = await app.request('/', {
      headers: { Origin: 'https://example.com' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'UNAUTHORIZED',
      retryable: false,
    });
  });
});
