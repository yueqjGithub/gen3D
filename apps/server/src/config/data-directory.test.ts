import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type DataDirectoryModule = typeof import('./data-directory');

let dataDirectoryModule: DataDirectoryModule | undefined;

beforeAll(async () => {
  const module = await import('./data-directory').catch(() => null);
  expect(module).not.toBeNull();
  if (!module) {
    throw new Error('Data directory resolver is missing.');
  }
  dataDirectoryModule = module;
});

function resolver(): DataDirectoryModule {
  if (!dataDirectoryModule) {
    throw new Error('Data directory resolver did not load.');
  }
  return dataDirectoryModule;
}

describe('data directory resolution', () => {
  it('uses the Windows app-data root and Electron application name', () => {
    const dataDirectory = resolver().resolveDataDirectory(
      { APPDATA: 'C:\\Users\\learner\\AppData\\Roaming' },
      'win32',
      'C:\\Users\\learner',
      '@agent3d/desktop',
    );

    expect(dataDirectory).toBe(win32.join(
      'C:\\Users\\learner\\AppData\\Roaming',
      '@agent3d/desktop',
    ));
    expect(win32.join(dataDirectory, 'data', 'agent3d.sqlite')).toBe(
      'C:\\Users\\learner\\AppData\\Roaming\\@agent3d\\desktop\\data\\agent3d.sqlite',
    );
  });

  it('uses the existing desktop package name for Electron user data', () => {
    const packagePath = fileURLToPath(new URL('../../../desktop/package.json', import.meta.url));
    const desktopPackage = JSON.parse(readFileSync(packagePath, 'utf8')) as { name: string };

    expect(resolver().electronApplicationName).toBe(desktopPackage.name);
  });

  it('follows Electron app-data conventions on macOS and Linux', () => {
    expect(resolver().resolveDataDirectory(
      {},
      'darwin',
      '/Users/learner',
      'Agent 3D',
    )).toBe(posix.join('/Users/learner', 'Library', 'Application Support', 'Agent 3D'));
    expect(resolver().resolveDataDirectory(
      { XDG_CONFIG_HOME: '/home/learner/.config-custom' },
      'linux',
      '/home/learner',
      'Agent 3D',
    )).toBe('/home/learner/.config-custom/Agent 3D');
    expect(resolver().resolveDataDirectory(
      {},
      'linux',
      '/home/learner',
      'Agent 3D',
    )).toBe('/home/learner/.config/Agent 3D');
  });

  it('uses an explicit override without moving existing user data', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent3d-data-dir-'));
    const existingDirectory = join(directory, 'existing');
    const sentinel = join(existingDirectory, 'agent3d.sqlite');
    const override = join(directory, 'new-location');
    mkdirSync(existingDirectory);
    writeFileSync(sentinel, 'existing database');

    try {
      expect(resolver().resolveDataDirectory(
        { AGENT3D_DATA_DIR: override },
        'win32',
        'C:\\Users\\learner',
        '@agent3d/desktop',
      )).toBe(win32.resolve(override));
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(override)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves a relative override against the same home directory in each process', () => {
    expect(resolver().resolveDataDirectory(
      { AGENT3D_DATA_DIR: 'agent3d-data' },
      'linux',
      '/home/learner',
      'Agent 3D',
    )).toBe('/home/learner/agent3d-data');
  });

  it('fails explicitly when Electron reports a different user-data directory', () => {
    const { assertDataDirectoryMatches } = resolver();

    expect(() => assertDataDirectoryMatches(
      '/home/learner/.config/Agent 3D',
      '/home/learner/.config/Agent 3D',
    )).not.toThrow();
    expect(() => assertDataDirectoryMatches(
      '/home/learner/.config/Agent 3D',
      '/home/learner/.config/Agent 3D-new',
    )).toThrow('does not match');
  });
});
