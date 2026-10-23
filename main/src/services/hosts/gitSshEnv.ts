/**
 * gitSshEnv — how LOCAL git (push / fetch / ls-remote run on this Mac) reaches a repository on an SSH environment
 * over the SAME connection options the rest of Environments uses (SshTransport.controlArgs: BatchMode, timeouts,
 * the shared ControlMaster socket).
 *
 * git runs GIT_SSH_COMMAND through `sh -c "$GIT_SSH_COMMAND" <host> <remote command>`, so the command is SHELL TEXT:
 * every word is single-quoted (sshTransport.shQuote). That matters for the ControlPath value, which carries literal
 * double quotes meant for ssh's own option parser and may sit under a data dir with spaces or `%`.
 * GIT_SSH_VARIANT=ssh stops git from guessing the variant from the command's first word.
 *
 * The remote command git asks ssh to run (`git-receive-pack '<path>'`, or what `--receive-pack` names) is parsed by
 * the REMOTE shell: {@link remoteGitPackCommand} quotes the probed git path for that.
 *
 * Nothing secret is in either value: ssh authenticates with the user's agent / keys, never an argv.
 */
import { SSH_TARGET_RE } from '../../../../shared/types/hosts';
import { shQuote } from './sshTransport';

/** The slice of SshTransport this needs (SshTransportLike satisfies it). */
export interface GitSshTransportLike {
  controlArgs(target: string): string[];
}

export class InvalidRemoteRepoPathError extends Error {
  constructor() {
    super('A remote repository path must be absolute and on one line.');
    this.name = 'InvalidRemoteRepoPathError';
  }
}

// eslint-disable-next-line no-control-regex
const BAD_PATH_CHARS_RE = /[\u0000\n\r]/;

/** @throws InvalidRemoteRepoPathError unless absolute and free of newline / CR / NUL. */
export function assertRemoteRepoPath(p: string): string {
  if (!p.startsWith('/') || BAD_PATH_CHARS_RE.test(p)) throw new InvalidRemoteRepoPathError();
  return p;
}

/** `ssh ...controlArgs`, each word shell-quoted, space-joined: the value of GIT_SSH_COMMAND. */
export function buildGitSshCommand(transport: GitSshTransportLike, target: string): string {
  return ['ssh', ...transport.controlArgs(target)].map(shQuote).join(' ');
}

/** The env overlay for a local git command that talks to `target` (merge it over the usual command env). */
export function buildGitSshEnv(transport: GitSshTransportLike, target: string): Record<string, string> {
  return { GIT_SSH_COMMAND: buildGitSshCommand(transport, target), GIT_SSH_VARIANT: 'ssh' };
}

/**
 * `ssh://<target>/<absolute path>` — git's ssh URL form; the absolute path follows the host (`%` escaped). The target is
 * the validated `[user@]host` (SSH_TARGET_RE) — but a URL reads a bare `:` as a port separator and `%` as an escape,
 * so a target carrying either outside `[...]` (an alias ssh itself would accept) is refused rather than misread.
 */
export function remoteGitUrl(target: string, absPath: string): string {
  if (!SSH_TARGET_RE.test(target) || target.includes('%') || target.replace(/\[[^\]]*\]/g, '').includes(':')) {
    throw new Error('This environment\'s ssh destination cannot be used in a git URL (it contains ":" or "%").');
  }
  // git URL-decodes the path of a URL (`%41` → `A`), so a literal `%` travels as `%25`.
  return `ssh://${target}${assertRemoteRepoPath(absPath).replace(/%/g, '%25')}`;
}

/**
 * The `--receive-pack` / `--upload-pack` value: `'<gitPath>' receive-pack` with the probed absolute git (so the
 * non-login PATH's CLT shim is never relied on), or the bare `git-<pack>` when no absolute git is known.
 */
export function remoteGitPackCommand(gitPath: string | null, pack: 'receive-pack' | 'upload-pack'): string {
  if (gitPath !== null && gitPath.startsWith('/') && !BAD_PATH_CHARS_RE.test(gitPath)) {
    return `${shQuote(gitPath)} ${pack}`;
  }
  return `git-${pack}`;
}
