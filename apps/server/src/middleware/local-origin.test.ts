import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createLocalOriginMiddleware } from './local-origin';

const app = new Hono();
app.use('*', createLocalOriginMiddleware());
app.get('/', (context) => context.text('ok'));

describe('local renderer origin boundary', () => {
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
