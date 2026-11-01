import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { ResolvedModelConfig } from '../config/model-resolver';

export function createMastraModel(config: ResolvedModelConfig): MastraModelConfig {
  if (config.protocol === 'openai-compatible') {
    return createOpenAICompatible({
      name: config.providerId,
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    }).chatModel(config.modelId);
  }

  const modelId = config.modelId.replace(new RegExp(`^${config.providerId}/`), '');
  return createAnthropic({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  }).messages(modelId);
}
