// Shared contract for the in-app auto-updater (electron-updater). Lives in
// shared/ so the main-process service (main/src/services/appUpdater.ts) and the
// renderer (preload + electron.d.ts + UI) reference ONE definition — per the
// no-dual-declaration rule in CLAUDE.md. The renderer subscribes to UpdaterEvent
// over the 'updater:event' IPC channel and drives check/download/install via
// the updater IPC handlers.

/**
 * Push-events the main process emits to the renderer as the update lifecycle
 * progresses. Discriminated on `kind` so the UI can switch exhaustively.
 */
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseDate?: string; releaseNotes?: string }
  | { kind: 'not-available'; version: string }
  | {
      kind: 'download-progress';
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

/**
 * Synchronous result of a manual `updater:check` request — the immediate
 * answer for "is there an update?". Progress/availability also arrive as
 * UpdaterEvents, but this lets a caller (e.g. the About dialog button) await a
 * direct verdict. `supported` is false in dev / unpackaged builds where the
 * updater is a no-op.
 */
export interface UpdateCheckResult {
  supported: boolean;
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion?: string;
}
