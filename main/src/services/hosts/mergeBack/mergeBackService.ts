/**
 * MergeBackService — brings a remote session's work back to This Mac (spec M2 §6 E2), per SESSION.
 *
 * session_merge_backs (MergeBackStore, the sole writer) walks, after RemoteCheckout's bare_ready → base_pushed →
 * remote_ready:
 *   [checkpointed]*  a lane integrated: the branch tip is fetched into refs/cyboflow/checkpoint/<key> (background,
 *                    coalesced per session; never regresses a later state)
 *   import_intent    Merge pressed: the session's live processes are stopped FIRST, the remote worktree must be clean,
 *                    S = remote rev-parse refs/heads/<branch> is persisted BEFORE anything is fetched
 *   imported         local `git fetch --upload-pack=<probed git> upload-pack <url> +refs/heads/<branch>:
 *                    refs/cyboflow/import/<key>` over GIT_SSH_COMMAND, then rev-parse == S (≤ 3 attempts, S re-read)
 *   local_ready      the MIRROR: a local worktree at <project>/.cyboflow/worktrees/remote-import/<key> (git-excluded),
 *                    hard-reset to the import ref before EVERY merge attempt (the squash rewrites it)
 *   merged           the UNCHANGED WorktreeManager squash / rebase-merge ran on the mirror (or ALREADY_UP_TO_DATE /
 *                    the landing probe of the IMPORT ref says the work is already on main); recorded, with merged_sha
 *                    and merged_at, the moment the local merge returned. closed_out_at follows once the run / lane
 *                    close-out completed (recordClosedOut), so boot never repeats it.
 *   remote_ready     the post-merge RESYNC (background, under the session lock), so a merged session behaves like a
 *                    local one — it keeps its worktree, its branch now equals main, and it can merge again:
 *                    local main (the merge result) is force-pushed to refs/cyboflow/base/<key>; the remote branch is
 *                    moved by a compare-and-swap `update-ref <branch> <main> <imported tip>` (an agent commit since
 *                    wins: the branch is left alone and the next merge asks for a rebase) and the tree follows with
 *                    `read-tree -m -u <imported> <main>` (refuses to clobber a local change; the branch is swapped
 *                    back); then the LOCAL half (import + checkpoint refs, the mirror worktree and the mirror branch)
 *                    is deleted. A dirty tree keeps `merged` + last_error; the next Merge (or boot) finishes it first.
 *
 *   remote_ready ─▶ [checkpointed]* ─▶ import_intent ─▶ imported ─▶ local_ready ─▶ merged ─▶ remote_ready ─▶ …
 *                                          ▲   (imported / local_ready ─▶ import_intent: the branch moved; S re-read)
 *
 * The remote worktree, branch and base ref are removed only at archive: any state ─▶ `abandoned` ─▶ `cleaned`
 * (RemoteCheckout.removeSessionWorktree owns the remote half; the local half runs through
 * {@link MergeBackService.cleanupLocal}, wired to the store's change callback by hostsComposition; boot resume
 * finishes an `abandoned` row through {@link MergeBackService.cleanup}). "Already gone" = success.
 *
 * The mirror branch is the session branch `<branch>` (so Create-PR pushes a branch named like the session) unless This
 * Mac already has a `<branch>` cyboflow did not create; then it is the cyboflow-owned `cyboflow-import/<key>`.
 * Ownership is recorded in the project's git config (`branch.<name>.cyboflowMirror = <key>`, which `branch -D` drops
 * with the branch) and implied for whatever branch sits at the mirror path. A branch we do not own is never moved or
 * deleted.
 *
 * Every step checks its postcondition first, so a re-entry after a crash completes the work instead of repeating it.
 * A failure keeps the last good state and records last_error (redacted); the message thrown is user-presentable.
 * All operations for one session serialize on the SAME lock RemoteCheckout uses, so an archive never removes the
 * remote worktree under a running import. Nothing secret is on any argv.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactSecrets } from '../../../../../shared/types/hosts';
import { HostNotFoundError, HostsDisabledError, RemoteHostsDisabledError } from '../../../orchestrator/hosts/errors';
import type { HostCheckoutRow, HostRow } from '../../../orchestrator/hosts/hostStore';
import type { MergeBackRow, MergeBackStore } from '../../../orchestrator/hosts/mergeBackStore';
import { canTransition, type MergeBackState } from '../../../orchestrator/hosts/mergeBackState';
import type { ExecutionHost, HostPath } from '../../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../../orchestrator/types';
import { ensureGitExcludeEntries } from '../../../utils/gitExcludeWriter';
import { withLock } from '../../../utils/mutex';
import { END_OF_OPTIONS, runGitCapture } from '../../../utils/runGit';
import { ALREADY_UP_TO_DATE_CODE } from '../../worktreeManager';
import { buildGitSshEnv, remoteGitPackCommand, remoteGitUrl, type GitSshTransportLike } from '../gitSshEnv';
import { remoteFactsFromPreflight } from '../hostRegistry';
import type { CaptureErrorFn } from '../preflight/preflightEngine';
import {
  parseWorktreeList,
  remoteBareRepoPath,
  remoteSessionWorktreePath,
  type GitRemoteResolver,
  type LocalGitRunner,
} from '../remoteCheckout';

const GIT_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30 * 60_000;
const WORKTREE_TIMEOUT_MS = 10 * 60_000;
/** Same name and wait as RemoteCheckout's per-session lock: one queue for setup, merge-back and archive. */
const SESSION_LOCK_WAIT_MS = 60 * 60_000;
const PROBE_LOCK_WAIT_MS = 30_000;
const DEFAULT_IMPORT_ATTEMPTS = 3;
const MIRROR_OWNER_CONFIG = 'cyboflowMirror';
const MIRROR_DIR_SEGMENTS = ['.cyboflow', 'worktrees', 'remote-import'] as const;
/** The project-repo exclude that keeps the mirror out of `git status` (same entry RunLauncher writes). */
const MIRROR_EXCLUDE_ENTRY = '.cyboflow/worktrees/';

const IMPORTABLE: readonly MergeBackState[] = ['remote_ready', 'checkpointed', 'import_intent', 'imported', 'local_ready'];
const CHECKPOINTABLE: readonly MergeBackState[] = ['remote_ready', 'checkpointed'];
/** Every live row (an archived session's is abandoned at boot) — plus `abandoned`, cleaned at boot. */
const RESUMABLE: readonly MergeBackState[] = [
  'bare_ready', 'base_pushed', 'remote_ready', 'checkpointed', 'import_intent', 'imported', 'local_ready', 'merged', 'abandoned',
];
/** The rows boot resumes on a session that is NOT archived. */
const RESUME_ON_BOOT: readonly MergeBackState[] = ['merged', 'import_intent', 'imported', 'local_ready'];

export const importRef = (key: string): string => `refs/cyboflow/import/${key}`;
export const checkpointRef = (key: string): string => `refs/cyboflow/checkpoint/${key}`;
export const baseRef = (key: string): string => `refs/cyboflow/base/${key}`;
export const fallbackMirrorBranch = (key: string): string => `cyboflow-import/${key}`;

/** `<project>/.cyboflow/worktrees/remote-import/<key>`. */
export function mirrorWorktreePath(projectPath: string, key: string): string {
  return path.join(projectPath, ...MIRROR_DIR_SEGMENTS, key);
}

export type MergeBackErrorCode =
  | 'not-remote' | 'needs-check' | 'no-row' | 'state' | 'dirty' | 'import' | 'mirror' | 'refresh' | 'resync' | 'cleanup';

/** `message` is user-presentable: redacted, no ssh target. */
export class MergeBackError extends Error {
  readonly code: MergeBackErrorCode;
  constructor(code: MergeBackErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MergeBackError';
    this.code = code;
  }
}

export type RemoteMergeOutcome =
  | { kind: 'merged' }
  /** ALREADY_UP_TO_DATE, the landing probe, or an earlier merge: the work is on main; the row is merged. */
  | { kind: 'already-landed' }
  /** Main moved past the branch: the base was refreshed on the environment; `message` tells the user what to ask. */
  | { kind: 'needs-rebase'; message: string };

export interface MirrorHandle {
  /** The local mirror worktree (the path the git listing reports). */
  worktreePath: string;
  /** The local branch checked out there. */
  branch: string;
  importSha: string;
}

export interface MirrorInput {
  sessionId: string;
  projectPath: string;
  /** Ends the session's live (remote) processes; awaited BEFORE the branch tip is read. A throw is logged, not fatal. */
  stopProcesses?: () => Promise<void>;
}

export interface MergeSessionInput extends MirrorInput {
  mainBranch: string;
  /** Whether main has commits the mirror lacks (gitOps: WorktreeManager.hasChangesToRebase on the mirror). */
  needsRebase?: (mirrorPath: string) => Promise<boolean>;
  /** The unchanged WorktreeManager squash / rebase-merge, run on the mirror. */
  merge: (mirrorPath: string) => Promise<void>;
}

export interface LandingProbe {
  landed: boolean;
  ownCommits: number;
  /** false = git could not answer (nothing fetched, host away) or the work is merged and its refs are gone. */
  proven: boolean;
}

export interface ResumeDeps {
  /** gitOps closeOutSessionAfterLanding (fail-soft, idempotent). */
  closeOut(sessionId: string, mergeSha: string | undefined): Promise<void>;
  /**
   * The session is archived (or its row is gone): a live row then records the abandon intent an archive could not
   * (no checkout service was wired), and both halves are cleaned. Absent = never.
   */
  isArchived?(sessionId: string): boolean;
  /** How many of the session's runs were created after `iso` (a close-out must never stamp them). Absent = 0. */
  runsCreatedSince?(sessionId: string, iso: string): number;
}

export interface ResumeSummary {
  /** `merged` rows brought back to remote_ready (resync). */
  resynced: number;
  /** `abandoned` rows whose two halves were removed. */
  cleaned: number;
  closedOut: number;
  left: number;
  errored: number;
}

/** The slice gitOps / bootRecovery / hostsComposition use (MergeBackService satisfies it). */
export interface MergeBackServiceLike {
  mergeSession(input: MergeSessionInput): Promise<RemoteMergeOutcome>;
  withMirror<T>(input: MirrorInput, fn: (mirror: MirrorHandle) => Promise<T>): Promise<T>;
  refreshBase(sessionId: string, projectPath: string, mainBranch: string): Promise<string>;
  probeLanding(sessionId: string, projectPath: string, mainBranch: string): Promise<LandingProbe>;
  /** `mainBranch` = the branch the work landed on (default: the project's checked-out branch). */
  recordLanded(sessionId: string, mainBranch?: string): Promise<void>;
  /** The caller finished the run / lane close-out of the last merge (boot resume will not repeat it). Never throws. */
  recordClosedOut?(sessionId: string): Promise<void>;
  mirrorBranch(sessionId: string, projectPath: string): Promise<string | null>;
  requestCheckpoint(sessionId: string): Promise<void>;
  cleanup(sessionId: string): Promise<boolean>;
  cleanupLocal(sessionId: string): Promise<boolean>;
  resumeAll(deps: ResumeDeps): Promise<ResumeSummary>;
}

export type MergeBackStep =
  | 'import-intent' | 'imported' | 'local-ready' | 'merged' | 'checkpointed'
  | 'resync-base' | 'resync-remote' | 'cleanup-remote' | 'cleanup-local';

export interface MergeBackServiceDeps {
  /** HostsService.status(): the Environments gates. */
  status(): { running: boolean; killed: boolean };
  store: { get(id: string): HostRow | null; getCheckout(hostId: string, projectId: number): HostCheckoutRow | null };
  /** HostRegistry.get — @throws HostNotFoundError. */
  getHost(hostId: string): ExecutionHost;
  transport: GitSshTransportLike;
  mergeBacks: Pick<MergeBackStore, 'get' | 'transition' | 'setError' | 'listByState' | 'markClosedOut'>;
  /** projects.path; null when the project is gone. */
  projectPathFor(projectId: number): string | null;
  logger: LoggerLike;
  captureError?: CaptureErrorFn;
  /** Local git. Default utils/runGit runGitCapture. */
  localGit?: LocalGitRunner;
  /** How local git addresses the bare repo. Default: ssh:// URL + GIT_SSH_COMMAND; tests use a local path. */
  gitRemote?: GitRemoteResolver;
  /** Keeps the mirror out of the project's `git status`. Default: utils/gitExcludeWriter. */
  ensureExcluded?: (projectPath: string) => void;
  /** Test seam: runs after each persisted step (a throw simulates a crash right there). */
  afterStep?: (sessionId: string, step: MergeBackStep) => void | Promise<void>;
  importAttempts?: number;
}

interface ResolvedHost {
  row: HostRow & { sshTarget: string };
  host: ExecutionHost;
  remoteRoot: string;
  gitPath: string | null;
}

interface ListedMirror {
  path: string;
  branch: string | null;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** The tail of a (git) error, redacted and bounded, for a user-facing message / last_error. */
function readable(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = redactSecrets(raw).trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-3).join(' ').trim();
  return tail.length > 400 ? `${tail.slice(0, 400)}…` : tail;
}

function isAlreadyUpToDate(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ALREADY_UP_TO_DATE_CODE;
}

function defaultGitRemote(transport: GitSshTransportLike): GitRemoteResolver {
  return (host, bare) => ({ url: remoteGitUrl(host.sshTarget, bare), env: buildGitSshEnv(transport, host.sshTarget) });
}

export class MergeBackService implements MergeBackServiceLike {
  private readonly localGit: LocalGitRunner;
  private readonly gitRemote: GitRemoteResolver;
  private readonly ensureExcluded: (projectPath: string) => void;
  private readonly checkpoints = new Map<string, { running: Promise<void>; again: boolean }>();
  private readonly resyncs = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: MergeBackServiceDeps) {
    this.localGit = deps.localGit ?? ((cwd, args, opts) => runGitCapture(cwd, args, opts));
    this.gitRemote = deps.gitRemote ?? defaultGitRemote(deps.transport);
    this.ensureExcluded = deps.ensureExcluded
      ?? ((projectPath) => { ensureGitExcludeEntries(projectPath, [MIRROR_EXCLUDE_ENTRY], { logger: deps.logger, label: 'merge-back' }); });
  }

  // ------------------------------------------------------------------ plumbing

  private locked<T>(sessionId: string, fn: () => Promise<T>, waitMs = SESSION_LOCK_WAIT_MS): Promise<T> {
    return withLock(`remote-checkout-session-${sessionId}`, fn, waitMs);
  }

  /** Gates + a live SSH host with a complete check. */
  private resolve(hostId: string): ResolvedHost {
    const status = this.deps.status();
    if (!status.running) throw new HostsDisabledError();
    if (status.killed) throw new RemoteHostsDisabledError();
    const row = this.deps.store.get(hostId);
    if (!row || row.archivedAt !== null) throw new HostNotFoundError();
    if (row.kind !== 'ssh' || row.sshTarget === null) throw new MergeBackError('not-remote', 'This environment is not a remote machine.');
    const facts = remoteFactsFromPreflight(row.preflight);
    if (facts === null) {
      throw new MergeBackError('needs-check', `The environment "${row.label}" has no completed check yet. Run a check first.`);
    }
    return { row: { ...row, sshTarget: row.sshTarget }, host: this.deps.getHost(hostId), remoteRoot: facts.remoteRoot, gitPath: row.preflight?.remote?.gitPath ?? null };
  }

  private hp(hostId: string, p: string): HostPath {
    return { hostId, path: p };
  }

  private bareOf(r: ResolvedHost, row: MergeBackRow): string {
    return this.deps.store.getCheckout(row.hostId, row.projectId)?.remoteRepoPath ?? remoteBareRepoPath(r.remoteRoot, row.projectId);
  }

  private requireRow(sessionId: string): MergeBackRow {
    const row = this.deps.mergeBacks.get(sessionId);
    if (row === null) throw new MergeBackError('no-row', 'This session has no worktree on an environment to bring back.');
    return row;
  }

  private async step(sessionId: string, step: MergeBackStep): Promise<void> {
    if (this.deps.afterStep) await this.deps.afterStep(sessionId, step);
  }

  private async lg(cwd: string, args: string[], opts: { env?: Record<string, string>; timeout?: number } = {}): Promise<string> {
    return (await this.localGit(cwd, args, { timeout: GIT_TIMEOUT_MS, ...opts })).stdout;
  }

  /** The commit a local ref resolves to, or null. */
  private async localSha(cwd: string, ref: string): Promise<string | null> {
    try {
      const out = (await this.lg(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).trim();
      return out === '' ? null : out;
    } catch {
      return null;
    }
  }

  private async localTry(cwd: string, args: string[]): Promise<boolean> {
    try {
      await this.lg(cwd, args);
      return true;
    } catch {
      return false;
    }
  }

  private async count(cwd: string, range: string): Promise<number> {
    return Number.parseInt((await this.lg(cwd, ['rev-list', '--count', END_OF_OPTIONS, range])).trim(), 10) || 0;
  }

  /** Records last_error (redacted) and reports the failure; never throws. */
  private async recordFailure(sessionId: string, hostId: string, step: string, err: unknown, message: string): Promise<void> {
    this.deps.logger.warn('[merge-back] step failed', { hostId, sessionId, step, error: errorName(err) });
    this.deps.captureError?.('host-merge-back', err, { hostKind: 'ssh', step, errorClass: errorName(err) });
    try {
      if (this.deps.mergeBacks.get(sessionId) !== null) await this.deps.mergeBacks.setError(sessionId, redactSecrets(message));
    } catch (writeErr) {
      this.deps.logger.warn('[merge-back] could not record the error', { sessionId, error: errorName(writeErr) });
    }
  }

  private async fetchTip(r: ResolvedHost, row: MergeBackRow, projectPath: string, dest: string): Promise<void> {
    const { url, env } = this.gitRemote({ sshTarget: r.row.sshTarget }, this.bareOf(r, row));
    await this.localGit(projectPath, [
      'fetch', '--quiet', '--no-tags', `--upload-pack=${remoteGitPackCommand(r.gitPath, 'upload-pack')}`,
      url, `+refs/heads/${row.branch}:${dest}`,
    ], { env, timeout: FETCH_TIMEOUT_MS });
  }

  // -------------------------------------------------------------------- import

  /** Stop → clean check → S → (persist) → fetch → assert; ends `imported` (or later, re-entered). Returns S. */
  private async importLocked(row0: MergeBackRow, r: ResolvedHost, input: MirrorInput): Promise<{ row: MergeBackRow; sha: string }> {
    const { sessionId, projectPath } = input;
    let row = row0;
    const label = r.row.label;
    if (input.stopProcesses) {
      try {
        await input.stopProcesses();
      } catch (err) {
        this.deps.logger.warn('[merge-back] could not stop the session processes', { sessionId, error: errorName(err) });
      }
    }
    const wt = row.remoteWorktreePath ?? remoteSessionWorktreePath(r.remoteRoot, row.mergeKey);
    const status = await r.host.git.run(this.hp(row.hostId, wt), ['status', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
    if (status.code !== 0) {
      throw new MergeBackError('import', `Could not read the session worktree on "${label}": ${readable(status.stderr)}`);
    }
    if (status.stdout.trim() !== '') {
      throw new MergeBackError('dirty', `Uncommitted changes on ${label} — ask the agent to commit them first.`);
    }

    const ref = importRef(row.mergeKey);
    const bare = this.bareOf(r, row);
    const attempts = this.deps.importAttempts ?? DEFAULT_IMPORT_ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      const tip = await r.host.git.run(this.hp(row.hostId, bare), ['rev-parse', '--verify', '-q', `refs/heads/${row.branch}^{commit}`], { timeoutMs: GIT_TIMEOUT_MS });
      const sha = tip.stdout.trim();
      if (tip.code !== 0 || sha === '') throw new MergeBackError('import', `The session branch is missing on "${label}".`);
      // Persist S before anything is fetched. Re-entry at import_intent keeps its row; a branch that moved after
      // an earlier import re-records S only where the state machine allows the edge.
      if (row.state === 'remote_ready' || row.state === 'checkpointed'
        || (row.importSha !== sha && row.state !== 'import_intent' && canTransition(row.state, 'import_intent'))) {
        row = await this.deps.mergeBacks.transition(sessionId, { from: [row.state], to: 'import_intent', patch: { importSha: sha, lastError: null } });
        await this.step(sessionId, 'import-intent');
      }
      if ((await this.localSha(projectPath, ref)) !== sha) {
        try {
          await this.fetchTip(r, row, projectPath, ref);
        } catch (err) {
          throw new MergeBackError('import', `Could not bring the session's commits back from "${label}": ${readable(err)}`, { cause: err });
        }
      }
      if ((await this.localSha(projectPath, ref)) === sha) {
        if (row.state === 'import_intent') {
          row = await this.deps.mergeBacks.transition(sessionId, { from: ['import_intent'], to: 'imported', patch: { importSha: sha, lastError: null } });
          await this.step(sessionId, 'imported');
        }
        return { row, sha };
      }
      if (attempt >= attempts) {
        throw new MergeBackError('import', `The session branch on "${label}" kept changing while it was being brought back. Try again.`);
      }
      this.deps.logger.info('[merge-back] branch moved during import; retrying', { sessionId, attempt });
    }
  }

  // -------------------------------------------------------------------- mirror

  private async findMirror(projectPath: string, key: string): Promise<ListedMirror | null> {
    const out = await this.lg(projectPath, ['worktree', 'list', '--porcelain']);
    const suffix = `/${MIRROR_DIR_SEGMENTS.join('/')}/${key}`;
    for (const [p, head] of parseWorktreeList(out)) {
      if (p.split(path.sep).join('/').endsWith(suffix)) {
        return { path: p, branch: head !== null && head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null };
      }
    }
    return null;
  }

  private async ownsBranch(projectPath: string, branch: string, key: string): Promise<boolean> {
    try {
      return (await this.lg(projectPath, ['config', '--get', `branch.${branch}.${MIRROR_OWNER_CONFIG}`])).trim() === key;
    } catch {
      return false;
    }
  }

  /** `<branch>` when absent or ours; otherwise the cyboflow-owned fallback (a user's branch is never touched). */
  private async chooseMirrorBranch(projectPath: string, row: MergeBackRow): Promise<string> {
    const exists = (await this.localSha(projectPath, `refs/heads/${row.branch}`)) !== null;
    if (!exists || (await this.ownsBranch(projectPath, row.branch, row.mergeKey))) return row.branch;
    return fallbackMirrorBranch(row.mergeKey);
  }

  /** The mirror on its branch, reset hard to the import ref; ends `local_ready`. */
  private async mirrorLocked(row0: MergeBackRow, projectPath: string, sha: string): Promise<{ row: MergeBackRow; mirror: MirrorHandle }> {
    let row = row0;
    const key = row.mergeKey;
    const ref = importRef(key);
    this.ensureExcluded(projectPath);
    let listed = await this.findMirror(projectPath, key);
    let branch: string;
    if (listed === null) {
      const target = mirrorWorktreePath(projectPath, key);
      await this.lg(projectPath, ['worktree', 'prune']);
      // A directory git does not list (a crash mid-add) is ours: the path is cyboflow's and the key is the session's.
      await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      branch = await this.chooseMirrorBranch(projectPath, row);
      await this.lg(projectPath, ['worktree', 'add', '-q', '-B', branch, target, ref], { timeout: WORKTREE_TIMEOUT_MS });
      listed = (await this.findMirror(projectPath, key)) ?? { path: target, branch };
    } else if (listed.branch === null || (listed.branch !== row.branch && listed.branch !== fallbackMirrorBranch(key))) {
      branch = await this.chooseMirrorBranch(projectPath, row);
      await this.lg(listed.path, ['checkout', '-q', '-B', branch, ref]);
    } else {
      branch = listed.branch;
    }
    await this.lg(projectPath, ['config', `branch.${branch}.${MIRROR_OWNER_CONFIG}`, key]);
    // Re-sync before EVERY attempt: a failed squash leaves the branch rebased / reset / committed.
    await this.localTry(listed.path, ['rebase', '--abort']);
    await this.localTry(listed.path, ['merge', '--abort']);
    await this.lg(listed.path, ['reset', '--hard', '-q', ref]);
    await this.lg(listed.path, ['clean', '-fdq']);
    if (row.state === 'imported') {
      row = await this.deps.mergeBacks.transition(row.sessionId, {
        from: ['imported'], to: 'local_ready', patch: { localWorktreePath: listed.path, importSha: sha, lastError: null },
      });
      await this.step(row.sessionId, 'local-ready');
    }
    return { row, mirror: { worktreePath: listed.path, branch, importSha: sha } };
  }

  private async prepareLocked(input: MirrorInput): Promise<{ row: MergeBackRow; r: ResolvedHost; mirror: MirrorHandle }> {
    const row0 = this.requireRow(input.sessionId);
    if (!IMPORTABLE.includes(row0.state)) {
      throw new MergeBackError('state', row0.state === 'abandoned' || row0.state === 'cleaned'
        ? 'This session\'s worktree on its environment was already removed.'
        : 'This session\'s worktree on its environment is not ready yet.');
    }
    const r = this.resolve(row0.hostId);
    try {
      const imported = await this.importLocked(row0, r, input);
      const { row, mirror } = await this.mirrorLocked(imported.row, input.projectPath, imported.sha);
      return { row, r, mirror };
    } catch (err) {
      const e = err instanceof MergeBackError
        ? err
        : new MergeBackError('mirror', `Could not prepare the session's work on This Mac: ${readable(err)}`, { cause: err });
      await this.recordFailure(input.sessionId, row0.hostId, `merge-back-${e.code}`, err, e.message);
      throw e;
    }
  }

  /** imported / local_ready (or import_intent with the ref fetched) → merged, with the local main it landed on. */
  private async markMergedLocked(sessionId: string, mainBranch: string | null): Promise<void> {
    const row = this.requireRow(sessionId);
    if (row.state === 'merged') return;
    if (row.state === 'import_intent') {
      const sha = await this.importedShaFor(row);
      if (sha === null) return;
      await this.deps.mergeBacks.transition(sessionId, { from: ['import_intent'], to: 'imported', patch: { importSha: sha } });
    }
    const cur = this.requireRow(sessionId);
    if (cur.state !== 'imported' && cur.state !== 'local_ready') return;
    const projectPath = this.deps.projectPathFor(cur.projectId);
    let mergedSha: string | null = null;
    if (projectPath !== null) {
      mergedSha = mainBranch !== null
        ? await this.localSha(projectPath, `refs/heads/${mainBranch}`)
        : await this.localMainSha(projectPath);
    }
    await this.deps.mergeBacks.transition(sessionId, { from: [cur.state], to: 'merged', patch: { mergedSha, lastError: null } });
    await this.step(sessionId, 'merged');
  }

  /** The commit the import ref holds locally (the project is looked up), or null. */
  private async importedShaFor(row: MergeBackRow): Promise<string | null> {
    const projectPath = this.deps.projectPathFor(row.projectId);
    return projectPath === null ? null : this.localSha(projectPath, importRef(row.mergeKey));
  }

  private scheduleResync(sessionId: string, mainBranch: string | null): void {
    if (this.resyncs.has(sessionId)) return;
    const p = this.resync(sessionId, mainBranch).finally(() => this.resyncs.delete(sessionId));
    this.resyncs.set(sessionId, p);
  }

  /** Test seam: the background resync a merge scheduled (resolved true when none is pending). */
  whenResynced(sessionId: string): Promise<boolean> {
    return this.resyncs.get(sessionId) ?? Promise.resolve(true);
  }

  /** Every background resync and checkpoint in flight has settled (quit drain, tests). */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.resyncs.values(), ...[...this.checkpoints.values()].map((c) => c.running)]);
  }

  // ------------------------------------------------------------------ merge

  async mergeSession(input: MergeSessionInput): Promise<RemoteMergeOutcome> {
    const { sessionId, projectPath, mainBranch } = input;
    const outcome = await this.locked(sessionId, async (): Promise<RemoteMergeOutcome> => {
      // The last round landed but its resync never finished: finish it (a failure throws, recorded), then this is an
      // ordinary round — nothing new on the branch ends ALREADY_UP_TO_DATE = already-landed.
      if (this.requireRow(sessionId).state === 'merged') await this.resyncLocked(sessionId, mainBranch);
      const { row, r, mirror } = await this.prepareLocked(input);
      if (input.needsRebase && (await input.needsRebase(mirror.worktreePath))) {
        // Main moved — maybe because this very work was landed by hand; then there is nothing to rebase.
        if ((await this.refLanding(projectPath, importRef(row.mergeKey), mainBranch, row.baseSha)).landed) {
          await this.markMergedLocked(sessionId, mainBranch);
          return { kind: 'already-landed' };
        }
        return { kind: 'needs-rebase', message: await this.refreshBaseLocked(row, r, projectPath, mainBranch) };
      }
      try {
        await input.merge(mirror.worktreePath);
      } catch (err) {
        if (isAlreadyUpToDate(err) || (await this.refLanding(projectPath, importRef(row.mergeKey), mainBranch, row.baseSha)).landed) {
          await this.markMergedLocked(sessionId, mainBranch);
          return { kind: 'already-landed' };
        }
        await this.recordFailure(sessionId, row.hostId, 'merge-back-merge', err, `The merge on This Mac failed: ${readable(err)}`);
        throw err;
      }
      // The local merge returned: record it NOW (merged + merged_sha in one write) — boot resume trusts only this
      // record or a landing check of the import ref, never the mirror's HEAD.
      await this.markMergedLocked(sessionId, mainBranch);
      return { kind: 'merged' };
    });
    if (outcome.kind !== 'needs-rebase') this.scheduleResync(sessionId, mainBranch);
    return outcome;
  }

  async withMirror<T>(input: MirrorInput, fn: (mirror: MirrorHandle) => Promise<T>): Promise<T> {
    return this.locked(input.sessionId, async () => {
      const { row, mirror } = await this.prepareLocked(input);
      try {
        return await fn(mirror);
      } catch (err) {
        await this.recordFailure(input.sessionId, row.hostId, 'merge-back-mirror-op', err, readable(err));
        throw err;
      }
    });
  }

  // ------------------------------------------------------------ refresh base

  async refreshBase(sessionId: string, projectPath: string, mainBranch: string): Promise<string> {
    return this.locked(sessionId, async () => {
      const row = this.requireRow(sessionId);
      if (!IMPORTABLE.includes(row.state)) throw new MergeBackError('state', 'This session\'s worktree on its environment is not available.');
      return this.refreshBaseLocked(row, this.resolve(row.hostId), projectPath, mainBranch);
    });
  }

  /** Force-push the local commit `sha` to refs/cyboflow/base/<key> in the environment's bare repo. */
  private async pushBase(row: MergeBackRow, r: ResolvedHost, projectPath: string, sha: string): Promise<void> {
    const { url, env } = this.gitRemote({ sshTarget: r.row.sshTarget }, this.bareOf(r, row));
    await this.localGit(projectPath, [
      'push', '--quiet', '--no-verify', `--receive-pack=${remoteGitPackCommand(r.gitPath, 'receive-pack')}`, url,
      `+${sha}:${baseRef(row.mergeKey)}`,
    ], { env, timeout: FETCH_TIMEOUT_MS });
  }

  /** Force-push local `mainBranch` to refs/cyboflow/base/<key> on the environment; returns the message for the user. */
  private async refreshBaseLocked(row: MergeBackRow, r: ResolvedHost, projectPath: string, mainBranch: string): Promise<string> {
    const ref = baseRef(row.mergeKey);
    try {
      const sha = await this.localSha(projectPath, `refs/heads/${mainBranch}`);
      if (sha === null) throw new Error(`${mainBranch} does not resolve to a commit.`);
      await this.pushBase(row, r, projectPath, sha);
    } catch (err) {
      const e = new MergeBackError('refresh', `Could not send the latest ${mainBranch} to "${r.row.label}": ${readable(err)}`, { cause: err });
      await this.recordFailure(row.sessionId, row.hostId, 'merge-back-refresh', err, e.message);
      throw e;
    }
    return `${mainBranch} has new commits since this branch started. Cyboflow sent the latest ${mainBranch} to ${r.row.label} as ${ref} — ask the agent to run \`git rebase ${ref}\`, then merge again.`;
  }

  // ------------------------------------------------------------------ landing

  /**
   * WorktreeManager.getBranchLandingState's three questions, asked of a REF (no worktree, no reflog): every commit in
   * main, every patch in main, or identical trees. A tip that main swallowed whole (a fast-forward landing) is told
   * apart from an untouched branch by the recorded base. Never throws (fail-closed).
   */
  private async refLanding(projectPath: string, ref: string, mainBranch: string, baseSha: string | null): Promise<LandingProbe> {
    const none: LandingProbe = { landed: false, ownCommits: 0, proven: false };
    try {
      const tip = await this.localSha(projectPath, ref);
      const main = await this.localSha(projectPath, `refs/heads/${mainBranch}`);
      if (tip === null || main === null) return none;
      const fork = (await this.lg(projectPath, ['merge-base', END_OF_OPTIONS, main, tip])).trim();
      if (fork === '') return none;
      const own = await this.count(projectPath, `${fork}..${tip}`);
      const ahead = await this.count(projectPath, `${main}..${tip}`);
      if (own === 0) {
        if (baseSha !== null && tip !== baseSha && (await this.localSha(projectPath, baseSha)) !== null) {
          const since = await this.count(projectPath, `${baseSha}..${tip}`);
          if (since > 0) return { landed: true, ownCommits: since, proven: true };
        }
        return { landed: false, ownCommits: 0, proven: true };
      }
      if (ahead === 0) return { landed: true, ownCommits: own, proven: true };
      const cherry = await this.lg(projectPath, ['cherry', END_OF_OPTIONS, main, tip]);
      if (cherry.trim() !== '' && !cherry.split('\n').some((l) => l.trim().startsWith('+'))) {
        return { landed: true, ownCommits: own, proven: true };
      }
      if (await this.localTry(projectPath, ['diff', '--quiet', END_OF_OPTIONS, main, tip])) {
        return { landed: true, ownCommits: own, proven: true };
      }
      return { landed: false, ownCommits: own, proven: true };
    } catch {
      return none;
    }
  }

  /** Delivery probe: fetches the current tip (no process is stopped, nothing is refused) and asks git. */
  async probeLanding(sessionId: string, projectPath: string, mainBranch: string): Promise<LandingProbe> {
    const row = this.deps.mergeBacks.get(sessionId);
    if (row === null || row.state === 'abandoned') return { landed: false, ownCommits: 0, proven: false };
    if (row.state === 'merged' || row.state === 'cleaned') return { landed: true, ownCommits: 0, proven: false };
    try {
      await this.locked(sessionId, () => this.checkpointLocked(sessionId, projectPath), PROBE_LOCK_WAIT_MS);
    } catch (err) {
      this.deps.logger.warn('[merge-back] delivery probe could not refresh the branch tip', { sessionId, error: errorName(err) });
    }
    for (const ref of [checkpointRef(row.mergeKey), importRef(row.mergeKey)]) {
      const probe = await this.refLanding(projectPath, ref, mainBranch, row.baseSha);
      if (probe.proven) return probe;
    }
    return { landed: false, ownCommits: 0, proven: false };
  }

  /** markComplete found the work on main: an import in flight is closed as merged (and resynced). */
  async recordLanded(sessionId: string, mainBranch?: string): Promise<void> {
    const merged = await this.locked(sessionId, async () => {
      const row = this.deps.mergeBacks.get(sessionId);
      if (row === null || !['import_intent', 'imported', 'local_ready'].includes(row.state)) return false;
      await this.markMergedLocked(sessionId, mainBranch ?? null);
      if (this.requireRow(sessionId).state !== 'merged') return false;
      // markComplete ran the close-out BEFORE asking: it is done for this merge.
      await this.deps.mergeBacks.markClosedOut(sessionId);
      return true;
    });
    if (merged) this.scheduleResync(sessionId, mainBranch ?? null);
  }

  async recordClosedOut(sessionId: string): Promise<void> {
    try {
      await this.deps.mergeBacks.markClosedOut(sessionId);
    } catch (err) {
      this.deps.logger.warn('[merge-back] could not record the close-out', { sessionId, error: errorName(err) });
    }
  }

  async mirrorBranch(sessionId: string, projectPath: string): Promise<string | null> {
    const row = this.deps.mergeBacks.get(sessionId);
    if (row === null) return null;
    try {
      return (await this.findMirror(projectPath, row.mergeKey))?.branch ?? row.branch;
    } catch {
      return row.branch;
    }
  }

  // -------------------------------------------------------------- checkpoints

  /** Coalesced per session: a request while one runs folds into one more pass. Never rejects. */
  requestCheckpoint(sessionId: string): Promise<void> {
    const cur = this.checkpoints.get(sessionId);
    if (cur) {
      cur.again = true;
      return cur.running;
    }
    const entry = { running: Promise.resolve(), again: false };
    entry.running = (async () => {
      try {
        do {
          entry.again = false;
          await this.checkpointOnce(sessionId);
        } while (entry.again);
      } finally {
        this.checkpoints.delete(sessionId);
      }
    })();
    this.checkpoints.set(sessionId, entry);
    return entry.running;
  }

  private async checkpointOnce(sessionId: string): Promise<void> {
    const row = this.deps.mergeBacks.get(sessionId);
    if (row === null || !CHECKPOINTABLE.includes(row.state)) return;
    const projectPath = this.deps.projectPathFor(row.projectId);
    if (projectPath === null) return;
    try {
      await this.locked(sessionId, () => this.checkpointLocked(sessionId, projectPath));
    } catch (err) {
      await this.recordFailure(sessionId, row.hostId, 'merge-back-checkpoint', err, `Could not save a checkpoint of the session's commits: ${readable(err)}`);
    }
  }

  /** Fetch the tip into the checkpoint ref; record it only from remote_ready / checkpointed (no regression). */
  private async checkpointLocked(sessionId: string, projectPath: string): Promise<void> {
    const row = this.deps.mergeBacks.get(sessionId);
    if (row === null || !IMPORTABLE.includes(row.state)) return;
    const r = this.resolve(row.hostId);
    const ref = checkpointRef(row.mergeKey);
    await this.fetchTip(r, row, projectPath, ref);
    const sha = await this.localSha(projectPath, ref);
    if (sha === null || !CHECKPOINTABLE.includes(row.state)) return;
    if (row.state === 'checkpointed' && row.checkpointSha === sha && row.lastError === null) return;
    await this.deps.mergeBacks.transition(sessionId, { from: [...CHECKPOINTABLE], to: 'checkpointed', patch: { checkpointSha: sha, lastError: null } });
    await this.step(sessionId, 'checkpointed');
  }

  // ------------------------------------------------------------------- resync

  /** After `merged`: the resync below, under the session lock. Resolves false (last_error set) on failure. */
  async resync(sessionId: string, mainBranch: string | null): Promise<boolean> {
    try {
      await this.locked(sessionId, () => this.resyncLocked(sessionId, mainBranch));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * `merged` → `remote_ready`: base ref := local main, the remote worktree reset to it, the local half removed.
   * No-op for any other state (or a project that is gone — archive removes the rest). Throws (recorded) on failure,
   * keeping `merged`.
   */
  private async resyncLocked(sessionId: string, mainBranch: string | null): Promise<void> {
    const row = this.deps.mergeBacks.get(sessionId);
    if (row === null || row.state !== 'merged') return;
    const projectPath = this.deps.projectPathFor(row.projectId);
    if (projectPath === null) return;
    const r = this.resolve(row.hostId);
    try {
      const main = mainBranch ?? (await this.localMainBranch(projectPath));
      const mainSha = main === null ? null : await this.localSha(projectPath, `refs/heads/${main}`);
      if (main === null || mainSha === null) throw new MergeBackError('resync', 'Could not read the main branch on This Mac.');
      try {
        await this.pushBase(row, r, projectPath, mainSha);
      } catch (err) {
        throw new MergeBackError('resync', `Could not send the merged ${main} to "${r.row.label}": ${readable(err)}`, { cause: err });
      }
      await this.step(sessionId, 'resync-base');
      const reset = await this.resetRemoteLocked(row, r, mainSha);
      if (reset === 'moved') {
        this.deps.logger.info('[merge-back] the session branch moved after the merge; the environment worktree was not reset', { sessionId });
      }
      await this.step(sessionId, 'resync-remote');
      await this.cleanupLocalFor(row, projectPath);
      await this.step(sessionId, 'cleanup-local');
      await this.deps.mergeBacks.transition(sessionId, {
        from: ['merged'],
        to: 'remote_ready',
        patch: { baseSha: mainSha, importSha: null, checkpointSha: null, localWorktreePath: null, lastError: null },
      });
      this.deps.logger.info('[merge-back] session resynced after the merge', { hostId: row.hostId, sessionId, reset });
    } catch (err) {
      const e = err instanceof MergeBackError
        ? err
        : new MergeBackError('resync', `Could not bring the session on its environment up to date after the merge: ${readable(err)}`, { cause: err });
      await this.recordFailure(sessionId, row.hostId, `merge-back-${e.code}`, err, e.message);
      throw e;
    }
  }

  /**
   * The remote branch moved from the imported tip (the work that just landed) to `mainSha`, and its worktree with it —
   * never by an unconditional reset: the agent may be running again by now.
   *   1. a dirty tree, a detached / other HEAD, or a branch no longer at the imported tip → nothing is touched;
   *   2. `update-ref refs/heads/<branch> <main> <imported>` is a compare-and-swap: an agent commit since step 1 makes
   *      it fail, and the branch (with that commit) is left alone ('moved');
   *   3. `read-tree -m -u <imported> <main>` carries the index + worktree across like `git checkout` does, refusing
   *      (and touching nothing) when a local change would be overwritten; then the branch is swapped back (CAS again)
   *      and the dirty error keeps `merged` for a later retry.
   */
  private async resetRemoteLocked(row: MergeBackRow, r: ResolvedHost, mainSha: string): Promise<'reset' | 'current' | 'moved'> {
    const label = r.row.label;
    const wt = this.hp(row.hostId, row.remoteWorktreePath ?? remoteSessionWorktreePath(r.remoteRoot, row.mergeKey));
    const opts = { timeoutMs: GIT_TIMEOUT_MS };
    const branchRef = `refs/heads/${row.branch}`;
    const dirty = (): MergeBackError => new MergeBackError(
      'dirty', `Uncommitted changes on ${label} after the merge — ask the agent to commit them, then merge again.`,
    );
    const status = await r.host.git.run(wt, ['status', '--porcelain'], opts);
    if (status.code !== 0) {
      throw new MergeBackError('resync', `Could not read the session worktree on "${label}": ${readable(status.stderr)}`);
    }
    if (status.stdout.trim() !== '') throw dirty();
    const tipOf = async (): Promise<string> => {
      const tip = await r.host.git.run(wt, ['rev-parse', '--verify', '-q', `${branchRef}^{commit}`], opts);
      return tip.code === 0 ? tip.stdout.trim() : '';
    };
    const sha = await tipOf();
    if (sha === mainSha) return 'current';
    const head = await r.host.git.run(wt, ['symbolic-ref', '-q', 'HEAD'], opts);
    const importSha = row.importSha;
    if (sha === '' || importSha === null || sha !== importSha || head.code !== 0 || head.stdout.trim() !== branchRef) return 'moved';
    const cas = await r.host.git.run(wt, ['update-ref', '-m', 'cyboflow: resync after merge', branchRef, mainSha, importSha], opts);
    if (cas.code !== 0) {
      if ((await tipOf()) !== importSha) return 'moved';
      throw new MergeBackError('resync', `Could not move the session branch on "${label}": ${readable(cas.stderr)}`);
    }
    // Fresh stat info, so an untouched file is not mistaken for a local change (exit 1 = "needs update": fine).
    await r.host.git.run(wt, ['update-index', '-q', '--refresh'], opts);
    const tree = await r.host.git.run(wt, ['read-tree', '-m', '-u', importSha, mainSha], { timeoutMs: WORKTREE_TIMEOUT_MS });
    if (tree.code !== 0) {
      const back = await r.host.git.run(wt, ['update-ref', '-m', 'cyboflow: resync undone', branchRef, importSha, mainSha], opts);
      if (back.code !== 0) {
        this.deps.logger.warn('[merge-back] could not put the session branch back after a refused resync', { sessionId: row.sessionId });
      }
      throw dirty();
    }
    return 'reset';
  }

  // ------------------------------------------------------------------ cleanup

  /**
   * After `abandoned` (archive): both halves, then `cleaned`. The LOCAL half runs whatever the remote half did (an
   * environment that is away or archived must not strand This Mac's mirror and refs); a remote failure keeps
   * `abandoned` + last_error, so boot resume retries it. Resolves false (last_error set) on any failure.
   */
  async cleanup(sessionId: string): Promise<boolean> {
    return this.locked(sessionId, async () => {
      const row = this.deps.mergeBacks.get(sessionId);
      if (row === null || row.state === 'cleaned') return true;
      if (row.state !== 'abandoned') {
        this.deps.logger.warn('[merge-back] cleanup refused before archive', { sessionId, state: row.state });
        return false;
      }
      let remoteError: unknown = null;
      try {
        await this.cleanupRemote(row);
        await this.step(sessionId, 'cleanup-remote');
      } catch (err) {
        remoteError = err;
      }
      try {
        const projectPath = this.deps.projectPathFor(row.projectId);
        if (projectPath !== null) await this.cleanupLocalFor(row, projectPath);
        await this.step(sessionId, 'cleanup-local');
      } catch (err) {
        await this.recordFailure(sessionId, row.hostId, 'merge-back-cleanup', err, `Could not clean up after the session: ${readable(err)}`);
        return false;
      }
      if (remoteError !== null) {
        await this.recordFailure(
          sessionId, row.hostId, 'merge-back-cleanup', remoteError,
          `Could not clean up after the session on its environment: ${readable(remoteError)}`,
        );
        return false;
      }
      try {
        await this.deps.mergeBacks.transition(sessionId, { from: ['abandoned'], to: 'cleaned', patch: { lastError: null } });
        this.deps.logger.info('[merge-back] session cleaned up', { hostId: row.hostId, sessionId });
        return true;
      } catch (err) {
        await this.recordFailure(sessionId, row.hostId, 'merge-back-cleanup', err, `Could not clean up after the session: ${readable(err)}`);
        return false;
      }
    });
  }

  /** Records `abandoned` (the archive intent) for a live row, under the session lock; true when the row is now abandoned. */
  private async abandon(sessionId: string): Promise<boolean> {
    return this.locked(sessionId, async () => {
      const row = this.deps.mergeBacks.get(sessionId);
      if (row === null || row.state === 'cleaned') return false;
      if (row.state !== 'abandoned') await this.deps.mergeBacks.transition(sessionId, { from: [row.state], to: 'abandoned' });
      return true;
    });
  }

  /** The local half only (archive: RemoteCheckout removed the remote half). Never throws. */
  async cleanupLocal(sessionId: string): Promise<boolean> {
    return this.locked(sessionId, async () => {
      const row = this.deps.mergeBacks.get(sessionId);
      if (row === null) return true;
      const projectPath = this.deps.projectPathFor(row.projectId);
      if (projectPath === null) return true;
      try {
        await this.cleanupLocalFor(row, projectPath);
        return true;
      } catch (err) {
        this.deps.logger.warn('[merge-back] local cleanup failed', { sessionId, error: errorName(err) });
        this.deps.captureError?.('host-merge-back', err, { hostKind: 'ssh', step: 'merge-back-cleanup-local', errorClass: errorName(err) });
        return false;
      }
    });
  }

  private async cleanupRemote(row: MergeBackRow): Promise<void> {
    const r = this.resolve(row.hostId);
    const bare = this.bareOf(r, row);
    const at = this.hp(row.hostId, bare);
    const opts = { timeoutMs: GIT_TIMEOUT_MS };
    const bareOk = await r.host.git.run(at, ['rev-parse', '--is-bare-repository'], opts);
    if (bareOk.code === 0 && bareOk.stdout.trim() === 'true') {
      const listing = await r.host.git.capture(at, ['worktree', 'list', '--porcelain'], opts);
      const suffix = `/wt/${row.mergeKey}`;
      for (const [p, head] of parseWorktreeList(listing.stdout)) {
        if (p.endsWith(suffix) && head === `refs/heads/${row.branch}`) {
          await r.host.git.capture(at, ['worktree', 'remove', '--force', p], { timeoutMs: WORKTREE_TIMEOUT_MS });
        }
      }
      await r.host.git.capture(at, ['worktree', 'prune'], opts);
      const hasBranch = await r.host.git.run(at, ['rev-parse', '--verify', '-q', `refs/heads/${row.branch}`], opts);
      if (hasBranch.code === 0) await r.host.git.capture(at, ['branch', '-D', row.branch], opts);
      // update-ref -d of a missing ref exits 0.
      await r.host.git.capture(at, ['update-ref', '-d', baseRef(row.mergeKey)], opts);
    }
    const wt = row.remoteWorktreePath ?? remoteSessionWorktreePath(r.remoteRoot, row.mergeKey);
    if (await r.host.fs.exists(this.hp(row.hostId, wt))) await r.host.fs.rmrf(this.hp(row.hostId, wt));
  }

  private async cleanupLocalFor(row: MergeBackRow, projectPath: string): Promise<void> {
    if (!fs.existsSync(projectPath)) return;
    const key = row.mergeKey;
    const listed = await this.findMirror(projectPath, key);
    if (listed !== null) await this.lg(projectPath, ['worktree', 'remove', '--force', listed.path], { timeout: WORKTREE_TIMEOUT_MS });
    await fs.promises.rm(mirrorWorktreePath(projectPath, key), { recursive: true, force: true });
    await this.lg(projectPath, ['worktree', 'prune']);
    const candidates = new Set([listed?.branch ?? null, row.branch, fallbackMirrorBranch(key)]);
    for (const b of candidates) {
      if (b === null || (await this.localSha(projectPath, `refs/heads/${b}`)) === null) continue;
      // Ours: recorded in config, or the branch that sat at our mirror path.
      if (b === listed?.branch || (await this.ownsBranch(projectPath, b, key))) {
        await this.lg(projectPath, ['branch', '-D', END_OF_OPTIONS, b]);
      }
    }
    await this.lg(projectPath, ['update-ref', '-d', importRef(key)]);
    await this.lg(projectPath, ['update-ref', '-d', checkpointRef(key)]);
  }

  // ------------------------------------------------------------------- resume

  /**
   * Boot. Per row, fail-soft, never throws:
   *   - an ARCHIVED session's live row (an archive with no checkout service, or a half-provisioned session the boot
   *     sweep hid) → `abandoned`; `abandoned` → cleanup (both halves);
   *   - `merged` → the close-out only if it never completed (closed_out_at unset) and never once the session has
   *     runs created after the merge (that process outlived the merge, so its close-out ran); then the resync;
   *   - an import left mid-way → closed out + merged + resynced ONLY when the import ref's work is on main (a squash
   *     that failed or crashed part-way never counts: the mirror's HEAD is not evidence); else left for the user.
   */
  async resumeAll(deps: ResumeDeps): Promise<ResumeSummary> {
    const summary: ResumeSummary = { resynced: 0, cleaned: 0, closedOut: 0, left: 0, errored: 0 };
    const tally = (ok: boolean, done: 'resynced' | 'cleaned'): void => {
      if (ok) summary[done]++;
      else summary.errored++;
    };
    let rows: MergeBackRow[];
    try {
      rows = this.deps.mergeBacks.listByState(RESUMABLE);
    } catch (err) {
      this.deps.logger.warn('[merge-back] resume could not list sessions', { error: errorName(err) });
      return summary;
    }
    for (const row of rows) {
      try {
        if (row.state === 'abandoned' || (deps.isArchived?.(row.sessionId) === true && (await this.abandon(row.sessionId)))) {
          tally(await this.cleanup(row.sessionId), 'cleaned');
          continue;
        }
        if (!RESUME_ON_BOOT.includes(row.state)) continue;
        const projectPath = this.deps.projectPathFor(row.projectId);
        if (row.state === 'merged') {
          if (projectPath === null) {
            summary.left++;
            continue;
          }
          if (row.closedOutAt === null) {
            const later = row.mergedAt !== null ? (deps.runsCreatedSince?.(row.sessionId, row.mergedAt) ?? 0) : 0;
            if (later === 0) {
              await deps.closeOut(row.sessionId, row.mergedSha ?? (await this.localMainSha(projectPath)) ?? undefined);
              summary.closedOut++;
            } else {
              this.deps.logger.info('[merge-back] the session worked on after its merge; its close-out is not repeated', { sessionId: row.sessionId });
            }
            await this.deps.mergeBacks.markClosedOut(row.sessionId);
          }
          tally(await this.resync(row.sessionId, null), 'resynced');
          continue;
        }
        if (projectPath === null || !(await this.landedForResume(row, projectPath))) {
          summary.left++;
          continue;
        }
        await deps.closeOut(row.sessionId, (await this.localMainSha(projectPath)) ?? undefined);
        summary.closedOut++;
        await this.locked(row.sessionId, async () => {
          await this.markMergedLocked(row.sessionId, null);
          if (this.requireRow(row.sessionId).state === 'merged') await this.deps.mergeBacks.markClosedOut(row.sessionId);
        });
        tally(await this.resync(row.sessionId, null), 'resynced');
      } catch (err) {
        summary.errored++;
        this.deps.logger.warn('[merge-back] resume failed for a session', { sessionId: row.sessionId, error: errorName(err) });
      }
    }
    return summary;
  }

  private async localMainBranch(projectPath: string): Promise<string | null> {
    try {
      const b = (await this.lg(projectPath, ['branch', '--show-current'])).trim();
      return b === '' ? null : b;
    } catch {
      return null;
    }
  }

  private async localMainSha(projectPath: string): Promise<string | null> {
    const main = await this.localMainBranch(projectPath);
    return main === null ? null : this.localSha(projectPath, `refs/heads/${main}`);
  }

  /**
   * The IMPORT ref's work is already on main. Never the mirror's HEAD: a squash that failed part-way (a rejecting
   * commit hook, a crash mid-rebase) leaves it reset onto main, which proves nothing landed.
   */
  private async landedForResume(row: MergeBackRow, projectPath: string): Promise<boolean> {
    const main = await this.localMainBranch(projectPath);
    if (main === null) return false;
    return (await this.refLanding(projectPath, importRef(row.mergeKey), main, row.baseSha)).landed;
  }
}
