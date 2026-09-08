import { session } from 'electron';
import type { App, BrowserWindow } from 'electron';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import type { Logger } from '../utils/logger';
import { NodeHttpExecutor, isProxyOrCertTransportFailure } from './nodeHttpExecutor';
import type { UpdaterEvent, UpdateCheckResult } from '../../../shared/types/updater';

const EVENT_CHANNEL = 'updater:event';
// Let the window finish loading before the first automatic check so the
// 'available' event isn't dropped against a not-yet-ready webContents.
const INITIAL_CHECK_DELAY_MS = 8_000;
// One transport switch (Node -> electron.net) plus one session rebind is the
// most any single operation can usefully recover from; past that the failure is
// not about which stack carries the request.
const MAX_TRANSPORT_RECOVERIES = 2;

/** Parse the leading MAJOR.MINOR.PATCH of a version string; null if absent. */
function releaseTriple(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * True when `latest` is strictly newer than `current`.
 *
 * A plain `latest !== current` is wrong: the update feed can legitimately sit
 * BEHIND the installed build (a dev build ahead of the published dev feed, or
 * a stable feed rolled back), and electron-updater refuses to stage a
 * downgrade. Offering one produces a Download button that can only ever fail
 * with "Please check update first".
 *
 * Comparison is on the numeric release triple only. If the triples tie but the
 * full strings differ (a prerelease/build suffix on one side), or either string
 * has no parseable triple, fall back to inequality — cyboflow ships plain
 * MAJOR.MINOR.PATCH today, and this keeps an unfamiliar future format
 * offerable rather than silently unreachable.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = releaseTriple(latest);
  const b = releaseTriple(current);
  if (!a || !b) return latest !== current;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return latest !== current;
}

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
  // Set when Chromium's network service process dies mid-run. Electron's
  // main-process `net` sessions (including electron-updater's cached
  // "electron-updater" partition) stay bound to the dead network context, so
  // every subsequent request fails with a bare net::ERR_FAILED until the app
  // relaunches.
  //
  // Since the updater runs on Node's transport this no longer breaks update
  // checks on its own, and the electron.net fallback recovers by rebinding onto
  // a fresh session (see rebindElectronSession). The flag survives only to
  // explain a failure that outlives even that — at which point relaunching
  // really is the remaining advice.
  private networkStackLost = false;
  // electron-updater's own ElectronHttpExecutor, captured before we replace it.
  // Kept as the fallback for managed networks where Node's stack cannot reach
  // the feed (OS proxy config, keychain-installed root certs) — see
  // runWithRecovery. Untyped because electron-updater assigns
  // `httpExecutor` in its constructor without declaring it on the public type.
  private electronExecutor: unknown = null;
  // Sticky once the fallback wins: a machine that needs Chromium's stack needs
  // it for every subsequent request too, so don't pay the failed Node attempt
  // again on each check.
  private usingElectronExecutor = false;
  // Bumped on every network-service death. An Electron Session is poisoned by
  // USE, not by creation: one that issued a request before the crash fails
  // forever after it, while a partition minted afterwards binds to the
  // respawned service and works. Comparing the two counters is therefore how we
  // know whether the fallback's session predates the current crash and must be
  // replaced before it is worth trying.
  private crashGeneration = 0;
  private electronSessionGeneration = 0;

  constructor(
    private readonly app: App,
    private readonly getMainWindow: () => BrowserWindow | null,
    private readonly logger?: Logger,
    /**
     * Test seam: the host platform gates the updater (a feed exists for
     * macOS only today), and tests must be deterministic on every host.
     */
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Wire events + kick off a delayed first check. Safe to call once at boot. */
  init(): void {
    if (!this.app.isPackaged) {
      this.logger?.verbose('[AppUpdater] dev build — auto-updater disabled');
      return;
    }
    if (this.platform !== 'darwin') {
      // No update feed exists for non-macOS platforms yet (the R2 feed only
      // carries macOS artifacts, and electron-updater would log a hard ENOENT
      // for the missing app-update.yml on every interval). Log once, disable.
      // Revisit when a Windows feed (latest.yml) ships.
      this.logger?.verbose('[AppUpdater] no update feed for this platform — auto-updater disabled');
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    this.installNodeHttpExecutor();
    this.wireEvents();
    this.watchNetworkService();

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
    if (!this.app.isPackaged || this.platform !== 'darwin') {
      // Mirrors init(): no feed exists for non-macOS platforms (yet), so an
      // updater verdict there is not "no update" but "not supported".
      return { supported: false, currentVersion, updateAvailable: false };
    }
    try {
      const result = await this.runWithRecovery('check', () =>
        autoUpdater.checkForUpdates(),
      );
      const latestVersion = result?.updateInfo?.version;
      const updateAvailable = !!latestVersion && isNewerVersion(latestVersion, currentVersion);
      return { supported: true, currentVersion, updateAvailable, latestVersion };
    } catch (error) {
      this.logger?.error('[AppUpdater] check failed', error instanceof Error ? error : undefined);
      this.emit(this.errorEventOf(error));
      return { supported: true, currentVersion, updateAvailable: false };
    }
  }

  /** Download the available update; progress arrives as UpdaterEvents. */
  async download(): Promise<void> {
    if (!this.app.isPackaged) return;
    try {
      await this.runWithRecovery('download', () => autoUpdater.downloadUpdate());
    } catch (error) {
      this.logger?.error('[AppUpdater] download failed', error instanceof Error ? error : undefined);
      this.emit(this.errorEventOf(error));
    }
  }

  /** Quit and install a downloaded update. Does not return on success. */
  install(): void {
    if (!this.app.isPackaged) return;
    // isSilent=false (show the installer), isForceRunAfter=true (relaunch).
    autoUpdater.quitAndInstall(false, true);
  }

  /**
   * Replace electron-updater's Chromium-backed HTTP executor with a Node-backed
   * one, stashing the original as a fallback.
   *
   * `httpExecutor` is assigned in electron-updater's constructor but is not on
   * its public type, so both the read and the write go through a structural
   * cast. If a future version drops or renames the field the swap is skipped
   * and the updater simply keeps its stock Chromium behaviour, so this fails
   * soft rather than throwing at boot.
   *
   * The original instance is stashed rather than reconstructed on demand: it
   * was built with a `login` callback wired to the updater's proxy-auth event,
   * and rebuilding one here would silently drop authenticated-proxy support.
   */
  private installNodeHttpExecutor(): void {
    const slot = autoUpdater as unknown as { httpExecutor?: unknown };
    if (!('httpExecutor' in slot)) {
      this.logger?.warn(
        '[AppUpdater] electron-updater exposes no httpExecutor slot — keeping its stock Chromium transport',
      );
      return;
    }
    this.electronExecutor = slot.httpExecutor ?? null;
    if (this.electronExecutor == null) {
      this.logger?.warn(
        '[AppUpdater] no ElectronHttpExecutor to fall back to — proceeding on Node transport only',
      );
    }
    slot.httpExecutor = new NodeHttpExecutor();
    this.logger?.verbose('[AppUpdater] update transport: Node http/https (electron.net on standby)');
  }

  /**
   * Run an updater operation, recovering from the two transport failures that
   * a retry can actually fix:
   *
   *  - Node cannot see the OS proxy configuration or the macOS keychain, so a
   *    managed corporate network fails there and may succeed over electron.net.
   *  - electron.net's session is dead after a network-service crash, but a
   *    partition minted after that crash binds to the respawned service.
   *
   * Anything else — an HTTP status, a checksum mismatch — propagates, since no
   * change of transport addresses it.
   *
   * A retry re-runs the whole operation, so a download that failed part-way
   * restarts from zero and the renderer's progress bar rewinds. That is worth
   * the simplicity: the alternative is resuming a byte range across a transport
   * we have just decided is broken.
   */
  private async runWithRecovery<T>(label: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const recovery = attempt < MAX_TRANSPORT_RECOVERIES ? this.planRecovery(error) : null;
        if (recovery == null) throw error;
        const from = this.usingElectronExecutor ? 'electron.net' : 'the Node transport';
        this.logger?.warn(
          `[AppUpdater] ${label} failed on ${from} (${this.messageOf(error)}) — ${
            recovery === 'switch'
              ? 'retrying over electron.net'
              : 'rebinding electron.net onto a post-crash session'
          }`,
        );
        if (recovery === 'switch') this.switchToElectronExecutor();
        else this.rebindElectronSession();
      }
    }
  }

  private planRecovery(error: unknown): 'switch' | 'rebind' | null {
    if (this.electronExecutor == null) return null;
    if (!this.usingElectronExecutor) {
      return isProxyOrCertTransportFailure(error) ? 'switch' : null;
    }
    // Already on electron.net. The only recoverable failure there is a network
    // context killed by a crash, and only when our session predates it — once
    // rebound, a repeat net:: error is a real one.
    if (this.electronSessionGeneration === this.crashGeneration) return null;
    return this.messageOf(error).includes('net::ERR') ? 'rebind' : null;
  }

  private switchToElectronExecutor(): void {
    // Cover the case where the crash landed before we ever switched: handing
    // the operation to a session minted pre-crash would fail on principle.
    this.rebindElectronSession();
    (autoUpdater as unknown as { httpExecutor?: unknown }).httpExecutor = this.electronExecutor;
    this.usingElectronExecutor = true;
  }

  /**
   * Point the Electron executor at a partition minted after the latest crash.
   *
   * `session.fromPartition` is identity-mapped by name — asking for the
   * "electron-updater" partition again returns the same poisoned object, and
   * `Session` has no destroy() — so recovery has to go through a NEW name.
   * ElectronHttpExecutor memoises its session in `cachedSession`, which is the
   * single place that decides which one every subsequent request rides.
   */
  private rebindElectronSession(): void {
    if (this.electronExecutor == null) return;
    if (this.electronSessionGeneration === this.crashGeneration) return;
    const partition = `electron-updater-r${this.crashGeneration}`;
    (this.electronExecutor as { cachedSession?: unknown }).cachedSession = session.fromPartition(
      partition,
      { cache: false },
    );
    this.electronSessionGeneration = this.crashGeneration;
    this.logger?.warn(`[AppUpdater] electron.net rebound to a fresh session "${partition}"`);
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
    autoUpdater.on('error', (error: Error) => this.emit(this.errorEventOf(error)));
  }

  /**
   * Detect the Chromium network service dying mid-run. Once it's gone, every
   * main-process `electron.net` request fails with net::ERR_FAILED until
   * relaunch — Chromium respawns the service but existing sessions stay bound
   * to the dead network context. 'clean-exit' is excluded: that's normal
   * shutdown, not a crash.
   */
  private watchNetworkService(): void {
    this.app.on('child-process-gone', (_event, details) => {
      if (
        details.type === 'Utility' &&
        details.serviceName === 'network.mojom.NetworkService' &&
        details.reason !== 'clean-exit'
      ) {
        this.networkStackLost = true;
        this.crashGeneration += 1;
        this.logger?.error(
          `[AppUpdater] Chromium network service gone (reason=${details.reason}, exitCode=${details.exitCode}) — electron.net requests on already-used sessions fail until relaunch; the updater rides Node's transport and is unaffected`,
        );
      }
    });
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

  /**
   * Build the error event for the renderer. After a network-service crash, a
   * Chromium-level net:: failure is a symptom of the dead network stack, not
   * of the update feed — swap in an actionable restart message. Non-net errors
   * (HTTP statuses, checksum mismatches, …) keep their original text.
   *
   * Reachable only when the electron.net fallback is in play AND rebinding it
   * onto a post-crash session did not help: Node's transport is unaffected by
   * the crash and never produces a net:: error in the first place.
   */
  private errorEventOf(error: unknown): UpdaterEvent {
    const message = this.messageOf(error);
    if (this.networkStackLost && message.includes('net::ERR')) {
      return {
        kind: 'error',
        message:
          "The app's network process crashed earlier this session, so update checks can't reach the server. Quit and relaunch Cyboflow, then check again.",
      };
    }
    return { kind: 'error', message };
  }
}
