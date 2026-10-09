/**
 * The tracker-claim seam between tracker sync and cross-machine backlog sync
 * (desktop doc, "Existing tracker connections").
 *
 * With backlog sync on for a project, a tracker connection for that project
 * runs on only ONE device: the one holding its claim on the sync service. Two
 * machines running the same Linear workspace against one synced backlog would
 * each import the other's issues and file each new idea twice.
 *
 * Tracker sync knows nothing about the sync service: it asks this gate before a
 * connection starts running, tells it when one is disconnected, and shows its
 * hold reason. Backlog sync implements it (remoteSync/trackerClaims.ts) and
 * drives the other direction through {@link TrackerClaimConnections}. With no
 * gate wired (a release build, where backlog sync does not exist) every
 * connection runs as before.
 */
import type { TrackerProvider } from '../../../../shared/types/trackerSync';

/** What a claim is keyed on: (remote project, provider, workspace, instance). */
export interface TrackerClaimSubject {
  projectId: number;
  provider: TrackerProvider;
  workspaceId: string | null;
  baseUrl: string | null;
  /** For the claim's human label ("Linear (acme)"). */
  workspaceName: string | null;
}

export type TrackerClaimDecision = { allowed: true } | { allowed: false; reason: string };

export interface TrackerClaimGate {
  /**
   * Called before a connection starts running (connect, re-connect, key
   * rotation, workspace adoption, resume). Allowed when the project does not
   * sync or this device holds (or just took) the claim. FAILS CLOSED: when the
   * claim cannot be checked, only the last-known holder may run. Never throws.
   */
  acquire(subject: TrackerClaimSubject): Promise<TrackerClaimDecision>;
  /** A connection was disconnected here: release its claim once no live connection on this machine shares it. */
  release(subject: TrackerClaimSubject): void;
  /** Why a paused connection is held by its claim ("Runs on Studio"), or null when it is not. */
  holdReason(subject: TrackerClaimSubject): string | null;
}

/** A live (active or paused) connection, as backlog sync sees it. */
export interface TrackerClaimConnection extends TrackerClaimSubject {
  id: string;
  status: 'active' | 'paused';
}

/** What backlog sync may do to tracker connections: list, pause, and resume through the gate. */
export interface TrackerClaimConnections {
  listLive(projectId: number): TrackerClaimConnection[];
  /** Pause a connection whose claim another device holds (or while a join bootstraps). Never reactivates. */
  pause(connectionId: string): void;
  /** Resume a paused connection through the gate; denied leaves it paused. */
  resume(connectionId: string): Promise<TrackerClaimDecision>;
}
