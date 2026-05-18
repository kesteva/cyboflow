/**
 * workflowPromptReader.ts
 *
 * Pure synchronous helper that reads a SoloFlow workflow `.md` file and
 * returns the two strings needed to launch a Claude Code session:
 *
 *   - `prompt`            — the trimmed body below the YAML frontmatter block,
 *                           used as the user-facing prompt (the `.md` body is
 *                           the canonical prompt source per IDEA-018 Q2).
 *   - `systemPromptAppend`— the optional `system_prompt_append` frontmatter
 *                           field; empty string when absent.
 *
 * @see RunExecutor (TASK-640) — the caller that passes these through to
 *   `ClaudeCodeManager.spawnCliProcess()`.  `prompt` maps to `options.prompt`;
 *   `systemPromptAppend` maps to the `append` slot composed by
 *   `ClaudeCodeManager.composeSystemPromptAppend` at
 *   `main/src/services/panels/claude/claudeCodeManager.ts:413-416`.
 *
 * No DB, IPC, or Electron imports — intentional; keep this module testable in
 * plain Node/vitest without bootstrapping the full app.
 */

import { readFileSync } from 'fs';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class WorkflowPromptReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'WorkflowPromptReadError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface WorkflowPrompt {
  prompt: string;
  systemPromptAppend: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a workflow `.md` file and extract the prompt body and optional
 * `system_prompt_append` frontmatter field.
 *
 * @throws {WorkflowPromptReadError} if the file cannot be read (ENOENT, EACCES,
 *   …) or if the body below the frontmatter is empty / whitespace-only.
 */
export function readWorkflowPrompt(workflowPath: string): WorkflowPrompt {
  let raw: string;
  try {
    raw = readFileSync(workflowPath, 'utf-8');
  } catch (err) {
    throw new WorkflowPromptReadError(
      `readWorkflowPrompt: could not read workflow file at ${workflowPath}`,
      { cause: err },
    );
  }

  const { frontmatter, body } = splitFrontmatter(raw);
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    throw new WorkflowPromptReadError(
      `readWorkflowPrompt: workflow body is empty at ${workflowPath}`,
    );
  }

  const systemPromptAppend = frontmatter['system_prompt_append'] ?? '';
  return { prompt: trimmedBody, systemPromptAppend };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split a markdown string into its frontmatter key-value map and the body
 * that follows.  Handles both LF and CRLF line endings.  Strips surrounding
 * single/double quotes from values.  When no `--- … ---` block is found the
 * entire input is returned as the body with an empty frontmatter map.
 *
 * This mirrors the regex shape used by `WorkflowRegistry.parseFrontmatter`
 * (`main/src/orchestrator/workflowRegistry.ts:174-192`) so CRLF behaviour and
 * quote-stripping behave identically across both parsers.  A shared parser was
 * intentionally NOT extracted here — see the "Hardest Decision" section in the
 * TASK-641 plan.
 */
function splitFrontmatter(md: string): { frontmatter: Record<string, string>; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { frontmatter: {}, body: md };
  }
  const fmBlock = match[1];
  const body = md.slice(match[0].length);
  const out: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return { frontmatter: out, body };
}
