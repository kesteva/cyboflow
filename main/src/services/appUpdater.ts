import type { App, BrowserWindow } from 'electron';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import type { Logger } from '../utils/logger';
import type { UpdaterEvent, UpdateCheckResult } from '../../../shared/types/updater';

const EVENT_CHANNEL = 'updater:event';
// Let the window finish loading before the first automatic check so the
// 'available' event isn't dropped against a not-yet-ready webContents.
const INITIAL_CHECK_DELAY_MS = 8_000;

/**
 * Wraps electron-updater for cyboflow. Reads the generic update feed baked into
 * the packaged app-update.yml — which feed (.../stable vs .../dev) is fixed at
 * build time per app variant, so there is no in-app channel switch (see
 * docs/UPDATES.md). Relays the lifecycle to the renderer over the
 * 'updater:event' IPC channel.
 *
 * Design choices (deliberate):
 *  - No-op unless `app.isPackaged` — there is no feed in dev and electron-updater
 *    throws on an unpackaged app, so init() returns early.
 *  - `autoDownload` + `autoInstallOnAppQuit` are OFF. cyboflow runs long-lived
 *    orchestrator/agent sessions in worktrees; a silent download or
 *    quit-time install could interrupt one. The flow is explicit:
 *    check → download → quitAndInstall, all user-triggered from the UI.
 */
export class AppUpdater {
  private wired = false;

  constructor(
    private readonly app: App,
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly logger?: Logger,
  ) {}

  /** Wire events + kick off a delayed first check. Safe to call once at boot. */
  init(): void {
    if (!this.app.isPackaged) {
      this.logger?.verbose('[AppUpdater] dev build — auto-updater disabled');
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    this.wireEvents();

    setTimeout(() => {
      void this.check().catch(() => {
        /* fail-soft: initial check errors already surface via the 'error' event */
      });
    }, INITIAL_CHECK_DELAY_MS);
  }

  /**
   * Trigger a check now and return the immediate verdict. Availability/progress
   * also flow as UpdaterEvents. Fail-soft — never throws to the caller.
   */
  async check(): Promise<UpdateCheckResult> {
    const currentVersion = this.app.getVersion();
    if (!this.app.isPackaged) {
      return { supported: false, currentVersion, updateAvailable: false };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      const latestVersion = result?.updateInfo?.version;
      const updateAvailable = !!latestVersion && latestVersion !== currentVersion;
      return { supported: true, currentVersion, updateAvailable, latestVersion };
    } catch (error) {
      this.logger?.error('[AppUpdater] check failed', error instanceof Error ? error : undefined);
      this.emit({ kind: 'error', message: this.messageOf(error) });
      return { supported: true, currentVersion, updateAvailable: false };
    }
  }

  /** Download the available update; progress arrives as UpdaterEvents. */
  async download(): Promise<void> {
    if (!this.app.isPackaged) return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.logger?.error('[AppUpdater] download failed', error instanceof Error ? error : undefined);
      this.emit({ kind: 'error', message: this.messageOf(error) });
    }
  }

  /** Quit and install a downloaded update. Does not return on success. */
  install(): void {
    if (!this.app.isPackaged) return;
    // isSilent=false (show the installer), isForceRunAfter=true (relaunch).
    autoUpdater.quitAndInstall(false, true);
  }

  private wireEvents(): void {
    if (this.wired) return;
    this.wired = true;

    autoUpdater.on('checking-for-update', () => this.emit({ kind: 'checking' }));
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      this.emit({
        kind: 'available',
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      }),
    );
    autoUpdater.on('update-not-available', (info: UpdateInfo) =>
      this.emit({ kind: 'not-available', version: info.version }),
    );
    autoUpdater.on('download-progress', (p: ProgressInfo) =>
      this.emit({
        kind: 'download-progress',
        percent: p.percent,
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond,
      }),
    );
    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      this.emit({ kind: 'downloaded', version: info.version }),
    );
    autoUpdater.on('error', (error: Error) =>
      this.emit({ kind: 'error', message: this.messageOf(error) }),
    );
  }

  private emit(event: UpdaterEvent): void {
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(EVENT_CHANNEL, event);
    }
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
