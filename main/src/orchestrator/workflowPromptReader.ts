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
import { parseMarkdownFrontmatter } from './markdownFrontmatter';

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

  const { frontmatter, body } = parseMarkdownFrontmatter(raw);
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    throw new WorkflowPromptReadError(
      `readWorkflowPrompt: workflow body is empty at ${workflowPath}`,
    );
  }

  const systemPromptAppend = frontmatter['system_prompt_append'] ?? '';
  return { prompt: trimmedBody, systemPromptAppend };
}

