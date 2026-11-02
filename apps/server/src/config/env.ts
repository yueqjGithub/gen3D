export interface ServerEnvironment {
  mockMode: boolean;
  chatApiKey: string | null;
  imageApiKey: string | null;
  serverUrl: string;
  serverPort: number;
  serverToken: string;
  rendererOrigin: string;
  agentServiceUrl: string;
  agentServiceToken: string;
  credentialBrokerPort: number;
  credentialBrokerToken: string;
}

function optionalSecret(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function credentialBrokerPort(value: string | undefined): number {
  const port = value === undefined ? 62588 : Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('AGENT3D_CREDENTIAL_BROKER_PORT must be a valid TCP port.');
  }
  return port;
}

function requiredServerURL(value: string | undefined): { url: string; port: number } {
  const normalized = value?.trim();
  if (!normalized) {
    throw new TypeError('AGENT3D_SERVER_URL must be configured.');
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError('AGENT3D_SERVER_URL must be an HTTP URL bound to 127.0.0.1.');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new TypeError('AGENT3D_SERVER_URL must be an HTTP URL with a valid port bound to 127.0.0.1.');
  }
  return { url: url.origin, port };
}

function requiredRendererOrigin(value: string | undefined): string {
  const normalized = value?.trim() || 'http://localhost:5173';
  if (normalized === 'null') {
    return normalized;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError('AGENT3D_RENDERER_ORIGIN must be an HTTP origin or "null".');
  }
  if (
    url.protocol !== 'http:'
    || url.origin !== normalized
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new TypeError('AGENT3D_RENDERER_ORIGIN must be an HTTP origin or "null".');
  }
  return url.origin;
}

function requiredAgentServiceUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new TypeError('AGENT3D_AGENT_URL must be configured.');
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError('AGENT3D_AGENT_URL must be an HTTP URL bound to 127.0.0.1.');
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new TypeError('AGENT3D_AGENT_URL must be an HTTP URL bound to 127.0.0.1.');
  }
  return url.origin;
}

export function readServerEnvironment(
  source: Record<string, string | undefined> = process.env,
): ServerEnvironment {
  const mockMode = source.AGENT3D_MOCK_MODE ?? 'false';
  if (mockMode !== 'true' && mockMode !== 'false') {
    throw new TypeError('AGENT3D_MOCK_MODE must be "true" or "false".');
  }
  const agentServiceUrl = requiredAgentServiceUrl(source.AGENT3D_AGENT_URL);
  const agentServiceToken = optionalSecret(source.AGENT3D_AGENT_TOKEN);
  if (!agentServiceToken) {
    throw new TypeError('AGENT3D_AGENT_TOKEN must be configured.');
  }
  const server = requiredServerURL(source.AGENT3D_SERVER_URL);
  const serverToken = optionalSecret(source.AGENT3D_SERVER_TOKEN);
  if (!serverToken) {
    throw new TypeError('AGENT3D_SERVER_TOKEN must be configured.');
  }
  const credentialBrokerToken = optionalSecret(source.AGENT3D_CREDENTIAL_BROKER_TOKEN);
  if (!credentialBrokerToken) {
    throw new TypeError('AGENT3D_CREDENTIAL_BROKER_TOKEN must be configured.');
  }

  return {
    mockMode: mockMode === 'true',
    chatApiKey: optionalSecret(source.AGENT3D_CHAT_API_KEY),
    imageApiKey: optionalSecret(source.AGENT3D_IMAGE_API_KEY),
    serverUrl: server.url,
    serverPort: server.port,
    serverToken,
    rendererOrigin: requiredRendererOrigin(source.AGENT3D_RENDERER_ORIGIN),
    agentServiceUrl,
    agentServiceToken,
    credentialBrokerPort: credentialBrokerPort(source.AGENT3D_CREDENTIAL_BROKER_PORT),
    credentialBrokerToken,
  };
}
