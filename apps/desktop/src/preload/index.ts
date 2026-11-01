import { contextBridge } from 'electron';

function argumentValue(prefix: string): string {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length) ?? '';
}

// Keep the renderer isolated; expose only the local API address and launch token.
contextBridge.exposeInMainWorld('desktopApi', {
  platform: process.platform,
  apiBaseUrl: argumentValue('--agent3d-api-base-url='),
  apiToken: argumentValue('--agent3d-api-token='),
});
