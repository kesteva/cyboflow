/**
 * fsAccessGuard — pure, side-effect-free enforcement helpers backing the
 * global-agent filesystem tools (cyboflow_fs_read / _list / _grep).
 *
 * These functions take ALREADY-RESOLVED absolute paths (the handler
 * canonicalizes every target and every allowed root with realpathSync BEFORE
 * calling in) and answer scope / secret / glob / binary questions with no I/O
 * of their own, so they are exhaustively unit-testable in isolation. The
 * security-critical guarantees are:
 *
 *  - `isPathWithinRoots` — a path-separator-boundary prefix check (NOT a bare
 *    startsWith): `/a/bc` must NOT count as inside root `/a/b`. Combined with
 *    the handler realpath'ing the target first, this defeats the classic
 *    symlink escape (a symlink inside a scoped folder pointing at ~/.ssh
 *    resolves OUT of every root and is rejected).
 *  - `isSecretPath` — a deny-list applied even to in-scope paths so a
 *    prompt-injected read/grep cannot harvest credentials that merely happen to
 *    live inside a project folder.
 *
 * Directory listing is intentionally NOT secret-filtered — showing that a
 * `.env` file EXISTS is metadata, not content; only read/grep CONTENT access
 * runs through isSecretPath.
 */
import * as path from 'path';

// ---------------------------------------------------------------------------
// Caps (shared by the handler; exported so tests assert against the same values)
// ---------------------------------------------------------------------------

/** cyboflow_fs_read: max bytes returned before the `truncated` flag is set. */
export const FS_READ_MAX_BYTES = 256_000;
/** cyboflow_fs_list: max entries returned before `truncated`. */
export const FS_LIST_MAX_ENTRIES = 500;
/** cyboflow_fs_grep: default + hard-ceiling match count. */
export const FS_GREP_MAX_RESULTS = 200;
/** cyboflow_fs_grep: max files opened+scanned before the walk stops (truncated). */
export const FS_GREP_MAX_FILES = 20_000;
/** cyboflow_fs_grep: per-line text is truncated to this many chars. */
export const FS_GREP_MAX_LINE_LEN = 500;
/** cyboflow_fs_grep: files larger than this are skipped outright (grep reads
 * each candidate fully into memory — a giant in-scope log must not balloon
 * the main process). */
export const FS_GREP_MAX_FILE_BYTES = 2_000_000;
/** Bytes sampled from the head of a file for the NUL-byte binary heuristic. */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Directory basenames the grep walk never descends into. Kept out of the walk
 * both for cost (node_modules is enormous) and noise (build output / VCS
 * internals are never what a code-level question is about).
 */
export const GREP_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.venv',
  '__pycache__',
]);

// ---------------------------------------------------------------------------
// Scope containment
// ---------------------------------------------------------------------------

/**
 * True when `target` is inside (or equal to) at least one of `roots`, using a
 * path-separator-boundary prefix so a sibling with a shared name prefix does
 * NOT pass (`/a/bc` is not inside `/a/b`). BOTH arguments must already be
 * canonical absolute paths (realpathSync'd) — this function does no
 * resolution, so passing an unresolved path silently weakens the guarantee.
 */
export function isPathWithinRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(root + path.sep));
}

// ---------------------------------------------------------------------------
// Secret deny-list
// ---------------------------------------------------------------------------

/** Directory components anywhere in the path that mark a credential store. */
const SECRET_DIR_COMPONENTS: ReadonlySet<string> = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
]);

/** Exact basenames (case-insensitive) that are always secrets. */
const SECRET_EXACT_BASENAMES: ReadonlySet<string> = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.htpasswd',
  'credentials',
]);

/** Basename prefixes (case-insensitive) that mark private keys / dotenv variants. */
const SECRET_BASENAME_PREFIXES: readonly string[] = [
  '.env.',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
];

/** Basename suffixes (case-insensitive) for key/cert material. */
const SECRET_BASENAME_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx'];

/**
 * True when `filePath` names (or lives under a directory that names) a secret —
 * credentials, private keys, dotenv files. Case-insensitive on the basename.
 * Applied to CONTENT access (read + grep) even when the path is in scope, so a
 * `.env` that happens to sit inside a project folder is still refused.
 *
 * Takes a resolved absolute path; splits on the platform separator so a `.ssh`
 * ANYWHERE in the chain (not just the final component) is caught.
 */
export function isSecretPath(filePath: string): boolean {
  const components = filePath.split(path.sep).filter((c) => c.length > 0);
  for (const component of components) {
    if (SECRET_DIR_COMPONENTS.has(component)) return true;
  }
  const basename = path.basename(filePath).toLowerCase();
  if (basename.length === 0) return false;
  if (SECRET_EXACT_BASENAMES.has(basename)) return true;
  if (SECRET_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix))) return true;
  if (SECRET_BASENAME_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Binary sniff
// ---------------------------------------------------------------------------

/**
 * True when the sampled head of a file contains a NUL byte — the same cheap
 * "is this text?" heuristic git uses. The handler samples only the first
 * BINARY_SNIFF_BYTES; a NUL there means read refuses (`binary_file`) and grep
 * silently skips the file.
 */
export function bufferLooksBinary(head: Buffer): boolean {
  return head.includes(0);
}

// ---------------------------------------------------------------------------
// Basename glob (grep's optional `glob` filter — matches basenames, e.g. *.ts)
// ---------------------------------------------------------------------------

/**
 * Compile a shell-style basename glob (`*`, `?`, character classes are NOT
 * supported — only `*` and `?`) into an anchored, case-sensitive RegExp.
 * Returns null for an empty pattern (caller treats null as "no filter").
 */
export function compileBasenameGlob(glob: string): RegExp | null {
  if (glob.length === 0) return null;
  let re = '^';
  for (const ch of glob) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  return new RegExp(re);
}

/**
 * True when `basename` matches the compiled glob (or the glob is null — no
 * filter). A convenience wrapper so callers don't repeat the null check.
 */
export function matchesBasenameGlob(basename: string, compiled: RegExp | null): boolean {
  return compiled === null || compiled.test(basename);
}
