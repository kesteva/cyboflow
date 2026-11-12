/**
 * The single remote probe of an SSH preflight: ONE POSIX `sh` script, sent on stdin to `/bin/sh -s`, that
 * prints `key=value` lines only.
 *
 * Secrets rule: the probe never prints file contents and never sources or executes anything it reads. The
 * token env file (`<remote root>/env`) is only inspected with `test`, `stat` (its mode) and `grep -c`
 * (COUNTS of token lines) — never its value. `/etc/os-release` is read with `sed -n` for one field, never
 * sourced. Every probe is guarded (`2>/dev/null`, `|| true` style), so the script runs to `probe_done=1`.
 */
import { redactSecrets } from '../../../../shared/types/hosts';
import { shQuote } from './sshTransport';

export interface ProbeRecord {
  home: string | null;
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
  /** The script reached its last line (output not truncated by a timeout or a dropped connection). */
  complete: boolean;
}

const EMPTY_PROBE: ProbeRecord = {
  home: null, unameS: null, unameM: null, osVersion: null, xcodeClt: null, gitVersion: null,
  nodePath: null, nodeVersion: null, claudePath: null, claudeVersion: null, codexPath: null,
  codexVersion: null, codexAuth: null, envExists: null, envMode: null, envWellformed: null, envLines: null,
  sleepValue: null, sleepPrevented: null, diskFreeKb: null, complete: false,
};

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

/** Build the probe script for one host. Pure. */
export function buildProbeScript(remoteRoot: string): string {
  const candidates = (bin: string): string =>
    `"$HOME/.local/bin/${bin}" /opt/homebrew/bin/${bin} /usr/local/bin/${bin} /usr/bin/${bin}`;
  return [
    'kv() { printf \'%s=%s\\n\' "$1" "$(printf \'%s\' "$2" | head -n 1 | tr -d \'\\r\')"; }',
    'kv home "$HOME"',
    'uname_s=$(uname -s 2>/dev/null)',
    'kv uname_s "$uname_s"',
    'kv uname_m "$(uname -m 2>/dev/null)"',
    'if [ "$uname_s" = Darwin ]; then',
    '  kv os_version "$(sw_vers -productVersion 2>/dev/null)"',
    'else',
    '  kv os_version "$(sed -n \'s/^PRETTY_NAME=//p\' /etc/os-release 2>/dev/null | tr -d \'"\')"',
    'fi',
    // git: on Darwin /usr/bin/git is a shim that pops the Command Line Tools installer when CLT is missing,
    // so it is only run when xcode-select -p succeeds; otherwise only a Homebrew git is tried.
    'git_v=',
    'if [ "$uname_s" = Darwin ]; then',
    '  if xcode-select -p >/dev/null 2>&1; then',
    '    kv xcode_clt 1',
    '    git_v=$(/usr/bin/git --version 2>/dev/null)',
    '  else',
    '    kv xcode_clt 0',
    '    for c in /opt/homebrew/bin/git /usr/local/bin/git; do',
    '      if [ -x "$c" ]; then git_v=$("$c" --version 2>/dev/null); [ -n "$git_v" ] && break; fi',
    '    done',
    '  fi',
    'else',
    '  gp=$(command -v git 2>/dev/null)',
    '  if [ -n "$gp" ]; then git_v=$("$gp" --version 2>/dev/null); fi',
    'fi',
    'kv git_version "$git_v"',
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
    'if [ "$uname_s" = Darwin ]; then',
    '  sl=$(pmset -g 2>/dev/null | sed -n \'s/^ *sleep *//p\' | head -n 1)',
    '  kv sleep_value "${sl%% *}"',
    '  case "$sl" in *"prevented by"*) kv sleep_prevented 1 ;; *) kv sleep_prevented 0 ;; esac',
    'fi',
    'kv disk_free_kb "$(df -Pk "$HOME" 2>/dev/null | awk \'NR==2{print $4}\')"',
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
    complete: flag(g('probe_done')) === true,
  };
}
