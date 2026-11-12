/**
 * ENVIRONMENT ACTIONS — the fixed, host-run set of things the run supervisor may
 * do to a sprint's WORKTREE ENVIRONMENT (as opposed to its code). Observed
 * 2026-09-28: two cyboflow sprint worktrees had no installed dependencies, so
 * every lane's typecheck/lint died on `tsc: command not found`, task-verify
 * failed correct work on it, and a monitor with read-only tools could diagnose
 * it but never fix it.
 *
 * SAFETY MODEL: there is no free-form shell. The supervisor names an ACTION from
 * a closed enum; this module decides the exact argv. Today there is one:
 *   - `install_dependencies` — the package manager the worktree's LOCKFILE names,
 *     in frozen/CI mode, so it can never rewrite the lockfile or pick new
 *     versions. No lockfile (or an unrecognized one) ⇒ the action is unavailable.
 * Each action runs at most ONCE per run (memoized): a second request returns the
 * first result instead of re-running, so a supervisor cannot loop an install.
 *
 * Electron-free and exec-injected so it is unit-testable with a fake runner.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, posix } from 'path';
import type { RunWorktreeHost } from '../trpc/contracts/runHostAccess';
import type { LoggerLike } from '../types';

/** The closed set of environment actions a supervisor may request. */
export type EnvironmentActionKind = 'install_dependencies';

export const ENVIRONMENT_ACTION_KINDS: readonly EnvironmentActionKind[] = ['install_dependencies'];

/** Kill switch: set to '1' to disable every environment action (and the preflight). */
export const ENVIRONMENT_ACTIONS_KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_ENV_ACTIONS';

export interface EnvironmentActionResult {
  ok: boolean;
  /** One-line summary for chat / findings. */
  summary: string;
  /** Tail of the command output (or the refusal reason). */
  detail: string;
}

/** Runs `bin args` in `cwd`; rejects on a non-zero exit / timeout like execFile. */
export type EnvironmentExec = (
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ stdout: string; stderr: string }>;

interface PackageManagerPlan {
  lockfile: string;
  bin: string;
  args: string[];
}

/** Lockfile → frozen install command. First match wins (pnpm before npm before yarn/bun). */
const PACKAGE_MANAGERS: readonly PackageManagerPlan[] = [
  { lockfile: 'pnpm-lock.yaml', bin: 'pnpm', args: ['install', '--frozen-lockfile'] },
  { lockfile: 'package-lock.json', bin: 'npm', args: ['ci'] },
  { lockfile: 'yarn.lock', bin: 'yarn', args: ['install', '--frozen-lockfile'] },
  { lockfile: 'bun.lockb', bin: 'bun', args: ['install', '--frozen-lockfile'] },
  { lockfile: 'bun.lock', bin: 'bun', args: ['install', '--frozen-lockfile'] },
];

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 2000;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the package.json at `dir` declares at least one dependency. */
function declaresDependencies(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
      const block = pkg[key];
      return typeof block === 'object' && block !== null && Object.keys(block).length > 0;
    });
  } catch {
    return false;
  }
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed;
}

export class EnvironmentActions {
  private installOnce: Promise<EnvironmentActionResult> | undefined;

  constructor(
    private readonly worktreePath: string,
    private readonly exec: EnvironmentExec,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** The install plan the worktree's lockfile implies, or undefined. */
  private plan(): PackageManagerPlan | undefined {
    return PACKAGE_MANAGERS.find((pm) => existsSync(join(this.worktreePath, pm.lockfile)));
  }

  /**
   * Package roots (the worktree root and its immediate sub-directories) that
   * declare dependencies but have no `node_modules` — relative paths. Empty when
   * the worktree has no JS lockfile at all.
   */
  missingDependencyDirs(): string[] {
    if (this.plan() === undefined) return [];
    const candidates = ['.'];
    try {
      for (const entry of readdirSync(this.worktreePath)) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        if (isDir(join(this.worktreePath, entry)) && existsSync(join(this.worktreePath, entry, 'package.json'))) {
          candidates.push(entry);
        }
      }
    } catch {
      return [];
    }
    return candidates.filter((rel) => {
      const dir = join(this.worktreePath, rel);
      return declaresDependencies(dir) && !isDir(join(dir, 'node_modules'));
    });
  }

  /**
   * The actions available in this worktree right now.
   *
   * Nothing on win32: the injected exec is shell-free execFile, and on Windows
   * pnpm/npm/yarn are `.cmd` shims, which execFile cannot launch (ENOENT without
   * PATHEXT resolution; EINVAL without `shell: true` since the CVE-2024-27980
   * fix). Enabling a shell reopens the quoting surface the closed argv avoids,
   * and resolving each shim's JS entry point is untested — so the action (and
   * the fan-out preflight) stays off there until someone verifies one of those.
   */
  available(): EnvironmentActionKind[] {
    return this.platform !== 'win32' && this.plan() !== undefined ? ['install_dependencies'] : [];
  }

  /**
   * A short human/LLM-readable description of the worktree environment, for the
   * supervisor's triage prompt: the package manager, missing dependency dirs,
   * and whether an install already ran this run.
   */
  describe(): string {
    const plan = this.plan();
    if (plan === undefined) return 'No JavaScript lockfile at the worktree root; no environment actions are available.';
    const missing = this.missingDependencyDirs();
    const lines = [
      `Package manager: ${plan.bin} (${plan.lockfile}); install_dependencies would run \`${plan.bin} ${plan.args.join(' ')}\`.`,
      missing.length > 0
        ? `Dependency folders MISSING: ${missing.map((rel) => (rel === '.' ? 'node_modules' : `${rel}/node_modules`)).join(', ')}.`
        : 'Every package with dependencies has a node_modules folder.',
    ];
    if (this.installOnce !== undefined) lines.push('install_dependencies already ran in this run (it runs at most once).');
    if (this.platform === 'win32') lines.push('Environment actions are not supported on Windows.');
    return lines.join('\n');
  }

  /** Run a requested action (memoized: at most once per run per action). */
  run(action: EnvironmentActionKind): Promise<EnvironmentActionResult> {
    switch (action) {
      case 'install_dependencies':
        this.installOnce ??= this.installDependencies();
        return this.installOnce;
    }
  }

  private async installDependencies(): Promise<EnvironmentActionResult> {
    const plan = this.plan();
    if (plan === undefined) {
      return { ok: false, summary: 'no lockfile — nothing to install from', detail: 'No supported lockfile at the worktree root.' };
    }
    if (this.platform === 'win32') {
      return { ok: false, summary: 'not supported on Windows', detail: 'Environment actions are not supported on Windows.' };
    }
    const command = `${plan.bin} ${plan.args.join(' ')}`;
    try {
      const { stdout, stderr } = await this.exec(plan.bin, plan.args, this.worktreePath, INSTALL_TIMEOUT_MS);
      return { ok: true, summary: `\`${command}\` succeeded`, detail: tail(`${stdout}\n${stderr}`) };
    } catch (err) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      return {
        ok: false,
        summary: `\`${command}\` failed`,
        detail: tail(`${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? String(err)}`),
      };
    }
  }
}

/** What a {@link HostEnvironmentActions} last read from the remote worktree. */
interface HostEnvironmentSnapshot {
  plan: PackageManagerPlan | undefined;
  missing: string[];
  readAt: Date;
}

/** Bounds on reading a remote worktree's environment state. */
const HOST_SNAPSHOT_TIMEOUT_MS = 20_000;
const HOST_PACKAGE_JSON_MAX_BYTES = 1024 * 1024;
/** Sub-directories of the worktree root inspected for a package.json (a monorepo's packages). */
const HOST_MAX_ROOT_ENTRIES = 200;

/** True when the package.json text declares at least one dependency. */
function declaresDependenciesIn(text: string): boolean {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
      const block = pkg[key];
      return typeof block === 'object' && block !== null && Object.keys(block).length > 0;
    });
  } catch {
    return false;
  }
}

/**
 * {@link EnvironmentActions} for a run whose worktree is on a REMOTE environment (spec M2 §5 D3): the same closed
 * action set and the same lockfile → frozen-install plan, but every read and the install itself go through the
 * run's host (`execIn` with cwd = the remote worktree and the environment's tool PATH). Nothing runs on This Mac.
 *
 * The run host consumes `describe` / `available` / `missingDependencyDirs` SYNCHRONOUSLY, while the remote reads
 * are async, so this answers from a SNAPSHOT: {@link prime} reads it (the runner awaits it once, bounded, before
 * the run host exists), every sync read kicks a coalesced background refresh, and an install re-reads it when it
 * finishes. A snapshot that could not be read means "no actions available" — fail-soft, never a guess.
 */
export class HostEnvironmentActions {
  private installOnce: Promise<EnvironmentActionResult> | undefined;
  private snapshot: HostEnvironmentSnapshot | undefined;
  private snapshotError: string | undefined;
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly worktreePath: string,
    private readonly host: RunWorktreeHost,
    private readonly logger?: LoggerLike,
  ) {}

  /** Read the remote worktree's state (bounded; never rejects). Concurrent calls share one read. */
  prime(): Promise<void> {
    this.refreshing ??= this.readSnapshot().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  missingDependencyDirs(): string[] {
    void this.prime();
    return this.snapshot?.plan !== undefined ? [...this.snapshot.missing] : [];
  }

  available(): EnvironmentActionKind[] {
    void this.prime();
    return this.snapshot?.plan !== undefined ? ['install_dependencies'] : [];
  }

  describe(): string {
    void this.prime();
    const snap = this.snapshot;
    if (snap === undefined) {
      return [
        'The worktree is on a remote environment and its state could not be read yet; no environment actions are available.',
        ...(this.snapshotError !== undefined ? [`Last read error: ${this.snapshotError}`] : []),
      ].join('\n');
    }
    const where = `The worktree is on a remote environment; this report was read from it at ${snap.readAt.toISOString()}.`;
    if (snap.plan === undefined) {
      return `${where}\nNo JavaScript lockfile at the worktree root; no environment actions are available.`;
    }
    const plan = snap.plan;
    const lines = [
      where,
      `Package manager: ${plan.bin} (${plan.lockfile}); install_dependencies would run \`${plan.bin} ${plan.args.join(' ')}\` on the environment.`,
      snap.missing.length > 0
        ? `Dependency folders MISSING: ${snap.missing.map((rel) => (rel === '.' ? 'node_modules' : `${rel}/node_modules`)).join(', ')}.`
        : 'Every package with dependencies has a node_modules folder.',
    ];
    if (this.installOnce !== undefined) lines.push('install_dependencies already ran in this run (it runs at most once).');
    return lines.join('\n');
  }

  /** Run a requested action (memoized: at most once per run per action). */
  run(action: EnvironmentActionKind): Promise<EnvironmentActionResult> {
    switch (action) {
      case 'install_dependencies':
        this.installOnce ??= this.installDependencies();
        return this.installOnce;
    }
  }

  private async installDependencies(): Promise<EnvironmentActionResult> {
    let plan: PackageManagerPlan | undefined;
    try {
      plan = await this.readPlan();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, summary: 'could not read the worktree on the environment', detail: message };
    }
    if (plan === undefined) {
      return { ok: false, summary: 'no lockfile — nothing to install from', detail: 'No supported lockfile at the worktree root.' };
    }
    const command = `${plan.bin} ${plan.args.join(' ')}`;
    let result: EnvironmentActionResult;
    try {
      const { stdout, stderr } = await this.host.execIn(this.worktreePath, plan.bin, plan.args, { timeoutMs: INSTALL_TIMEOUT_MS });
      result = { ok: true, summary: `\`${command}\` succeeded on the environment`, detail: tail(`${stdout}\n${stderr}`) };
    } catch (err) {
      const e = err as { message?: string; stdout?: string; stderr?: string };
      result = {
        ok: false,
        summary: `\`${command}\` failed on the environment`,
        detail: tail(`${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? String(err)}`),
      };
    }
    // A read already in flight started before the install finished: let it settle, then read afresh.
    await this.refreshing;
    await this.prime();
    return result;
  }

  private async readPlan(): Promise<PackageManagerPlan | undefined> {
    for (const pm of PACKAGE_MANAGERS) {
      if (await this.host.exists(posix.join(this.worktreePath, pm.lockfile))) return pm;
    }
    return undefined;
  }

  private async hostDeclaresDependencies(dir: string): Promise<boolean> {
    try {
      return declaresDependenciesIn(await this.host.readFile(posix.join(dir, 'package.json'), HOST_PACKAGE_JSON_MAX_BYTES));
    } catch {
      return false;
    }
  }

  private async hostIsDir(p: string): Promise<boolean> {
    try {
      return (await this.host.stat(p))?.isDir === true;
    } catch {
      return false;
    }
  }

  /** The local {@link EnvironmentActions.missingDependencyDirs} walk, over the host. */
  private async readMissing(): Promise<string[]> {
    const root = this.worktreePath;
    const candidates = ['.'];
    try {
      const entries = (await this.host.readdir(root)).filter((e) => !e.startsWith('.') && e !== 'node_modules');
      for (const entry of entries.slice(0, HOST_MAX_ROOT_ENTRIES)) {
        // A package.json under `entry` implies `entry` is a directory (the local walk's isDir && exists).
        if ((await this.host.stat(posix.join(root, entry, 'package.json'))) !== null) candidates.push(entry);
      }
    } catch {
      return [];
    }
    const missing: string[] = [];
    for (const rel of candidates) {
      const dir = rel === '.' ? root : posix.join(root, rel);
      if ((await this.hostDeclaresDependencies(dir)) && !(await this.hostIsDir(posix.join(dir, 'node_modules')))) {
        missing.push(rel);
      }
    }
    return missing;
  }

  private async readSnapshot(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${HOST_SNAPSHOT_TIMEOUT_MS} ms`)), HOST_SNAPSHOT_TIMEOUT_MS);
    });
    try {
      const read = (async (): Promise<HostEnvironmentSnapshot> => {
        const plan = await this.readPlan();
        const missing = plan === undefined ? [] : await this.readMissing();
        return { plan, missing, readAt: new Date() };
      })();
      read.catch(() => undefined);
      this.snapshot = await Promise.race([read, deadline]);
      this.snapshotError = undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Logged once per distinct error: every sync read re-kicks a refresh.
      if (message !== this.snapshotError) {
        this.logger?.warn('[EnvironmentActions] could not read the remote worktree environment (fail-soft)', {
          hostId: this.host.hostId,
          error: message,
        });
      }
      this.snapshotError = message;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

export function environmentActionsDisabled(): boolean {
  return process.env[ENVIRONMENT_ACTIONS_KILL_SWITCH_ENV] === '1';
}
