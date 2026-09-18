/**
 * The scheduler's scarce-resource vocabulary: lease NAMES (screen, agent slots,
 * ports, simulators, the per-batch worktree-sync mutex), the ResourceLeasePool
 * that emulates N-slot pools over the shared count-1 `mutex`, and the
 * abort-bounded `raceWithAbort` the drain wraps every collaborator call in.
 * Extracted verbatim from verificationScheduler.ts (issue #19 step 5); that file
 * re-exports everything here, so existing importers are unchanged.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron', 'fs',
 * 'better-sqlite3', or concrete main/src/services import.
 */
import { mutex as globalMutex } from '../../utils/mutex';
import type { Mutex } from '../../utils/mutex';
import type { LoggerLike } from '../types';

// ---------------------------------------------------------------------------
// Lease names
//
// The ResourceLeasePool emulates N ports / N simulators by holding N DISTINCT
// named count-1 leases over the shared `mutex` and probing for a free one. A
// single-display capture is one count-1 lease ('verify:screen'). Reusing the SAME
// `mutex` singleton is why 'verify:screen' composes app-wide with the
// PanelManager / WorktreeManager holders that already lock named resources there.
// ---------------------------------------------------------------------------

/** The single-display capture lease (Peekaboo / native-desktop). Count-1. */
export const VERIFY_SCREEN_LEASE = 'verify:screen';

/**
 * SUPERSEDED by the {@link verifyAgentSlot} pool (§4 footnote ¹). This was the
 * single count-1 lease that serialized EVERY agent verification app-wide
 * regardless of modality; the roster's concurrency column ("parallel, port
 * lease" for `web`/`cdp-app`, "exclusive" only for `native-screen`) is exactly
 * what that lease made unimplementable. Kept EXPORTED and unused-by-the-drain
 * on purpose: the name is a stable identifier a still-running older client (or
 * an external holder on the shared mutex) may be holding, and deleting it would
 * silently turn such a hold into a no-op rather than a compile error. Nothing in
 * the scheduler acquires it any more — see {@link verifyAgentSlot}.
 *
 * @deprecated Use {@link verifyAgentSlot} — the bounded N-slot pool.
 */
export const VERIFY_AGENT_LEASE = 'verify:agent';

/**
 * Build the lease name for agent-deployment slot `index` (§4 footnote ¹ — the
 * budgeted scheduler work item). The bounded web/cdp pool is emulated the same
 * way the port pool is: N DISTINCT count-1 leases over the SHARED mutex, probed
 * in order by `tryAcquireOneOf`, so two requests in ONE drain pass take slot 0
 * and slot 1 and run concurrently while the (N+1)th finds every slot held and
 * stays 'queued' — the lane never blocks, exactly as before.
 *
 * Slot COUNT comes from `ResolvedVisualVerifyConfig.agentSlots` (default 2) and
 * is deliberately DECOUPLED from `SPRINT_BATCH_CAP` (§5.4): a verification slot
 * is a full SDK deploy competing with the user's own dev work for host
 * CPU/network, so it must be sizeable independently of how many sprint lanes
 * fan out. `native-screen` requests draw a slot from this pool too — they are
 * agent deployments like any other — and ADDITIONALLY serialize on the separate
 * count-1 {@link VERIFY_SCREEN_LEASE}; `agentSlots` governs only how many agent
 * deployments may be in flight, never how many may touch the one screen.
 */
export function verifyAgentSlot(index: number): string {
  return `verify:agent:${index}`;
}

/** Build the per-port lease name for one dev-server port. */
export function verifyPortLease(port: number): string {
  return `verify:port:${port}`;
}

/** Build the per-simulator lease name for one device udid. */
export function verifySimLease(udid: string): string {
  return `verify:sim:${udid}`;
}

/**
 * Build the batch worktree-sync mutex name for one sprint batch (L4 / locked
 * decision #5). Acquired AFTER the dev-server/port lease and BEFORE backend
 * capture for any verification operating on a batched run; a count-1
 * serialization point per batchId over the SAME shared `mutex` as the
 * port/screen leases. It prevents a verification reading a half-committed shared
 * sprint worktree: while this is held, the next capture on the same batchId
 * WAITS (it does not start while another lane's verification is mid-capture).
 * A non-batch run (null/empty batch_id) acquires nothing — single-run captures
 * are byte-identical to before this layer.
 */
export function sprintVerifyBatchLease(batchId: string): string {
  return `sprint-verify-${batchId}`;
}

// ---------------------------------------------------------------------------
// ResourceLeasePool — N-slot leasing over the count-1 `mutex`
// ---------------------------------------------------------------------------

/** A held lease; call release() exactly once (the scheduler does so in finally). */
export interface LeaseHandle {
  /** The concrete lease name acquired (e.g. 'verify:port:5173'), or null for the no-lease slot. */
  readonly name: string | null;
  release(): void;
}

/** A lease that needs NO scarce resource (rung 0 / rung 1 sans dev server / judge). */
const NO_LEASE: LeaseHandle = { name: null, release: () => {} };

/**
 * ResourceLeasePool — built OVER the shared count-1 `mutex` (utils/mutex.ts). It
 * does NOT add a second locking primitive; it composes the existing one. A
 * "logical" pool of N ports / N sims is emulated as N distinct count-1 leases:
 * tryAcquireOneOf() probes the candidate names in order and grabs the first whose
 * mutex slot is free (mutex.isLocked === false), returning a LeaseHandle that
 * releases exactly that name.
 *
 * Crucially this is NON-BLOCKING by design — if every candidate is held it returns
 * null IMMEDIATELY (it does NOT await mutex.acquire's spin-until-timeout). The
 * scheduler then LEAVES the request 'queued' and retries next drain, so a busy
 * pool never stalls the drain loop or the lane.
 *
 * Concurrency note: the scheduler drains serially (one request leased per
 * iteration before the next isLocked probe) so the check-then-acquire window is
 * not a race within the scheduler. The mutex itself is the source of truth across
 * the rest of the app.
 */
export class ResourceLeasePool {
  constructor(private readonly mutex: Mutex = globalMutex) {}

  /**
   * QUARANTINED lease names (redesign §5.4 step 6): a lease whose underlying
   * resource (a leaked verification port) would NOT free at teardown. The mutex
   * slot is kept HELD (the retained `release` is stored, never called at
   * quarantine time) so the next acquisition can never hand out a still-dirty
   * port; each entry carries a `probeFree` re-check that `tryAcquireOneOf` runs
   * before considering the slot, freeing it once the resource is genuinely free.
   */
  private readonly quarantined = new Map<
    string,
    { probeFree: () => Promise<boolean>; reason: string; release: () => void }
  >();

  /**
   * Quarantine a held lease instead of releasing it (§5.4 step 6). The mutex slot
   * stays HELD — `handle.release()` is retained, not called — so a leaked port can
   * never collide with the next verification. `probeFree` is re-run on a later
   * acquisition attempt for this exact name; when it reports the resource free the
   * slot is released and re-enters normal rotation. A no-lease handle is a no-op.
   */
  quarantine(handle: LeaseHandle, probeFree: () => Promise<boolean>, reason: string): void {
    if (handle.name === null) return;
    this.quarantined.set(handle.name, { probeFree, reason, release: handle.release });
  }

  /** True when `name` is currently held in quarantine (test/observability helper). */
  isQuarantined(name: string): boolean {
    return this.quarantined.has(name);
  }

  /**
   * The underlying count-1 mutex this pool composes over. Exposed so the
   * scheduler can take a BLOCKING count-1 lock (the batch worktree-sync mutex,
   * `sprint-verify-<batchId>`) on the SAME mutex instance the port/screen leases
   * use, so all named locks compose app-wide. Distinct from tryAcquire* (which is
   * non-blocking): the batch mutex is a serialization point where the second
   * concurrent capture WAITS for the first to release, not a pool that leaves a
   * request queued.
   */
  get sharedMutex(): Mutex {
    return this.mutex;
  }

  /** A lease that needs no scarce resource. Always "available". */
  noLease(): LeaseHandle {
    return NO_LEASE;
  }

  /**
   * Probe `candidates` in order; acquire the FIRST whose count-1 mutex slot is
   * free and return its handle, else return null immediately (pool exhausted).
   * Acquire is awaited but resolves instantly because we only call it on a slot
   * isLocked() already reported free.
   */
  async tryAcquireOneOf(candidates: readonly string[]): Promise<LeaseHandle | null> {
    for (const name of candidates) {
      // A quarantined slot (§5.4 step 6) is re-probed before it can be handed out:
      // if its resource freed, release the held quarantine (which frees the mutex
      // slot) and fall through to the normal acquire; otherwise skip this candidate.
      const q = this.quarantined.get(name);
      if (q) {
        if (await q.probeFree()) {
          this.quarantined.delete(name);
          q.release();
        } else {
          continue;
        }
      }
      if (!this.mutex.isLocked(name)) {
        const release = await this.mutex.acquire(name);
        let released = false;
        return {
          name,
          release: () => {
            if (released) return;
            released = true;
            release();
          },
        };
      }
    }
    return null;
  }

  /** Probe + acquire a SINGLE count-1 lease by exact name; null if held. */
  async tryAcquire(name: string): Promise<LeaseHandle | null> {
    return this.tryAcquireOneOf([name]);
  }
}

// ---------------------------------------------------------------------------
// Abort-bounded await (R1 #1a — the scheduler must NEVER hang on a collaborator
// that ignores its abort signal)
//
// The per-request deadline `.abort()`s the shared controller, but a backend/judge
// that does not honour the signal (e.g. an offscreen renderer wedged on a GPU
// stall) may never settle its capture promise. Awaiting that promise raw would
// hang runChosen forever → drain()'s Promise.allSettled never resolves → `draining`
// stays true → every future request across all runs strands 'queued'. raceWithAbort
// closes that hole at the SCHEDULER: it rejects with a distinguishable AbortRaceError
// THE MOMENT the signal aborts, even if the underlying promise never settles. The
// orphaned promise is intentionally DETACHED (its eventual settle/reject is logged,
// not awaited). The backend-side cleanup (CapturePageBackend destroys its window on
// abort) is the complementary fix that prevents a leaked wedged window; this race is
// the hard guarantee that the loop itself can never wedge.
// ---------------------------------------------------------------------------

/**
 * The distinguishable rejection raceWithAbort throws when the signal aborts before
 * the raced promise settles. runChosen's catch keys timeout-vs-failed off
 * `signal.aborted` (not this identity), but the named class keeps the abort path
 * greppable in logs + assertable in tests.
 */
export class AbortRaceError extends Error {
  constructor(label: string) {
    super(`aborted while awaiting ${label}`);
    this.name = 'AbortRaceError';
  }
}

/**
 * Await `promise`, but reject with an AbortRaceError the instant `signal` aborts —
 * even if `promise` never settles (an abort-unaware collaborator). When the abort
 * wins, the underlying promise is DETACHED: its later settle/reject is logged at
 * debug (so a leaked orphan is observable) and dropped. When the promise wins, its
 * value/error propagates and the abort listener is removed. Orchestrator-local (no
 * electron/service import) so the scheduler stays standalone-typecheck-clean.
 */
export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  label: string,
  logger?: LoggerLike,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new AbortRaceError(label));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new AbortRaceError(label));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          logger?.debug('[VerificationScheduler] detached work settled after abort', { label });
          return;
        }
        settled = true;
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          logger?.debug('[VerificationScheduler] detached work rejected after abort', {
            label,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
