/**
 * revisionWorker — runs ONE in-artifact feedback batch end to end (IDEA-033).
 *
 * The host fires this (detached) after `send-batch` mints a pending batch while a
 * planner/ship run is parked at its human gate. It loads the batch's comments and
 * the owning idea body, asks a scoped read-only SDK "revision agent" to rewrite the
 * target document faithfully+minimally, applies a HOST-SIDE safety splice (spec
 * feedback may never mutate the architecture section), writes the revised body
 * through the TaskChangeRouter chokepoint (the artifact tabs re-derive from
 * `ideas.body`, so the UI updates live), and flips the batch applied → comments
 * 'addressed'. ANY failure flips the batch failed (the FeedbackRouter then reverts
 * its comments to editable drafts). The run itself stays parked and untouched.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * any concrete service in main/src/services/*. Every impure collaborator (the SDK
 * query, the feedback chokepoint, the entity-write chokepoint) is injected — the
 * concrete singletons satisfy the narrow interfaces structurally at the wiring
 * seam. `node:fs` (worktree existence probe) mirrors evalWorker and is allowed.
 *
 * `runRevisionBatch` NEVER throws — every path resolves, flipping the batch to a
 * terminal status. The caller fires it as a void promise.
 */
import { existsSync } from 'node:fs';
import type { DatabaseLike, LoggerLike } from '../types';
import type { RevisionQueryFn } from './revisionQuery';
import {
  ARCH_DESIGN_SECTION_HEADING,
  extractArchDesignSection,
  replaceArchDesignSection,
} from '../../../../shared/types/artifacts';
import type { FeedbackAtype } from '../../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Injected collaborator interfaces (narrow slices, injected at the wiring seam)
// ---------------------------------------------------------------------------

/**
 * Narrow slice of FeedbackRouter needed to close a batch out. The concrete
 * FeedbackRouter.apply overloads satisfy this structurally. Return typed
 * `Promise<unknown>` — the worker never inspects the flip result.
 */
export interface RevisionFeedbackRouterLike {
  apply(
    projectId: number,
    change:
      | { op: 'batch-applied'; batchId: string }
      | { op: 'batch-failed'; batchId: string; error: string },
  ): Promise<unknown>;
}

/**
 * The single field-update the revision write needs on an idea. Matches the
 * relevant slice of TaskChangeRouter.applyChange's TaskChange input.
 */
export interface RevisionTaskChange {
  actor: 'orchestrator';
  entityType: 'idea';
  taskId: string;
  fields: { body: string };
  runId: string;
  expectedVersion: number;
}

/**
 * Narrow slice of TaskChangeRouter.applyChange. The concrete applyChange is
 * assignable to this (its richer TaskChange param + richer return both satisfy).
 * Wired as `(p, c) => TaskChangeRouter.getInstance().applyChange(p, c)`.
 */
export interface ApplyTaskChangeLike {
  (projectId: number, change: RevisionTaskChange): Promise<{ taskId: string }>;
}

export interface RevisionWorkerDeps {
  db: DatabaseLike;
  queryFn: RevisionQueryFn;
  feedbackRouter: RevisionFeedbackRouterLike;
  applyTaskChange: ApplyTaskChangeLike;
  logger?: LoggerLike;
}

export interface RunRevisionBatchArgs {
  projectId: number;
  runId: string;
  batchId: string;
  atype: FeedbackAtype;
  /** The owning idea id (feedback source_ref IS the idea id). */
  sourceRef: string;
  /** Optional model pin for the revision agent (undefined → SDK default). */
  model?: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Structured-output schema + parse
// ---------------------------------------------------------------------------

/** JSON-schema the revision agent's structured output is enforced against. */
export const REVISION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['revisedDocument'],
  properties: {
    revisedDocument: { type: 'string' },
    notes: { type: 'string' },
  },
};

/** Canonical arch-design heading line the worker prepends / validates against. */
const ARCH_HEADING_LINE = `## ${ARCH_DESIGN_SECTION_HEADING}`;

/** Tolerant (case-insensitive) match of the arch-design heading as a whole line. */
const ARCH_HEADING_LINE_RE = new RegExp(`^##[ \\t]+${ARCH_DESIGN_SECTION_HEADING}[ \\t]*$`, 'i');

interface IdeaRow {
  body: string | null;
  version: number;
}

interface CommentRow {
  anchor_json: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Run one feedback batch to a terminal state. Never throws — resolves after the
 * batch is flipped applied or failed.
 */
export async function runRevisionBatch(
  args: RunRevisionBatchArgs,
  deps: RevisionWorkerDeps,
): Promise<void> {
  const { projectId, runId, batchId, atype, sourceRef, model, signal } = args;
  const { db, queryFn, feedbackRouter, applyTaskChange, logger } = deps;

  const fail = async (reason: string): Promise<void> => {
    try {
      await feedbackRouter.apply(projectId, { op: 'batch-failed', batchId, error: reason });
    } catch (err) {
      logger?.error('[revisionWorker] batch-failed flip threw (swallowed)', {
        batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    // 1. Load the idea + the batch's sent comments.
    const idea = db
      .prepare('SELECT body, version FROM ideas WHERE id = ?')
      .get(sourceRef) as IdeaRow | undefined;
    const originalBody = idea?.body ?? '';
    if (!idea || originalBody.trim().length === 0) {
      await fail('the idea document could not be loaded for revision');
      return;
    }

    const comments = db
      .prepare(
        `SELECT anchor_json, body FROM feedback_comments
          WHERE batch_id = ? AND status = 'sent'
          ORDER BY created_at ASC`,
      )
      .all(batchId) as CommentRow[];
    if (comments.length === 0) {
      await fail('no sent comments were found for this feedback batch');
      return;
    }

    // 2. Build the prompt.
    const prompt = buildRevisionPrompt(atype, originalBody, comments);

    // 3. cwd = the run's worktree, only if it is still on disk (mirrors evalWorker:
    //    a fast human merge can tear it down; the prompt is self-contained anyway).
    const run = db
      .prepare('SELECT worktree_path FROM workflow_runs WHERE id = ?')
      .get(runId) as { worktree_path: string | null } | undefined;
    const cwd =
      run?.worktree_path && existsSync(run.worktree_path) ? run.worktree_path : undefined;

    // 4. Run the revision agent.
    const raw = await queryFn({
      prompt,
      schema: REVISION_OUTPUT_SCHEMA,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(signal ? { signal } : {}),
    });

    const revisedDocument = parseRevisedDocument(raw);
    if (revisedDocument === null) {
      await fail('the revision agent returned no usable revised document');
      return;
    }

    // 5. Validate + compose the new body.
    const newBody = composeNewBody(atype, originalBody, revisedDocument);

    // 6. Write through the chokepoint with the step-1 version as the optimistic
    //    staleness guard (a concurrent body edit → concurrency rejection → fail).
    try {
      await applyTaskChange(projectId, {
        actor: 'orchestrator',
        entityType: 'idea',
        taskId: sourceRef,
        fields: { body: newBody },
        runId,
        expectedVersion: idea.version,
      });
    } catch (err) {
      if (isConcurrencyError(err)) {
        await fail('the document changed during revision — resend to try again');
        return;
      }
      await fail(concise(err, 'writing the revised document failed'));
      return;
    }

    // 7. Success → flip the batch applied (comments → addressed).
    await feedbackRouter.apply(projectId, { op: 'batch-applied', batchId });
    logger?.info('[revisionWorker] batch applied', { batchId, runId, atype, sourceRef });
  } catch (err) {
    logger?.warn('[revisionWorker] unexpected failure (batch failed)', {
      batchId,
      error: err instanceof Error ? err.message : String(err),
    });
    await fail(concise(err, 'the revision failed unexpectedly'));
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildRevisionPrompt(
  atype: FeedbackAtype,
  originalBody: string,
  comments: CommentRow[],
): string {
  const feedbackBlock = comments
    .map((c, i) => {
      const quote = parseQuote(c.anchor_json);
      const excerpt = quote
        ? quote
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : '> (no excerpt captured)';
      return `### Comment ${i + 1}\n${excerpt}\n\n${c.body.trim()}`;
    })
    .join('\n\n');

  if (atype === 'arch-design') {
    const currentSection = extractArchDesignSection(originalBody) ?? '';
    return [
      'You are the cyboflow revision agent. A human reviewed the ARCHITECTURE DESIGN',
      'of an idea while its planner/ship run is parked at a review gate, and left the',
      'feedback below. Apply that feedback to the architecture-design section.',
      '',
      'You may Read/Grep/Glob the codebase at the working directory to ground your',
      'claims in real files and existing patterns — do not invent hypothetical ones.',
      '',
      '## Full idea document (context — do NOT return this)',
      '',
      originalBody,
      '',
      '## The document under revision — the `## Architecture design` section',
      '',
      currentSection.length > 0 ? currentSection : '(the section is currently empty)',
      '',
      '## Feedback to apply',
      '',
      feedbackBlock,
      '',
      '## Instructions',
      '',
      '- Apply the feedback faithfully and MINIMALLY: the smallest coherent revision.',
      "  Do NOT rewrite or restructure content the feedback doesn't touch.",
      '- Stay at design altitude — decisions and their rationale, not implementation',
      '  detail. Keep it human-reviewable (roughly 60–120 lines).',
      `- Return ONLY the revised architecture-design section. Its FIRST line MUST be`,
      `  exactly "${ARCH_HEADING_LINE}".`,
      '- Put the full revised section in the `revisedDocument` field of your structured',
      '  output; put any short summary of what you changed in the optional `notes` field.',
    ].join('\n');
  }

  // idea-spec
  return [
    'You are the cyboflow revision agent. A human reviewed the IDEA SPEC document',
    'while its planner/ship run is parked at a review gate, and left the feedback',
    'below. Apply that feedback to the document.',
    '',
    'You may Read/Grep/Glob the codebase at the working directory to ground your',
    'claims in real files and existing patterns — do not invent hypothetical ones.',
    '',
    '## The document under revision (the full idea spec)',
    '',
    originalBody,
    '',
    '## Feedback to apply',
    '',
    feedbackBlock,
    '',
    '## Instructions',
    '',
    '- Apply the feedback faithfully and MINIMALLY: the smallest coherent revision.',
    "  Do NOT rewrite or restructure content the feedback doesn't touch.",
    '- Preserve any `SCOPE:`, `UI_PROTOTYPE:`, and `ARCH_DESIGN:` flag lines EXACTLY',
    '  as they appear.',
    `- Do NOT modify the "${ARCH_HEADING_LINE}" section — leave it byte-for-byte as it`,
    '  is (architecture changes are made through the architecture document, not here).',
    '- Return the FULL revised document in the `revisedDocument` field of your',
    '  structured output; put any short summary of what you changed in `notes`.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Result validation + body composition
// ---------------------------------------------------------------------------

/** Pull a non-empty `revisedDocument` string out of the structured output, or null. */
function parseRevisedDocument(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const doc = (raw as { revisedDocument?: unknown }).revisedDocument;
  if (typeof doc !== 'string' || doc.trim().length === 0) return null;
  return doc;
}

/**
 * Compose the new idea body from the revised document.
 *  - arch-design → splice the revised (heading-led) section back into the original
 *    body via replaceArchDesignSection.
 *  - idea-spec → the revised full document, with the HOST-SIDE SAFETY SPLICE:
 *    the original architecture section (if any) is restored verbatim, so spec
 *    feedback can never mutate the architecture even if the agent misbehaved.
 */
function composeNewBody(atype: FeedbackAtype, originalBody: string, revisedDocument: string): string {
  if (atype === 'arch-design') {
    const section = ensureArchHeading(revisedDocument);
    return replaceArchDesignSection(originalBody, section);
  }

  // idea-spec safety splice: overwrite whatever arch section the agent produced
  // with the original one (append it if the revision dropped it entirely).
  const originalArch = extractArchDesignSection(originalBody);
  if (originalArch === null) return revisedDocument;
  const originalArchSection = `${ARCH_HEADING_LINE}\n\n${originalArch}`;
  return replaceArchDesignSection(revisedDocument, originalArchSection);
}

/**
 * Guarantee the revised arch section leads with the canonical heading line. If the
 * agent returned the body without it, prepend the heading rather than failing.
 */
function ensureArchHeading(section: string): string {
  const firstNonBlank = section.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  if (ARCH_HEADING_LINE_RE.test(firstNonBlank)) return section;
  return `${ARCH_HEADING_LINE}\n\n${section.replace(/^\s+/, '')}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseQuote(anchorJson: string): string {
  try {
    const parsed = JSON.parse(anchorJson) as { quote?: unknown };
    return typeof parsed.quote === 'string' ? parsed.quote : '';
  } catch {
    return '';
  }
}

/** Structural check for a TaskChangeError-shaped optimistic-concurrency rejection. */
function isConcurrencyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'concurrency'
  );
}

/** A concise, human-readable failure reason — never a raw stack trace. */
function concise(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const firstLine = msg.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine.slice(0, 300) : fallback;
}
