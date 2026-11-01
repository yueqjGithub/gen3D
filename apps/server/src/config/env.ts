export interface ServerEnvironment {
  mockMode: boolean;
  chatApiKey: string | null;
  imageApiKey: string | null;
}

function optionalSecret(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function readServerEnvironment(
  source: Record<string, string | undefined> = process.env,
): ServerEnvironment {
  const mockMode = source.AGENT3D_MOCK_MODE ?? 'false';
  if (mockMode !== 'true' && mockMode !== 'false') {
    throw new TypeError('AGENT3D_MOCK_MODE must be "true" or "false".');
  }

  return {
    mockMode: mockMode === 'true',
    chatApiKey: optionalSecret(source.AGENT3D_CHAT_API_KEY),
    imageApiKey: optionalSecret(source.AGENT3D_IMAGE_API_KEY),
  };
}
