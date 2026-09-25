/**
 * dependencyGuardShim — the "Codex live dependency guard (F8)" PATH shim
 * (docs/proposals/runbook-optional-verification.md "A1.4 Explore guardrails" →
 * "Codex live dependency guard (F8)", the "Preferred" mechanism). The Claude
 * `canUseTool` handler (verificationAgentQuery.makeDependencyCommandCanUseTool)
 * has no Codex equivalent — the Codex app-server runs `danger-full-access` with
 * no per-call approval hook (codexVerificationAgentQuery.ts's module doc) — so
 * on THAT runtime the §7.2 dependency-mutation rule has to intercept the
 * dependency-manager BINARIES themselves rather than the shell call.
 *
 * `materializeDependencyGuardShim` (re)builds a small `bin/` directory holding
 * one wrapper per {@link DEPENDENCY_GUARD_SHIM_TOOLS} entry. A wrapper first
 * runs a NODE SCRIPT — `guard.js`, written alongside the wrappers — that tests
 * the invoked tool's ARGV with {@link isForbiddenDependencyInvocation} and
 * either denies it (stderr + exit 126) or prints the path of the REAL tool
 * binary found further down PATH; the wrapper then `exec`s that binary itself. The
 * caller (a sibling module — see verificationAgentRunner.ts) prepends the
 * returned `binDir` onto the agent's PATH for BOTH runtimes and in EVERY mode
 * (defence in depth, not a sandbox — see below): on Claude it sits behind
 * `canUseTool`, which already denies the same commands, so the shim there is
 * redundant-on-purpose; on Codex it is the ONLY guard.
 *
 * WHY ARGV AND NOT THE REGEX, AND WHY NOT INSIDE PACKAGE SCRIPTS
 * (adversarial-review fix). Because pnpm/npm only PREPEND `node_modules/.bin`
 * to a script's PATH, the shim also sits in front of every package-manager
 * call NESTED inside a project script — calls no enqueue check or
 * `canUseTool` ever saw, in pinned and legacy requests too. The first cut ran
 * `FORBIDDEN_DEP_COMMAND_PATTERN` over the joined argv there, and that
 * pattern's `\b` verb match accepts `:`, `-` and `.` as boundaries, so a
 * `build` script running `pnpm ci:prepare`, a `pnpm update-snapshots` or a
 * `bun up.ts` exited 126 and failed a proven runbook's build — a failed
 * verdict charged to the lane for a harness change. Two changes close that:
 *
 *   - guard.js matches the ARGV the tool actually received, not a joined
 *     string: the first positional token (skipping flags, and the operand of
 *     each tool's known value-taking flags) must EQUAL a dependency verb, and
 *     a launcher (`npx`, `pnpm exec|dlx`, `bun x`) is followed into what it
 *     launches (`playwright install`, `electron-rebuild`, a nested manager).
 *     `FORBIDDEN_DEP_COMMAND_PATTERN` stays the source of truth for the
 *     SHELL-STRING seams (enqueue, `canUseTool`); a test pins the two agree on
 *     every canonical forbidden form.
 *   - A package-manager call made BY a package script (`npm_lifecycle_event`
 *     set — pnpm, npm, yarn and bun all export it to a script's children) is
 *     not enforced at all: the agent never composed it, a `prebuild: npm ci`
 *     is the project's own business, and the snapshot's dependency CLONE
 *     already contains whatever it writes (the same clone that absorbed it
 *     before the shim existed). The one value that does NOT count is the one
 *     the HOST process itself carried when it materialized the shim — cyboflow
 *     launched by `pnpm dev` has `npm_lifecycle_event=dev` in its own env, and
 *     the agent inherits it — so {@link isPackageScriptChild} ignores an
 *     (event, package.json) pair equal to the host's. An agent that SETS the
 *     variable itself walks past the guard, like the absolute-path bypass
 *     below: defence in depth, not a sandbox.
 *
 * WHY THE WRAPPER EXECS AND guard.js ONLY DECIDES (adversarial-review fix). The
 * first cut had guard.js `spawnSync` the real tool and wait on it. Because the
 * shim sits in front of EVERY mode — pinned and legacy included — that changed
 * what a caller's pid IS: `pnpm dev & … kill $!` (or `timeout 60 pnpm build`)
 * signalled the guard's node process, which died without forwarding, and the
 * real dev server or build carried on ORPHANED — holding the leased port past
 * the request, the "stale server on a leased port" failure class
 * verification-setup-flow §1 names. It also kept one extra interpreter resident
 * per package-manager level for a serve's whole life. Execing from the wrapper
 * makes the shim invisible once it has allowed a command: the real tool
 * replaces the wrapper's own process, so pid, signals, exit status and the
 * process tree are exactly what they were without it, and `nodeEnv` (set only
 * on the guard's own invocation) never reaches the real tool at all — while a
 * value the CALLER already carried for one of those keys reaches it untouched,
 * as it did before the shim existed.
 *
 * NEVER RESOLVES TO A SHIM (adversarial-review fix). Skipping only the guard's
 * OWN bin dir is not enough: with two shim dirs on PATH (a verified cyboflow
 * instance inheriting the outer request's PATH, then materializing its own), A
 * resolves to B's wrapper, B to A's, forever — measured at ~20 new processes a
 * second under the first cut, an unbounded chain. Every wrapper therefore
 * carries {@link DEPENDENCY_GUARD_SHIM_MARKER} and guard.js skips any candidate
 * whose head carries it, whatever directory (or symlinked spelling of one) it
 * sits in.
 *
 * WHY A GENERATED, STANDALONE guard.js AND NOT A REPO IMPORT AT RUNTIME. The
 * wrapper invokes `guard.js` through a bare interpreter path (the Electron
 * binary running `ELECTRON_RUN_AS_NODE=1`, or a real node — whichever
 * `nodePath` names), with no `NODE_PATH` and no cwd guarantee, so `require()`
 * of anything but a Node builtin would be a broken relative path the moment
 * this ships packaged. `guard.js` is therefore generated TEXT: Node builtins
 * only (`fs`/`path`), and the pieces of logic that must never drift from
 * their live TypeScript originals — {@link isForbiddenDependencyInvocation},
 * {@link isPackageScriptChild} and {@link forbiddenDepCommandDenyMessage} —
 * are SERIALIZED into the generated file at materialize time via each
 * function's own `.toString()`, which is safe only because every one of them
 * is self-contained (see their docs). The request's execution mode and the
 * host's inherited lifecycle pair are embedded as JSON constants, so the deny
 * wording matches the mode's contract (explore → `unverifiable`, otherwise
 * `build_failed`).
 *
 * DEFENCE IN DEPTH, NOT A SANDBOX — say so plainly, per A1.4: an absolute path
 * to the real binary (`/opt/homebrew/bin/pnpm install`), or a launcher that
 * skips PATH lookup entirely (`node node_modules/.bin/pnpm install`), bypasses
 * this shim completely. It raises the bar for the command an agent reaches for
 * BY NAME; it is not a containment boundary — `snapshotProvisioner`'s dependency
 * CLONE (dependencyCommandGuard.ts's module doc) is that boundary. It is also
 * only as early on PATH as the shell that finally runs the command leaves it: a
 * LOGIN shell re-sorts PATH on macOS (`/etc/zprofile`'s path_helper and a
 * `brew shellenv` in `~/.zprofile` put `/usr/local/bin` / `/opt/homebrew/bin`
 * back in front), so a package manager installed there wins over the shim in
 * any shell started with `-l`. Codex's shell tool uses login shells by default,
 * so codexVerificationAgentQuery starts its thread with
 * `allow_login_shell: false` (measured on 0.153.3 to keep this dir in front).
 *
 * WINDOWS: returns `{ binDir: null }` without writing anything — there is no
 * POSIX `sh`/`exec` to build the wrappers from, so that platform has no shim
 * (the design names none for it).
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { escapeShellArg } from '../../utils/shellEscape';
import type { VerificationExecutionMode } from '../../../../shared/types/visualVerification';
import { forbiddenDepCommandDenyMessage } from './dependencyCommandGuard';

/**
 * The dependency-manager (+ ecosystem-adjacent) binaries the shim intercepts.
 * `npx` is included because `npx playwright install` is one of the
 * dependency pattern's matched forms (dependencyCommandGuard.ts, family 2) — routing
 * `npx` itself through the shim catches it whatever npx resolves `playwright`
 * to, the same way the pattern matches it runner-agnostically today.
 */
export const DEPENDENCY_GUARD_SHIM_TOOLS = ['pnpm', 'npm', 'yarn', 'bun', 'pod', 'swift', 'npx'] as const;

/** Filename of the generated guard script, written alongside the tool wrappers. */
const GUARD_SCRIPT_NAME = 'guard.js';

/**
 * The line every generated wrapper carries in its head, and the one guard.js
 * looks for so it never resolves a tool to ANOTHER shim's wrapper (see the
 * module doc's "never resolves to a shim").
 */
export const DEPENDENCY_GUARD_SHIM_MARKER = 'cyboflow-dependency-guard-shim-wrapper-v1';

export interface DependencyGuardShimOptions {
  /** Parent directory; the shim's `bin/` subdirectory is (re)created under it. */
  dir: string;
  /** The interpreter every wrapper runs guard.js with (a real node, or Electron running ELECTRON_RUN_AS_NODE=1). */
  nodePath: string;
  /**
   * Extra env vars the wrapper sets (via `env KEY=VALUE ...`) on the guard's
   * OWN invocation only — e.g. `{ ELECTRON_RUN_AS_NODE: '1' }` when `nodePath`
   * is Electron. They never reach the real tool: the wrapper execs that with
   * its own, unmodified environment (see the module doc).
   */
  nodeEnv: Record<string, string>;
  /**
   * The request's resolved execution mode; guard.js words its deny by it
   * (forbiddenDepCommandDenyMessage — explore routes to `unverifiable`).
   * Absent ⇒ the pinned wording.
   */
  executionMode?: VerificationExecutionMode;
  /**
   * The environment the agent INHERITS from this process — read for the host's
   * own `npm_lifecycle_event`/`npm_package_json` pair (see the module doc's
   * package-script exemption). Defaults to `process.env`; a test seam.
   */
  hostEnv?: NodeJS.ProcessEnv;
}

/** The host's inherited package-script identity, which {@link isPackageScriptChild} must NOT treat as a script child. */
export interface HostLifecycle {
  event: string;
  packageJson: string;
}

/** The host's own lifecycle pair from `env`, or `null` when the host was not itself started by a package script. */
export function hostLifecycleFromEnv(env: NodeJS.ProcessEnv): HostLifecycle | null {
  const event = env.npm_lifecycle_event;
  if (!event) return null;
  return { event, packageJson: env.npm_package_json ?? '' };
}

/**
 * Does this invocation of a package manager (`tool`, with exactly the `args`
 * it received) mutate dependencies? The argv twin of
 * FORBIDDEN_DEP_COMMAND_PATTERN (dependencyCommandGuard.ts) for the shim —
 * see the module doc for why the shim cannot use the pattern itself.
 *
 * The SUBCOMMAND is the first positional token: flags are skipped, and so is
 * the operand of each tool's known value-taking flags (`pnpm -C dir install`,
 * `npm --prefix x ci`, `yarn --cwd x add`) — `--flag=value` is one token. It
 * must EQUAL a dependency verb, so `pnpm ci:prepare`, `pnpm update-snapshots`,
 * `bun up.ts` and `pnpm run install` (a script named install) are all
 * allowed. Launchers are followed into what they launch: `npx` /
 * `pnpm|npm|yarn exec` / `pnpm|yarn dlx` / `bun x` denying `playwright
 * install`, `electron-rebuild` (or `@electron/rebuild`), `electron-builder
 * install-app-deps`, or another package manager's own dependency verb; `yarn
 * workspace <name> <verb>` is followed the same way. `pod install|update|repo
 * update` and `swift package resolve|update` keep their exact verb tuples.
 * Unknown value flags are treated as boolean — the cheap direction here is a
 * miss (the snapshot clone contains it), never a failed build.
 *
 * STANDALONE ON PURPOSE: dependencyGuardScriptBody embeds this
 * function's `.toString()` into guard.js, so it closes over nothing but its
 * own parameters (it recurses only by its own name, which the embedding
 * preserves).
 */
export function isForbiddenDependencyInvocation(tool: string, args: readonly string[]): boolean {
  const managers = ['pnpm', 'npm', 'yarn', 'bun'];
  const depVerbs = ['install', 'i', 'ci', 'add', 'rebuild', 'up', 'update', 'upgrade'];
  const launchVerbs = ['exec', 'dlx', 'x'];
  const valueFlagsByTool: Record<string, string[]> = {
    pnpm: ['-C', '--dir', '--filter', '-F', '--filter-prod', '--reporter', '--loglevel'],
    npm: ['--prefix', '-w', '--workspace', '--loglevel', '--userconfig'],
    yarn: ['--cwd'],
    bun: ['--cwd', '-c', '--config', '--filter'],
    npx: ['-p', '--package', '-c', '--call'],
    pod: ['--project-directory'],
    swift: ['--package-path', '--scratch-path', '--build-path', '-c', '--configuration'],
  };
  const valueFlags = valueFlagsByTool[tool] ?? [];
  // Index of the first positional token at or after `from`, or -1.
  const positional = (from: number): number => {
    let i = from;
    while (i < args.length) {
      const token = args[i];
      if (token === '--') return i + 1 < args.length ? i + 1 : -1;
      if (!token.startsWith('-')) return i;
      i += valueFlags.includes(token) ? 2 : 1;
    }
    return -1;
  };
  const at = (i: number): string => (i >= 0 ? args[i] : '');
  // What a launcher launches, starting at positional index `i`.
  const launchesForbidden = (i: number): boolean => {
    if (i < 0) return false;
    // Drop a version suffix (`playwright@1.44`, `@electron/rebuild@3`) and a path prefix.
    const spec = args[i].replace(/(.)@.*$/, '$1');
    const name = spec.startsWith('@') ? spec : spec.split('/').pop() ?? spec;
    const sub = at(positional(i + 1));
    if (name === 'playwright' || name === '@playwright/test') return sub === 'install';
    if (name === 'electron-rebuild' || name === '@electron/rebuild') return true;
    if (name === 'electron-builder') return sub === 'install-app-deps';
    if (managers.includes(name)) return isForbiddenDependencyInvocation(name, args.slice(i + 1));
    return false;
  };

  const first = positional(0);
  const verb = at(first);
  if (tool === 'npx') return launchesForbidden(first);
  if (tool === 'pod') return verb === 'install' || verb === 'update' || (verb === 'repo' && at(positional(first + 1)) === 'update');
  if (tool === 'swift') {
    const sub = at(positional(first + 1));
    return verb === 'package' && (sub === 'resolve' || sub === 'update');
  }
  if (!managers.includes(tool)) return false;
  if (depVerbs.includes(verb)) return true;
  if (tool === 'yarn' && verb === 'workspace') {
    const workspaceName = positional(first + 1);
    return workspaceName >= 0 && isForbiddenDependencyInvocation(tool, args.slice(workspaceName + 1));
  }
  if (launchVerbs.includes(verb)) return launchesForbidden(positional(first + 1));
  return false;
}

/**
 * Is this guard invocation a package-manager call made BY a package script
 * (and therefore exempt — see the module doc)? True when `npm_lifecycle_event`
 * is set and the (event, `npm_package_json`) pair is NOT the one the host
 * itself inherited (`host`), which every process under a `pnpm dev`-launched
 * cyboflow carries without being a script child at all.
 *
 * STANDALONE ON PURPOSE: embedded into guard.js by `.toString()`.
 */
export function isPackageScriptChild(env: Record<string, string | undefined>, host: HostLifecycle | null): boolean {
  const event = env.npm_lifecycle_event;
  if (!event) return false;
  const packageJson = env.npm_package_json ?? '';
  return !(host !== null && host.event === event && host.packageJson === packageJson);
}

/**
 * Build the generated `guard.js` TEXT. Pure and side-effect-free so it is
 * independently testable (the tests inspect its output without touching the
 * filesystem).
 *
 * Every embedded value is produced via `JSON.stringify` (never hand-quoted) so
 * the generated source is always syntactically valid regardless of what the
 * mode, the host's lifecycle pair or the marker happen to contain.
 *
 * ITS STDOUT IS THE WRAPPER'S INPUT: on an allowed command it writes the real
 * binary's ABSOLUTE path and nothing else (an unanchored `pnpm` would send the
 * wrapper's `exec` back through PATH — and into this shim). Both streams are
 * written with `fs.writeSync`, never `process.stdout.write`, because the
 * latter is asynchronous on a macOS pipe and `process.exit` may cut it short.
 */
export function dependencyGuardScriptBody(
  opts: { executionMode?: VerificationExecutionMode; hostLifecycle?: HostLifecycle | null } = {},
): string {
  const markerLiteral = JSON.stringify(DEPENDENCY_GUARD_SHIM_MARKER);
  const modeLiteral = JSON.stringify(opts.executionMode ?? null);
  const hostLifecycleLiteral = JSON.stringify(opts.hostLifecycle ?? null);
  // Self-contained by contract (see each function's doc) — each `.toString()`
  // is a complete, standalone function declaration we can drop into the
  // generated file verbatim, with nothing else to carry along.
  const denyMessageFnSource = forbiddenDepCommandDenyMessage.toString();
  const matcherFnSource = isForbiddenDependencyInvocation.toString();
  const scriptChildFnSource = isPackageScriptChild.toString();

  const notFoundPrefix = JSON.stringify('dependencyGuardShim: "');
  const notFoundSuffix = JSON.stringify('" not found on PATH (outside the guard shim directory)\n');
  const trailingNewline = JSON.stringify('\n');

  return [
    '#!/usr/bin/env node',
    "'use strict';",
    '// AUTO-GENERATED by dependencyGuardShim.materializeDependencyGuardShim — do not edit by hand.',
    '// Defence in depth, not a sandbox: an absolute path to the real binary, or',
    '// `node node_modules/.bin/<tool>`, bypasses this guard entirely.',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    `const SHIM_MARKER = ${markerLiteral};`,
    `const EXECUTION_MODE = ${modeLiteral};`,
    `const HOST_LIFECYCLE = ${hostLifecycleLiteral};`,
    '',
    denyMessageFnSource,
    '',
    matcherFnSource,
    '',
    scriptChildFnSource,
    '',
    'const tool = process.argv[2];',
    'const toolArgs = process.argv.slice(3);',
    '',
    '// A call made BY a package script is the project\'s own, not the agent\'s (module doc).',
    'if (!isPackageScriptChild(process.env, HOST_LIFECYCLE) && isForbiddenDependencyInvocation(tool, toolArgs)) {',
    "  const cmd = [tool, ...toolArgs].join(' ');",
    `  fs.writeSync(2, forbiddenDepCommandDenyMessage(cmd, EXECUTION_MODE === null ? undefined : EXECUTION_MODE) + ${trailingNewline});`,
    '  process.exit(126);',
    '}',
    '',
    '// Resolve the REAL binary: scan PATH, skipping this shim\'s own bin dir and',
    '// any candidate that is itself a shim wrapper (ANY shim — see the module doc',
    '// of dependencyGuardShim.ts). First executable regular file wins.',
    'const shimBinDir = path.dirname(process.argv[1]);',
    "const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);",
    '',
    'function isExecutableFile(candidate) {',
    '  try {',
    '    if (!fs.statSync(candidate).isFile()) return false;',
    '    fs.accessSync(candidate, fs.constants.X_OK);',
    '    return true;',
    '  } catch (err) {',
    '    return false;',
    '  }',
    '}',
    '',
    'function isShimWrapper(candidate) {',
    '  let fd = null;',
    '  try {',
    "    fd = fs.openSync(candidate, 'r');",
    '    const head = Buffer.alloc(512);',
    '    const read = fs.readSync(fd, head, 0, head.length, 0);',
    "    return head.toString('utf8', 0, read).includes(SHIM_MARKER);",
    '  } catch (err) {',
    '    return false;',
    '  } finally {',
    '    if (fd !== null) { try { fs.closeSync(fd); } catch (err) { /* best-effort */ } }',
    '  }',
    '}',
    '',
    'let realBin = null;',
    'for (const dir of pathDirs) {',
    '  if (path.resolve(dir) === shimBinDir) continue;',
    '  const candidate = path.resolve(dir, tool);',
    '  if (isExecutableFile(candidate) && !isShimWrapper(candidate)) { realBin = candidate; break; }',
    '}',
    '',
    'if (!realBin) {',
    `  fs.writeSync(2, ${notFoundPrefix} + tool + ${notFoundSuffix});`,
    '  process.exit(127);',
    '}',
    '',
    'fs.writeSync(1, realBin);',
    'process.exit(0);',
    '',
  ].join('\n');
}

/**
 * Build one tool wrapper's POSIX `sh` body. Two statements: run the guard
 * (`env <nodeEnv...> "<nodePath>" "<guardScriptPath>" <tool> "$@"`) in a
 * command substitution, exiting with ITS status when it refuses (126) or finds
 * nothing (127); otherwise `exec` the real binary it printed with the SAME
 * arguments, so the real tool takes over this process (see the module doc for
 * why that, and not a spawn from guard.js). Every embedded path (and every
 * `KEY=VALUE` env assignment) is quoted with {@link escapeShellArg}, which
 * handles spaces and embedded single quotes correctly — `nodePath` in
 * particular is NOT guaranteed to be a clean path (an Electron install under
 * "Application Support", a dev checkout with a space in it). The `"$@"`
 * expansions and `"$real"` are deliberate, unescaped POSIX parameter
 * expansions and must stay that way. The second line is
 * {@link DEPENDENCY_GUARD_SHIM_MARKER}, which guard.js keys on.
 */
export function dependencyGuardWrapperBody(
  tool: string,
  nodePath: string,
  guardScriptPath: string,
  nodeEnv: Record<string, string>,
): string {
  const envAssignments = Object.entries(nodeEnv).map(([key, value]) => escapeShellArg(`${key}=${value}`));
  const guardParts = [
    'env',
    ...envAssignments,
    escapeShellArg(nodePath),
    escapeShellArg(guardScriptPath),
    escapeShellArg(tool),
  ];
  return [
    '#!/bin/sh',
    `# ${DEPENDENCY_GUARD_SHIM_MARKER} (generated by cyboflow dependencyGuardShim.ts; do not edit)`,
    `real=$(${guardParts.join(' ')} "$@") || exit $?`,
    'exec "$real" "$@"',
    '',
  ].join('\n');
}

/**
 * (Re)materialize the PATH shim under `opts.dir/bin` (mode 0700) and return its
 * path, or `{ binDir: null }` on Windows (nothing written) or any fs failure
 * (LOG-FREE by design — the caller logs, since it also knows whether the
 * failure matters for the request at hand).
 *
 * IDEMPOTENT: the bin dir is removed and recreated on every call, so calling
 * this twice for the same `dir` (a new request reusing a run-scoped shim dir,
 * or a nodeEnv that changed between calls) always rewrites cleanly rather than
 * layering stale wrappers under new ones.
 */
export async function materializeDependencyGuardShim(
  opts: DependencyGuardShimOptions,
): Promise<{ binDir: string | null }> {
  if (process.platform === 'win32') return { binDir: null };

  // ABSOLUTE, whatever `dir` was: the wrappers embed the guard path, and
  // guard.js compares its own dir against PATH entries resolved from ANY cwd.
  const binDir = resolve(opts.dir, 'bin');
  try {
    await rm(binDir, { recursive: true, force: true });
    await mkdir(binDir, { recursive: true, mode: 0o700 });

    const guardScriptPath = join(binDir, GUARD_SCRIPT_NAME);
    const guardScript = dependencyGuardScriptBody({
      executionMode: opts.executionMode,
      hostLifecycle: hostLifecycleFromEnv(opts.hostEnv ?? process.env),
    });
    await writeFile(guardScriptPath, guardScript, 'utf8');
    await chmod(guardScriptPath, 0o755);

    for (const tool of DEPENDENCY_GUARD_SHIM_TOOLS) {
      const wrapperPath = join(binDir, tool);
      await writeFile(wrapperPath, dependencyGuardWrapperBody(tool, opts.nodePath, guardScriptPath, opts.nodeEnv), 'utf8');
      await chmod(wrapperPath, 0o755);
    }

    return { binDir };
  } catch {
    return { binDir: null };
  }
}
