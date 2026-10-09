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

/** A synced project's row status (remote_sync_projects.status). */
export type RemoteSyncProjectState =
  | 'pending'
  | 'active'
  | 'paused'
  | 'error'
  | 'rewound'
  | 'upgrade_required'
  | 'storage_full';

/** A tracker claim on a synced project: which machine runs that tracker connection. */
export interface RemoteSyncTrackerClaim {
  /** "Linear (acme) runs on Studio". */
  label: string;
  /** This machine holds it. */
  mine: boolean;
}

/** One local project in the Sync section; every project is listed, synced or not. */
export interface RemoteSyncProjectStatus {
  projectId: number;
  name: string;
  /** Null while sync is off for this project (then `status` is null too). */
  remoteProjectId: string | null;
  status: RemoteSyncProjectState | null;
  statusDetail: string | null;
  lastSyncAt: string | null;
  /** A pass is running right now. */
  syncing: boolean;
  /** Set while the project backs off after a failure (ISO). */
  backoffUntil: string | null;
  openConflicts: number;
  /** Local deletes held back as a mass delete, waiting for the user to push or restore them. */
  heldDeletes: number;
  trackerClaims: RemoteSyncTrackerClaim[];
}

/** A project on the sync service, as offered for joining. */
export interface RemoteSyncRemoteProject {
  id: string;
  name: string;
  /** Epoch ms. */
  createdAt: number;
}

/** What turning sync on for a project can offer (Settings → Sync, per project). */
export interface RemoteSyncProjectChoices {
  projectId: number;
  /** The repo fingerprint sent to the service (credentials stripped); null when the project has no usable git remote. */
  fingerprint: string | null;
  /** Ideas, epics and tasks in the local backlog. Joining needs 0 in this version. */
  localItemCount: number;
  /** Remote projects with this project's fingerprint: the proposed join. */
  matches: RemoteSyncRemoteProject[];
  /** Every other remote project not already linked here, for an explicit pick. */
  others: RemoteSyncRemoteProject[];
}

export type RemoteSyncEnableRequest =
  | { projectId: number; mode: 'create' }
  | { projectId: number; mode: 'join'; remoteProjectId: string };

export type RemoteSyncEnableFailure =
  /** Sync is off, signed out, or the token is locked. */
  | 'not_ready'
  /** Joining needs an empty local backlog in this version. */
  | 'not_empty'
  /** A remote project with this fingerprint already exists: offer to join it. */
  | 'exists'
  /** The remote project is gone. */
  | 'not_found'
  /** Another project here already syncs with that remote project, or this one syncs with another. */
  | 'conflict'
  | 'failed';

export type RemoteSyncEnableResult =
  | { ok: true; remoteProjectId: string }
  | { ok: false; reason: RemoteSyncEnableFailure; message: string; project?: RemoteSyncRemoteProject };

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
      /** The shared cyboflow cloud sign-in's state (CloudHandleState). */
      cloudState: string;
      /** The signed-in device sync runs as. */
      device: { name: string; code: string } | null;
      /** The cloud origin the signed-in device talks to. */
      serverOrigin: string | null;
      /** True when `serverOrigin` is the staging deployment (drives the "Staging" badge). */
      staging: boolean;
      signedIn: boolean;
      projects: RemoteSyncProjectStatus[];
    };
