import { Mastra } from '@mastra/core/mastra';
import type { AssetAgentDependencies } from './asset-agent';
import { createAssetAgent } from './asset-agent';

// Keep this factory request-scoped so each run receives only the selected model's credentials.
export function createMastra(dependencies: AssetAgentDependencies) {
  return new Mastra({
    agents: {
      assetAgent: createAssetAgent(dependencies),
    },
  });
}
