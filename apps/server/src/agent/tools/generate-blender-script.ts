import { createTool } from '@mastra/core/tools';
import {
  assetGenerationOutputSchema,
  type AssetGenerationOutput,
} from '@agent3d/shared';
import { z } from 'zod';
import { validateBlenderScript } from '../validate-script';

export class InvalidBlenderScriptError extends Error {
  constructor(code: string) {
    super(`Generated Blender script failed static validation: ${code}`);
    this.name = 'InvalidBlenderScriptError';
  }
}

export function parseAgentOutput(value: unknown): AssetGenerationOutput {
  const output = assetGenerationOutputSchema.parse(value);
  const validation = validateBlenderScript(output.script);
  if (!validation.ok) {
    throw new InvalidBlenderScriptError(validation.code);
  }
  return output;
}

const scriptValidationSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['empty', 'too_large', 'missing_bpy', 'blocked_pattern']),
  }),
]);

export function createValidateBlenderScriptTool() {
  return createTool({
    id: 'validate-blender-script',
    description: 'Statically check a Blender 4.x script. This never runs the script.',
    inputSchema: z.object({ script: z.string().max(100 * 1024) }),
    outputSchema: scriptValidationSchema,
    execute: async ({ script }) => validateBlenderScript(script),
  });
}
