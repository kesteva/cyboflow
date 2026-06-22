import { homedir } from 'os';
import { join } from 'path';
import { app } from 'electron';

let customCyboflowDir: string | undefined;

/**
 * Sets a custom Cyboflow directory path. This should be called early in the
 * application lifecycle, before any services are initialized.
 */
export function setCyboflowDirectory(dir: string): void {
  customCyboflowDir = dir;
}

/**
 * Base directory name for the running app variant. The dev variant ships as a
 * separate app (appId com.cyboflow.app.dev) and MUST keep its own data dir so
 * its forward-only DB migrations never advance the stable install's database.
 * macOS sets __CFBundleIdentifier to the launched bundle's id, so it's a reliable
 * runtime signal for both packaged and dev-inside-Cyboflow launches.
 */
function cyboflowDirName(): string {
  return process.env.__CFBundleIdentifier === 'com.cyboflow.app.dev'
    ? '.cyboflow-dev'
    : '.cyboflow';
}

/**
 * Determines if Cyboflow is running from an installed application (DMG/Applications folder)
 * rather than a development build
 */
function isInstalledApp(): boolean {
  // Check if app is packaged (built for distribution)
  if (!app.isPackaged) {
    return false;
  }

  // On macOS, check if running from /Applications or a mounted DMG volume
  if (process.platform === 'darwin') {
    const appPath = app.getPath('exe');
    // Apps installed from DMG or in /Applications will have these paths
    const isInApplications = appPath.startsWith('/Applications/');
    const isInVolumes = appPath.startsWith('/Volumes/');
    const isInPrivateTmp = appPath.includes('/private/var/folders/'); // Temp mount for DMG

    return isInApplications || isInVolumes || isInPrivateTmp;
  }

  // For other platforms, being packaged is sufficient
  return true;
}

/**
 * Gets the Cyboflow directory path. Returns the custom directory if set,
 * otherwise falls back to the environment variable CYBOFLOW_DIR,
 * and finally defaults to ~/.cyboflow
 */
export function getCyboflowDirectory(): string {
  // 1. Check if custom directory was set programmatically
  if (customCyboflowDir) {
    return customCyboflowDir;
  }

  // 2. Check environment variable
  const envDir = process.env.CYBOFLOW_DIR;
  if (envDir) {
    return envDir;
  }

  // 3. If running as an installed app (from DMG, /Applications, etc), use the
  // variant data dir (~/.cyboflow, or ~/.cyboflow-dev for the dev app).
  if (isInstalledApp()) {
    const dirName = cyboflowDirName();
    console.log(`[Cyboflow] Running as installed app, using ~/${dirName}`);
    return join(homedir(), dirName);
  }

  // 4. If running inside Cyboflow (detected by bundle identifier) in development, use development directory
  // This prevents development Cyboflow from interfering with production Cyboflow
  if (process.env.__CFBundleIdentifier === 'com.cyboflow.app' && !app.isPackaged) {
    console.log('[Cyboflow] Detected running inside Cyboflow development, using ~/.cyboflow_dev for isolation');
    return join(homedir(), '.cyboflow_dev');
  }

  // 5. Default to the variant data dir (~/.cyboflow or ~/.cyboflow-dev)
  return join(homedir(), cyboflowDirName());
}

/**
 * Gets a subdirectory path within the Cyboflow directory
 */
export function getCyboflowSubdirectory(...subPaths: string[]): string {
  return join(getCyboflowDirectory(), ...subPaths);
}
