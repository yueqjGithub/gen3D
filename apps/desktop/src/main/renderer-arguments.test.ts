import { beforeAll, describe, expect, it } from 'vitest';

type RendererArgumentsModule = typeof import('./renderer-arguments') & {
  readRendererServerConfig(source?: Record<string, string | undefined>): {
    serverUrl: string;
    serverToken: string;
  };
};

let rendererArgumentsModule: RendererArgumentsModule | undefined;

beforeAll(async () => {
  const module = await import('./renderer-arguments').catch(() => null);
  expect(module).not.toBeNull();
  if (!module) {
    throw new Error('Renderer argument builder is missing.');
  }
  rendererArgumentsModule = module as RendererArgumentsModule;
});

describe('renderer arguments', () => {
  it('passesOnlyTheHonoApiUrlAndTokenToTheRenderer', () => {
    if (!rendererArgumentsModule) {
      throw new Error('Renderer argument builder did not load.');
    }

    const argumentsList = rendererArgumentsModule.createRendererArguments(
      'http://127.0.0.1:62686',
      'renderer-api-token',
    );

    expect(argumentsList).toEqual([
      '--agent3d-api-base-url=http://127.0.0.1:62686',
      '--agent3d-api-token=renderer-api-token',
    ]);
    expect(argumentsList.join(' ')).not.toContain('AGENT3D_AGENT_URL');
    expect(argumentsList.join(' ')).not.toContain('AGENT3D_AGENT_TOKEN');
    expect(argumentsList.join(' ')).not.toContain('CREDENTIAL_BROKER_TOKEN');
  });

  it('requiresAConfiguredLoopbackHonoUrlAndToken', () => {
    if (!rendererArgumentsModule) {
      throw new Error('Renderer argument builder did not load.');
    }

    expect(rendererArgumentsModule.readRendererServerConfig({
      AGENT3D_SERVER_URL: 'http://127.0.0.1:62686',
      AGENT3D_SERVER_TOKEN: 'renderer-api-token',
    })).toEqual({
      serverUrl: 'http://127.0.0.1:62686',
      serverToken: 'renderer-api-token',
    });
    expect(() => rendererArgumentsModule?.readRendererServerConfig({
      AGENT3D_SERVER_URL: 'http://192.0.2.10:62686',
      AGENT3D_SERVER_TOKEN: 'renderer-api-token',
    })).toThrow('127.0.0.1');
    expect(() => rendererArgumentsModule?.readRendererServerConfig({
      AGENT3D_SERVER_URL: 'http://127.0.0.1:62686',
      AGENT3D_SERVER_TOKEN: '',
    })).toThrow('AGENT3D_SERVER_TOKEN');
  });
});
