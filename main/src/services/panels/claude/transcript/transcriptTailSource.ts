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
 * Logger contract (CLAUDE.md optional-logger rule): the structural logger is
 * REQUIRED, not optional — discovery-timeout, malformed-line-skip, and
 * watch-fallback diagnostics are all gated on it. Omitting it would silently
 * no-op observability, so the constructor demands it.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Logger } from '../../../../utils/logger';
import { encodeCwd } from './encodeCwd';
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
  /** Bound on the spawn -> first-`.jsonl` discovery race. */
  discoveryTimeoutMs: number;
  /** REQUIRED structural logger (CLAUDE.md optional-logger rule). */
  logger: StructuralLogger;
}

/** Poll cadence for the fs.watch fallback and the tail loop (ms). */
const POLL_INTERVAL_MS = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class TranscriptTailSource implements TranscriptSource {
  private readonly worktreePath: string;
  private readonly projectsRoot: string;
  private readonly keyDir: string;
  private readonly discoveryTimeoutMs: number;
  private readonly logger: StructuralLogger;

  private onLine: OnLineCallback | undefined;
  private onTurnEnd: OnTurnEndCallback | undefined;

  /** Basenames present at start — a NEW one is the candidate session UUID. */
  private snapshot: Set<string> = new Set();

  /** Watcher / interval handles cleared by stop(). */
  private watcher: fs.FSWatcher | undefined;
  private discoveryInterval: ReturnType<typeof setInterval> | undefined;
  private tailInterval: ReturnType<typeof setInterval> | undefined;
  private discoveryTimer: ReturnType<typeof setTimeout> | undefined;

  /** Discovery promise plumbing for waitForFirstLine. */
  private firstLinePromise: Promise<void> | undefined;
  private resolveFirstLine: (() => void) | undefined;
  private rejectFirstLine: ((err: Error) => void) | undefined;
  private settled = false;

  /** Bound-file tail state. */
  private boundPath: string | undefined;
  private sessionUuid: string | undefined;
  private bound = false;
  private inode: number | undefined;
  private offset = 0;
  private buffer = '';
  private stopped = false;

  constructor(opts: TranscriptTailSourceOptions) {
    this.worktreePath = opts.worktreePath;
    this.projectsRoot =
      opts.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
    this.keyDir = path.join(this.projectsRoot, encodeCwd(this.worktreePath));
    this.discoveryTimeoutMs = opts.discoveryTimeoutMs;
    this.logger = opts.logger;
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

    this.discoveryInterval = setInterval(() => {
      this.tryDiscover();
    }, POLL_INTERVAL_MS);

    this.discoveryTimer = setTimeout(() => {
      this.onDiscoveryTimeout();
    }, this.discoveryTimeoutMs);

    // Attempt an immediate discovery in case the file already appeared.
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
    return this.firstLinePromise;
  }

  stop(): void {
    this.stopped = true;
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
    if (this.bound || this.stopped || this.settled) return;

    const current = this.listJsonlBasenames();
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
    this.logger.verbose?.(
      `[Cyboflow Transcript] bound session ${this.sessionUuid} (${this.boundPath})`,
    );
    this.settle(true);
    this.startTail();
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

  private onDiscoveryTimeout(): void {
    if (this.settled || this.bound) return;
    this.logger.error(
      `[Cyboflow Transcript] discovery timeout after ${this.discoveryTimeoutMs}ms — no new *.jsonl appeared in ${this.keyDir}`,
    );
    this.clearDiscovery();
    this.settle(false);
  }

  private clearDiscovery(): void {
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

  private settle(success: boolean): void {
    if (this.settled) return;
    this.settled = true;
    if (success) {
      this.resolveFirstLine?.();
    } else {
      this.rejectFirstLine?.(
        new Error(
          `[Cyboflow Transcript] discovery timeout after ${this.discoveryTimeoutMs}ms`,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Tail loop
  // ---------------------------------------------------------------------------

  private startTail(): void {
    // Read whatever is already in the bound file, then poll for appends.
    this.readAppended();
    this.tailInterval = setInterval(() => {
      this.readAppended();
    }, POLL_INTERVAL_MS);
  }

  /**
   * Read bytes appended since `offset`, re-syncing on truncation / inode change,
   * then frame and dispatch complete lines.
   */
  private readAppended(): void {
    if (this.stopped || this.boundPath === undefined) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.boundPath);
    } catch {
      // File vanished — nothing to read this tick.
      return;
    }

    // Re-sync on rotation/truncation: new inode OR shrunk below our offset.
    if ((this.inode !== undefined && stat.ino !== this.inode) || stat.size < this.offset) {
      this.inode = stat.ino;
      this.offset = 0;
      this.buffer = '';
    }

    if (stat.size <= this.offset) return;

    let chunk: string;
    try {
      const fd = fs.openSync(this.boundPath, 'r');
      try {
        const len = stat.size - this.offset;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, this.offset);
        chunk = buf.subarray(0, read).toString('utf8');
        this.offset += read;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.logger.warn(
        `[Cyboflow Transcript] read error tailing ${this.boundPath}: ${this.errMsg(err)}`,
      );
      return;
    }

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
