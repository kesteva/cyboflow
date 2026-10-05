/**
 * Cross-machine backlog sync ("remote sync") — shared config + status types.
 *
 * The desktop is a client of the cyboflow-sync service: it relies on the
 * service's HTTP contract (protocol 1), never on the server's code. This module
 * is compiled into BOTH the Electron main process and the Vite renderer, so it
 * stays Electron-free: pure types and constants.
 *
 * DEV BUILDS ONLY for now. The whole feature is gated on
 * `ConfigManager.isRemoteSyncAvailable()` (unpackaged `pnpm dev` or the
 * packaged "Cyboflow Dev" variant). In a stable build no facade is wired, the
 * engine never starts, the config write is rejected, and the renderer renders
 * nothing.
 */

/**
 * Stored shape of the `remoteSync` config block. Sparse like `webViewer`: an
 * absent member floors on read, so config.json stays byte-identical for users
 * who never touch the feature.
 */
export interface RemoteSyncConfig {
  /**
   * The feature flag. Absent → `false`. Effective only in a dev build:
   * `isRemoteSyncEnabled()` is `isRemoteSyncAvailable() && enabled`.
   */
  enabled?: boolean;
}

/** The complete set of storable keys; the config boundary iterates THIS. */
export const REMOTE_SYNC_CONFIG_KEYS = ['enabled'] as const satisfies readonly (keyof RemoteSyncConfig)[];

/** The staging deployment of cyboflow-sync. Dev builds talk to it by default. */
export const REMOTE_SYNC_STAGING_ORIGIN = 'https://cyboflow-remote-staging.jolly-cliff-20260824.workers.dev';

/** The wire protocol version every `/v1` call declares (`Cyboflow-Sync-Protocol`). */
export const REMOTE_SYNC_PROTOCOL_VERSION = 1;

/**
 * What the Settings → Integrations → Sync section renders from.
 * `available: false` is the release-build answer: the section renders nothing.
 */
export type RemoteSyncStatus =
  | { available: false }
  | {
      available: true;
      /** The feature flag (`remoteSync.enabled`). */
      enabled: boolean;
      /** The cyboflow-sync origin this build talks to. */
      serverOrigin: string;
      /** True when `serverOrigin` is the staging deployment (drives the "Staging" badge). */
      staging: boolean;
      /** Whether this device holds a device token. Always false until sign-in lands. */
      signedIn: boolean;
    };
