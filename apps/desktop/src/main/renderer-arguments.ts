/**
 * Keeps Agent service credentials in the main process by exposing only the Hono API to renderer.
 */
export interface RendererServerConfig {
  serverUrl: string;
  serverToken: string;
}

export function readRendererServerConfig(
  source: Record<string, string | undefined> = process.env,
): RendererServerConfig {
  const serverUrl = source.AGENT3D_SERVER_URL?.trim();
  if (!serverUrl) {
    throw new TypeError('AGENT3D_SERVER_URL must be configured.');
  }

  let url: URL;
  try {
    url = new URL(serverUrl);
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
  const serverToken = source.AGENT3D_SERVER_TOKEN?.trim();
  if (!serverToken) {
    throw new TypeError('AGENT3D_SERVER_TOKEN must be configured.');
  }

  return { serverUrl: url.origin, serverToken };
}

export function createRendererArguments(apiBaseUrl: string, apiToken: string): string[] {
  return [
    `--agent3d-api-base-url=${apiBaseUrl}`,
    `--agent3d-api-token=${apiToken}`,
  ];
}
