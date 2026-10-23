/**
 * The single remote probe of an SSH preflight: ONE POSIX `sh` script, sent on stdin to `/bin/sh -s`, that
 * prints `key=value` lines only.
 *
 * Secrets rule: the probe never prints file contents and never sources or executes anything it reads. The
 * token env file (`<remote root>/env`) is only inspected with `test`, `stat` (its mode) and `grep -c`
 * (COUNTS of token lines) — never its value. `/etc/os-release` is read with `sed -n` for one field, never
 * sourced. Every probe is guarded (`2>/dev/null`, `|| true` style), so the script runs to `probe_done=1`.
 *
 * Installed toolchain (spec A6 `sdk-binary-hash`): given the EXPECTED hash of this Mac's toolchain for the
 * machine's arch, the probe reports whether `<root>/toolchain/<hash>/manifest.json` exists, whether it names that
 * hash, and the byte sizes (stat, never a checksum: the push already verified every sha256) of the claude binary,
 * the MCP bundle and the codex entrypoint. The hash and the codex path are validated locally and enter the script
 * only as single-quoted shell words.
 */
import { redactSecrets } from '../../../../shared/types/hosts';
import { shQuote } from './sshTransport';
import { TOOLCHAIN_CLAUDE_REL, TOOLCHAIN_HASH_RE, TOOLCHAIN_MANIFEST_NAME, TOOLCHAIN_MCP_REL } from './toolchain/types';

export interface ProbeRecord {
  home: string | null;
  /** `id -un`. */
  user: string | null;
  /** $LOGNAME, else `logname`, else `user`. */
  logname: string | null;
  /** $SHELL, else the passwd entry via `getent` (absent on macOS, where sshd always sets $SHELL). */
  shell: string | null;
  /** Darwin: `getconf DARWIN_USER_TEMP_DIR`; else $TMPDIR. */
  tmpdir: string | null;
  lang: string | null;
  /**
   * The git binary that produced `gitVersion` — never the Darwin `/usr/bin/git` shim unless the Command Line
   * Tools are installed (`xcode-select -p` succeeds or /Library/Developer/CommandLineTools exists).
   */
  gitPath: string | null;
  /** The configured remote root, shell-expanded (`~/x` → `$HOME/x`); not resolved, it may not exist yet. */
  remoteRoot: string | null;
  /** Byte length of `<remoteRoot>/s/o.sock` (the orch forward's remote socket). */
  sockPathBytes: number | null;
  unameS: string | null;
  unameM: string | null;
  osVersion: string | null;
  /** Darwin only: `xcode-select -p` succeeded. null off Darwin / not reported. */
  xcodeClt: boolean | null;
  gitVersion: string | null;
  nodePath: string | null;
  nodeVersion: string | null;
  claudePath: string | null;
  claudeVersion: string | null;
  codexPath: string | null;
  codexVersion: string | null;
  codexAuth: boolean | null;
  envExists: boolean | null;
  envMode: string | null;
  envWellformed: number | null;
  envLines: number | null;
  sleepValue: string | null;
  sleepPrevented: boolean | null;
  diskFreeKb: number | null;
  /** The toolchain hash the toolchain section looked for (echoed back); null when no section ran. */
  tcHash: string | null;
  /** `<root>/toolchain/<hash>/manifest.json` exists. null = not reported. */
  tcManifest: boolean | null;
  /** That manifest names the expected hash. null = not reported (no manifest). */
  tcManifestHash: boolean | null;
  /** Byte sizes of the installed claude binary / MCP bundle / codex entrypoint; null = missing or not reported. */
  tcClaudeSize: number | null;
  tcMcpSize: number | null;
  tcCodexSize: number | null;
  /** The script reached its last line (output not truncated by a timeout or a dropped connection). */
  complete: boolean;
}

const EMPTY_PROBE: ProbeRecord = {
  home: null, user: null, logname: null, shell: null, tmpdir: null, lang: null, gitPath: null, remoteRoot: null,
  sockPathBytes: null, unameS: null, unameM: null, osVersion: null, xcodeClt: null, gitVersion: null,
  nodePath: null, nodeVersion: null, claudePath: null, claudeVersion: null, codexPath: null,
  codexVersion: null, codexAuth: null, envExists: null, envMode: null, envWellformed: null, envLines: null,
  sleepValue: null, sleepPrevented: null, diskFreeKb: null, tcHash: null, tcManifest: null, tcManifestHash: null,
  tcClaudeSize: null, tcMcpSize: null, tcCodexSize: null, complete: false,
};

/** What the toolchain section looks for: the expected hash and (when the bundle has codex) its entrypoint path. */
export interface ToolchainProbeSpec {
  hash: string;
  /** e.g. `codex/aarch64-apple-darwin/bin/codex`; null for a claude-only toolchain. */
  codexBinRel: string | null;
}

/** A codex entrypoint path as the toolchain lays it out; nothing else may enter the probe text. */
export const CODEX_BIN_REL_RE = /^codex\/[A-Za-z0-9._-]+\/bin\/codex$/;

export class InvalidToolchainProbeSpecError extends Error {
  constructor() {
    super('Invalid toolchain probe input.');
    this.name = 'InvalidToolchainProbeSpecError';
  }
}

const KV_FN = 'kv() { printf \'%s=%s\\n\' "$1" "$(printf \'%s\' "$2" | head -n 1 | tr -d \'\\r\')"; }';

/**
 * A shell expression for the remote root: `~/x` becomes `"$HOME"/'x'` (tilde expansion never happens
 * inside quotes), anything else is single-quoted as-is.
 */
export function remoteRootShellExpr(remoteRoot: string): string {
  if (remoteRoot === '~') return '"$HOME"';
  if (remoteRoot.startsWith('~/')) return `"$HOME"/${shQuote(remoteRoot.slice(2))}`;
  return shQuote(remoteRoot);
}

/** Expand a `~/…` remote root with the probe's `home`; null when it cannot be expanded. */
export function expandRemoteRoot(remoteRoot: string, home: string | null): string | null {
  if (remoteRoot === '~') return home;
  if (remoteRoot.startsWith('~/')) return home ? `${home.replace(/\/+$/, '')}/${remoteRoot.slice(2)}` : null;
  return remoteRoot;
}

/** The token env file's presence / mode / line counts — never its value. Expects `kv`, `$root`, `$uname_s`. */
const ENV_FILE_LINES: readonly string[] = [
  'envf="$root/env"',
  'if [ -f "$envf" ]; then',
  '  kv env_exists 1',
  '  if [ "$uname_s" = Darwin ]; then',
  '    kv env_mode "$(stat -f %Lp "$envf" 2>/dev/null)"',
  '  else',
  '    kv env_mode "$(stat -c %a "$envf" 2>/dev/null)"',
  '  fi',
  '  kv env_wellformed "$(grep -c \'^CLAUDE_CODE_OAUTH_TOKEN=sk-ant-[A-Za-z0-9_-]*$\' "$envf" 2>/dev/null)"',
  '  kv env_lines "$(grep -c \'^CLAUDE_CODE_OAUTH_TOKEN=\' "$envf" 2>/dev/null)"',
  'else',
  '  kv env_exists 0',
  'fi',
];

/**
 * Build the probe script for one host. Pure. `opts.toolchain` adds the installed-toolchain section for that
 * expected hash (see buildToolchainProbeFragment).
 */
export function buildProbeScript(remoteRoot: string, opts: { toolchain?: ToolchainProbeSpec | null } = {}): string {
  const candidates = (bin: string): string =>
    `"$HOME/.local/bin/${bin}" /opt/homebrew/bin/${bin} /usr/local/bin/${bin} /usr/bin/${bin}`;
  return [
    KV_FN,
    'kv home "$HOME"',
    'u=$(id -un 2>/dev/null)',
    'kv user "$u"',
    // $LOGNAME first: sshd sets it, while logname(1) asks getlogin(), which can name another account.
    'ln=$LOGNAME; [ -z "$ln" ] && ln=$(logname 2>/dev/null)',
    'kv logname "${ln:-$u}"',
    'sh_=$SHELL',
    'if [ -z "$sh_" ] && [ -n "$u" ]; then sh_=$(getent passwd "$u" 2>/dev/null | cut -d: -f7); fi',
    'kv shell "$sh_"',
    'kv lang "$LANG"',
    'uname_s=$(uname -s 2>/dev/null)',
    'kv uname_s "$uname_s"',
    'kv uname_m "$(uname -m 2>/dev/null)"',
    'if [ "$uname_s" = Darwin ]; then',
    '  td=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)',
    '  kv tmpdir "${td:-$TMPDIR}"',
    '  kv os_version "$(sw_vers -productVersion 2>/dev/null)"',
    'else',
    '  kv tmpdir "$TMPDIR"',
    '  kv os_version "$(sed -n \'s/^PRETTY_NAME=//p\' /etc/os-release 2>/dev/null | tr -d \'"\')"',
    'fi',
    // git: on Darwin /usr/bin/git is a shim that pops the Command Line Tools installer when CLT is missing,
    // so it is only run when xcode-select -p succeeds (or the CLT folder exists); otherwise only a Homebrew git
    // is tried. git_path is the binary that answered.
    'git_v=; git_p=',
    'if [ "$uname_s" = Darwin ]; then',
    '  clt=',
    '  if xcode-select -p >/dev/null 2>&1; then kv xcode_clt 1; clt=1; else kv xcode_clt 0; fi',
    '  [ -d /Library/Developer/CommandLineTools ] && clt=1',
    '  if [ -n "$clt" ]; then set -- /usr/bin/git /opt/homebrew/bin/git /usr/local/bin/git; else set -- /opt/homebrew/bin/git /usr/local/bin/git; fi',
    '  for c in "$@"; do',
    '    if [ -x "$c" ]; then git_v=$("$c" --version 2>/dev/null); if [ -n "$git_v" ]; then git_p=$c; break; fi; fi',
    '  done',
    'else',
    '  gp=$(command -v git 2>/dev/null)',
    '  if [ -n "$gp" ]; then git_v=$("$gp" --version 2>/dev/null); [ -n "$git_v" ] && git_p=$gp; fi',
    'fi',
    'kv git_version "$git_v"',
    'kv git_path "$git_p"',
    // node first: claude / codex are often node-shebang scripts, so the found node joins PATH.
    'probe_bin() {',
    '  name=$1; shift',
    '  for c in "$@"; do',
    '    if [ -x "$c" ]; then',
    '      v=$("$c" --version 2>/dev/null)',
    '      if [ -n "$v" ]; then kv "${name}_path" "$c"; kv "${name}_version" "$v"; probe_found=$c; return 0; fi',
    '    fi',
    '  done',
    '  return 1',
    '}',
    // nvm installs are common on dev machines: the lexically last version dir is the fallback candidate.
    'nvm_node=',
    'for c in "$HOME"/.nvm/versions/node/v*/bin/node; do if [ -x "$c" ]; then nvm_node=$c; fi; done',
    `if probe_bin node ${candidates('node')} "$(command -v node 2>/dev/null)" "$nvm_node"; then`,
    '  PATH="${probe_found%/*}:$PATH"; export PATH',
    'fi',
    `probe_bin claude ${candidates('claude')} "$(command -v claude 2>/dev/null)"`,
    `probe_bin codex ${candidates('codex')} "$(command -v codex 2>/dev/null)"`,
    'if [ -s "$HOME/.codex/auth.json" ]; then kv codex_auth 1; else kv codex_auth 0; fi',
    `root=${remoteRootShellExpr(remoteRoot)}`,
    'kv remote_root "$root"',
    // The orch forward's remote socket must fit sun_path (104 on macOS): `wc -c` counts bytes.
    'kv sock_path_bytes "$(printf \'%s\' "$root/s/o.sock" | wc -c | tr -d \' \')"',
    ...ENV_FILE_LINES,
    'if [ "$uname_s" = Darwin ]; then',
    '  sl=$(pmset -g 2>/dev/null | sed -n \'s/^ *sleep *//p\' | head -n 1)',
    '  kv sleep_value "${sl%% *}"',
    '  case "$sl" in *"prevented by"*) kv sleep_prevented 1 ;; *) kv sleep_prevented 0 ;; esac',
    'fi',
    'kv disk_free_kb "$(df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4}\')"',
    ...(opts.toolchain ? buildToolchainProbeFragment(opts.toolchain) : []),
    'kv probe_done 1',
    '',
  ].join('\n');
}

/**
 * The toolchain section. Expects `kv`, `$root` and `$uname_s` to be defined. Throws (caller bug) for a hash
 * that is not lowercase sha256 hex or a codex path of another shape.
 */
export function buildToolchainProbeFragment(spec: ToolchainProbeSpec): string[] {
  if (!TOOLCHAIN_HASH_RE.test(spec.hash)) throw new InvalidToolchainProbeSpecError();
  if (spec.codexBinRel !== null && (!CODEX_BIN_REL_RE.test(spec.codexBinRel) || spec.codexBinRel.includes('..'))) {
    throw new InvalidToolchainProbeSpecError();
  }
  return [
    `tc_h=${shQuote(spec.hash)}`,
    'kv tc_hash "$tc_h"',
    'tcd="$root/toolchain/$tc_h"',
    // stat, not a checksum: ~550 MB is never re-hashed on a preflight (the push verified every sha256).
    'fsz() { if [ -f "$1" ]; then if [ "$uname_s" = Darwin ]; then stat -f %z -- "$1" 2>/dev/null; else stat -c %s -- "$1" 2>/dev/null; fi; fi; }',
    `if [ -f "$tcd/${TOOLCHAIN_MANIFEST_NAME}" ]; then`,
    '  kv tc_manifest 1',
    // serializeToolchainManifest writes `"hash": "<hex>"` (2-space JSON); files carry "sha256", never "hash".
    `  if grep -q -F "\\"hash\\": \\"$tc_h\\"" "$tcd/${TOOLCHAIN_MANIFEST_NAME}" 2>/dev/null; then kv tc_manifest_hash 1; else kv tc_manifest_hash 0; fi`,
    `  kv tc_claude_size "$(fsz "$tcd/${TOOLCHAIN_CLAUDE_REL}")"`,
    `  kv tc_mcp_size "$(fsz "$tcd/${TOOLCHAIN_MCP_REL}")"`,
    ...(spec.codexBinRel !== null ? [`  kv tc_codex_size "$(fsz "$tcd"/${shQuote(spec.codexBinRel)})"`] : []),
    'else',
    '  kv tc_manifest 0',
    'fi',
  ];
}

/**
 * A toolchain-only probe (used when the full probe ran without the right expected hash: the first check of a
 * machine, or an arch that changed). Prints the toolchain keys then `probe_done=1`.
 */
export function buildToolchainProbeScript(remoteRoot: string, spec: ToolchainProbeSpec): string {
  return [
    KV_FN,
    'uname_s=$(uname -s 2>/dev/null)',
    `root=${remoteRootShellExpr(remoteRoot)}`,
    ...buildToolchainProbeFragment(spec),
    'kv probe_done 1',
    '',
  ].join('\n');
}

/**
 * The trimmed probe of a PRELAUNCH preflight (a launch-time liveness check under a 2 s budget): the remote home,
 * the token env file's shape (same rules as the full probe), node (the last known path first) and the installed
 * toolchain. Nothing else.
 */
export function buildPrelaunchProbeScript(
  remoteRoot: string,
  opts: { toolchain: ToolchainProbeSpec | null; nodePath: string | null },
): string {
  const nodeFirst = opts.nodePath !== null && opts.nodePath.startsWith('/') ? `${shQuote(opts.nodePath)} ` : '';
  return [
    KV_FN,
    'kv home "$HOME"',
    'uname_s=$(uname -s 2>/dev/null)',
    'kv uname_s "$uname_s"',
    'nv=; np=',
    `for c in ${nodeFirst}"$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do`,
    '  if [ -x "$c" ]; then nv=$("$c" --version 2>/dev/null); if [ -n "$nv" ]; then np=$c; break; fi; fi',
    'done',
    'kv node_path "$np"',
    'kv node_version "$nv"',
    `root=${remoteRootShellExpr(remoteRoot)}`,
    'kv remote_root "$root"',
    ...ENV_FILE_LINES,
    ...(opts.toolchain !== null ? buildToolchainProbeFragment(opts.toolchain) : []),
    'kv probe_done 1',
    '',
  ].join('\n');
}

function str(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function flag(v: string | undefined): boolean | null {
  const t = str(v);
  if (t === '1') return true;
  if (t === '0') return false;
  return null;
}

function int(v: string | undefined): number | null {
  const t = str(v);
  if (t === null || !/^\d+$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return Number.isSafeInteger(n) ? n : null;
}

const KEY_RE = /^([a-z_]+)=(.*)$/;

/** Parse the probe's stdout into a typed record. Unknown keys, garbage and duplicate keys (first wins) are ignored. */
export function parseProbeOutput(stdout: string): ProbeRecord {
  const kv = new Map<string, string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const m = KEY_RE.exec(raw);
    if (!m) continue;
    if (!kv.has(m[1])) kv.set(m[1], redactSecrets(m[2]));
  }
  const g = (k: string): string | undefined => kv.get(k);
  return {
    ...EMPTY_PROBE,
    home: str(g('home')),
    user: str(g('user')),
    logname: str(g('logname')),
    shell: str(g('shell')),
    tmpdir: str(g('tmpdir')),
    lang: str(g('lang')),
    gitPath: str(g('git_path')),
    remoteRoot: str(g('remote_root')),
    sockPathBytes: int(g('sock_path_bytes')),
    unameS: str(g('uname_s')),
    unameM: str(g('uname_m')),
    osVersion: str(g('os_version')),
    xcodeClt: flag(g('xcode_clt')),
    gitVersion: str(g('git_version')),
    nodePath: str(g('node_path')),
    nodeVersion: str(g('node_version')),
    claudePath: str(g('claude_path')),
    claudeVersion: str(g('claude_version')),
    codexPath: str(g('codex_path')),
    codexVersion: str(g('codex_version')),
    codexAuth: flag(g('codex_auth')),
    envExists: flag(g('env_exists')),
    envMode: str(g('env_mode')),
    envWellformed: int(g('env_wellformed')),
    envLines: int(g('env_lines')),
    sleepValue: str(g('sleep_value')),
    sleepPrevented: flag(g('sleep_prevented')),
    diskFreeKb: int(g('disk_free_kb')),
    tcHash: str(g('tc_hash')),
    tcManifest: flag(g('tc_manifest')),
    tcManifestHash: flag(g('tc_manifest_hash')),
    tcClaudeSize: int(g('tc_claude_size')),
    tcMcpSize: int(g('tc_mcp_size')),
    tcCodexSize: int(g('tc_codex_size')),
    complete: flag(g('probe_done')) === true,
  };
}
