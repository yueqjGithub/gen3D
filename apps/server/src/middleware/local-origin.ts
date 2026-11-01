import { timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { apiErrorSchema } from '@agent3d/shared';

export interface LocalOriginOptions {
  allowedOrigin: string;
  token: string;
}

function matchesToken(expected: string, actual: string | undefined): boolean {
  if (!actual) {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function createLocalOriginMiddleware({ allowedOrigin, token }: LocalOriginOptions) {
  return createMiddleware(async (context, next) => {
    const origin = context.req.header('Origin');
    if (origin !== allowedOrigin) {
      return context.json(apiErrorSchema.parse({
        code: 'UNAUTHORIZED',
        message: 'This local API origin is not allowed.',
        retryable: false,
      }), 403);
    }

    function setCorsHeaders(): void {
      context.header('Access-Control-Allow-Origin', allowedOrigin);
      context.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      context.header('Access-Control-Allow-Headers', 'Content-Type, X-Agent3D-Token');
      context.header('Vary', 'Origin');
      context.header('Cache-Control', 'no-store');
    }

    setCorsHeaders();

    if (context.req.method === 'OPTIONS') {
      return context.body(null, 204);
    }
    if (!matchesToken(token, context.req.header('X-Agent3D-Token'))) {
      return context.json(apiErrorSchema.parse({
        code: 'UNAUTHORIZED',
        message: 'The local API token is missing or invalid.',
        retryable: false,
      }), 403);
    }

    await next();
    setCorsHeaders();
  });
}
