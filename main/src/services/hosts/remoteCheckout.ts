/**
 * RemoteCheckout — a remote session's git worktree on an SSH environment (spec M2 §4 C2).
 *
 * Layout on the environment (all absolute, under the probed `<remoteRoot>`):
 *   <remoteRoot>/repos/<projectId>.git   one bare repo per (host, project); host_project_checkouts records it
 *   <remoteRoot>/wt/<key>                 the session worktree, on branch <branch>, cut at refs/cyboflow/base/<key>
 * where `key` is the session's unique worktree_name.
 *
 * ensureSessionWorktree() walks session_merge_backs through bare_ready → base_pushed → remote_ready:
 *   1. bare repo: `git init --bare`, `uploadpack.allowReachableSHA1InWant true` (exact-SHA fetches at merge-back),
 *      the cyboflow git excludes in `<bare>/info/exclude` (shared by every worktree of the bare repo); checkout row
 *      upserted with the ABSOLUTE path;
 *   2. the base SHA, resolved LOCALLY with worktreeManager's rules (baseCommittish > baseBranch > HEAD) and stored on
 *      the row at creation, so a retry pushes the same base;
 *   3. local `git push --receive-pack='<gitPath>' receive-pack ssh://<target><bare> +<sha>:refs/cyboflow/base/<key>`
 *      over GIT_SSH_COMMAND (gitSshEnv.ts); the `+` force-updates that one ref only;
 *   4. remote `git -C <bare> worktree add -B <branch> <wt> refs/cyboflow/base/<key>`.
 * Every step checks its postcondition first (bare repo valid, ref at the SHA, worktree listed on the branch), so a
 * re-entry after a crash completes the work instead of duplicating it. A failure keeps the last good state and
 * records last_error (redacted); it never falls back to a local worktree.
 *
 * removeSessionWorktree() is the compensation (and dismiss) path: the row goes to `abandoned` first, then remote
 * `worktree remove --force`, `branch -D`, `update-ref -d` of the base ref ("already gone" = success), then `cleaned`.
 *
 * Secrets: nothing secret on any argv; remote stderr reaching an error message or the row passes redactSecrets().
 */
import { redactSecrets } from '../../../../shared/types/hosts';
import { HostNotFoundError, HostsDisabledError, RemoteHostsDisabledError } from '../../orchestrator/hosts/errors';
import type { HostCheckoutRow, HostRow, UpsertCheckoutInput } from '../../orchestrator/hosts/hostStore';
import type { MergeBackRow, MergeBackStore } from '../../orchestrator/hosts/mergeBackStore';
import type { MergeBackState } from '../../orchestrator/hosts/mergeBackState';
import type { ExecutionHost, HostPath } from '../../orchestrator/trpc/contracts/executionHost';
import type { LoggerLike } from '../../orchestrator/types';
import { withLock } from '../../utils/mutex';
import { runGitCapture, type CommandOutput } from '../../utils/runGit';
import { resolveWorktreeBase, type ResolvedWorktreeBase } from '../worktreeManager';
import { buildGitSshEnv, remoteGitPackCommand, remoteGitUrl, type GitSshTransportLike } from './gitSshEnv';
import { remoteFactsFromPreflight } from './hostRegistry';
import type { CaptureErrorFn } from './preflight/preflightEngine';

/** The excludes cyboflow writes into a local worktree's git exclude (bundle, `.cyboflow/`, OMP), pre-seeded here. */
export const REMOTE_GIT_EXCLUDE_MARKER = '# cyboflow: generated files (not user code)';
export const REMOTE_GIT_EXCLUDE_ENTRIES: readonly string[] = [
  '.cyboflow/',
  '.omp/',
  '.claude/agents/cyboflow-*.md',
  '.claude/commands/cyboflow-*.md',
];

const BASE_REF_PREFIX = 'refs/cyboflow/base/';
const KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const PUSH_TIMEOUT_MS = 30 * 60_000;
const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const BARE_LOCK_WAIT_MS = 5 * 60_000;
const SESSION_LOCK_WAIT_MS = 60 * 60_000;
const SETUP_STATES: readonly MergeBackState[] = ['bare_ready', 'base_pushed', 'remote_ready'];

export type RemoteCheckoutErrorCode =
  | 'not-remote'
  | 'needs-check'
  | 'invalid-name'
  | 'conflict'
  | 'base'
  | 'bare'
  | 'push'
  | 'worktree'
  | 'cleanup';

/** `message` is user-presentable: redacted, no ssh target. */
export class RemoteCheckoutError extends Error {
  readonly code: RemoteCheckoutErrorCode;
  constructor(code: RemoteCheckoutErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteCheckoutError';
    this.code = code;
  }
}

export interface EnsureSessionWorktreeInput {
  /** The session row (must exist: session_merge_backs.session_id references it). */
  sessionId: string;
  hostId: string;
  projectId: number;
  /** The LOCAL project checkout the base is resolved in and pushed from. */
  projectPath: string;
  /** The session's unique worktree_name: the remote worktree dir and the base ref's name. */
  sessionKey: string;
  /** The session branch on the environment (taskQueue: = sessionKey). */
  branch: string;
  baseBranch?: string;
  baseCommittish?: string;
  /** Already resolved by the caller (resolveBase); skips the local resolve. */
  baseSha?: string;
}

export interface EnsureSessionWorktreeResult {
  /** Absolute, on the environment. */
  remoteWorktreePath: string;
  baseSha: string;
  /** The session-row label: the base branch or 'HEAD'. */
  baseBranch: string;
}

/** How local git addresses the bare repo. Default: ssh:// URL + GIT_SSH_COMMAND; tests use a local path. */
export type GitRemoteResolver = (host: { sshTarget: string }, bareRepoPath: string) => { url: string; env: Record<string, string> };

export type LocalGitRunner = (
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; timeout?: number },
) => Promise<CommandOutput>;

export interface RemoteCheckoutDeps {
  /** HostsService.status(): the Environments gates. */
  status(): { running: boolean; killed: boolean };
  /** HostStore (sole writer of host_project_checkouts). */
  store: {
    get(id: string): HostRow | null;
    getCheckout(hostId: string, projectId: number): HostCheckoutRow | null;
    upsertCheckout(input: UpsertCheckoutInput): Promise<HostCheckoutRow>;
  };
  /** HostRegistry.get — @throws HostNotFoundError. */
  getHost(hostId: string): ExecutionHost;
  transport: GitSshTransportLike;
  mergeBacks: Pick<MergeBackStore, 'get' | 'create' | 'transition' | 'setError'>;
  logger: LoggerLike;
  captureError?: CaptureErrorFn;
  /** Local git (base resolve is separate). Default utils/runGit runGitCapture. */
  localGit?: LocalGitRunner;
  /** Default worktreeManager.resolveWorktreeBase. */
  resolveBase?: (projectPath: string, opts: { baseBranch?: string; baseCommittish?: string }) => Promise<ResolvedWorktreeBase>;
  gitRemote?: GitRemoteResolver;
}

/** The slice taskQueue / createQuickSessionCore use (RemoteCheckout satisfies it). */
export interface RemoteCheckoutLike {
  /** `<remoteRoot>/wt/<name>` exists on the environment (the name-uniqueness probe). */
  worktreeExists(hostId: string, name: string): Promise<boolean>;
  /** The LOCAL base for a new remote session (worktreeManager's rules). */
  resolveBase(projectPath: string, opts: { baseBranch?: string; baseCommittish?: string }): Promise<ResolvedWorktreeBase>;
  /** The absolute remote worktree path a session with this key gets. */
  plannedWorktreePath(hostId: string, sessionKey: string): string;
  ensureSessionWorktree(input: EnsureSessionWorktreeInput): Promise<EnsureSessionWorktreeResult>;
  /** Compensation / dismiss. Never throws for "already gone"; resolves false when cleanup could not finish. */
  removeSessionWorktree(sessionId: string): Promise<boolean>;
}

interface ResolvedHost {
  row: HostRow & { sshTarget: string };
  host: ExecutionHost;
  remoteRoot: string;
  gitPath: string | null;
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

function defaultGitRemote(transport: GitSshTransportLike): GitRemoteResolver {
  return (host, bare) => ({ url: remoteGitUrl(host.sshTarget, bare), env: buildGitSshEnv(transport, host.sshTarget) });
}

export function remoteBareRepoPath(remoteRoot: string, projectId: number): string {
  return `${remoteRoot.replace(/\/+$/, '')}/repos/${projectId}.git`;
}

export function remoteSessionWorktreePath(remoteRoot: string, key: string): string {
  return `${remoteRoot.replace(/\/+$/, '')}/wt/${key}`;
}

/** Paths listed by `git worktree list --porcelain`, with each one's branch ref (null = detached / bare). */
export function parseWorktreeList(stdout: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
      out.set(current, null);
    } else if (current !== null && line.startsWith('branch ')) {
      out.set(current, line.slice('branch '.length));
    } else if (line === '') {
      current = null;
    }
  }
  return out;
}

function assertKey(key: string): string {
  if (!KEY_RE.test(key) || key === '.' || key === '..') {
    throw new RemoteCheckoutError('invalid-name', 'That session name cannot name a worktree on the environment.');
  }
  return key;
}

function assertBranch(branch: string): string {
  if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')
    || branch.includes('..') || branch.includes('//') || branch.endsWith('.lock') || branch.endsWith('.')) {
    throw new RemoteCheckoutError('invalid-name', 'That branch name cannot be used on the environment.');
  }
  return branch;
}

export class RemoteCheckout implements RemoteCheckoutLike {
  private readonly localGit: LocalGitRunner;
  private readonly gitRemote: GitRemoteResolver;
  /**
   * (host, worktree key) and (host, branch) → the session provisioning them right now. The session lock keys on the
   * session id, so without this two sessions given the same name would walk one remote path at once and the later
   * would adopt the earlier's worktree (then removing either deletes both). Same-session re-entry still adopts.
   */
  private readonly provisioning = new Map<string, string>();

  constructor(private readonly deps: RemoteCheckoutDeps) {
    this.localGit = deps.localGit ?? ((cwd, args, opts) => runGitCapture(cwd, args, opts));
    this.gitRemote = deps.gitRemote ?? defaultGitRemote(deps.transport);
  }

  // ------------------------------------------------------------------ host

  /** Gates + a live SSH host with a complete check. Throws RemoteCheckoutError / HostNotFoundError. */
  private resolve(hostId: string): ResolvedHost {
    const status = this.deps.status();
    if (!status.running) throw new HostsDisabledError();
    if (status.killed) throw new RemoteHostsDisabledError();
    const row = this.deps.store.get(hostId);
    if (!row || row.archivedAt !== null) throw new HostNotFoundError();
    if (row.kind !== 'ssh' || row.sshTarget === null) {
      throw new RemoteCheckoutError('not-remote', 'This environment is not a remote machine.');
    }
    const facts = remoteFactsFromPreflight(row.preflight);
    if (facts === null) {
      throw new RemoteCheckoutError('needs-check', `The environment "${row.label}" has no completed check yet. Run a check first.`);
    }
    return {
      row: { ...row, sshTarget: row.sshTarget },
      host: this.deps.getHost(hostId),
      remoteRoot: facts.remoteRoot,
      gitPath: row.preflight?.remote?.gitPath ?? null,
    };
  }

  private hp(hostId: string, path: string): HostPath {
    return { hostId, path };
  }

  // ----------------------------------------------------------------- reads

  async worktreeExists(hostId: string, name: string): Promise<boolean> {
    const r = this.resolve(hostId);
    return r.host.fs.exists(this.hp(hostId, remoteSessionWorktreePath(r.remoteRoot, assertKey(name))));
  }

  resolveBase(projectPath: string, opts: { baseBranch?: string; baseCommittish?: string }): Promise<ResolvedWorktreeBase> {
    return (this.deps.resolveBase ?? resolveWorktreeBase)(projectPath, opts);
  }

  plannedWorktreePath(hostId: string, sessionKey: string): string {
    return remoteSessionWorktreePath(this.resolve(hostId).remoteRoot, assertKey(sessionKey));
  }

  // ----------------------------------------------------------------- create

  async ensureSessionWorktree(input: EnsureSessionWorktreeInput): Promise<EnsureSessionWorktreeResult> {
    const key = assertKey(input.sessionKey);
    const branch = assertBranch(input.branch);
    // Synchronous check + claim (no await in between); refused before any merge-back row exists, so the caller's
    // compensating removeSessionWorktree has nothing of the other session's to remove.
    const claims = [`wt\0${input.hostId}\0${key}`, `br\0${input.hostId}\0${branch}`];
    if (claims.some((c) => (this.provisioning.get(c) ?? input.sessionId) !== input.sessionId)) {
      throw new RemoteCheckoutError('conflict', 'Another session is setting up a worktree with this name on the environment; try again.');
    }
    const mine = claims.filter((c) => !this.provisioning.has(c));
    for (const c of mine) this.provisioning.set(c, input.sessionId);
    try {
      return await withLock(`remote-checkout-session-${input.sessionId}`, () => this.ensureLocked(input, key, branch), SESSION_LOCK_WAIT_MS);
    } finally {
      for (const c of mine) this.provisioning.delete(c);
    }
  }

  private async ensureLocked(input: EnsureSessionWorktreeInput, key: string, branch: string): Promise<EnsureSessionWorktreeResult> {
    const { sessionId, hostId, projectId } = input;
    const r = this.resolve(hostId);
    const label = r.row.label;
    let row: MergeBackRow | null = this.deps.mergeBacks.get(sessionId);
    if (row !== null) {
      if (row.hostId !== hostId || row.projectId !== projectId || row.mergeKey !== key || row.branch !== branch) {
        throw new RemoteCheckoutError('conflict', 'This session is already set up for a different environment worktree.');
      }
      if (!SETUP_STATES.includes(row.state)) {
        throw new RemoteCheckoutError('conflict', `This session's environment worktree is ${row.state.replace(/_/g, ' ')}; it cannot be set up again.`);
      }
    }
    try {
      const bare = await this.ensureBare(r, projectId);

      // Base: a re-entry keeps the SHA it recorded; a first entry resolves it locally (before any row exists).
      let baseSha = row?.baseSha ?? null;
      let baseBranch = input.baseBranch || 'HEAD';
      if (baseSha === null) {
        if (input.baseSha !== undefined) {
          baseSha = input.baseSha;
        } else {
          try {
            const base = await this.resolveBase(input.projectPath, { baseBranch: input.baseBranch, baseCommittish: input.baseCommittish });
            baseSha = base.baseCommit;
            baseBranch = base.baseBranch;
          } catch (err) {
            throw new RemoteCheckoutError('base', `Could not resolve the session's base commit: ${readable(err)}`, { cause: err });
          }
        }
      }
      if (!SHA_RE.test(baseSha)) throw new RemoteCheckoutError('base', 'The session base is not a full commit id.');

      if (row === null) {
        row = await this.deps.mergeBacks.create({ sessionId, hostId, projectId, mergeKey: key, branch, baseSha, state: 'bare_ready' });
      }

      const baseRef = `${BASE_REF_PREFIX}${key}`;
      if (!(await this.remoteRefIs(r, bare, baseRef, baseSha))) await this.pushBase(r, input.projectPath, bare, baseSha, baseRef);
      if (row.state === 'bare_ready') {
        row = await this.deps.mergeBacks.transition(sessionId, { from: ['bare_ready'], to: 'base_pushed', patch: { baseSha, lastError: null } });
      }

      const wt = remoteSessionWorktreePath(r.remoteRoot, key);
      await this.ensureWorktree(r, bare, wt, key, branch, baseRef);
      if (row.state === 'base_pushed') {
        row = await this.deps.mergeBacks.transition(sessionId, { from: ['base_pushed'], to: 'remote_ready', patch: { remoteWorktreePath: wt, lastError: null } });
      } else if (row.lastError !== null) {
        await this.deps.mergeBacks.setError(sessionId, null);
      }
      this.deps.logger.info('[hosts] remote session worktree ready', { hostId, sessionId });
      return { remoteWorktreePath: wt, baseSha, baseBranch };
    } catch (err) {
      const e = err instanceof RemoteCheckoutError
        ? err
        : new RemoteCheckoutError('worktree', `Could not prepare the session's worktree on "${label}": ${readable(err)}`, { cause: err });
      this.deps.logger.warn('[hosts] remote session worktree failed', { hostId, sessionId, step: e.code, error: errorName(err) });
      this.deps.captureError?.('host-merge-back', err, { hostKind: 'ssh', step: `checkout-${e.code}`, errorClass: errorName(err) });
      if (this.deps.mergeBacks.get(sessionId) !== null) {
        await this.deps.mergeBacks.setError(sessionId, e.message).catch(() => undefined);
      }
      throw e;
    }
  }

  /** `<remoteRoot>/repos/<projectId>.git`, created and configured once per (host, project). */
  private async ensureBare(r: ResolvedHost, projectId: number): Promise<string> {
    const hostId = r.row.id;
    return withLock(`remote-checkout-bare-${hostId}-${projectId}`, async () => {
      const existing = this.deps.store.getCheckout(hostId, projectId);
      const bare = existing?.remoteRepoPath ?? remoteBareRepoPath(r.remoteRoot, projectId);
      const probe = await r.host.git.run(this.hp(hostId, bare), ['rev-parse', '--is-bare-repository'], { timeoutMs: GIT_TIMEOUT_MS });
      const valid = probe.code === 0 && probe.stdout.trim() === 'true';
      if (valid && existing !== null && existing.initializedAt !== null) return bare;
      try {
        if (!valid) {
          await r.host.fs.mkdirp(this.hp(hostId, bare));
          await r.host.git.capture(this.hp(hostId, bare), ['init', '--bare', '-q'], { timeoutMs: GIT_TIMEOUT_MS });
        }
        await r.host.git.capture(this.hp(hostId, bare), ['config', 'uploadpack.allowReachableSHA1InWant', 'true'], { timeoutMs: GIT_TIMEOUT_MS });
        await this.writeExcludes(r, bare);
      } catch (err) {
        throw new RemoteCheckoutError('bare', `Could not create the project repository on "${r.row.label}": ${readable(err)}`, { cause: err });
      }
      await this.deps.store.upsertCheckout({ hostId, projectId, remoteRepoPath: bare });
      return bare;
    }, BARE_LOCK_WAIT_MS);
  }

  /** Append the cyboflow excludes (marker once) to `<bare>/info/exclude`, keeping whatever is there. */
  private async writeExcludes(r: ResolvedHost, bare: string): Promise<void> {
    const hostId = r.row.id;
    const file = this.hp(hostId, `${bare}/info/exclude`);
    await r.host.fs.mkdirp(this.hp(hostId, `${bare}/info`));
    const existing = (await r.host.fs.exists(file)) ? await r.host.fs.readFile(file) : '';
    const lines = existing.split(/\r?\n/);
    const have = new Set(lines.map((l) => l.trim()));
    const missing = REMOTE_GIT_EXCLUDE_ENTRIES.filter((e) => !have.has(e));
    if (missing.length === 0) return;
    const parts: string[] = [];
    if (existing.length > 0 && !existing.endsWith('\n')) parts.push('');
    if (!have.has(REMOTE_GIT_EXCLUDE_MARKER)) parts.push(REMOTE_GIT_EXCLUDE_MARKER);
    parts.push(...missing, '');
    await r.host.fs.writeFile(file, existing + parts.join('\n'), 0o644);
  }

  /** The remote ref resolves to exactly `sha`. */
  private async remoteRefIs(r: ResolvedHost, bare: string, ref: string, sha: string): Promise<boolean> {
    const res = await r.host.git.run(this.hp(r.row.id, bare), ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { timeoutMs: GIT_TIMEOUT_MS });
    return res.code === 0 && res.stdout.trim() === sha;
  }

  private async pushBase(r: ResolvedHost, projectPath: string, bare: string, sha: string, baseRef: string): Promise<void> {
    const { url, env } = this.gitRemote({ sshTarget: r.row.sshTarget }, bare);
    try {
      await this.localGit(projectPath, [
        'push', '--quiet', '--no-verify', `--receive-pack=${remoteGitPackCommand(r.gitPath, 'receive-pack')}`,
        url, `+${sha}:${baseRef}`,
      ], { env, timeout: PUSH_TIMEOUT_MS });
    } catch (err) {
      throw new RemoteCheckoutError('push', `Could not send the project to "${r.row.label}": ${readable(err)}`, { cause: err });
    }
  }

  /** The worktree at `wt` on `branch`, cut at `baseRef` — unless it is already there. */
  private async ensureWorktree(r: ResolvedHost, bare: string, wt: string, key: string, branch: string, baseRef: string): Promise<void> {
    const hostId = r.row.id;
    const at = this.hp(hostId, bare);
    try {
      if ((await this.findSessionWorktree(r, bare, key, branch)) !== null) return;
      // A directory git does not list (a crash mid-add) is ours: the key is unique to this session.
      await r.host.git.capture(at, ['worktree', 'prune'], { timeoutMs: GIT_TIMEOUT_MS });
      if (await r.host.fs.exists(this.hp(hostId, wt))) await r.host.fs.rmrf(this.hp(hostId, wt));
      await r.host.fs.mkdirp(this.hp(hostId, wt.slice(0, wt.lastIndexOf('/'))));
      // -B: a branch left by an interrupted add (only this session owns the name) is reset to the base.
      await r.host.git.capture(at, ['worktree', 'add', '-q', '-B', branch, wt, baseRef], { timeoutMs: WORKTREE_ADD_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof RemoteCheckoutError) throw err;
      throw new RemoteCheckoutError('worktree', `Could not create the session worktree on "${r.row.label}": ${readable(err)}`, { cause: err });
    }
  }

  /**
   * The listed (PHYSICAL — git stores realpaths) path of this session's worktree, or null when git lists none.
   * Identified by the session branch (unique to the session) and the `/wt/<key>` suffix; a listing that has one
   * without the other is someone else's worktree and refused.
   */
  private async findSessionWorktree(r: ResolvedHost, bare: string, key: string, branch: string): Promise<string | null> {
    const out = await r.host.git.capture(this.hp(r.row.id, bare), ['worktree', 'list', '--porcelain'], { timeoutMs: GIT_TIMEOUT_MS });
    const suffix = `/wt/${key}`;
    const ref = `refs/heads/${branch}`;
    for (const [path, head] of parseWorktreeList(out.stdout)) {
      const atPath = path.endsWith(suffix);
      const onBranch = head === ref;
      if (atPath && onBranch) return path;
      if (atPath || onBranch) {
        throw new RemoteCheckoutError('worktree', `The environment "${r.row.label}" already has a different worktree for this session's name.`);
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- remove

  async removeSessionWorktree(sessionId: string): Promise<boolean> {
    return withLock(`remote-checkout-session-${sessionId}`, () => this.removeLocked(sessionId), SESSION_LOCK_WAIT_MS);
  }

  private async removeLocked(sessionId: string): Promise<boolean> {
    const { mergeBacks, logger } = this.deps;
    let row = mergeBacks.get(sessionId);
    if (row === null || row.state === 'cleaned') return true;
    if (row.state !== 'abandoned') {
      row = await mergeBacks.transition(sessionId, {
        from: [row.state],
        to: 'abandoned',
      });
    }
    const hostId = row.hostId;
    try {
      const r = this.resolve(hostId);
      const checkout = this.deps.store.getCheckout(hostId, row.projectId);
      const bare = checkout?.remoteRepoPath ?? remoteBareRepoPath(r.remoteRoot, row.projectId);
      const at = this.hp(hostId, bare);
      const bareOk = await r.host.git.run(at, ['rev-parse', '--is-bare-repository'], { timeoutMs: GIT_TIMEOUT_MS });
      const wt = row.remoteWorktreePath ?? remoteSessionWorktreePath(r.remoteRoot, row.mergeKey);
      if (bareOk.code === 0 && bareOk.stdout.trim() === 'true') {
        const listed = await this.findSessionWorktree(r, bare, row.mergeKey, row.branch);
        if (listed !== null) await r.host.git.capture(at, ['worktree', 'remove', '--force', listed], { timeoutMs: WORKTREE_ADD_TIMEOUT_MS });
        await r.host.git.capture(at, ['worktree', 'prune'], { timeoutMs: GIT_TIMEOUT_MS });
        const hasBranch = await r.host.git.run(at, ['rev-parse', '--verify', '-q', `refs/heads/${row.branch}`], { timeoutMs: GIT_TIMEOUT_MS });
        if (hasBranch.code === 0) await r.host.git.capture(at, ['branch', '-D', row.branch], { timeoutMs: GIT_TIMEOUT_MS });
        // update-ref -d of a missing ref exits 0.
        await r.host.git.capture(at, ['update-ref', '-d', `${BASE_REF_PREFIX}${row.mergeKey}`], { timeoutMs: GIT_TIMEOUT_MS });
      }
      // A directory left without a repo (or by a crash mid-add) goes too; rmrf stays inside the remote root.
      if (await r.host.fs.exists(this.hp(hostId, wt))) await r.host.fs.rmrf(this.hp(hostId, wt));
      await mergeBacks.transition(sessionId, { from: ['abandoned'], to: 'cleaned', patch: { lastError: null } });
      logger.info('[hosts] remote session worktree removed', { hostId, sessionId });
      return true;
    } catch (err) {
      const message = `Could not remove the session worktree on the environment: ${readable(err)}`;
      logger.warn('[hosts] remote session worktree cleanup failed', { hostId, sessionId, error: errorName(err) });
      this.deps.captureError?.('host-merge-back', err, { hostKind: 'ssh', step: 'checkout-cleanup', errorClass: errorName(err) });
      await mergeBacks.setError(sessionId, message).catch(() => undefined);
      return false;
    }
  }
}
