/**
 * workflowBundle — resolves a workflow's co-located `.claude/` command + agent
 * bundle from app-bundled assets (IDEA-013 rung-(ii): structure-as-invokable-units).
 *
 * A built-in flow's prose `.md` (e.g. `planner.md`) is paired with a sibling
 * directory of the SAME basename holding its invokable phase units:
 *
 *   workflows/planner.md                 ← the (slim) orchestrator prose
 *   workflows/planner/commands/*.md      ← one slash-command per phase
 *   workflows/planner/agents/*.md        ← optional subagents for isolated side-work
 *
 * Resolving the bundle from the run's `workflow_path` (the SAME `.md` the prompt
 * body is read from) — rather than keying it by workflow NAME — means any flow
 * that reuses a built-in's prose automatically gets that built-in's bundle, and a
 * custom flow with its own self-contained `.md` (no sibling bundle dir) simply
 * resolves to an EMPTY bundle (fail-soft) and is unaffected.
 *
 * Each returned file carries a LOGICAL `name` (the asset filename minus `.md`);
 * the cyboflow `cyboflow-` namespace prefix and the `.claude/commands|agents`
 * target paths are owned by `WorkflowBundleWriter`, not here. This module is a
 * pure fs reader — no DB, IPC, or Electron imports — mirroring
 * `workflowPromptReader.ts` so it stays testable in plain Node/vitest.
 *
 * Path resolution mirrors `builtInWorkflows.ts` / `database.ts`: assets are
 * resolved relative to the resolved `workflow_path`, which `copy:assets` places
 * under `dist/main/src/orchestrator/workflows/` at build time.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

/**
 * One bundle file with its LOGICAL name (asset filename minus `.md`). The writer
 * prepends the `cyboflow-` namespace and the `.claude/commands|agents` target dir.
 */
export interface WorkflowBundleFile {
  /** Asset filename without extension, e.g. `implement` (becomes `/cyboflow-implement`). */
  name: string;
  /** Raw markdown content (YAML frontmatter + body) written verbatim. */
  content: string;
}

/** A workflow's resolved invokable bundle: phase slash-commands + optional subagents. */
export interface WorkflowBundle {
  commands: WorkflowBundleFile[];
  agents: WorkflowBundleFile[];
}

/** An empty bundle — the fail-soft result when no sibling bundle dir exists. */
const EMPTY_BUNDLE: WorkflowBundle = { commands: [], agents: [] };

/**
 * Resolve the command + agent bundle co-located with a workflow's prose `.md`.
 *
 * @param workflowPath The run's `workflows.workflow_path` (the `.md` the prompt
 *   body is read from). `null`/`undefined`/empty resolves to an empty bundle.
 * @returns The bundle, or an empty bundle when the path is absent or has no
 *   sibling `<basename>/commands` | `<basename>/agents` directories. Never throws.
 */
export function resolveWorkflowBundle(workflowPath: string | null | undefined): WorkflowBundle {
  if (typeof workflowPath !== 'string' || workflowPath.trim().length === 0) {
    return EMPTY_BUNDLE;
  }

  // `…/workflows/planner.md` → `…/workflows/planner`
  const bundleRoot = join(dirname(workflowPath), basename(workflowPath, '.md'));

  return {
    commands: readBundleDir(join(bundleRoot, 'commands')),
    agents: readBundleDir(join(bundleRoot, 'agents')),
  };
}

/**
 * Read every `*.md` file in `dir` into a `WorkflowBundleFile[]`, sorted by name
 * for deterministic ordering. Fail-soft: a missing/unreadable dir yields `[]`, and
 * an individual unreadable file is skipped rather than aborting the whole read.
 */
function readBundleDir(dir: string): WorkflowBundleFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const files: WorkflowBundleFile[] = [];
  for (const entry of entries.sort()) {
    if (extname(entry).toLowerCase() !== '.md') continue;
    const full = join(dir, entry);
    try {
      if (!statSync(full).isFile()) continue;
      files.push({ name: basename(entry, '.md'), content: readFileSync(full, 'utf-8') });
    } catch {
      // Skip an individual unreadable entry; never abort the whole bundle.
    }
  }
  return files;
}
