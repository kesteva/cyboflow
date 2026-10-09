/**
 * Tracker claims (desktop doc, "Existing tracker connections").
 *
 * With sync on for a project, each of its tracker connections runs only on the
 * device holding the connection's claim, keyed
 * `remote_project_id|provider|workspace_id|base_url` (mappings of one workspace
 * share a claim).
 *
 *   - acquire: before a connection starts running here. Claims it on the
 *     service; FAILS CLOSED when the service cannot be reached: only the
 *     last-known holder keeps running, so a Cloudflare outage never stops the
 *     machine that runs Linear, and never starts a second one.
 *   - refresh: every successful pass, from /head. A running connection whose
 *     claim another device holds is paused, and is never reactivated
 *     automatically; one with no holder is claimed. Claims this device holds
 *     for connections it no longer has are released.
 *   - holdForJoin / resumeAfterJoin: a joining machine pauses its connections
 *     while the first pull applies, so historical ideas never file as new
 *     issues; afterwards the claim decides which resume.
 *
 * Implements tracker sync's TrackerClaimGate; tracker sync stays unaware of the
 * service.
 */
import type {
  TrackerClaimConnection,
  TrackerClaimConnections,
  TrackerClaimDecision,
  TrackerClaimGate,
  TrackerClaimSubject,
} from '../trackerSync/claimGate';
import type { TrackerClaim, TrackerClaimResponse } from '../../../../shared/types/remoteSyncWire';
import type { SyncHttpClient } from './syncHttpClient';
import type { StoredTrackerClaim, SyncStore } from './syncStore';

const PROVIDER_NAMES: Record<string, string> = { linear: 'Linear', plane: 'Plane', dart: 'Dart', beads: 'beads' };
/** The service's limit on a claim label. */
const MAX_LABEL = 200;

export const UNCONFIRMED_REASON =
  'Paused: cyboflow sync could not confirm which computer runs this tracker. Resume it once sync is back online.';

export interface TrackerClaimsDeps {
  store: SyncStore;
  /** The sync client, or null when sync cannot reach the service (off, signed out, locked). */
  getClient(): SyncHttpClient | null;
  /** This device, while signed in. */
  getDevice(): { deviceId: string; deviceName: string } | null;
  /** The machine-wide sync switch: with it off, no project syncs and no claim applies. */
  isSyncOn(): boolean;
  /** A claim call failed with a service error (a dead token goes back to the sign-in). */
  onClientError?(err: unknown): void;
  log?(projectId: number, line: string): void;
  now?: () => number;
}

export function claimKey(remoteProjectId: string, s: Pick<TrackerClaimSubject, 'provider' | 'workspaceId' | 'baseUrl'>): string {
  return [remoteProjectId, s.provider, s.workspaceId ?? '', s.baseUrl ?? ''].join('|');
}

export class TrackerClaims implements TrackerClaimGate {
  private connections: TrackerClaimConnections | null = null;
  private readonly joinHolds = new Map<number, string[]>();
  private readonly now: () => number;

  constructor(private readonly deps: TrackerClaimsDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Tracker sync's connections; null in tests or before it is wired. */
  setConnections(connections: TrackerClaimConnections | null): void {
    this.connections = connections;
  }

  // ---- the gate ------------------------------------------------------------

  async acquire(subject: TrackerClaimSubject): Promise<TrackerClaimDecision> {
    const remoteId = this.remoteIdFor(subject.projectId);
    if (!remoteId) return { allowed: true };
    const key = claimKey(remoteId, subject);
    const client = this.deps.getClient();
    const device = this.deps.getDevice();
    if (client && device) {
      try {
        const r = await client.trackerClaim({ key, label: this.label(subject, device.deviceName), action: 'claim' });
        const stored = this.record(subject.projectId, r.body, device.deviceId);
        if (stored.state === 'held_by_you') return { allowed: true };
        return { allowed: false, reason: holdText(stored) ?? UNCONFIRMED_REASON };
      } catch (err) {
        this.deps.onClientError?.(err);
      }
    }
    // Unreachable: only the last-known holder keeps running.
    const last = this.deps.store.getClaim(key);
    if (last?.state === 'held_by_you') return { allowed: true };
    if (!last) this.put({ key, projectId: subject.projectId, state: 'unconfirmed', holderDevice: null, holderLabel: null });
    return { allowed: false, reason: (last && holdText(last)) ?? UNCONFIRMED_REASON };
  }

  release(subject: TrackerClaimSubject): void {
    const remoteId = this.remoteIdFor(subject.projectId);
    if (!remoteId) return;
    const key = claimKey(remoteId, subject);
    const shared = this.live(subject.projectId).some((c) => claimKey(remoteId, c) === key);
    if (shared) return;
    // Without a client the record stays; the next refresh releases the orphan.
    if (this.releaseRemote(key)) this.deps.store.deleteClaim(key);
  }

  holdReason(subject: TrackerClaimSubject): string | null {
    const remoteId = this.remoteIdFor(subject.projectId);
    if (!remoteId) return null;
    const stored = this.deps.store.getClaim(claimKey(remoteId, subject));
    return stored ? holdText(stored) : null;
  }

  // ---- passes --------------------------------------------------------------

  /** Reconcile the project's connections with the claims from this pass's /head. */
  async refresh(projectId: number, claims: TrackerClaim[]): Promise<void> {
    const remoteId = this.remoteIdFor(projectId);
    const device = this.deps.getDevice();
    if (!remoteId || !device || !this.connections) return;
    const prefix = `${remoteId}|`;
    const byKey = new Map(claims.filter((c) => c.key.startsWith(prefix)).map((c) => [c.key, c]));
    const decided = new Map<string, StoredTrackerClaim>();
    for (const conn of this.live(projectId)) {
      const key = claimKey(remoteId, conn);
      let stored: StoredTrackerClaim | null | undefined = decided.get(key);
      if (!stored) {
        const holder = byKey.get(key) ?? null;
        if (holder || conn.status !== 'active') {
          stored = this.record(projectId, { key, state: holder ? (holder.deviceId === device.deviceId ? 'held_by_you' : 'held_by_other') : 'free', holder }, device.deviceId);
        } else {
          stored = await this.claimNow(projectId, key, conn, device);
        }
        if (!stored) continue;
        decided.set(key, stored);
      }
      if (conn.status === 'active' && stored.state === 'held_by_other') {
        this.connections.pause(conn.id);
        this.deps.log?.(projectId, `tracker ${this.connectionLabel(conn)} paused: ${stored.holderLabel ?? 'another computer runs it'}`);
      }
    }
    // Claims this device holds for connections it no longer has.
    for (const [key, claim] of byKey) {
      if (claim.deviceId === device.deviceId && !decided.has(key) && this.releaseRemote(key)) this.deps.store.deleteClaim(key);
    }
    for (const stale of this.deps.store.listClaims(projectId)) {
      if (!decided.has(stale.key) && !byKey.has(stale.key)) this.deps.store.deleteClaim(stale.key);
    }
  }

  /** Pause the project's running connections while a join's first pull applies. */
  holdForJoin(projectId: number): void {
    if (!this.connections) return;
    const held: string[] = [];
    for (const conn of this.live(projectId)) {
      if (conn.status !== 'active') continue;
      this.connections.pause(conn.id);
      held.push(conn.id);
    }
    if (held.length > 0) {
      this.joinHolds.set(projectId, held);
      this.deps.log?.(projectId, `paused ${held.length} tracker connection${held.length === 1 ? '' : 's'} while joining`);
    }
  }

  /** After the join's first successful pass: resume what holdForJoin paused, as the claims allow. */
  async resumeAfterJoin(projectId: number): Promise<void> {
    const held = this.joinHolds.get(projectId);
    if (!held || !this.connections) return;
    this.joinHolds.delete(projectId);
    for (const id of held) {
      const decision = await this.connections.resume(id);
      if (!decision.allowed) this.deps.log?.(projectId, `tracker connection stays paused: ${decision.reason}`);
    }
  }

  /** Before a project stops syncing here: release the claims this device holds for it. */
  releaseAll(projectId: number): void {
    this.joinHolds.delete(projectId);
    for (const c of this.deps.store.listClaims(projectId)) {
      if (c.state === 'held_by_you') this.releaseRemote(c.key);
    }
  }

  // ---- internals -----------------------------------------------------------

  private async claimNow(
    projectId: number,
    key: string,
    conn: TrackerClaimConnection,
    device: { deviceId: string; deviceName: string },
  ): Promise<StoredTrackerClaim | null> {
    const client = this.deps.getClient();
    if (!client) return null;
    try {
      const r = await client.trackerClaim({ key, label: this.label(conn, device.deviceName), action: 'claim' });
      return this.record(projectId, r.body, device.deviceId);
    } catch (err) {
      this.deps.onClientError?.(err);
      return null;
    }
  }

  /** Best-effort release on the service; false when it could not be sent. */
  private releaseRemote(key: string): boolean {
    const client = this.deps.getClient();
    if (!client) return false;
    client.trackerClaim({ key, label: '', action: 'release' }).catch((err: unknown) => this.deps.onClientError?.(err));
    return true;
  }

  private record(projectId: number, r: Pick<TrackerClaimResponse, 'key' | 'state' | 'holder'>, myDeviceId: string): StoredTrackerClaim {
    // The service answers from this device's point of view; a holder that is
    // this device is held_by_you whatever the state field says.
    const state = r.holder ? (r.holder.deviceId === myDeviceId ? 'held_by_you' : 'held_by_other') : r.state === 'held_by_you' ? 'held_by_you' : 'free';
    return this.put({ key: r.key, projectId, state, holderDevice: r.holder?.deviceId ?? null, holderLabel: r.holder?.label ?? null });
  }

  private put(c: Omit<StoredTrackerClaim, 'checkedAt'>): StoredTrackerClaim {
    const stored = { ...c, checkedAt: new Date(this.now()).toISOString() };
    this.deps.store.putClaim(stored);
    return stored;
  }

  private remoteIdFor(projectId: number): string | null {
    if (!this.deps.isSyncOn()) return null;
    return this.deps.store.getProject(projectId)?.remoteProjectId ?? null;
  }

  private live(projectId: number): TrackerClaimConnection[] {
    return this.connections?.listLive(projectId) ?? [];
  }

  private connectionLabel(s: TrackerClaimSubject): string {
    const name = PROVIDER_NAMES[s.provider] ?? s.provider;
    const workspace = s.workspaceName ?? s.workspaceId;
    return workspace ? `${name} (${workspace})` : name;
  }

  /** "Linear (acme) runs on Studio": what other machines show for this claim. */
  private label(s: TrackerClaimSubject, deviceName: string): string {
    return `${this.connectionLabel(s)} runs on ${deviceName}`.slice(0, MAX_LABEL);
  }
}

/** Why a connection is held, from a stored claim; null when it is not held. */
function holdText(c: StoredTrackerClaim): string | null {
  if (c.state === 'held_by_other') return c.holderLabel ? `Paused: ${c.holderLabel}` : 'Paused: another computer runs this tracker';
  if (c.state === 'unconfirmed') return UNCONFIRMED_REASON;
  return null;
}
