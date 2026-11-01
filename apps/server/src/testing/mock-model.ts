import type { AgentStructuredOutput } from '@agent3d/shared';
import type { MastraChatAgent } from '../streaming/mastra-ui-stream';

const demoOutput: AgentStructuredOutput = {
  result: {
    type: 'asset',
    brief: 'A small stoneware bowl with a gently irregular rim.',
    script: [
      'import bpy',
      'import math',
      '',
      'bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=1.0, depth=0.25)',
      'bowl = bpy.context.object',
      'bowl.name = "Stoneware Bowl"',
      'bowl.modifiers.new(name="Solidify", type="SOLIDIFY").thickness = 0.12',
      'bowl.modifiers.new(name="Subdivision", type="SUBSURF").levels = 2',
    ].join('\n'),
    blenderVersion: '4.x',
    preferenceProposals: [],
  },
};

export function createMockModelAgent(): MastraChatAgent {
  return {
    async stream() {
      const fullStream = (async function* () {
        yield {
          type: 'reasoning-start',
          payload: { id: 'mock-reasoning' },
        };
        yield {
          type: 'reasoning-delta',
          payload: {
            id: 'mock-reasoning',
            text: '我会把参考内容转化为可审阅的基础体块和材质建议。',
          },
        };
        yield {
          type: 'reasoning-end',
          payload: { id: 'mock-reasoning' },
        };
        yield {
          type: 'tool-call-input-available',
          payload: { toolCallId: 'mock-analyze', toolName: 'analyze-input' },
        };
        yield {
          type: 'tool-call-output-available',
          payload: { toolCallId: 'mock-analyze', toolName: 'analyze-input' },
        };
        yield {
          type: 'text-start',
          payload: { id: 'mock-reply' },
        };
        yield {
          type: 'text-delta',
          payload: {
            id: 'mock-reply',
            text: '我已根据你的描述准备好一个 Blender 4.x 碗形资产草稿，可在右侧审阅。',
          },
        };
        yield {
          type: 'text-end',
          payload: { id: 'mock-reply' },
        };
        yield { type: 'finish', payload: { finishReason: 'stop' } };
      })();
      return {
        fullStream,
        object: Promise.resolve(demoOutput),
      };
    },
  };
}
