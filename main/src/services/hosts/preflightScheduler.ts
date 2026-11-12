/**
 * Scheduled SSH preflights. An hourly unref'd tick (same shape as DatabaseBackupService): each tick runs a
 * full preflight, SEQUENTIALLY, for every live SSH host whose last reachable preflight is older than 24 h (or
 * missing) or was taken by a different app version. The row's own preflight_at / preflight_app_version are
 * the watermark — there is no separate "last run" record.
 *
 * A tick does nothing when CYBOFLOW_DISABLE_HOST_PREFLIGHT_SCHEDULE=1, when remote hosts are killed, or when
 * the feature is not running (all read per tick). `inFlight` guards re-entrancy; stop() also ends a running
 * tick after its current host. Fail-soft: a tick logs and never throws.
 */
import type { HostRow } from '../../orchestrator/hosts/hostStore';
import type { LoggerLike } from '../../orchestrator/types';
import { isHostPreflightScheduleKilled, isRemoteHostsKilled } from './flags';

export const HOST_PREFLIGHT_TICK_INTERVAL_MS = 60 * 60 * 1000;
export const HOST_PREFLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface UnreffableTimer {
  unref?: () => void;
}

export interface PreflightSchedulerDeps {
  /** Live (non-archived) hosts. */
  listHosts(): HostRow[];
  runPreflight(hostId: string): Promise<unknown>;
  appVersion: string;
  /** HostsService.status().running. */
  isRunning(): boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  intervalMs?: number;
  logger: LoggerLike;
}

/** The SSH hosts a tick should re-check, in list order. Pure. */
export function selectDueHosts(hosts: readonly HostRow[], appVersion: string, now: Date): HostRow[] {
  return hosts.filter((h) => {
    if (h.kind !== 'ssh' || h.archivedAt !== null) return false;
    if (h.preflightAppVersion !== appVersion) return true;
    if (h.preflightAt === null) return true;
    const at = Date.parse(h.preflightAt);
    if (Number.isNaN(at)) return true;
    return now.getTime() - at >= HOST_PREFLIGHT_MAX_AGE_MS;
  });
}

export class PreflightScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private stopped = false;
  private readonly now: () => Date;

  constructor(private readonly deps: PreflightSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    void this.tick();
    const timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? HOST_PREFLIGHT_TICK_INTERVAL_MS);
    (timer as unknown as UnreffableTimer).unref?.();
    this.timer = timer;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private skipReason(): string | null {
    const env = this.deps.env ?? process.env;
    if (isHostPreflightScheduleKilled(env)) return 'schedule-killed';
    if (isRemoteHostsKilled(env)) return 'remote-hosts-killed';
    if (!this.deps.isRunning()) return 'not-running';
    return null;
  }

  /** Public so tests can drive it. Never throws. */
  async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      if (this.skipReason() !== null) return;
      const due = selectDueHosts(this.deps.listHosts(), this.deps.appVersion, this.now());
      for (const host of due) {
        if (this.stopped || this.skipReason() !== null) break;
        try {
          await this.deps.runPreflight(host.id);
        } catch (err) {
          this.deps.logger.warn('[hosts] scheduled preflight failed', {
            error: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
    } catch (err) {
      this.deps.logger.warn('[hosts] preflight schedule tick failed', { error: err instanceof Error ? err.name : 'unknown' });
    } finally {
      this.inFlight = false;
    }
  }
}
