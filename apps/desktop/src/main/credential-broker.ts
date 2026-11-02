import { timingSafeEqual } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CredentialStore } from '@agent3d/shared';
import { CredentialStorageUnavailableError } from './credentials';

const providerIdPattern = /^[a-zA-Z0-9._-]{1,80}$/;
const credentialBodySchema = z.object({
  apiKey: z.string().trim().min(1).max(4096),
}).strict();

export interface CredentialBrokerOptions {
  store: CredentialStore;
  token: string;
  port: number;
}

export interface CredentialBrokerServer {
  baseURL: string;
  port: number;
  close(): Promise<void>;
}

function isAuthorized(suppliedToken: string | undefined, expectedToken: Buffer): boolean {
  if (!suppliedToken) {
    return false;
  }
  const supplied = Buffer.from(suppliedToken);
  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
}

function createCredentialBrokerApp(store: CredentialStore, token: string) {
  const app = new Hono();
  const expectedToken = Buffer.from(token);

  app.use('*', async (context, next) => {
    if (!isAuthorized(context.req.header('X-Agent3D-Credential-Token'), expectedToken)) {
      return context.json({ message: 'Unauthorized.' }, 401);
    }
    await next();
  });

  app.get('/credentials/:providerId', async (context) => {
    const providerId = context.req.param('providerId');
    if (!providerIdPattern.test(providerId)) {
      return context.json({ message: 'Invalid provider ID.' }, 400);
    }

    try {
      return context.json({ apiKey: await store.get(providerId) });
    } catch (error) {
      return credentialStoreError(context, error);
    }
  });

  app.put('/credentials/:providerId', async (context) => {
    const providerId = context.req.param('providerId');
    if (!providerIdPattern.test(providerId)) {
      return context.json({ message: 'Invalid provider ID.' }, 400);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ message: 'Invalid credential request.' }, 400);
    }
    const parsedBody = credentialBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return context.json({ message: 'Invalid credential request.' }, 400);
    }

    try {
      await store.set(providerId, parsedBody.data.apiKey);
      return context.body(null, 204);
    } catch (error) {
      return credentialStoreError(context, error);
    }
  });

  app.delete('/credentials/:providerId', async (context) => {
    const providerId = context.req.param('providerId');
    if (!providerIdPattern.test(providerId)) {
      return context.json({ message: 'Invalid provider ID.' }, 400);
    }

    try {
      await store.delete(providerId);
      return context.body(null, 204);
    } catch (error) {
      return credentialStoreError(context, error);
    }
  });

  return app;
}

function credentialStoreError(
  context: Context,
  error: unknown,
): Response {
  if (error instanceof CredentialStorageUnavailableError) {
    return context.json({ message: 'Secure credential storage is unavailable.' }, 503);
  }
  return context.json({ message: 'The credential operation failed.' }, 500);
}

/**
 * Starts the authenticated broker on loopback and returns an idempotent shutdown handle.
 */
export function startCredentialBroker({
  store,
  token,
  port,
}: CredentialBrokerOptions): Promise<CredentialBrokerServer> {
  if (!token.trim()) {
    throw new TypeError('The credential broker token must be configured.');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError('The credential broker port is invalid.');
  }

  const app = createCredentialBrokerApp(store, token);
  const server: ServerType = serve({
    fetch: (request) => app.fetch(request),
    hostname: '127.0.0.1',
    port,
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('The credential broker did not bind to a TCP address.'));
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
        baseURL: `http://127.0.0.1:${address.port}`,
        port: address.port,
        close,
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}
