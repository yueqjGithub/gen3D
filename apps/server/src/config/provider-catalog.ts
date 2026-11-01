import type { ModelSelection } from '@agent3d/shared';

export type ModelRole = 'chat' | 'image';
export type ProviderProtocol = 'openai-compatible' | 'anthropic';

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  supportsInlineImages: boolean;
  models: Record<ModelRole, readonly string[]>;
}

export const providerCatalog = {
  agnes: {
    id: 'agnes',
    name: 'Agnes AI',
    protocol: 'openai-compatible',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    supportsInlineImages: false,
    models: {
      chat: ['agnes/agnes-3.0-flash'],
      image: ['agnes-image-2.5-flash'],
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    supportsInlineImages: true,
    models: {
      chat: ['openai/gpt-4.1-mini'],
      image: ['openai/gpt-image-1'],
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    supportsInlineImages: true,
    models: {
      chat: ['anthropic/claude-sonnet-4-5'],
      image: [],
    },
  },
} satisfies Record<string, ProviderPreset>;

export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  chat: {
    providerId: 'agnes',
    modelId: 'agnes/agnes-3.0-flash',
    baseURL: providerCatalog.agnes.baseURL,
    apiKeyConfigured: false,
  },
  image: {
    providerId: 'agnes',
    modelId: 'agnes-image-2.5-flash',
    baseURL: providerCatalog.agnes.baseURL,
    apiKeyConfigured: false,
  },
};

export const providerOptions = Object.values(providerCatalog).map((provider) => ({
  id: provider.id,
  name: provider.name,
  protocol: provider.protocol,
  baseURL: provider.baseURL,
  supportsInlineImages: provider.supportsInlineImages,
  models: provider.models,
}));
