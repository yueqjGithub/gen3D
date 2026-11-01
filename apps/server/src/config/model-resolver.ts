import type {
  CredentialReader,
  ModelConfig,
} from '@agent3d/shared';
import { providerCatalog, type ModelRole } from './provider-catalog';

export class UnsupportedProviderError extends Error {
  constructor(providerId: string, modelId: string) {
    super(`The provider/model combination is not supported: ${providerId}/${modelId}`);
    this.name = 'UnsupportedProviderError';
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor(providerId: string) {
    super(`Configure an API key for ${providerId} before making a request.`);
    this.name = 'ProviderNotConfiguredError';
  }
}

export interface ResolvedModelConfig {
  providerId: string;
  modelId: string;
  baseURL: string;
  protocol: 'openai-compatible' | 'anthropic';
  supportsInlineImages: boolean;
  apiKey: string;
}

export async function resolveModel(
  selection: ModelConfig,
  role: ModelRole,
  credentials: CredentialReader,
): Promise<ResolvedModelConfig> {
  const provider = Object.values(providerCatalog).find(({ id }) => id === selection.providerId);
  if (!provider) {
    throw new UnsupportedProviderError(selection.providerId, selection.modelId);
  }

  const supportedModels: readonly string[] = provider.models[role];
  if (!supportedModels.includes(selection.modelId)) {
    throw new UnsupportedProviderError(selection.providerId, selection.modelId);
  }

  const apiKey = await credentials.get(provider.id);
  if (!apiKey) {
    throw new ProviderNotConfiguredError(provider.id);
  }

  const baseURL = new URL(selection.baseURL);
  if (baseURL.protocol !== 'https:' && baseURL.protocol !== 'http:') {
    throw new TypeError('Model base URL must use HTTP or HTTPS.');
  }

  return {
    providerId: provider.id,
    modelId: selection.modelId,
    baseURL: baseURL.toString().replace(/\/$/, ''),
    protocol: provider.protocol,
    supportsInlineImages: provider.supportsInlineImages,
    apiKey,
  };
}
