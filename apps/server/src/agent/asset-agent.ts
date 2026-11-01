import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import {
  agentStructuredOutputSchema,
  type AgentStructuredOutput,
} from '@agent3d/shared';
import type { AttachmentStore } from '../storage/attachments';
import type { PreferenceRepository } from '../storage/preferences';
import { assetAgentInstructions } from './prompts/asset-agent';
import { createAnalyzeInputTool } from './tools/analyze-input';
import { createBuildAssetBriefTool } from './tools/build-asset-brief';
import { createValidateBlenderScriptTool } from './tools/generate-blender-script';
import { createPreferenceProposalTool } from './tools/update-preferences';

export interface AssetAgentDependencies {
  model: MastraModelConfig;
  preferences: PreferenceRepository;
  attachments: AttachmentStore;
  supportsInlineImages: boolean;
}

export type AssetAgent = Agent<
  'asset-creation-agent',
  {
    analyzeInput: ReturnType<typeof createAnalyzeInputTool>;
    buildAssetBrief: ReturnType<typeof createBuildAssetBriefTool>;
    validateBlenderScript: ReturnType<typeof createValidateBlenderScriptTool>;
    proposePreferenceUpdate: ReturnType<typeof createPreferenceProposalTool>;
  },
  AgentStructuredOutput
>;

export function createAssetAgent({
  model,
  preferences,
  attachments,
  supportsInlineImages,
}: AssetAgentDependencies): AssetAgent {
  const tools = {
    analyzeInput: createAnalyzeInputTool(attachments, supportsInlineImages),
    buildAssetBrief: createBuildAssetBriefTool(preferences),
    validateBlenderScript: createValidateBlenderScriptTool(),
    proposePreferenceUpdate: createPreferenceProposalTool(preferences),
  };

  return new Agent<'asset-creation-agent', typeof tools, AgentStructuredOutput>({
    id: 'asset-creation-agent',
    name: '3D Asset Creation Agent',
    instructions: assetAgentInstructions,
    model,
    tools,
    defaultOptions: {
      structuredOutput: {
        schema: agentStructuredOutputSchema,
      },
    },
    maxRetries: 2,
  });
}
