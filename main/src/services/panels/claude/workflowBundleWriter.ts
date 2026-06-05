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

/** The cyboflow filename namespace. Every written file is `cyboflow-<name>.md`. */
const CYBOFLOW_PREFIX = 'cyboflow-';

/** The two `.claude/` subdirectories a bundle writes into. */
const COMMANDS_DIR = ['.claude', 'commands'] as const;
const AGENTS_DIR = ['.claude', 'agents'] as const;

/** Absolute paths written by a single `write` call (for logging / assertions). */
export interface WorkflowBundleWriteResult {
  commandPaths: string[];
  agentPaths: string[];
}

export class WorkflowBundleWriter {
  /**
   * @param logger Optional structured logger. Passed through for write/skip/remove
   *   diagnostics (CLAUDE.md optional-logger rule: pass it, don't omit it).
   */
  constructor(private readonly logger?: LoggerLike) {}

  /**
   * Install `bundle` into `<worktreePath>/.claude/commands` and `.../agents`,
   * each file written as `cyboflow-<name>.md`. Clears the prior cyboflow set first
   * so a removed asset does not linger. Returns the written paths, or `null` when
   * the bundle is empty (nothing to install — no dirs are created).
   */
  write(worktreePath: string, bundle: WorkflowBundle): WorkflowBundleWriteResult | null {
    if (bundle.commands.length === 0 && bundle.agents.length === 0) {
      this.logger?.debug('[Cyboflow WorkflowBundle] empty bundle — nothing to install', { worktreePath });
      return null;
    }

    // Clear any prior cyboflow set first so the on-disk bundle == the current one.
    this.remove(worktreePath);

    const commandPaths = this.writeFiles(worktreePath, COMMANDS_DIR, bundle.commands);
    const agentPaths = this.writeFiles(worktreePath, AGENTS_DIR, bundle.agents);

    this.logger?.debug('[Cyboflow WorkflowBundle] installed bundle', {
      worktreePath,
      commands: commandPaths.length,
      agents: agentPaths.length,
    });
    return { commandPaths, agentPaths };
  }

  /**
   * Remove ONLY the cyboflow-namespaced files (`cyboflow-*.md`) from the worktree's
   * `.claude/commands` and `.claude/agents`, preserving every user file. A no-op
   * when the directories are absent or carry no cyboflow files. Idempotent.
   */
  remove(worktreePath: string): void {
    const removed =
      this.removeFiles(worktreePath, COMMANDS_DIR) + this.removeFiles(worktreePath, AGENTS_DIR);
    if (removed > 0) {
      this.logger?.debug('[Cyboflow WorkflowBundle] removed bundle files', { worktreePath, removed });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private writeFiles(
    worktreePath: string,
    dirParts: readonly string[],
    files: WorkflowBundle['commands'],
  ): string[] {
    if (files.length === 0) return [];
    const dir = path.join(worktreePath, ...dirParts);
    fs.mkdirSync(dir, { recursive: true });

    const written: string[] = [];
    for (const file of files) {
      const target = path.join(dir, `${CYBOFLOW_PREFIX}${file.name}.md`);
      fs.writeFileSync(target, file.content, 'utf8');
      written.push(target);
    }
    return written;
  }

  /** Unlink every `cyboflow-*.md` in the dir. Returns the count removed. Fail-soft. */
  private removeFiles(worktreePath: string, dirParts: readonly string[]): number {
    const dir = path.join(worktreePath, ...dirParts);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.startsWith(CYBOFLOW_PREFIX) || path.extname(entry).toLowerCase() !== '.md') continue;
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
