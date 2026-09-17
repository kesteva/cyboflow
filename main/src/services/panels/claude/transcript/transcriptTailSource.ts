/**
 * TranscriptTailSource — the roll-our-own `TranscriptSource` implementation for
 * IDEA-013's interactive substrate (Q1 = roll-our-own, Probe D).
 *
 * Pipeline: discover the session JSONL -> inode+offset tail -> normalize each
 * line -> forward normalized panel objects to `onLine`, turn-end markers to
 * `onTurnEnd`. It does NOT spawn a PTY, does NOT emit panel output, and does NOT
 * import the event-narrowing layer — type-narrowing stays in the S3 manager
 * (TASK-808). It imports only node builtins, `encodeCwd`, and the normalizer.
 *
 * Fully unit-testable with zero PTY coupling: `projectsRoot` is injectable so
 * tests point at a temp dir (never touches the real `~/.claude`), and the
 * discovery timeout is injected.
 *
 * Logger contract (CODE-PATTERNS.md optional-logger rule): the structural logger is
 * REQUIRED, not optional — discovery-timeout, malformed-line-skip, and
 * watch-fallback diagnostics are all gated on it. Omitting it would silently
 * no-op observability, so the constructor demands it.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../../../../utils/logger';
import { encodeCwd } from '../../../../../../shared/utils/encodeCwd';
import { normalizeTranscriptLine } from './transcriptNormalizer';
import type {
  TranscriptSource,
  OnLineCallback,
  OnTurnEndCallback,
} from './transcriptSource';

/** Structural logger surface — mirrors how claudeCodeManager imports `Logger`. */
type StructuralLogger = Pick<Logger, 'warn' | 'error' | 'verbose'>;

export interface TranscriptTailSourceOptions {
  /** Absolute path of the worktree this session runs in (the encodeCwd input). */
  worktreePath: string;
  /** Override the `~/.claude/projects` root (tests inject a temp dir). */
  projectsRoot?: string;
  /**
   * SOFT bound on the spawn -> first-`.jsonl` discovery race. When it elapses the
   * firstLine promise REJECTS (so the awaiting spawn proceeds) but discovery is
   * NOT abandoned — a low-frequency background poll stays alive for
   * `lateDiscoveryWindowMs` so a slow-but-successful `claude` launch still binds.
   */
  discoveryTimeoutMs: number;
  /**
   * How long the background poll keeps trying AFTER the soft timeout before a
   * true give-up (defaults to {@link DEFAULT_LATE_DISCOVERY_WINDOW_MS}). Injectable
   * so tests can exercise the give-up path without a real 2-minute wait.
   */
  lateDiscoveryWindowMs?: number;
  /**
   * Defer the discovery deadline until {@link TranscriptTailSource.armDiscoveryDeadline}
   * is called, instead of starting it at `start()`.
   *
   * The soft timeout + extended window bound the spawn -> first-`.jsonl` race,
   * but `claude` writes NO transcript while its REPL sits idle — the file appears
   * only once a turn begins. When the spawn carries an initial prompt those two
   * moments coincide and the default (false) is correct. When it does NOT (a
   * prompt-less REPL waiting on the user), a deadline started at `start()` is
   * timing the USER, and its give-up would detach the structured pipeline
   * permanently over a session that is merely idle. Such a source defers; the
   * manager arms it on the turn-start edge.
   *
   * A deferred source still watches + polls (at the low-frequency background
   * cadence). It also NEVER latches a give-up: the turn-start edge that arms it
   * is a keystroke heuristic that fires for slash commands and pastes too, so an
   * armed window that finds nothing returns to unarmed instead of detaching the
   * pipeline for good (see giveUpDiscovery). `onGiveUp` is never called for a
   * deferred source.
   */
  deferDeadlineUntilArmed?: boolean;
  /**
   * PIN discovery to one exact file: `<expectedSessionUuid>.jsonl`. The manager
   * mints this uuid and hands it to claude as `--session-id`, so the transcript
   * claude writes is named by US before it exists — discovery becomes "wait for
   * that file", with no snapshot-diff and no candidate ambiguity.
   *
   * This is what makes a long-lived (deferred) source safe. Unpinned discovery
   * binds the first NEW `.jsonl` in the key dir, and the key dir is shared by
   * every process whose cwd encodes to it: two in-place quick sessions on the
   * same project, an added chat panel beside an idle primary, the user's own
   * terminal `claude`, an SDK flow run hosted in the same worktree. Matching
   * the transcript's `cwd` cannot tell those apart — they share it. A source
   * that watches for a session's whole idle life would bind whichever of them
   * wrote first and persist a stranger's uuid as this session's.
   *
   * Omitted → legacy snapshot-diff discovery (tests; never production spawns).
   */
  expectedSessionUuid?: string;
  /** REQUIRED structural logger (CODE-PATTERNS.md optional-logger rule). */
  logger: StructuralLogger;
  /**
   * Optional: invoked when a transcript binds AFTER the soft discovery timeout
   * (late recovery). Lets the manager re-persist the recovered session id so a
   * slow-launched session stays cleanly resumable.
   */
  onLateBind?: (sessionUuid: string) => void;
  /**
   * Optional: invoked when late discovery TRULY gives up — the extended window
   * elapsed with no transcript ever appearing. This (not the soft timeout) is the
   * genuinely-actionable failure the manager reports as a seam error.
   */
  onGiveUp?: () => void;
}

/** Poll cadence for the fs.watch fallback and the tail loop (ms). */
const POLL_INTERVAL_MS = 50;

/** Low-frequency cadence for the post-timeout background discovery poll (ms). */
const LATE_POLL_INTERVAL_MS = 500;

/** Default extended discovery window after the soft timeout (ms). */
const DEFAULT_LATE_DISCOVERY_WINDOW_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class TranscriptTailSource implements TranscriptSource {
  private readonly worktreePath: string;
  private readonly projectsRoot: string;
  private readonly keyDir: string;
  private readonly discoveryTimeoutMs: number;
  private readonly lateDiscoveryWindowMs: number;
  private readonly logger: StructuralLogger;
  private readonly onLateBind: ((sessionUuid: string) => void) | undefined;
  private readonly onGiveUp: (() => void) | undefined;

  private onLine: OnLineCallback | undefined;
  private onTurnEnd: OnTurnEndCallback | undefined;

  /** Basenames present at start — a NEW one is the candidate session UUID. */
  private snapshot: Set<string> = new Set();

  /** Watcher / interval handles cleared by stop(). */
  private watcher: fs.FSWatcher | undefined;
  private discoveryInterval: ReturnType<typeof setInterval> | undefined;
  private tailInterval: ReturnType<typeof setInterval> | undefined;
  private discoveryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Post-timeout background discovery handles (late-recovery poll). */
  private lateDiscoveryInterval: ReturnType<typeof setInterval> | undefined;
  private lateDiscoveryDeadline: ReturnType<typeof setTimeout> | undefined;

  /** Discovery promise plumbing for waitForFirstLine. */
  private firstLinePromise: Promise<void> | undefined;
  private resolveFirstLine: (() => void) | undefined;
  private rejectFirstLine: ((err: Error) => void) | undefined;
  private settled = false;

  /**
   * Constructed with a DEFERRED deadline (see `deferDeadlineUntilArmed`). Stays
   * true for the source's whole life: it also marks every bind as out-of-band,
   * because the spawn that created this source never awaited `waitForFirstLine`
   * and has long since returned.
   */
  private readonly deferDeadline: boolean;
  /** The pinned transcript basename (`<uuid>.jsonl`), or undefined for snapshot-diff. */
  private readonly expectedBasename: string | undefined;
  /** The discovery deadline is running (always true from `start()` unless deferred). */
  private deadlineArmed = false;

  /** The soft timeout fired: a subsequent bind is a LATE recovery. */
  private softTimedOut = false;
  /** Discovery is permanently abandoned (true give-up or stop()). */
  private discoveryGaveUp = false;

  /** Bound-file tail state. */
  private boundPath: string | undefined;
  private sessionUuid: string | undefined;
  private bound = false;
  private inode: number | undefined;
  private offset = 0;
  private buffer = '';
  private stopped = false;

  /**
   * The currently-running readAppended() tick, if any — ticks never overlap
   * (F15): a tick still awaiting its fs/promises I/O when the next 50ms interval
   * fires is left to finish; the new tick is skipped rather than racing it.
   */
  private tickInFlight: Promise<void> | undefined;

  constructor(opts: TranscriptTailSourceOptions) {
    this.worktreePath = opts.worktreePath;
    this.projectsRoot =
      opts.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
    this.keyDir = path.join(this.projectsRoot, encodeCwd(this.worktreePath));
    this.discoveryTimeoutMs = opts.discoveryTimeoutMs;
    this.lateDiscoveryWindowMs =
      opts.lateDiscoveryWindowMs ?? DEFAULT_LATE_DISCOVERY_WINDOW_MS;
    this.deferDeadline = opts.deferDeadlineUntilArmed === true;
    this.expectedBasename =
      opts.expectedSessionUuid !== undefined ? `${opts.expectedSessionUuid}.jsonl` : undefined;
    this.logger = opts.logger;
    this.onLateBind = opts.onLateBind;
    this.onGiveUp = opts.onGiveUp;
  }

  /** The discovered session UUID (the bound file basename sans `.jsonl`). */
  getSessionUuid(): string | undefined {
    return this.sessionUuid;
  }

  async start(onLine: OnLineCallback, onTurnEnd?: OnTurnEndCallback): Promise<void> {
    this.onLine = onLine;
    this.onTurnEnd = onTurnEnd;
    this.stopped = false;

    this.firstLinePromise = new Promise<void>((resolve, reject) => {
      this.resolveFirstLine = resolve;
      this.rejectFirstLine = reject;
    });
    // Swallow unhandled-rejection noise: waitForFirstLine is the consumer's hook.
    this.firstLinePromise.catch(() => undefined);

    this.snapshot = this.listJsonlBasenames();

    // fs.watch is unreliable on some platforms — pair it with a poll fallback.
    try {
      if (fs.existsSync(this.keyDir)) {
        this.watcher = fs.watch(this.keyDir, () => {
          this.tryDiscover();
        });
      } else {
        this.logger.verbose?.(
          `[Cyboflow Transcript] key dir does not exist yet, polling: ${this.keyDir}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[Cyboflow Transcript] fs.watch unavailable, falling back to poll: ${this.errMsg(err)}`,
      );
    }

    // A DEFERRED source has no deadline yet, so it polls at the low-frequency
    // background cadence: nothing is expected to appear until a turn starts, and
    // a 50ms poll held for the whole idle life of the session would be pure
    // wakeups. armDiscoveryDeadline() upshifts to POLL_INTERVAL_MS.
    this.discoveryInterval = setInterval(
      () => {
        this.tryDiscover();
      },
      this.deferDeadline ? LATE_POLL_INTERVAL_MS : POLL_INTERVAL_MS,
    );

    if (this.deferDeadline) {
      this.logger.verbose?.(
        `[Cyboflow Transcript] discovery deadline DEFERRED in ${this.keyDir} — the spawn starts no turn, so there is nothing to time until one does`,
      );
    } else {
      this.deadlineArmed = true;
      this.discoveryTimer = setTimeout(() => {
        this.onDiscoveryTimeout();
      }, this.discoveryTimeoutMs);
    }

    // Attempt an immediate discovery in case the file already appeared.
    this.tryDiscover();
  }

  /**
   * Start the deferred discovery deadline (see `deferDeadlineUntilArmed`) and
   * upshift the background poll to the fast cadence. Called by the manager on the
   * turn-start edge — the first moment `claude` is actually expected to write a
   * transcript, and therefore the first moment a timeout would mean a real
   * failure rather than an idle user.
   *
   * Idempotent; inert once bound, stopped, given up, or already armed.
   */
  armDiscoveryDeadline(): void {
    if (this.deadlineArmed || this.bound || this.stopped || this.discoveryGaveUp) return;
    // Unpinned: "new" is measured from the turn start, not from spawn — anything
    // that appeared while we were idle belongs to another process.
    if (this.expectedBasename === undefined) this.snapshot = this.listJsonlBasenames();
    this.deadlineArmed = true;
    // Upshift the poll: a turn is in flight, so the transcript is imminent.
    if (this.discoveryInterval !== undefined) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = setInterval(() => {
        this.tryDiscover();
      }, POLL_INTERVAL_MS);
    }
    this.discoveryTimer = setTimeout(() => {
      this.onDiscoveryTimeout();
    }, this.discoveryTimeoutMs);
    this.logger.verbose?.(
      `[Cyboflow Transcript] discovery deadline ARMED in ${this.keyDir} — expecting ${this.expectedBasename ?? 'a new *.jsonl'} within ${this.discoveryTimeoutMs}ms`,
    );
    this.tryDiscover();
  }

  waitForFirstLine(_timeoutMs: number): Promise<void> {
    // The discovery timeout is established in start() via the injected
    // discoveryTimeoutMs; the argument is accepted for interface parity.
    if (this.firstLinePromise === undefined) {
      return Promise.reject(
        new Error('[Cyboflow Transcript] waitForFirstLine called before start()'),
      );
    }
    // Awaiting the first line IS the declaration that one is expected now, so an
    // unarmed deferred source arms here rather than handing back a promise with
    // no deadline behind it, which would hang the caller forever.
    this.armDiscoveryDeadline();
    return this.firstLinePromise;
  }

  /**
   * Tear down all watchers/intervals. `stopped` flips synchronously (the
   * interface is deliberately sync, not `Promise<void>` — every implementer and
   * test double keys off that), so a readAppended() tick already in flight is not
   * awaited here; instead it is CANCELLED cooperatively — every await-resume point
   * in readAppended() re-checks `stopped` and bails before touching offset/buffer
   * or dispatching, so no read's output can land after this call returns even
   * though the underlying fs/promises calls finish in the background.
   */
  stop(): void {
    this.stopped = true;
    this.discoveryGaveUp = true; // make any pending late-discovery timer inert
    // Settle a still-pending waitForFirstLine BEFORE clearing the timers: a
    // panel stopped inside the discovery window used to leave the spawn's
    // `await waitForFirstLine(...)` dangling forever (clearDiscovery() cancels
    // the soft-timeout timer, the only other thing that would have settled
    // it). The caller treats rejection as the non-fatal slow-discovery path,
    // and `stopped` keeps every later callback inert.
    this.settle(false, 'stopped before transcript discovery completed');
    this.clearDiscovery();
    if (this.tailInterval !== undefined) {
      clearInterval(this.tailInterval);
      this.tailInterval = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  private listJsonlBasenames(): Set<string> {
    try {
      const entries = fs.readdirSync(this.keyDir);
      return new Set(entries.filter((e) => e.endsWith('.jsonl')));
    } catch {
      // Dir may not exist yet — treat as empty snapshot.
      return new Set();
    }
  }

  /**
   * Scan for a NEW `*.jsonl` and bind it. With the collision fallback, if more
   * than one new candidate exists, bind only to the file whose first cwd-bearing
   * line matches the worktree abs path — never by mtime alone.
   */
  private tryDiscover(): void {
    // NOTE: `settled` is intentionally NOT a guard here — after the soft timeout
    // settles the firstLine promise (reject), the background poll must still be
    // able to bind a late-appearing transcript. `discoveryGaveUp` (true give-up
    // or stop()) is the terminal guard instead.
    if (this.bound || this.stopped || this.discoveryGaveUp) return;

    // PINNED: the only file that can be ours is the one claude was told to
    // write. Its appearance is proof of ownership regardless of arm state.
    if (this.expectedBasename !== undefined) {
      if (fs.existsSync(path.join(this.keyDir, this.expectedBasename))) {
        this.bindFile(this.expectedBasename);
      }
      return;
    }

    const current = this.listJsonlBasenames();

    // UNPINNED + UNARMED: nothing of ours can appear — every turn of ours passes
    // through the arming edge first — so a new file now is somebody else's.
    // Absorb it into the snapshot instead of binding it, so that when we DO arm,
    // "new" means "since the turn started".
    if (this.deferDeadline && !this.deadlineArmed) {
      this.snapshot = current;
      return;
    }

    const candidates: string[] = [];
    for (const name of current) {
      if (!this.snapshot.has(name)) candidates.push(name);
    }
    if (candidates.length === 0) return;

    if (candidates.length === 1) {
      this.bindFile(candidates[0]);
      return;
    }

    // Collision: multiple new files in the same encodeCwd key dir. Bind only the
    // one whose early lines carry a TOP-LEVEL `cwd` equal to the worktree path.
    for (const name of candidates) {
      if (this.cwdMatches(path.join(this.keyDir, name))) {
        this.bindFile(name);
        return;
      }
    }
    // No candidate's cwd matches yet — wait for more lines to be written.
    this.logger.verbose?.(
      `[Cyboflow Transcript] ${candidates.length} colliding candidates, awaiting cwd-bearing line`,
    );
  }

  /**
   * Read a candidate file's early lines and report whether the first line bearing
   * a TOP-LEVEL `cwd` equals the worktree abs path. The literal first physical
   * line (file-history-snapshot) lacks `cwd`, so binding waits for the first
   * cwd-bearing line; `system/init.cwd` is never consulted (it never appears
   * interactively). The camelCase top-level `sessionId` is a secondary cross-check.
   */
  private cwdMatches(filePath: string): boolean {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return false;
    }
    const basename = path.basename(filePath, '.jsonl');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!isRecord(obj)) continue;
      const cwd = obj['cwd'];
      if (typeof cwd === 'string') {
        if (cwd !== this.worktreePath) return false;
        // Secondary cross-check: top-level sessionId should match the basename.
        const sessionId = obj['sessionId'];
        if (typeof sessionId === 'string' && sessionId !== basename) {
          this.logger.verbose?.(
            `[Cyboflow Transcript] sessionId/basename mismatch: ${sessionId} vs ${basename}`,
          );
        }
        return true;
      }
    }
    return false;
  }

  private bindFile(basename: string): void {
    this.bound = true;
    this.boundPath = path.join(this.keyDir, basename);
    this.sessionUuid = basename.replace(/\.jsonl$/, '');
    this.offset = 0;
    this.buffer = '';
    try {
      this.inode = fs.statSync(this.boundPath).ino;
    } catch {
      this.inode = undefined;
    }
    this.clearDiscovery();
    // Captured BEFORE settle(true). `onLateBind` is the "the spawn is not waiting
    // on this bind, re-attach downstream state yourself" channel, and TWO shapes
    // need it: (a) the soft timeout already fired, so the firstLine promise was
    // rejected and the spawn moved on; (b) a DEFERRED source, whose spawn never
    // awaited waitForFirstLine at all and returned long before the user's first
    // turn produced this file. Without (b) a deferred session would bind its
    // transcript and still never persist `claude_session_id`.
    const outOfBand = this.softTimedOut || this.deferDeadline;
    this.logger.verbose?.(
      `[Cyboflow Transcript] bound session ${this.sessionUuid} (${this.boundPath})`,
    );
    this.settle(true); // no-op if the soft timeout already settled(false)
    this.startTail();
    if (outOfBand) {
      this.logger.warn(
        this.softTimedOut
          ? `[Cyboflow Transcript] late-bound session ${this.sessionUuid} after discovery timeout — structured pipeline recovered`
          : `[Cyboflow Transcript] bound session ${this.sessionUuid} on the session's first turn (deferred discovery) — structured pipeline attached`,
      );
      if (this.sessionUuid !== undefined) this.onLateBind?.(this.sessionUuid);
    }
  }

  /**
   * Bind a KNOWN, pre-existing `<uuid>.jsonl` and tail from its CURRENT END
   * (no-fork resume — see the interface doc). Must be called AFTER start() (which
   * installs onLine/onTurnEnd + the firstLine promise) and is a no-op once already
   * bound/settled/stopped. Sets `offset` to the file's current size so only lines
   * APPENDED after the resume dispatch — the prior history is never re-emitted as
   * duplicate events. Returns false (leaving discovery running) if the file is
   * absent.
   */
  bindKnownFileFromEnd(sessionUuid: string): boolean {
    if (this.bound || this.settled || this.stopped) return false;
    const candidate = path.join(this.keyDir, `${sessionUuid}.jsonl`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate);
    } catch {
      // Not on disk — leave discovery running (it will time out non-fatally).
      this.logger.verbose?.(
        `[Cyboflow Transcript] bindKnownFileFromEnd: ${candidate} not found, staying in discovery`,
      );
      return false;
    }
    this.bound = true;
    this.boundPath = candidate;
    this.sessionUuid = sessionUuid;
    this.offset = stat.size; // tail from EOF — skip the prior history
    this.buffer = '';
    this.inode = stat.ino;
    this.clearDiscovery();
    this.logger.verbose?.(
      `[Cyboflow Transcript] bound KNOWN session ${sessionUuid} from EOF (offset=${stat.size}, ${candidate})`,
    );
    this.settle(true);
    this.startTail();
    return true;
  }

  /**
   * SOFT timeout: the spawn->first-line race exceeded `discoveryTimeoutMs`. This
   * is NON-fatal and no longer a hard give-up — a slow-but-successful `claude`
   * launch (slow network / MCP bootstrap) may still write its transcript shortly.
   * We reject the firstLine promise (so the awaiting spawn proceeds) and then
   * DOWNSHIFT the fast 50ms poller to a low-frequency background poll: if the
   * transcript appears within `lateDiscoveryWindowMs`, bindFile attaches the
   * structured pipeline mid-session and fires `onLateBind`. Only a TRUE give-up
   * (the window elapses with no file) is surfaced as a seam-worthy failure.
   */
  private onDiscoveryTimeout(): void {
    // NOT guarded on `settled`: a deferred source that re-deferred after its
    // window can be armed again, and its firstLine promise settled long ago.
    // settle() is idempotent, so reaching this twice is harmless.
    if (this.bound || this.stopped || this.softTimedOut) return;
    this.softTimedOut = true;
    this.logger.warn(
      `[Cyboflow Transcript] discovery timeout after ${this.discoveryTimeoutMs}ms in ${this.keyDir} — keeping a background poll alive for ${this.lateDiscoveryWindowMs}ms in case claude is still bootstrapping`,
    );
    this.clearFastDiscovery();
    this.settle(false);
    this.startLateDiscovery();
  }

  /** Downshift to a low-frequency background poll bounded by the extended window. */
  private startLateDiscovery(): void {
    if (this.stopped || this.bound || this.discoveryGaveUp) return;
    this.lateDiscoveryInterval = setInterval(() => {
      this.tryDiscover();
    }, LATE_POLL_INTERVAL_MS);
    this.lateDiscoveryDeadline = setTimeout(() => {
      this.giveUpDiscovery();
    }, this.lateDiscoveryWindowMs);
  }

  /**
   * The extended window elapsed with no transcript appearing. What that MEANS
   * depends on how the clock was started:
   *
   * - A source armed at `start()` (the spawn carried an argv prompt) knows a
   *   turn was in flight the whole time, so this is the genuinely-actionable
   *   failure — claude never engaged the prompt. It latches (`discoveryGaveUp`),
   *   logs at error, and fires `onGiveUp` for the manager to report as a seam.
   *
   * - A DEFERRED source was armed by the manager's turn-start edge, which is a
   *   keystroke heuristic: a submitted line with a body. That fires for things
   *   that never produce a transcript — a local slash command (`/help`,
   *   `/status`, `/model`; verified: none writes a `.jsonl`), or a bracketed
   *   paste carrying its own newlines. Latching here would permanently detach
   *   the pipeline from a session whose REAL first prompt is still to come. So a
   *   deferred source never gives up: it drops back to the unarmed low-frequency
   *   state and waits for the next turn-start to arm it again. It logs at warn
   *   each time so a genuine never-engages case is still visible in the logs,
   *   just not as a latched failure.
   */
  private giveUpDiscovery(): void {
    if (this.bound || this.stopped || this.discoveryGaveUp) return;
    // One last look before concluding nothing appeared: the low-frequency poll
    // can be up to LATE_POLL_INTERVAL_MS behind a file that landed just inside
    // the window, and a deferred re-defer would otherwise absorb that file as a
    // stranger's on its next unarmed tick.
    this.tryDiscover();
    if (this.bound) return;
    this.clearLateDiscovery();
    if (this.deferDeadline) {
      this.redefer();
      return;
    }
    this.discoveryGaveUp = true;
    this.logger.error(
      `[Cyboflow Transcript] discovery gave up after ${this.discoveryTimeoutMs + this.lateDiscoveryWindowMs}ms — no new *.jsonl ever appeared in ${this.keyDir}; session runs without the structured pipeline`,
    );
    this.onGiveUp?.();
  }

  /**
   * Return a deferred source to its unarmed state after an armed window found
   * nothing: clock off, background poll back on, ready for the next
   * `armDiscoveryDeadline()`. The firstLine promise stays settled (nobody awaits
   * a deferred source's promise), and the soft-timeout flag is cleared so the
   * next arm can time out again rather than short-circuiting.
   */
  private redefer(): void {
    this.deadlineArmed = false;
    this.softTimedOut = false;
    this.logger.warn(
      `[Cyboflow Transcript] armed discovery window (${this.discoveryTimeoutMs + this.lateDiscoveryWindowMs}ms) found no transcript in ${this.keyDir} — the submitted line started no turn (slash command / paste?); returning to unarmed and waiting for the next one`,
    );
    if (this.discoveryInterval === undefined) {
      this.discoveryInterval = setInterval(() => {
        this.tryDiscover();
      }, LATE_POLL_INTERVAL_MS);
    }
  }

  private clearDiscovery(): void {
    this.clearFastDiscovery();
    this.clearLateDiscovery();
  }

  private clearFastDiscovery(): void {
    if (this.watcher !== undefined) {
      try {
        this.watcher.close();
      } catch {
        // ignore close errors
      }
      this.watcher = undefined;
    }
    if (this.discoveryInterval !== undefined) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = undefined;
    }
    if (this.discoveryTimer !== undefined) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
  }

  private clearLateDiscovery(): void {
    if (this.lateDiscoveryInterval !== undefined) {
      clearInterval(this.lateDiscoveryInterval);
      this.lateDiscoveryInterval = undefined;
    }
    if (this.lateDiscoveryDeadline !== undefined) {
      clearTimeout(this.lateDiscoveryDeadline);
      this.lateDiscoveryDeadline = undefined;
    }
  }

  private settle(success: boolean, failureReason?: string): void {
    if (this.settled) return;
    this.settled = true;
    if (success) {
      this.resolveFirstLine?.();
    } else {
      this.rejectFirstLine?.(
        new Error(
          `[Cyboflow Transcript] ${failureReason ?? `discovery timeout after ${this.discoveryTimeoutMs}ms`}`,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Tail loop
  // ---------------------------------------------------------------------------

  private startTail(): void {
    // Read whatever is already in the bound file, then poll for appends.
    this.tick();
    this.tailInterval = setInterval(() => {
      this.tick();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Fire one tail tick, unless the previous tick's fs/promises I/O is still in
   * flight (F15 in-flight guard) — ticks never overlap. A slow disk (or a huge
   * appended chunk) can make one tick outlive the 50ms cadence; skipping the next
   * tick rather than starting a second concurrent read keeps offset/buffer
   * mutation single-threaded without an explicit lock.
   */
  private tick(): void {
    if (this.tickInFlight !== undefined) return;
    const run = this.readAppended();
    this.tickInFlight = run;
    void run.finally(() => {
      if (this.tickInFlight === run) this.tickInFlight = undefined;
    });
  }

  /**
   * Read bytes appended since `offset`, re-syncing on truncation / inode change,
   * then frame and dispatch complete lines. Runs on `fs/promises` (stat/open/
   * read/close on a `FileHandle`) so the 50ms tick never blocks the main thread.
   * `stop()` flips `this.stopped` synchronously; every await-resume point below
   * re-checks it and bails before mutating offset/buffer or dispatching, so a
   * tick already in flight when stop() lands produces no observable output.
   */
  private async readAppended(): Promise<void> {
    if (this.stopped || this.boundPath === undefined) return;

    let stat: fs.Stats;
    try {
      stat = await fsp.stat(this.boundPath);
    } catch {
      // File vanished — nothing to read this tick.
      return;
    }
    if (this.stopped) return; // stop() landed while stat() awaited

    // Re-sync on rotation/truncation: new inode OR shrunk below our offset.
    if ((this.inode !== undefined && stat.ino !== this.inode) || stat.size < this.offset) {
      this.inode = stat.ino;
      this.offset = 0;
      this.buffer = '';
    }

    if (stat.size <= this.offset) return;

    let chunk: string;
    try {
      const handle = await fsp.open(this.boundPath, 'r');
      try {
        if (this.stopped) return; // stop() landed while open() awaited
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await handle.read(buf, 0, len, this.offset);
        chunk = buf.subarray(0, bytesRead).toString('utf8');
        this.offset += bytesRead;
      } finally {
        await handle.close();
      }
    } catch (err) {
      this.logger.warn(
        `[Cyboflow Transcript] read error tailing ${this.boundPath}: ${this.errMsg(err)}`,
      );
      return;
    }

    if (this.stopped) return; // stop() landed while read()/close() awaited — never dispatch after teardown

    // Rolling-buffer framing (mirrors cyboflowMcpServer.ts:69-79). A line split
    // across two appends is reassembled here.
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      // Fail-soft: log + skip malformed lines, never crash the tail loop.
      this.logger.warn(
        `[Cyboflow Transcript] skipping malformed transcript line: ${this.errMsg(err)}`,
      );
      return;
    }

    const result = normalizeTranscriptLine(parsed);
    if (result.kind === 'panel') {
      this.onLine?.(result.event);
    } else if (result.kind === 'turn-end') {
      this.onTurnEnd?.(result.marker);
    }
    // 'drop' -> skip.
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
