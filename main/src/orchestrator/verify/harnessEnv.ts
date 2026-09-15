/**
 * harnessEnv — the EXECUTION environment the verification harness hands to
 * everything it starts (F3 / RC4 of
 * docs/proposals/visual-verification-brittleness-fixes.md).
 *
 * WHY THIS EXISTS. A verification agent used to run with a WORSE environment
 * than a terminal. `verificationAgentQuery` merges the harness env over
 * `process.env`, and in a packaged app `process.env.PATH` is the GUI LOGIN PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — so the agent's Bash, `$VERIFY_DRIVER`, and
 * every serve child underneath them saw no `pnpm`, no `npx`, and frequently no
 * `node` at all (transcript vr_addb4401: `pnpm: command not found`; the 9/01
 * `spawn npx ENOENT` ×3 that left the dep mirror cold and classified a purely
 * environmental failure as `ambiguous`). `getShellPath()` — what EVERY other
 * spawn seam in this app already uses (`claudeCodeManager.resolveSpawnPath`) —
 * was used by nothing under `verify/`. This module is that seam for the verify
 * side, plus the `NODE_PATH` the bundled driver needs.
 *
 * IT DOES NOT WIDEN THE SANDBOX. Restoring PATH says which binaries EXIST, not
 * which commands the agent may run: the §7.2 dependency guard (`canUseTool`) and
 * the hermetic `settingSources: []` / `mcpServers: {}` options are separate
 * controls and are untouched by anything here.
 *
 * TWO DELIBERATE SHAPES:
 *
 *   1. The shell lookup shells out (`execSync` of a login shell), but this
 *      module adds NO cache of its own: `getShellPath()` memoizes internally and
 *      `configManager` clears THAT cache when the user's `additionalPaths`
 *      change, so a second layer here would make verification the only seam
 *      deaf to a PATH fix until the app restarts (round-2 review).
 *   2. `utils/shellPath` is imported LAZILY inside the default resolver. That
 *      module requires the Electron module at top level (in a try/catch), and both
 *      importers here — `verificationAgentRunner` and `depPreparer` — are
 *      Electron-free by construction and unit-tested as such.
 */
import { access } from 'node:fs/promises';
import { delimiter, dirname, join, parse } from 'node:path';

/** Resolves the user's real login-shell PATH. Injectable so tests never shell out. */
export type ShellPathResolver = () => Promise<string>;

/**
 * The default {@link ShellPathResolver} — `utils/shellPath.getShellPath()`, the
 * SAME implementation `claudeCodeManager.resolveSpawnPath` spawns sessions with,
 * so "what the verification agent sees" and "what a session sees" cannot drift.
 * Lazily imported (see the module header).
 */
export const defaultResolveShellPath: ShellPathResolver = async () => {
  const { getShellPath } = await import('../../utils/shellPath');
  return getShellPath();
};

export interface HarnessPathOptions {
  /**
   * The node executable the harness resolved (`deps.resolveNode()`); its
   * DIRECTORY is prepended when the login-shell PATH does not already contain
   * it. Omit when the caller resolves none — `depPreparer` never does, and the
   * login-shell PATH is the whole point there (it is where `npx` lives).
   */
  nodeExecutable?: string | null;
  /** Login-shell PATH source; defaults to {@link defaultResolveShellPath}. */
  resolveShellPath?: ShellPathResolver;
  /** Used when the lookup throws or answers empty; defaults to `process.env.PATH`. */
  fallbackPath?: string;
}

/**
 * Prepend the resolved node's own directory to `pathValue` when it is absent.
 *
 * A node resolved by `findNodeExecutable` can live somewhere no login shell
 * exports (an nvm version dir the user's shell only activates on demand, or —
 * in a packaged app — the Electron binary standing in as node), and the driver
 * wrapper invokes it by ABSOLUTE path. Prepending its directory is for what the
 * driver and the serve command spawn NEXT: a child that shells `node`, or an
 * `npx`, must find the same runtime the harness picked rather than an older one
 * earlier on PATH.
 */
export function prependNodeDir(pathValue: string, nodeExecutable: string | null): string {
  if (nodeExecutable === null || nodeExecutable.length === 0) return pathValue;
  const dir = dirname(nodeExecutable);
  // `dirname` answers '.' for a bare name (`node`) — a PATH-relative invocation
  // that by definition adds nothing, and '.' on PATH is its own hazard.
  if (dir.length === 0 || dir === '.') return pathValue;
  const entries = pathValue.split(delimiter).filter((e) => e.length > 0);
  if (entries.includes(dir)) return pathValue;
  return [dir, ...entries].join(delimiter);
}

/**
 * The PATH the harness exports: the user's login-shell PATH with the resolved
 * node's directory in front.
 *
 * NEVER THROWS. A shell lookup that fails degrades to `process.env.PATH` —
 * which is exactly today's behavior, so the worst case of this fix is the
 * status quo rather than a new failure mode.
 */
export async function resolveHarnessPath(opts: HarnessPathOptions = {}): Promise<string> {
  const resolve = opts.resolveShellPath ?? defaultResolveShellPath;
  const fallback = opts.fallbackPath ?? process.env.PATH ?? '';
  let base: string;
  try {
    base = (await resolve()).trim();
  } catch {
    base = '';
  }
  if (base.length === 0) base = fallback;
  return prependNodeDir(base, opts.nodeExecutable ?? null);
}

/**
 * The shared {@link resolveHarnessPath} for callers with no dependency-injection
 * seam of their own (`depPreparer.defaultDepExec`).
 *
 * DELIBERATELY NOT MEMOIZED (round-2 review, F3 / RC4). `getShellPath()` already
 * caches internally, and `configManager` CLEARS that cache when the config
 * changes — which is how a user's `additionalPaths` entry (the documented escape
 * hatch for "pnpm not found") reaches every spawn seam without an app restart. A
 * second cache on top bought one saved `execSync` on the very first call and, in
 * exchange, made verification the ONE seam that ignored that escape hatch for
 * the life of the process. After the first call this is a function call.
 */
export function sharedHarnessPath(): Promise<string> {
  return resolveHarnessPath();
}

/**
 * The key to write a PATH value under in `env`, matched CASE-INSENSITIVELY
 * against what the process already carries (round-2 review, F3 / RC4).
 *
 * Windows environment names are case-insensitive to the OS, but Node exposes
 * them with their ORIGINAL case — `Path`, as the registry spells it. A plain
 * object spread (`{ ...process.env, PATH: value }`) does NOT collide with that:
 * the merged map ends up carrying BOTH `Path` (the GUI value) and `PATH` (ours),
 * and which one `CreateProcess` hands the child is not something to depend on.
 * `prependCodexPathToEnvironment` already resolves the key this way for exactly
 * this reason; this is the same rule for the verify seams.
 */
export function pathEnvKey(base: NodeJS.ProcessEnv = process.env): string {
  return Object.keys(base).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

/** The marker that proves a `node_modules` is the one the DRIVER can load from. */
const PLAYWRIGHT_MARKER = join('node_modules', 'playwright', 'package.json');

const defaultExists = async (absPath: string): Promise<boolean> => {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * CYBOFLOW'S OWN `node_modules` root — the `NODE_PATH` the bundled driver needs
 * to `require('playwright')`, or `null` when this build has none.
 *
 * Found by walking UP from the compiled driver's own path to the nearest
 * directory carrying `node_modules/playwright/package.json` (dev:
 * `<repo>/node_modules`). It is deliberately NOT the snapshot's or the live
 * worktree's `node_modules` (Codex #4): the driver contract at `driverCli.ts:7`
 * is "under the app's own node runtime, the target project needs no playwright
 * install", and a deliverable-controlled playwright would BE the driver's
 * implementation — a verification the code under test can rewrite.
 *
 * PACKAGED BUILDS: `asarUnpack` in `package.json` unpacks the driver JS AND
 * `node_modules/playwright*` (a plain-node child cannot read inside
 * `app.asar`, so anything the driver requires must be a real file), and the
 * walk from the unpacked driver finds `app.asar.unpacked/node_modules`. Should
 * that entry ever be dropped, the walk answers `null` — honest (an unset
 * NODE_PATH beats one pointing at an unreadable directory) but the driver's
 * `import('playwright')` then fails, masked as "CDP endpoint not reachable".
 */
export async function resolveHarnessNodePath(
  driverCliPath: string,
  exists: (absPath: string) => Promise<boolean> = defaultExists,
): Promise<string | null> {
  const root = parse(driverCliPath).root;
  let dir = dirname(driverCliPath);
  // Bounded by reaching the filesystem root (where `dirname` becomes a fixed
  // point) — never by a depth guess, which would silently stop working the
  // first time someone installs the app one directory deeper.
  for (;;) {
    if (await exists(join(dir, PLAYWRIGHT_MARKER))) return join(dir, 'node_modules');
    const parent = dirname(dir);
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}
