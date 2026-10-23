/**
 * RemoteHostProcess — the HostProcess an SshHost's spawn returns: a local `ssh -T … <wrapper>` child dressed as
 * the remote program.
 *
 *  - The env prelude is written to stdin FIRST, at construction, so it precedes every byte the caller writes
 *    (stream writes keep their order); the caller then owns stdin.
 *  - `pid` is always undefined: the only local pid is ssh's, and the Codex client's teardown signals a pid's
 *    whole process GROUP — it must never reach a local group. Without a pid it calls kill() instead.
 *  - stdout is protocol data and passes untouched; stderr is redacted line by line (redactSecrets) before
 *    anyone reads it.
 *  - kill() (any non-KILL signal) is idempotent: end stdin (the SDK's graceful path), then after 2 s, if the
 *    process is still alive, a SECOND ssh exec signals the remote process group from the wrapper's pidfile
 *    (`kill -TERM -<pgid>`), then SIGTERM goes to the local ssh child. kill('SIGKILL') escalates at once (remote
 *    KILL + local SIGKILL). A process that already exited is not signalled (returns false); orphans of a dropped
 *    connection are fenced by the pidfile before the same spawnKey is re-dispatched (F1).
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Transform, type Readable, type TransformCallback, type Writable } from 'node:stream';
import { redactSecrets } from '../../../../shared/types/hosts';
import type { HostProcess } from '../../orchestrator/trpc/contracts/executionHost';

export const REMOTE_KILL_GRACE_MS = 2_000;
/** A stderr line longer than this is flushed (redacted) without waiting for its newline. */
const MAX_STDERR_LINE_BYTES = 64 * 1024;

export interface HostProcessTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: HostProcessTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface RemoteHostProcessDeps {
  /** The local ssh child, stdio all 'pipe'. */
  child: ChildProcess;
  /** Written to stdin before anything else (the wrapper's env prelude, terminator included). */
  prelude: string;
  /** Signal the remote process group via the pidfile (a second ssh exec). Must not reject. */
  remoteKill: (signal: 'TERM' | 'KILL') => Promise<void>;
  signal?: AbortSignal;
  timers?: HostProcessTimers;
  killGraceMs?: number;
}

/** Line-buffered redaction: a secret split across two chunks is still caught. */
export class RedactingLineStream extends Transform {
  private pending = '';

  override _transform(chunk: Buffer | string, _enc: BufferEncoding, cb: TransformCallback): void {
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const nl = this.pending.lastIndexOf('\n');
    if (nl >= 0) {
      this.push(redactSecrets(this.pending.slice(0, nl + 1)));
      this.pending = this.pending.slice(nl + 1);
    }
    if (this.pending.length > MAX_STDERR_LINE_BYTES) {
      this.push(redactSecrets(this.pending));
      this.pending = '';
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this.pending.length > 0) this.push(redactSecrets(this.pending));
    this.pending = '';
    cb();
  }
}

export class RemoteHostProcess extends EventEmitter implements HostProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid: undefined = undefined;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private killRequested = false;
  private graceTimer: unknown = null;
  private readonly timers: HostProcessTimers;
  private readonly onAbort = (): void => {
    this.kill('SIGTERM');
  };

  constructor(private readonly deps: RemoteHostProcessDeps) {
    super();
    const { child } = deps;
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('remote spawn needs piped stdio');
    this.timers = deps.timers ?? realTimers;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    const stderr = new RedactingLineStream();
    child.stderr.pipe(stderr);
    this.stderr = stderr;

    child.stdin.on('error', () => {
      /* EPIPE once the remote side is gone; the exit event tells the story */
    });
    child.stdin.write(deps.prelude);

    child.on('error', (e: Error) => this.emit('error', e));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exit) return;
      this.exit = { code, signal };
      this.clearGrace();
      deps.signal?.removeEventListener('abort', this.onAbort);
      this.emit('exit', code, signal);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => this.emit('close', code, signal));

    if (deps.signal?.aborted) queueMicrotask(this.onAbort);
    else deps.signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  get exitCode(): number | null {
    return this.exit?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exit?.signal ?? null;
  }

  get killed(): boolean {
    return this.killRequested;
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.exit) return false;
    if (signal === 'SIGKILL' || signal === 9) {
      this.killRequested = true;
      this.clearGrace();
      void this.deps.remoteKill('KILL').catch(() => undefined);
      this.signalLocal('SIGKILL');
      return true;
    }
    if (this.killRequested) return true;
    this.killRequested = true;
    try {
      this.stdin.end();
    } catch {
      /* already closed */
    }
    this.graceTimer = this.timers.setTimeout(() => {
      this.graceTimer = null;
      if (this.exit) return;
      void this.deps
        .remoteKill('TERM')
        .catch(() => undefined)
        .then(() => {
          if (!this.exit) this.signalLocal('SIGTERM');
        });
    }, this.deps.killGraceMs ?? REMOTE_KILL_GRACE_MS);
    return true;
  }

  private signalLocal(signal: NodeJS.Signals): void {
    try {
      this.deps.child.kill(signal);
    } catch {
      /* already gone */
    }
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) {
      this.timers.clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
