/**
 * workflowBundleWriter — installs/removes a workflow's invokable bundle (phase
 * subagents + optional slash-commands) into a worktree's `.claude/` directory for
 * BOTH CLI substrates (IDEA-013 rung-(ii): structure-as-invokable-units).
 *
 * The real `claude` REPL (interactive substrate) natively auto-loads
 * `.claude/agents/*.md` and `.claude/commands/*.md` at session start, and the SDK
 * substrate auto-discovers the same files via `settingSources: ['user','project']`
 * (claudeCodeManager.ts buildSdkOptions). So writing these files pre-spawn is the
 * SINGLE substrate-shared mechanism that turns each heavy workflow phase into a
 * delegable `cyboflow-<phase>` subagent (its own context window) instead of a
 * paragraph of prompt prose — no CLI flag and no SDK `agents` option required.
 *
 * Namespacing + merge-safety is the load-bearing property (the worktree IS the
 * user's project, so their own `.claude/commands` / `.claude/agents` may be
 * present): every written file is prefixed `cyboflow-`, and `remove` strips ONLY
 * `cyboflow-*.md` files — user files are never touched. `write` clears the prior
 * cyboflow set first, so the on-disk bundle always equals the CURRENT bundle (a
 * command removed from the asset set does not linger across a respawn). This
 * mirrors interactiveSettingsWriter's selective merge-safe write/remove contract.
 *
 * Standalone invariant (mirrors interactiveSettingsWriter / interactiveMcpEnabler):
 * only `fs`/`path` — no 'electron', no 'better-sqlite3', no service imports. The
 * bundle CONTENT is resolved upstream by `resolveWorkflowBundle` (a pure fs
 * reader); this writer only places/removes the resolved files.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LoggerLike } from '../../../orchestrator/types';
import type { WorkflowBundle } from '../../../orchestrator/workflows/workflowBundle';
import type { BundleFs, BundlePathApi } from './bundleFs';

/** The cyboflow filename namespace. Every written file is `cyboflow-<name>.md`. */
const CYBOFLOW_PREFIX = 'cyboflow-';

/** The `.claude/` subdirectories a bundle writes into, with their file extension. */
const COMMANDS_DIR = ['.claude', 'commands'] as const;
const AGENTS_DIR = ['.claude', 'agents'] as const;
/**
 * Dynamic-workflow stage scripts. `.js`, NOT `.md` — which is why the
 * write/remove helpers take the extension as a parameter instead of hardcoding
 * it: a remove scoped to `.md` would leave generated scripts behind forever,
 * and one scoped to "any cyboflow-* file" could delete a user's own.
 */
const WORKFLOWS_DIR = ['.claude', 'workflows'] as const;

const MARKDOWN_EXT = '.md';
const SCRIPT_EXT = '.js';

/**
 * The LOCAL {@link BundleFs}: today's sync node:fs calls, one-for-one (`writeFile` with no mode = node's default,
 * exactly what the sync writer does). Lives here, beside the sync writer it mirrors, because this file already
 * carries the fs-ratchet exemption.
 */
export const localBundleFs: BundleFs = {
  path,
  exists: async (p) => fs.existsSync(p),
  readFile: async (p) => fs.readFileSync(p, 'utf8'),
  writeFile: async (p, data, mode) => {
    if (mode === undefined) fs.writeFileSync(p, data, 'utf8');
    else fs.writeFileSync(p, data, { encoding: 'utf8', mode });
  },
  mkdirp: async (p) => {
    fs.mkdirSync(p, { recursive: true });
  },
  readdir: async (p) => fs.readdirSync(p),
  unlink: async (p) => fs.unlinkSync(p),
};

/** One bundle file's target path, or null when the name would escape `dir` (separator / `..`). */
function bundleTarget(pathApi: BundlePathApi, dir: string, name: string, ext: string): string | null {
  const target = pathApi.join(dir, `${CYBOFLOW_PREFIX}${name}${ext}`);
  return pathApi.dirname(pathApi.resolve(target)) === pathApi.resolve(dir) ? target : null;
}

/** A cyboflow-generated file of this extension (never a user file). */
function isCyboflowEntry(pathApi: BundlePathApi, entry: string, ext: string): boolean {
  return entry.startsWith(CYBOFLOW_PREFIX) && pathApi.extname(entry).toLowerCase() === ext;
}

const EMPTY_BUNDLE: WorkflowBundle = { commands: [], agents: [], scripts: [] };

/** The three bundle directories in write order, with the files each one gets. */
function bundleDirs(bundle: WorkflowBundle): Array<{ dirParts: readonly string[]; files: WorkflowBundle['commands']; ext: string }> {
  return [
    { dirParts: COMMANDS_DIR, files: bundle.commands, ext: MARKDOWN_EXT },
    { dirParts: AGENTS_DIR, files: bundle.agents, ext: MARKDOWN_EXT },
    { dirParts: WORKFLOWS_DIR, files: bundle.scripts, ext: SCRIPT_EXT },
  ];
}

/** Absolute paths written by a single `write` call (for logging / assertions). */
export interface WorkflowBundleWriteResult {
  commandPaths: string[];
  agentPaths: string[];
  scriptPaths: string[];
}

export class WorkflowBundleWriter {
  /**
   * @param logger Optional structured logger. Passed through for write/skip/remove
   *   diagnostics (CODE-PATTERNS.md optional-logger rule: pass it, don't omit it).
   */
  constructor(private readonly logger?: LoggerLike) {}

  /**
   * Install `bundle` into `<worktreePath>/.claude/commands` and `.../agents`,
   * each file written as `cyboflow-<name>.md`. Clears the prior cyboflow set first
   * so a removed asset does not linger. Returns the written paths, or `null` when
   * the bundle is empty (nothing to install — no dirs are created).
   */
  write(worktreePath: string, bundle: WorkflowBundle): WorkflowBundleWriteResult | null {
    // Reconcile FIRST, unconditionally — including for an empty bundle. An early
    // return before remove() would strand the previous run's cyboflow files on
    // disk whenever the bundle went non-empty -> empty (e.g. stage-script
    // dispatch switched off, or a flow edited down to no fan-out), leaving a
    // stale `.claude/workflows/cyboflow-*.js` that the CLI would still resolve
    // by name. The on-disk cyboflow set must always equal the CURRENT bundle.
    this.remove(worktreePath);

    if (bundle.commands.length === 0 && bundle.agents.length === 0 && bundle.scripts.length === 0) {
      this.logger?.debug('[Cyboflow WorkflowBundle] empty bundle — prior set cleared, nothing to install', {
        worktreePath,
      });
      return null;
    }

    const commandPaths = this.writeFiles(worktreePath, COMMANDS_DIR, bundle.commands, MARKDOWN_EXT);
    const agentPaths = this.writeFiles(worktreePath, AGENTS_DIR, bundle.agents, MARKDOWN_EXT);
    const scriptPaths = this.writeFiles(worktreePath, WORKFLOWS_DIR, bundle.scripts, SCRIPT_EXT);

    this.logger?.debug('[Cyboflow WorkflowBundle] installed bundle', {
      worktreePath,
      commands: commandPaths.length,
      agents: agentPaths.length,
      scripts: scriptPaths.length,
    });
    return { commandPaths, agentPaths, scriptPaths };
  }

  /**
   * Remove ONLY the cyboflow-namespaced files (`cyboflow-*.md`) from the worktree's
   * `.claude/commands` and `.claude/agents`, preserving every user file. A no-op
   * when the directories are absent or carry no cyboflow files. Idempotent.
   */
  remove(worktreePath: string): void {
    const removed =
      this.removeFiles(worktreePath, COMMANDS_DIR, MARKDOWN_EXT) +
      this.removeFiles(worktreePath, AGENTS_DIR, MARKDOWN_EXT) +
      this.removeFiles(worktreePath, WORKFLOWS_DIR, SCRIPT_EXT);
    if (removed > 0) {
      this.logger?.debug('[Cyboflow WorkflowBundle] removed bundle files', { worktreePath, removed });
    }
  }

  /**
   * {@link write} through a {@link BundleFs} port (an SSH environment's worktree). The final on-disk set is the
   * same as write()'s, but the order is RECONCILE — write the current files first, THEN unlink every stale
   * `cyboflow-*` file not in this bundle — instead of clear-then-write: over ssh each call is a round trip, and a
   * clear-first would leave a sibling fan-out lane (same shared worktree, still mid-turn) without its
   * `/cyboflow-<phase>` files for seconds. A failed write rejects (the caller is fail-soft); a failed prune
   * unlink is logged and skipped, like remove().
   */
  async writeVia(port: BundleFs, worktreePath: string, bundle: WorkflowBundle): Promise<WorkflowBundleWriteResult | null> {
    const dirs = bundleDirs(bundle);
    const written: string[][] = [];
    for (const { dirParts, files, ext } of dirs) {
      written.push(await this.writeFilesVia(port, worktreePath, dirParts, files, ext));
    }
    let removed = 0;
    for (const [i, { dirParts, ext }] of dirs.entries()) {
      removed += await this.removeFilesVia(port, worktreePath, dirParts, ext, new Set(written[i]));
    }
    const [commandPaths, agentPaths, scriptPaths] = written;
    if (commandPaths.length === 0 && agentPaths.length === 0 && scriptPaths.length === 0) {
      this.logger?.debug('[Cyboflow WorkflowBundle] empty bundle via port — prior set cleared, nothing to install', {
        worktreePath,
        removed,
      });
      return null;
    }
    this.logger?.debug('[Cyboflow WorkflowBundle] installed bundle via port', {
      worktreePath,
      commands: commandPaths.length,
      agents: agentPaths.length,
      scripts: scriptPaths.length,
      removed,
    });
    return { commandPaths, agentPaths, scriptPaths };
  }

  /** {@link remove} through a {@link BundleFs} port. Never rejects; returns the count removed. */
  async removeVia(port: BundleFs, worktreePath: string): Promise<number> {
    let removed = 0;
    for (const { dirParts, ext } of bundleDirs(EMPTY_BUNDLE)) {
      removed += await this.removeFilesVia(port, worktreePath, dirParts, ext, new Set());
    }
    if (removed > 0) {
      this.logger?.debug('[Cyboflow WorkflowBundle] removed bundle files via port', { worktreePath, removed });
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async writeFilesVia(
    port: BundleFs,
    worktreePath: string,
    dirParts: readonly string[],
    files: WorkflowBundle['commands'],
    ext: string,
  ): Promise<string[]> {
    if (files.length === 0) return [];
    const dir = port.path.join(worktreePath, ...dirParts);
    await port.mkdirp(dir);
    const written: string[] = [];
    for (const file of files) {
      const target = bundleTarget(port.path, dir, file.name, ext);
      if (target === null) {
        this.logger?.warn(
          `[Cyboflow WorkflowBundle] refusing to write outside ${dirParts.join('/')}: ${file.name}`,
        );
        continue;
      }
      await port.writeFile(target, file.content);
      written.push(target);
    }
    return written;
  }

  /** Unlink every `cyboflow-*<ext>` in the dir whose path is not in `keep`. Fail-soft; returns the count removed. */
  private async removeFilesVia(
    port: BundleFs,
    worktreePath: string,
    dirParts: readonly string[],
    ext: string,
    keep: ReadonlySet<string>,
  ): Promise<number> {
    const dir = port.path.join(worktreePath, ...dirParts);
    let entries: string[];
    try {
      entries = await port.readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!isCyboflowEntry(port.path, entry, ext)) continue;
      const target = port.path.join(dir, entry);
      if (keep.has(target)) continue;
      try {
        await port.unlink(target);
        removed += 1;
      } catch (err) {
        this.logger?.warn(
          `[Cyboflow WorkflowBundle] failed to remove ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return removed;
  }

  private writeFiles(
    worktreePath: string,
    dirParts: readonly string[],
    files: WorkflowBundle['commands'],
    ext: string,
  ): string[] {
    if (files.length === 0) return [];
    const dir = path.join(worktreePath, ...dirParts);
    fs.mkdirSync(dir, { recursive: true });

    const written: string[] = [];
    for (const file of files) {
      const target = bundleTarget(path, dir, file.name, ext);
      // Containment check: a logical name is caller-supplied and, for rendered
      // stage scripts, derives from free-form workflow/step ids. A name carrying
      // a separator or `..` would place the file outside its `.claude` dir (or
      // over a user file elsewhere in the tree). Skip rather than throw — one bad
      // name must not abort the whole bundle install.
      if (target === null) {
        this.logger?.warn(
          `[Cyboflow WorkflowBundle] refusing to write outside ${dirParts.join('/')}: ${file.name}`,
        );
        continue;
      }
      fs.writeFileSync(target, file.content, 'utf8');
      written.push(target);
    }
    return written;
  }

  /**
   * Unlink every `cyboflow-*<ext>` in the dir. Returns the count removed. Fail-soft.
   * The extension is scoped so a user's own `.js` beside our `.md` (or vice
   * versa) is never touched, and so generated scripts are actually reclaimed.
   */
  private removeFiles(worktreePath: string, dirParts: readonly string[], ext: string): number {
    const dir = path.join(worktreePath, ...dirParts);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!isCyboflowEntry(path, entry, ext)) continue;
      try {
        fs.unlinkSync(path.join(dir, entry));
        removed += 1;
      } catch (err) {
        this.logger?.warn(
          `[Cyboflow WorkflowBundle] failed to remove ${entry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return removed;
  }
}
