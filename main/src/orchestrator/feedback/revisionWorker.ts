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
  ARCH_DESIGN_HEADING_LINE_RE,
  ARCH_DESIGN_SECTION_HEADING,
  extractArchDesignSection,
  H2_LINE_RE,
  makeFenceState,
  replaceArchDesignSection,
} from '../../../../shared/types/artifacts';
import { hashDocumentText, type FeedbackAtype } from '../../../../shared/types/feedback';

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
  /**
   * The pending blocking decision review_item ids that were open when the user
   * clicked Send — the batch is BOUND to them: the pre-write revalidation
   * requires at least one of these EXACT gates to still be pending, so a
   * revision can never land under a different, later gate (e.g. sent at
   * approve-design, landing after the run advanced to approve-plan). In-memory
   * pass-through is sufficient — an in-flight revision never survives an app
   * restart (the boot sweep fails its batch).
   */
  gateReviewItemIds: string[];
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
  const { projectId, runId, batchId, atype, sourceRef, gateReviewItemIds, model, signal } = args;
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

    // 5. Validate the agent output + compose the new body. An arch-design revision
    //    whose returned document leaks content OUTSIDE the architecture section
    //    (extra unfenced H2s, a full-document echo) fails the batch rather than
    //    splicing the overflow into the idea body.
    const composed = composeNewBody(atype, originalBody, revisedDocument);
    if (!composed.ok) {
      await fail(composed.reason);
      return;
    }
    const newBody = composed.body;

    // Pre-write revalidation. The SDK revision query above can run for minutes; the
    // user may resolve the review gate (or the run may resume / complete) in the
    // meantime, at which point the document can no longer influence the decision.
    // Re-check the gate is still open immediately before the write, shrinking the
    // race window from minutes to milliseconds. A residual sub-millisecond TOCTOU
    // window is accepted by design: the body write itself is serialized through
    // TaskChangeRouter, and a post-resolve landing is voided (the optimistic
    // expectedVersion guard below still covers a concurrent body write).
    const gateStillOpen = revalidateGateStillOpen(db, runId, batchId, sourceRef, gateReviewItemIds);
    if (!gateStillOpen.ok) {
      await fail(gateStillOpen.reason);
      return;
    }

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

/** Warning appended to a comment whose anchor no longer matches the current document. */
const STALE_ANCHOR_NOTE =
  'Note: this excerpt no longer appears verbatim in the current document — the user ' +
  'highlighted an earlier version; apply the comment\'s intent to the closest matching content.';

function buildRevisionPrompt(
  atype: FeedbackAtype,
  originalBody: string,
  comments: CommentRow[],
): string {
  // The "current document" the anchors are checked against: the full body for a
  // spec revision, the extracted section for an arch revision (the text actually
  // rendered on that artifact tab, i.e. what the user highlighted).
  const currentDoc =
    atype === 'arch-design' ? extractArchDesignSection(originalBody) ?? '' : originalBody;
  const currentHash = hashDocumentText(currentDoc);

  const feedbackBlock = comments
    .map((c, i) => {
      const anchor = parseAnchor(c.anchor_json);
      const quote = anchor?.quote ?? '';
      const excerpt = quote
        ? quote
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : '> (no excerpt captured)';

      // Disambiguate a repeated excerpt (the anchor's 0-based occurrence rendered
      // 1-based) only when it actually appears more than once in the current doc.
      const occurrenceCount = quote.length > 0 ? countOccurrences(currentDoc, quote) : 0;
      const occurrenceNote =
        anchor && occurrenceCount > 1 ? ` (occurrence ${anchor.occurrence + 1} of the excerpt)` : '';

      // Warn when the anchor is stale: the quote is gone from the current document,
      // OR the body it was captured against (bodyHash) differs from the current one.
      const stale =
        (quote.length > 0 && !currentDoc.includes(quote)) ||
        (anchor !== null && anchor.bodyHash !== currentHash);

      let block = `### Comment ${i + 1}${occurrenceNote}\n${excerpt}`;
      if (stale) block += `\n${STALE_ANCHOR_NOTE}`;
      block += `\n\n${c.body.trim()}`;
      return block;
    })
    .join('\n\n');

  if (atype === 'arch-design') {
    const currentSection = currentDoc;
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

type ComposeResult = { ok: true; body: string } | { ok: false; reason: string };

/**
 * Compose the new idea body from the revised document.
 *  - arch-design → strictly validate the agent's output stays inside its section
 *    (see validateArchSection), then splice the revised (heading-led) section back
 *    into the original body via replaceArchDesignSection.
 *  - idea-spec → the revised full document, with the HOST-SIDE SAFETY SPLICE:
 *    the original architecture section (if any) is restored verbatim, so spec
 *    feedback can never mutate the architecture even if the agent misbehaved.
 */
function composeNewBody(atype: FeedbackAtype, originalBody: string, revisedDocument: string): ComposeResult {
  if (atype === 'arch-design') {
    const validated = validateArchSection(revisedDocument);
    if (!validated.ok) {
      return {
        ok: false,
        reason: 'the revision agent returned content outside the architecture section — feedback was not applied',
      };
    }
    return { ok: true, body: replaceArchDesignSection(originalBody, validated.section) };
  }

  // idea-spec safety splice: overwrite whatever arch section the agent produced
  // with the original one (append it if the revision dropped it entirely).
  const originalArch = extractArchDesignSection(originalBody);
  if (originalArch === null) return { ok: true, body: revisedDocument };
  const originalArchSection = `${ARCH_HEADING_LINE}\n\n${originalArch}`;
  return { ok: true, body: replaceArchDesignSection(revisedDocument, originalArchSection) };
}

/**
 * Strictly validate the arch-design agent's returned document so its content
 * cannot escape the architecture section once spliced (a section TERMINATOR after
 * the heading would push everything below it outside the architecture boundary).
 *
 * Uses the extractor's EXACT delimiter grammar (H2_LINE_RE / FENCE_LINE_RE
 * imported from shared/types/artifacts.ts — a delimiter the extractor honors but
 * this scan misses is a boundary escape; bare `##` was exactly such a gap):
 *  - Reject an UNTERMINATED fence outright — after splicing, an open fence would
 *    swallow the idea body's following H2 sections into the arch section, and a
 *    later replacement would then delete them.
 *  - Accept when the first non-blank line IS the arch heading AND no OTHER
 *    unfenced H2/terminator line exists — the document is the section verbatim.
 *  - When there is NO arch heading anywhere AND no terminator at all, the agent
 *    returned bare section content (benign) — prepend the canonical heading.
 *  - Any other shape (extra H2s, bare `##`, a full-document echo, heading not
 *    leading) → reject.
 */
function validateArchSection(doc: string): { ok: true; section: string } | { ok: false } {
  const lines = doc.split(/\r?\n/);
  const fence = makeFenceState();
  const h2Indices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence.handleLine(line)) continue;
    if (fence.inFence()) continue;
    if (H2_LINE_RE.test(line)) h2Indices.push(i);
  }
  // Unterminated fence (including a ``` opener "closed" only by a mismatched
  // ~~~ or a shorter run): unsafe to splice regardless of heading shape.
  if (fence.inFence()) return { ok: false };

  const firstNonBlankIdx = lines.findIndex((l) => l.trim().length > 0);
  const firstNonBlank = firstNonBlankIdx === -1 ? '' : lines[firstNonBlankIdx];
  const headingLed = ARCH_DESIGN_HEADING_LINE_RE.test(firstNonBlank);

  if (headingLed) {
    // The leading heading is itself an H2; accept only if it is the ONLY delimiter.
    const otherH2 = h2Indices.filter((idx) => idx !== firstNonBlankIdx);
    return otherH2.length === 0 ? { ok: true, section: doc } : { ok: false };
  }

  if (h2Indices.length === 0) {
    // Bare section content — no heading, no terminator to leak. Prepend the canonical heading.
    return { ok: true, section: `${ARCH_HEADING_LINE}\n\n${doc.replace(/^\s+/, '')}` };
  }

  return { ok: false };
}

/**
 * Pre-write gate revalidation (Fix 1 companion). Returns ok:false with a concise
 * human-readable reason when the review gate is no longer live for this batch —
 * the run left awaiting_review, the SPECIFIC gate(s) the batch was sent under all
 * resolved (a different later gate does NOT count: the document already had its
 * chance to influence the original decision), the idea was decomposed, or the
 * batch itself is no longer pending.
 */
function revalidateGateStillOpen(
  db: DatabaseLike,
  runId: string,
  batchId: string,
  sourceRef: string,
  gateReviewItemIds: string[],
): { ok: true } | { ok: false; reason: string } {
  const run = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as
    | { status: string }
    | undefined;
  if (!run || run.status !== 'awaiting_review') {
    return { ok: false, reason: 'the review gate resolved before the revision landed — feedback was not applied' };
  }

  // Bound-gate check: at least one of the EXACT gates open at send time must
  // still be pending. An empty binding never validates (fail closed).
  if (gateReviewItemIds.length === 0) {
    return { ok: false, reason: 'the review gate resolved before the revision landed — feedback was not applied' };
  }
  const placeholders = gateReviewItemIds.map(() => '?').join(', ');
  const gate = db
    .prepare(
      `SELECT 1 AS ok FROM review_items
        WHERE id IN (${placeholders}) AND status = 'pending' AND blocking = 1
        LIMIT 1`,
    )
    .get(...gateReviewItemIds) as { ok: number } | undefined;
  if (!gate) {
    return { ok: false, reason: 'the review gate resolved before the revision landed — feedback was not applied' };
  }

  const idea = db.prepare('SELECT decomposed_at FROM ideas WHERE id = ?').get(sourceRef) as
    | { decomposed_at: string | null }
    | undefined;
  if (!idea || idea.decomposed_at !== null) {
    return { ok: false, reason: 'the idea was decomposed before the revision landed — feedback was not applied' };
  }

  const batch = db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(batchId) as
    | { status: string }
    | undefined;
  if (!batch || batch.status !== 'pending') {
    return { ok: false, reason: 'the feedback batch was canceled before the revision landed — feedback was not applied' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Parse the stored anchor_json into a full CommentAnchor (quote + occurrence +
 * bodyHash), or null when the column is malformed/incomplete. The prompt uses the
 * occurrence to disambiguate repeats and the bodyHash to detect a stale anchor.
 */
function parseAnchor(anchorJson: string): { quote: string; occurrence: number; bodyHash: string } | null {
  try {
    const parsed = JSON.parse(anchorJson) as { quote?: unknown; occurrence?: unknown; bodyHash?: unknown };
    if (
      typeof parsed.quote !== 'string' ||
      typeof parsed.occurrence !== 'number' ||
      typeof parsed.bodyHash !== 'string'
    ) {
      return null;
    }
    return { quote: parsed.quote, occurrence: parsed.occurrence, bodyHash: parsed.bodyHash };
  } catch {
    return null;
  }
}

/** Count non-overlapping occurrences of `needle` in `haystack` (empty needle → 0). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
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
