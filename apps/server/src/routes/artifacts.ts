import { Hono } from 'hono';
import {
  artifactApprovalSchema,
  assetArtifactSchema,
} from '@agent3d/shared';
import { z } from 'zod';
import type { createArtifactRepository } from '../storage/artifacts';
import { HttpError } from '../http-errors';
import { validateBlenderScript } from '../agent/validate-script';

type ArtifactRepository = ReturnType<typeof createArtifactRepository>;

const editArtifactSchema = z.object({
  expectedVersion: z.number().int().positive(),
  script: assetArtifactSchema.shape.script,
}).strict();

export function createArtifactRoutes(artifacts: ArtifactRepository) {
  const routes = new Hono();

  routes.get('/artifacts/:id', (context) => {
    const artifact = artifacts.get(context.req.param('id'));
    if (!artifact) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested artifact does not exist.');
    }
    return context.json({
      artifact,
      scriptValidation: validateBlenderScript(artifact.script),
    });
  });

  routes.patch('/artifacts/:id', async (context) => {
    const body = editArtifactSchema.parse(await context.req.json());
    const artifact = artifacts.updatePending(
      context.req.param('id'),
      body.expectedVersion,
      body.script,
    );
    return context.json({
      artifact,
      scriptValidation: validateBlenderScript(artifact.script),
    });
  });

  routes.post('/artifacts/:id/approve', async (context) => {
    const { expectedVersion } = artifactApprovalSchema.parse(await context.req.json());
    const current = artifacts.get(context.req.param('id'));
    if (!current) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested artifact does not exist.');
    }
    const validation = validateBlenderScript(current.script);
    if (!validation.ok) {
      throw new HttpError(
        422,
        'VALIDATION_FAILED',
        `The Blender script must be corrected before approval (${validation.code}).`,
      );
    }
    return context.json({
      artifact: artifacts.setStatus(current.id, expectedVersion, 'approved'),
    });
  });

  routes.post('/artifacts/:id/reject', async (context) => {
    const { expectedVersion } = artifactApprovalSchema.parse(await context.req.json());
    return context.json({
      artifact: artifacts.setStatus(context.req.param('id'), expectedVersion, 'rejected'),
    });
  });

  routes.get('/artifacts/:id/download', (context) => {
    const artifact = artifacts.get(context.req.param('id'));
    if (!artifact) {
      throw new HttpError(404, 'NOT_FOUND', 'The requested artifact does not exist.');
    }
    if (artifact.status !== 'approved') {
      throw new HttpError(409, 'CONFLICT', 'Only approved assets can be downloaded.');
    }

    return new Response(artifact.script, {
      headers: {
        'Content-Type': 'text/x-python; charset=utf-8',
        'Content-Disposition': `attachment; filename="asset-${artifact.id}-v${artifact.version}.py"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  return routes;
}
