/**
 * remoteLaunch — the remote command every long-lived remote process (and every ssh exec that needs a working
 * directory or extra env) runs through. It is the ONLY channel for environment and the agent token:
 *
 *   /usr/bin/env -i HOME=… PATH=… [USER LOGNAME SHELL TMPDIR LANG]=… \
 *     /bin/sh -c '<SPAWN_WRAPPER>' sh <cwd> <envFileOrEmpty> <pidFileOrEmpty> <argv...>
 *
 * (exec with cwd/env skips the `env -i` base and inherits the remote login env, which the prelude then
 * overrides — "merged over the command env", like LocalHost.)
 *
 * SPAWN_WRAPPER is fixed POSIX sh text — no caller data is ever spliced into it; paths and argv are positional
 * parameters, single-quoted word by word by quoteRemoteArgv. In order it:
 *  1. `umask 077`; expands a leading `~/` of $1..$3 against the remote $HOME;
 *  2. `cd -- "$1" || exit 97` (an empty $1 keeps the login directory);
 *  3. writes `<pid> <pgid>` to the pidfile ($3, parent created) or exits 95 — `$$` is the pid the program keeps
 *     after `exec`. sh has no portable "new process group" primitive on macOS (no setsid(1), `set -m` is
 *     interactive-only), but it does not need one: sshd calls setsid() for every session channel, so the
 *     recorded pgid is that ssh session's group — the program and everything it spawns, nothing else.
 *     `kill -TERM -<pgid>` (KILL_PROGRAM) therefore reaps the whole remote tree;
 *  4. when $2 names an existing file, extracts ONLY `^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-[A-Za-z0-9_-]+$` with
 *     `grep -m1 -E` and exports it — the file is never sourced, a malformed file is ignored (the agent then fails
 *     auth visibly), and the token never transits this Mac;
 *  5. reads the env PRELUDE from stdin line by line up to the first empty line: each line must be
 *     `<identifier>=<value>` (checked with `case`, exported with `export "$line"`, never eval'd), else exit 98;
 *     EOF before the empty line is also 98. `read` consumes a pipe byte by byte, so every byte after the
 *     terminator belongs to the exec'd program;
 *  6. `exec "$@"` (exit 96 when no argv is left).
 * Helpers (ps, grep, mkdir) run BEFORE the prelude replaces PATH, under the `env -i` base PATH.
 *
 * The wrapper is ONE line on purpose: the remote login shell parses the command first, and csh-family shells
 * reject a newline inside single quotes.
 */
import type { ExecResult } from '../../orchestrator/trpc/contracts/executionHost';
import { quoteRemoteArgv } from './sshTransport';

export const WRAPPER_EXIT = { pidfile: 95, noArgv: 96, cwd: 97, prelude: 98 } as const;

/** The token line the wrapper accepts from the env file — the whole line, nothing else. */
export const TOKEN_ENV_FILE_PATTERN = '^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-[A-Za-z0-9_-]+$';

export const SPAWN_WRAPPER =
  'umask 077; c=$1; e=$2; f=$3; shift 3; ' +
  'case "$c" in "~/"*) c="$HOME/${c#??}" ;; esac; ' +
  'case "$e" in "~/"*) e="$HOME/${e#??}" ;; esac; ' +
  'case "$f" in "~/"*) f="$HOME/${f#??}" ;; esac; ' +
  'if [ -n "$c" ]; then cd -- "$c" || exit 97; fi; ' +
  'if [ -n "$f" ]; then g=$(ps -o pgid= -p $$ 2>/dev/null | tr -d " "); ' +
  'mkdir -p -- "${f%/*}" && printf "%s %s\\n" "$$" "$g" > "$f" || exit 95; fi; ' +
  'if [ -n "$e" ] && [ -f "$e" ]; then ' +
  't=$(grep -m1 -E -e "^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-[A-Za-z0-9_-]+\\$" -- "$e" 2>/dev/null) && [ -n "$t" ] && export "$t"; t=; fi; ' +
  'while :; do IFS= read -r l || exit 98; [ -z "$l" ] && break; ' +
  'case "$l" in *=*) ;; *) exit 98 ;; esac; k=${l%%=*}; ' +
  'case "$k" in ""|[!A-Za-z_]*|*[!A-Za-z0-9_]*) exit 98 ;; esac; ' +
  'export "$l"; done; ' +
  '[ $# -gt 0 ] || exit 96; exec "$@"';

/**
 * Signals the process group recorded in a wrapper pidfile ($1), signal name in $2 (TERM | KILL). A missing or
 * unreadable pidfile is success (nothing to kill); a pgid ≤ 1 is never signalled; without a pgid it falls back to
 * the pid. The pidfile is left in place (PIDFILE_REAP_PROGRAM removes it once the process is gone). Every spawn has
 * its OWN pidfile (`<spawnKey>.<nonce>.pid`), so a dying process's escalation can never signal its replacement.
 */
export const KILL_PROGRAM =
  'f=$1; case "$f" in "~/"*) f="$HOME/${f#??}" ;; esac; [ -f "$f" ] || exit 0; ' +
  'read p g < "$f" || [ -n "$p" ] || exit 0; ' +
  'case "$p" in ""|*[!0-9]*) p= ;; esac; case "$g" in ""|*[!0-9]*) g= ;; esac; ' +
  'if [ -n "$g" ] && [ "$g" -gt 1 ]; then kill -s "$2" -- "-$g" 2>/dev/null && exit 0; fi; ' +
  'if [ -n "$p" ] && [ "$p" -gt 1 ]; then kill -s "$2" "$p" 2>/dev/null; fi; exit 0';

/**
 * $1 = a spawn's pidfile. Removes it unless the pid it records is still alive (a process that outlived a dropped
 * connection keeps its pidfile, which is how F1 finds and fences it). Always exits 0 on a missing file.
 */
export const PIDFILE_REAP_PROGRAM =
  'f=$1; case "$f" in "~/"*) f="$HOME/${f#??}" ;; esac; [ -f "$f" ] || exit 0; p=; read p g < "$f"; ' +
  'if [ "$p" -gt 1 ] 2>/dev/null && kill -0 "$p" 2>/dev/null; then exit 0; fi; exec rm -f -- "$f"';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SPAWN_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** A per-spawn pidfile nonce: lowercase hex (SshHost mints 16 chars from node:crypto). */
const SPAWN_NONCE_RE = /^[0-9a-f]{8,64}$/;
/** The nonce width SshHost mints; remotePidFileGlob matches exactly this many hex digits. */
export const SPAWN_NONCE_HEX_CHARS = 16;

/** Keys that never travel in a prelude: the orch token goes by file, the agent token by the env file. */
const PRELUDE_DENIED_KEYS: ReadonlySet<string> = new Set([
  'CYBOFLOW_ORCH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ELECTRON_RUN_AS_NODE',
]);

export class InvalidRemoteEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRemoteEnvError';
  }
}

export class InvalidSpawnNonceError extends Error {
  constructor() {
    super('A remote spawn nonce must be 8-64 lowercase hex characters.');
    this.name = 'InvalidSpawnNonceError';
  }
}

export class InvalidSpawnKeyError extends Error {
  constructor() {
    super('A remote spawn key must be 1-128 characters of [A-Za-z0-9._-].');
    this.name = 'InvalidSpawnKeyError';
  }
}

/**
 * The remote facts a spawn needs, from the latest complete probe (A4). `remoteRoot` is absolute and expanded.
 * Only `home` is mandatory for the `env -i` base; the rest are included when known.
 */
export interface RemoteHostFacts {
  remoteRoot: string;
  home: string;
  path?: string | null;
  user?: string | null;
  logname?: string | null;
  shell?: string | null;
  tmpdir?: string | null;
  lang?: string | null;
}

/** PATH of the `env -i` base when the probe did not report one; the prelude normally replaces it. */
export const DEFAULT_REMOTE_BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function assertCarriable(key: string, value: string): void {
  if (value.includes('\n') || value.includes('\0')) {
    throw new InvalidRemoteEnvError(`The value of ${key} contains a newline or NUL byte and cannot be sent.`);
  }
}

/**
 * The stdin prelude: `KEY=value\n` per entry, then the empty terminator line. Throws InvalidRemoteEnvError
 * LOCALLY (nothing is sent) for a key that is not a shell identifier, a denied key, or a value with a newline /
 * NUL. `undefined` values are skipped.
 */
export function encodeEnvPrelude(env: Readonly<Record<string, string | undefined>>): string {
  let out = '';
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!ENV_KEY_RE.test(key)) throw new InvalidRemoteEnvError(`"${key.slice(0, 64)}" is not a valid environment variable name.`);
    if (PRELUDE_DENIED_KEYS.has(key)) throw new InvalidRemoteEnvError(`${key} must never be sent in the environment prelude.`);
    assertCarriable(key, value);
    out += `${key}=${value}\n`;
  }
  return `${out}\n`;
}

/** `/usr/bin/env -i HOME=… PATH=… …` from the probe facts (validated: no newline / NUL). */
export function envIBase(facts: RemoteHostFacts): string[] {
  const pairs: Array<[string, string | null | undefined]> = [
    ['HOME', facts.home],
    ['PATH', facts.path || DEFAULT_REMOTE_BASE_PATH],
    ['USER', facts.user],
    ['LOGNAME', facts.logname ?? facts.user],
    ['SHELL', facts.shell],
    ['TMPDIR', facts.tmpdir],
    ['LANG', facts.lang],
  ];
  if (!facts.home) throw new InvalidRemoteEnvError('The remote home directory is not known yet; run a check first.');
  const words = ['/usr/bin/env', '-i'];
  for (const [key, value] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    assertCarriable(key, value);
    words.push(`${key}=${value}`);
  }
  return words;
}

export function assertSpawnKey(key: string): string {
  if (!SPAWN_KEY_RE.test(key) || key === '.' || key === '..') throw new InvalidSpawnKeyError();
  return key;
}

export interface WrapperArgvInput {
  /** '' keeps the login directory. Absolute or `~/`. */
  cwd: string;
  /** '' = no token env file. */
  envFile: string;
  /** '' = no pidfile. */
  pidFile: string;
  argv: readonly string[];
}

/** `/bin/sh -c <SPAWN_WRAPPER> sh <cwd> <envFile> <pidFile> <argv...>` as a remote argv. */
export function wrapperArgv(input: WrapperArgvInput): string[] {
  if (input.argv.length === 0) throw new Error('remote argv is empty');
  return ['/bin/sh', '-c', SPAWN_WRAPPER, 'sh', input.cwd, input.envFile, input.pidFile, ...input.argv];
}

export interface RemoteSpawnCommandInput {
  facts: RemoteHostFacts;
  cwd?: string;
  /** Export the agent token from `<remoteRoot>/env`. */
  withTokenEnvFile?: boolean;
  spawnKey: string;
  /** This spawn's pidfile nonce (see remotePidFile). */
  spawnNonce: string;
  argv: readonly string[];
}

/**
 * `<remoteRoot>/run/<spawnKey>.<nonce>.pid` — ONE pidfile per spawn. Two spawns of the same spawnKey (a
 * replacement started while the old process is still dying) never share a pidfile, so each kill program only
 * ever reads the pgid of the process it belongs to.
 */
export function remotePidFile(remoteRoot: string, spawnKey: string, nonce: string): string {
  if (!SPAWN_NONCE_RE.test(nonce)) throw new InvalidSpawnNonceError();
  return `${remoteRoot}/run/${assertSpawnKey(spawnKey)}.${nonce}.pid`;
}

/**
 * A shell glob matching every pidfile of ONE spawnKey (any nonce SshHost mints), for fencing orphans before the
 * spawnKey is re-dispatched (F1). The nonce part is exactly SPAWN_NONCE_HEX_CHARS `[0-9a-f]` classes, so key `a`
 * never matches key `a.b`'s pidfiles. Spawn keys carry no glob metacharacters (assertSpawnKey).
 */
export function remotePidFileGlob(remoteRoot: string, spawnKey: string): string {
  return `${remoteRoot}/run/${pidFileBasenameGlob(spawnKey)}`;
}

/** The BASENAME part of remotePidFileGlob (`<spawnKey>.<16 × [0-9a-f]>.pid`), for programs that `cd` into run/ first. */
export function pidFileBasenameGlob(spawnKey: string): string {
  return `${assertSpawnKey(spawnKey)}.${'[0-9a-f]'.repeat(SPAWN_NONCE_HEX_CHARS)}.pid`;
}

/** True when a pidfile BASENAME belongs to `spawnKey` (the JS twin of remotePidFileGlob, any valid nonce width). */
export function isPidFileOfSpawnKey(fileName: string, spawnKey: string): boolean {
  const prefix = `${assertSpawnKey(spawnKey)}.`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.pid')) return false;
  return SPAWN_NONCE_RE.test(fileName.slice(prefix.length, -'.pid'.length));
}

export function remoteTokenEnvFile(remoteRoot: string): string {
  return `${remoteRoot}/env`;
}

/** The single remote command string ssh sends for a long-lived process (env -i base + wrapper). */
export function buildRemoteSpawnCommand(input: RemoteSpawnCommandInput): string {
  const root = input.facts.remoteRoot;
  return quoteRemoteArgv([
    ...envIBase(input.facts),
    ...wrapperArgv({
      cwd: input.cwd ?? '',
      envFile: input.withTokenEnvFile ? remoteTokenEnvFile(root) : '',
      pidFile: remotePidFile(root, input.spawnKey, input.spawnNonce),
      argv: input.argv,
    }),
  ]);
}

/** Remote argv running KILL_PROGRAM against a pidfile. */
export function killArgv(pidFile: string, signal: 'TERM' | 'KILL'): string[] {
  return ['/bin/sh', '-c', KILL_PROGRAM, 'sh', pidFile, signal];
}

/** Remote argv running PIDFILE_REAP_PROGRAM against a spawn's pidfile. */
export function reapPidFileArgv(pidFile: string): string[] {
  return ['/bin/sh', '-c', PIDFILE_REAP_PROGRAM, 'sh', pidFile];
}

/** Human-readable reason for a wrapper exit code, or null for the program's own codes. */
export function describeWrapperExit(result: Pick<ExecResult, 'code'>): string | null {
  switch (result.code) {
    case WRAPPER_EXIT.cwd: return 'The working directory does not exist on the environment.';
    case WRAPPER_EXIT.prelude: return 'The environment prelude was rejected.';
    case WRAPPER_EXIT.pidfile: return 'Could not write the process file on the environment.';
    case WRAPPER_EXIT.noArgv: return 'No command was given.';
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Env allowlist (spec A3)
// ---------------------------------------------------------------------------------------------------------------

/** A local path prefix and the remote path that replaces it (worktree, artifacts dir, …). */
export interface PathRemap {
  from: string;
  to: string;
}

export interface RemoteEnvRemap {
  /** Remote probe facts: HOME / USER / LOGNAME / SHELL / TMPDIR / LANG come from here, never from this Mac. */
  facts: RemoteHostFacts;
  /** Remote PATH (see composeRemotePath). */
  path: string;
  /** Remote orch socket; CYBOFLOW_ORCH_SOCKET is dropped when absent. */
  orchSocket?: string | null;
  /** Remote per-run artifacts dir; CYBOFLOW_RUN_ARTIFACTS_DIR is dropped when absent. */
  artifactsDir?: string | null;
  /** Remote 0600 orch token file; set as CYBOFLOW_ORCH_TOKEN_FILE (the token itself never travels). */
  orchTokenFile?: string | null;
  /** CODEX_HOME — only when it is set REMOTELY; never copied from this Mac. */
  codexHome?: string | null;
  /** Extra keys copied (remapped) from the local env: lane env keys. CYBOFLOW_* keys are always copied. */
  extraKeys?: readonly string[];
  /** Local→remote path prefixes applied to every copied value (exact match or `<from>/…`). */
  pathMap?: readonly PathRemap[];
}

/** Local keys copied verbatim (when set) besides CYBOFLOW_*. */
const COPIED_LOCAL_KEYS = ['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'LC_ALL'] as const;

/** Never forwarded, whatever the caller lists. */
const NEVER_FORWARDED: ReadonlySet<string> = new Set([
  'CYBOFLOW_ORCH_TOKEN',
  'CYBOFLOW_ORCH_TOKEN_FILE',
  'CYBOFLOW_ORCH_SOCKET',
  'CYBOFLOW_RUN_ARTIFACTS_DIR',
  'ELECTRON_RUN_AS_NODE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_HOME',
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'PATH',
]);

function remapValue(value: string, pathMap: readonly PathRemap[]): string {
  for (const { from, to } of pathMap) {
    if (from.length === 0) continue;
    if (value === from) return to;
    if (value.startsWith(`${from}/`)) return `${to}${value.slice(from.length)}`;
  }
  return value;
}

/**
 * `<codexPathDir>:<nodeDir>:<gitDir>:/usr/bin:/bin:/usr/sbin:/sbin` — absent pieces are skipped. The remote
 * non-login PATH is only the system dirs, so every tool the agent needs is named by its probed directory.
 */
export function composeRemotePath(dirs: { codexPathDir?: string | null; nodeDir?: string | null; gitDir?: string | null }): string {
  const parts = [dirs.codexPathDir, dirs.nodeDir, dirs.gitDir].filter((d): d is string => typeof d === 'string' && d.length > 0);
  return [...parts, DEFAULT_REMOTE_BASE_PATH].join(':');
}

/**
 * The COMPLETE remote child env from a locally composed one, by allowlist: HOME USER LOGNAME SHELL TMPDIR LANG
 * from the remote facts, TERM=dumb, the remote PATH, LC_ALL / CLAUDE_AGENT_SDK_VERSION / CLAUDE_CODE_ENTRYPOINT
 * when set locally, every CYBOFLOW_* key and every `extraKeys` key (values path-remapped), the three remapped
 * cyboflow paths, CODEX_HOME only when set remotely. Everything else — `process.env` noise, the orch token,
 * ELECTRON_RUN_AS_NODE — is dropped.
 */
export function composeRemoteEnv(
  localEnv: Readonly<Record<string, string | undefined>>,
  remap: RemoteEnvRemap,
): Record<string, string> {
  const pathMap = remap.pathMap ?? [];
  const f = remap.facts;
  const env: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined): void => {
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  };
  put('HOME', f.home);
  put('USER', f.user);
  put('LOGNAME', f.logname ?? f.user);
  put('SHELL', f.shell);
  put('TMPDIR', f.tmpdir);
  put('LANG', f.lang);
  env.TERM = 'dumb';
  put('PATH', remap.path);
  for (const key of COPIED_LOCAL_KEYS) put(key, localEnv[key]);
  const copy = (key: string): void => {
    if (NEVER_FORWARDED.has(key)) return;
    const v = localEnv[key];
    if (typeof v === 'string') put(key, remapValue(v, pathMap));
  };
  for (const key of Object.keys(localEnv)) {
    if (key.startsWith('CYBOFLOW_')) copy(key);
  }
  for (const key of remap.extraKeys ?? []) copy(key);
  put('CYBOFLOW_ORCH_SOCKET', remap.orchSocket);
  put('CYBOFLOW_RUN_ARTIFACTS_DIR', remap.artifactsDir);
  put('CYBOFLOW_ORCH_TOKEN_FILE', remap.orchTokenFile);
  put('CODEX_HOME', remap.codexHome);
  return env;
}
