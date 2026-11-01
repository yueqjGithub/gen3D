import { serve, type ServerType } from '@hono/node-server';
import type { Hono } from 'hono';

export interface LocalApiServer {
  baseUrl: string;
  port: number;
  close(): Promise<void>;
}

export interface AppLifecycle {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
}

export function listenLocalApi(app: Hono): Promise<LocalApiServer> {
  const server: ServerType = serve({
    fetch: (request) => app.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('The local API did not bind to a TCP address.'));
        return;
      }

      let closing: Promise<void> | null = null;
      const close = () => {
        if (closing) {
          return closing;
        }
        closing = new Promise<void>((closeResolve, closeReject) => {
          server.close((error) => {
            if (error) {
              closeReject(error);
            } else {
              closeResolve();
            }
          });
        });
        return closing;
      };

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close,
      });
    });
  });
}

export function registerServerShutdown(
  lifecycle: AppLifecycle,
  shutdown: () => Promise<void>,
  quit: () => void,
): void {
  let stopping = false;
  let finished = false;
  lifecycle.on('before-quit', (event) => {
    if (finished) {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    void shutdown().then(() => {
      finished = true;
      quit();
    }).catch((error: unknown) => {
      console.error('Failed to close the local API server cleanly.', error);
      finished = true;
      quit();
    });
  });
}
