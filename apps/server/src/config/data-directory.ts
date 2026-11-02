import { posix, resolve, win32 } from 'node:path';

type PathImplementation = typeof import('node:path').posix;

export const electronApplicationName = '@agent3d/desktop';

function platformPaths(platform: NodeJS.Platform): PathImplementation {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Resolves Electron's user-data root so the standalone API and desktop share one database.
 */
export function resolveDataDirectory(
  source: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  homeDirectory: string,
  appName: string,
): string {
  const paths = platformPaths(platform);
  const override = source.AGENT3D_DATA_DIR?.trim();
  if (override) {
    return paths.resolve(homeDirectory, override);
  }
  if (!appName.trim()) {
    throw new TypeError('The Electron application name must not be empty.');
  }

  let appDataDirectory: string;
  if (platform === 'win32') {
    const configuredAppData = source.APPDATA?.trim();
    appDataDirectory = configuredAppData && win32.isAbsolute(configuredAppData)
      ? configuredAppData
      : win32.join(homeDirectory, 'AppData', 'Roaming');
  } else if (platform === 'darwin') {
    appDataDirectory = posix.join(homeDirectory, 'Library', 'Application Support');
  } else {
    const configuredXdgDirectory = source.XDG_CONFIG_HOME?.trim();
    appDataDirectory = configuredXdgDirectory && posix.isAbsolute(configuredXdgDirectory)
      ? configuredXdgDirectory
      : posix.join(homeDirectory, '.config');
  }

  return paths.join(appDataDirectory, appName);
}

/**
 * Stops Electron from silently opening a second database if its user-data path changes.
 */
export function assertDataDirectoryMatches(expected: string, actual: string): void {
  if (resolve(expected) !== resolve(actual)) {
    throw new Error('The configured data directory does not match Electron userData.');
  }
}
