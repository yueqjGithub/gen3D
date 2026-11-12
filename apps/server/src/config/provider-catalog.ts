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

/**
 * 模型提供商目录：决定界面里可选的 provider 和模型。
 * 这里不保存 API Key，聊天请求从客户端携带密钥。
 * image 数组暂时只用于设置页面展示，对话模型才会真正被 Agent 调用。
 */
export const providerCatalog = {
  agnes: {
    id: 'agnes',
    name: 'Agnes AI',
    protocol: 'openai-compatible',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    supportsInlineImages: true,
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

// 首次使用、数据库里还没有保存设置时的默认选择
export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  chat: {
    providerId: 'agnes',
    modelId: 'agnes/agnes-3.0-flash',
    baseURL: providerCatalog.agnes.baseURL,
  },
  image: {
    providerId: 'agnes',
    modelId: 'agnes-image-2.5-flash',
    baseURL: providerCatalog.agnes.baseURL,
  },
};

// 返回给设置页面的提供商列表
export const providerOptions = Object.values(providerCatalog);
