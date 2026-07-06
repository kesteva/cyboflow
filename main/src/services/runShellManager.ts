/**
 * RunShellManager — a plain user-shell PTY scoped to a workflow run's worktree.
 *
 * This is the backend for the "Shell" tab in a run view: a bare login shell
 * (`$SHELL`, e.g. /bin/zsh) running in the run's checked-out worktree so the user
 * can run arbitrary commands against the code a flow built — most importantly
 * launching a dev server to test the changes. It is DELIBERATELY separate from:
 *
 *   - the agent CLI PTY (interactive substrate — `interactiveClaudeManager`): that
 *     PTY hosts the `claude --resume` REPL and is owned by the RunExecutor /
 *     SubstrateDispatchFacade. The user shell never touches that pipeline, so the
 *     structured SDK/interactive stream stays byte-identical (Q3 panel-preservation).
 *   - the panel/session terminal stack (`TerminalPanelManager`): that is keyed by
 *     a `panel.id` owned by a `sessions` row. Flow runs (planner/sprint/compound/
 *     ship) never create a sessions row (`workflow_runs.session_id` is always NULL
 *     today — migration 019), so they cannot hang a panel-scoped terminal. We key
 *     by `runId` instead and resolve the cwd from `workflow_runs.worktree_path`,
 *     which IS populated at launch and is 1:1 with the run.
 *
 * Lifecycle: a shell is spawned LAZILY on the first `open(runId)` (the Shell tab
 * mounting) and SURVIVES run completion — completing/failing/cancelling a run
 * never touches this manager, so a dev server keeps running after the flow ends.
 * It is torn down only by `close(runId)` (run close-out: merge / createPr /
 * dismiss, before worktree removal) and by `destroyAll()` (app quit).
 *
 * The node-pty spawner is injected (`ShellSpawner`) so this class is unit-testable
 * without loading the native module: the only runtime dependency is the injected
 * spawn fn (production wires it to `pty.spawn` in main/src/index.ts).
 */
import type { IPtyForkOptions, IWindowsPtyForkOptions } from '@homebridge/node-pty-prebuilt-multiarch';
import { ShellDetector } from '../utils/shellDetector';
import { getShellPath } from '../utils/shellPath';

/**
 * The narrow slice of node-pty's `IPty` this manager uses. Typed structurally so
 * the real `pty.spawn` return value (a full `IPty`) is assignable to it and a
 * test fake stays small. `onData`/`onExit` return `void` here (we ignore the real
 * `IDisposable`) — that is assignable from the real listener-returning signatures.
 */
export interface ManagedPty {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

/** Exactly the shape of `pty.spawn`, narrowed to return a {@link ManagedPty}. */
export type ShellSpawner = (
  file: string,
  args: string[] | string,
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => ManagedPty;

/** Result of {@link RunShellManager.open}. */
export type OpenShellResult = { ok: true } | { ok: false; reason: 'no_worktree' };

interface RunShell {
  pty: ManagedPty;
  /** The run this terminal belongs to (resolves the worktree + run close-out). */
  runId: string;
  /** The stable per-terminal key (the Map key). Equals `runId` for a run's
   *  PRIMARY terminal; additional terminals carry a distinct id (e.g.
   *  `${runId}::t1`). The renderer subscribes on `cyboflow:shell:<terminalId>`. */
  terminalId: string;
  worktreePath: string;
  /** Rolling tail of all bytes the PTY has emitted, replayed to a (re)mounting
   *  xterm so a late/returning terminal reconstructs recent output instead of
   *  rendering blank (mirrors the agent PTY's getPtyBacklog). */
  backlog: string;
}

export class RunShellManager {
  /** Keyed by terminalId (NOT runId) so a single run can host MULTIPLE worktree
   *  terminals. The primary terminal uses terminalId === runId (back-compat). */
  private readonly shells = new Map<string, RunShell>();
  /** Keep ~256 KB of scrollback per shell — enough to repaint a screenful of dev
   *  server output on remount without unbounded memory growth. */
  private readonly MAX_BACKLOG = 256_000;

  constructor(
    /** Resolve a run's absolute worktree directory, or null if it has none yet
     *  (launch not finished / failed before the worktree_path UPDATE). */
    private readonly resolveWorktree: (runId: string) => string | null,
    /** Push a raw PTY chunk to the renderer (wired to `cyboflow:shell:<terminalId>`). */
    private readonly emitBytes: (terminalId: string, chunk: string) => void,
    /** node-pty spawner (production: `pty.spawn`; tests: a fake). */
    private readonly spawn: ShellSpawner,
  ) {}

  /**
   * Lazily spawn a worktree shell for a run. Idempotent: a second call for a
   * terminal that already has a live shell is a no-op success (so a terminal tab
   * can call this on every mount). `terminalId` defaults to `runId` (the run's
   * primary terminal); pass a distinct id for additional terminals. Returns
   * `{ ok:false, reason:'no_worktree' }` if the run has no worktree to anchor in.
   */
  open(runId: string, terminalId: string = runId): OpenShellResult {
    if (this.shells.has(terminalId)) return { ok: true };

    const cwd = this.resolveWorktree(runId);
    if (!cwd) return { ok: false, reason: 'no_worktree' };

    const shellInfo = ShellDetector.getDefaultShell();
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: getShellPath(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'en_US.UTF-8',
      WORKTREE_PATH: cwd,
    };
    // This is the USER's shell — it must carry no run-scoped cyboflow context, or
    // any `claude` the user launches in it would target a run's MCP context. Never
    // set here, AND strip inherited values: when the app itself was launched from
    // inside a cyboflow session (dogfooding via `pnpm dev` in a session shell),
    // process.env carries the OUTER run's ids. The worktree path is the only
    // cyboflow breadcrumb a plain shell needs.
    delete env.CYBOFLOW_RUN_ID;
    delete env.CYBOFLOW_ORCH_SOCKET;
    delete env.CYBOFLOW_RUN_ARTIFACTS_DIR;
    const ptyProcess = this.spawn(shellInfo.path, shellInfo.args || [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd,
      env,
    });

    const shell: RunShell = { pty: ptyProcess, runId, terminalId, worktreePath: cwd, backlog: '' };
    this.shells.set(terminalId, shell);

    ptyProcess.onData((data) => {
      shell.backlog += data;
      if (shell.backlog.length > this.MAX_BACKLOG) {
        shell.backlog = shell.backlog.slice(-this.MAX_BACKLOG);
      }
      this.emitBytes(terminalId, data);
    });

    // The shell process exiting (user typed `exit`, or it crashed) frees the
    // slot so a later `open` re-spawns a fresh shell instead of writing to a dead
    // PTY. We do NOT emit anything here — the renderer keeps its scrollback.
    ptyProcess.onExit(() => {
      this.shells.delete(terminalId);
    });

    return { ok: true };
  }

  /** Write user keystrokes verbatim into a terminal. No-op for an unknown id. */
  write(terminalId: string, data: string): void {
    const shell = this.shells.get(terminalId);
    if (!shell) return;
    shell.pty.write(data);
  }

  /** Relay an xterm geometry change into a terminal. No-op for an unknown id
   *  or non-positive dimensions (a 0×0 resize would throw in node-pty). */
  resize(terminalId: string, cols: number, rows: number): void {
    const shell = this.shells.get(terminalId);
    if (!shell) return;
    if (cols <= 0 || rows <= 0) return;
    shell.pty.resize(cols, rows);
  }

  /** The retained scrollback tail for a terminal ('' for an unknown id). */
  getBacklog(terminalId: string): string {
    return this.shells.get(terminalId)?.backlog ?? '';
  }

  /** Whether a live shell exists for a terminal id. */
  isOpen(terminalId: string): boolean {
    return this.shells.has(terminalId);
  }

  /** Terminate and forget a SINGLE terminal (UI close of an added terminal tab). */
  closeOne(terminalId: string): void {
    const shell = this.shells.get(terminalId);
    if (!shell) return;
    try {
      shell.pty.kill();
    } catch (error) {
      console.error(`[RunShellManager] Error killing terminal ${terminalId}:`, error);
    }
    this.shells.delete(terminalId);
  }

  /** Terminate and forget EVERY terminal for a run (run close-out, before
   *  worktree removal). Closes the primary (terminalId === runId) plus any
   *  additional terminals spawned in the same worktree. */
  close(runId: string): void {
    for (const [terminalId, shell] of this.shells) {
      if (shell.runId !== runId) continue;
      try {
        shell.pty.kill();
      } catch (error) {
        console.error(`[RunShellManager] Error killing terminal ${terminalId} (run ${runId}):`, error);
      }
      this.shells.delete(terminalId);
    }
  }

  /** Terminate every shell (app quit) so no orphaned shells / dev servers linger. */
  destroyAll(): void {
    for (const [terminalId, shell] of this.shells) {
      try {
        shell.pty.kill();
      } catch (error) {
        console.error(`[RunShellManager] Error killing terminal ${terminalId}:`, error);
      }
    }
    this.shells.clear();
  }
}
