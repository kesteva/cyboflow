/**
 * runHostAccess — the services-side implementation of the orchestrator's RunHostAccess contract
 * (orchestrator/trpc/contracts/runHostAccess.ts, spec M2 §5 Phase D item 3): a remote run's worktree reached through
 * the ExecutionHost of its environment (HostRegistry.get, via executionHostBridge) for the programmatic runner's lane
 * build slots, environment actions and the commit-integrity probe.
 *
 * Gates, read on EVERY call (a run outlives a settings change): Environments running (HostsDisabledError), remote
 * hosts not kill-switched (RemoteHostsDisabledError), the registry wired (RemoteHostAccessUnavailableError). A gate
 * that fails REJECTS the call — nothing here ever runs on This Mac.
 *
 * No secrets travel: commands are fixed argv, git output is redacted by HostGitCommandError and here, and command
 * output that reaches chat / findings is redacted.
 */
import { isRemoteHostId, redactSecrets } from '../../../../shared/types/hosts';
import { HostsDisabledError, RemoteHostsDisabledError } from '../../orchestrator/hosts/errors';
import { peekHostsFacade, type HostsFacade } from '../../orchestrator/hostsBridge';
import type { ExecResult, ExecutionHost, HostPath } from '../../orchestrator/trpc/contracts/executionHost';
import type {
  RunHostAccess,
  RunHostCommandError,
  RunHostCommandOutput,
  RunHostGitExit,
  RunWorktreeHost,
} from '../../orchestrator/trpc/contracts/runHostAccess';
import { getExecutionHostResolver, type ExecutionHostResolver } from './executionHostBridge';
import { composeRemotePath, DEFAULT_REMOTE_BASE_PATH } from './remoteLaunch';

/** Environments are composed but the host registry is not wired (or was stopped). */
export class RemoteHostAccessUnavailableError extends Error {
  constructor() {
    super('Remote environments are not available right now, so the run worktree on its environment cannot be reached.');
    this.name = 'RemoteHostAccessUnavailableError';
  }
}

export interface RunHostAccessDeps {
  /** Default: the executionHostBridge resolver (HostRegistry.get). */
  getResolver?: () => ExecutionHostResolver | null;
  /** Default: the published HostsFacade. The status gate and the probed tool paths. */
  getHosts?: () => Pick<HostsFacade, 'status' | 'get'> | null;
}

const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_CHARS = 2000;
const BASE_PATH_DIRS: ReadonlySet<string> = new Set(DEFAULT_REMOTE_BASE_PATH.split(':'));

/** Directory of an absolute remote tool path, or null (relative, missing, or already on the base PATH). */
function remoteDirOf(p: string | null | undefined): string | null {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const i = p.lastIndexOf('/');
  const dir = i <= 0 ? '/' : p.slice(0, i);
  return BASE_PATH_DIRS.has(dir) ? null : dir;
}

function stderrTail(stderr: string): string {
  const tail = stderr.trimEnd().split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join('\n');
  return tail.length > OUTPUT_TAIL_CHARS ? tail.slice(-OUTPUT_TAIL_CHARS) : tail;
}

/** The execFile-shaped rejection of a non-zero / timed-out {@link RunWorktreeHost.execIn}. */
function commandError(bin: string, args: readonly string[], result: ExecResult): RunHostCommandError {
  const stdout = redactSecrets(result.stdout);
  const stderr = redactSecrets(result.stderr);
  const tail = stderrTail(stderr);
  const err = new Error(
    `Command failed: ${bin} ${args.join(' ')}${result.timedOut ? ' (timed out)' : ''}${tail ? `\n${tail}` : ''}`,
  ) as RunHostCommandError;
  err.name = 'RunHostCommandError';
  err.code = result.code;
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

export function createRunHostAccess(deps: RunHostAccessDeps = {}): RunHostAccess {
  const getResolver = deps.getResolver ?? getExecutionHostResolver;
  const getHosts = deps.getHosts ?? peekHostsFacade;

  return {
    forHost(hostIdIn: string): RunWorktreeHost {
      if (!isRemoteHostId(hostIdIn) || hostIdIn.length === 0) {
        throw new Error('RunHostAccess.forHost needs a remote host id; local runs use their local path.');
      }
      const hostId = hostIdIn;
      const gatedHosts = (): Pick<HostsFacade, 'status' | 'get'> => {
        const hosts = getHosts();
        if (hosts === null) throw new RemoteHostAccessUnavailableError();
        const status = hosts.status();
        if (!status.running) throw new HostsDisabledError();
        if (status.killed) throw new RemoteHostsDisabledError();
        return hosts;
      };
      const machine = (): ExecutionHost => {
        gatedHosts();
        const resolve = getResolver();
        if (resolve === null) throw new RemoteHostAccessUnavailableError();
        return resolve(hostId);
      };
      const at = (path: string): HostPath => ({ hostId, path });
      /** The environment's tool PATH from its last complete check (node / git dirs, then the system dirs). */
      const toolPath = (): string => {
        const remote = gatedHosts().get(hostId).preflight?.remote;
        const nodeDir = remoteDirOf(remote?.nodePath);
        const gitDir = remoteDirOf(remote?.gitPath);
        return composeRemotePath({ nodeDir, gitDir: gitDir === nodeDir ? null : gitDir });
      };

      return {
        hostId,
        exists: async (path) => machine().fs.exists(at(path)),
        stat: async (path) => machine().fs.stat(at(path)),
        readdir: async (path) => machine().fs.readdir(at(path)),
        readFile: async (path, maxBytes) => machine().fs.readFile(at(path), maxBytes),
        mkdirp: async (path) => machine().fs.mkdirp(at(path)),
        gitExit: async (cwd, args, opts = {}): Promise<RunHostGitExit> => {
          const r = await machine().git.run(at(cwd), args, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
          if (r.timedOut || r.code === null) {
            throw new Error(`git ${args[0] ?? ''} did not finish on the environment${r.timedOut ? ' (timed out)' : ''}`);
          }
          return { exitCode: r.code, stdout: r.stdout, stderr: redactSecrets(r.stderr) };
        },
        gitCapture: async (cwd, args, opts = {}): Promise<string> => {
          const out = await machine().git.capture(at(cwd), args, opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
          return out.stdout;
        },
        execIn: async (cwd, bin, args, opts): Promise<RunHostCommandOutput> => {
          const host = machine();
          const r = await host.exec.exec([bin, ...args], { cwd, env: { PATH: toolPath() }, timeoutMs: opts.timeoutMs });
          if (r.code !== 0 || r.timedOut) throw commandError(bin, args, r);
          return { stdout: redactSecrets(r.stdout), stderr: redactSecrets(r.stderr) };
        },
      };
    },
  };
}
