/**
 * verdictDelivery — wires the VerificationScheduler's `onVerdict` hook to the
 * EXISTING router chokepoints (no new table, no direct UPDATEs). It is the
 * concrete side-effect the P5 scheduler stubbed behind the injected `OnVerdict`
 * callback (see verificationScheduler.ts §"Verdict delivery"). The scheduler
 * itself stays electron/service-free (standalone-typecheck invariant) because
 * this module is INJECTED into it from main/src/index.ts, never imported by it.
 *
 * THREE deliveries (P8b promotes the lane gate from advisory to the visual
 * MERGE-GATE — locked decision #2):
 *
 *  1. ArtifactRouter.mergeScreenshots — ATOMICALLY merges into the SAME
 *     run-scoped 'screenshots' artifact (§5.9): fileNames unioned, verdict banner
 *     latest-wins, and (agent engine) a per-task `TaskVerificationReportEntry`
 *     upserted by (taskRef, requestId). The read-merge-write happens inside the
 *     router's per-project queue, so a concurrent auto-mint scan can never lose
 *     this delivery's reports entry (the pre-§5.9 read-then-create race).
 *
 *  2. MERGE-GATE lane drive (applyMergeGateVerdict — P8b). For a SPRINT run (one
 *     with a batch + lanes), the verdict drives the lane off its `awaiting-verify`
 *     park step: PASS → integrated; FAIL under the 3× cap → back to `implement`
 *     with a bumped attempt (the loopback); FAIL at the cap → `failed`;
 *     low_confidence → advisory pass-through. Threaded with the request's OWN
 *     attempt so a delivery-outbox boot replay never double-bumps the loopback.
 *
 *  3. ReviewItemRouter finding (§5.7). A FAIL / low_confidence / timeout / skipped
 *     terminal raises ONE finding (PASS raises none). A FAIL body now carries the
 *     agent's REPORT (behaviors failed + evidence + feedback), or the build/launch
 *     log excerpt for a verdict-less build failure; non-blocking findings carry the
 *     CONCRETE reason (error_message threaded from the agent path). Every finding
 *     persists a machine-readable (runId, taskRef, attempt, requestId) correlation
 *     so creation is idempotent by requestId (replay-safe) and a later terminal
 *     verdict can SUPERSEDE prior lower-attempt findings for the same lane.
 *
 * SUPERSESSION (§5.7): on EVERY terminal verdict for a lane (incl. PASS), prior
 * UNRESOLVED visual-verify findings for the same (runId, taskRef) at LOWER
 * attempts are resolved through ReviewItemRouter with a supersession note — a
 * recovered lane leaves no stale blocking item, and repeated failures keep only
 * the latest blocker live.
 *
 * Standalone-typecheck invariant: this file imports ONLY the electron-free
 * orchestrator routers + the merge-gate driver + shared types + the narrow
 * DatabaseLike / LoggerLike — no 'electron' / 'better-sqlite3' / 'fs' / services
 * import.
 */
import { ArtifactRouter } from '../artifactRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { applyMergeGateVerdict, isMergeGateBlocking, resolveLaneAttempts } from './mergeGateLaneAdvance';
import type { DatabaseLike, LoggerLike } from '../types';
import type { OnVerdict } from './verificationScheduler';
import type {
  CaptureOrigin,
  VerdictV1,
  VerificationReportV1,
  VerificationRequestInput,
  VerificationTaskV1,
} from '../../../../shared/types/visualVerification';
import { parseVerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { TaskVerificationReportEntry } from '../../../../shared/types/artifacts';
import type {
  FindingPayload,
  ReviewItemSeverity,
} from '../../../../shared/types/reviews';

/** Dependencies the verdict-delivery factory needs. */
export interface VerdictDeliveryDeps {
  /** Read-only DB surface — used to resolve the run's soft task link + persisted request columns. */
  db: DatabaseLike;
  logger?: LoggerLike;
}

/**
 * The terminal request statuses that warrant a finding: FAIL + low confidence, PLUS
 * `timeout` and `skipped` (R4, revised). Both timeout and skipped ADVANCE the lane
 * (an environment failure or missing precondition must never wedge a sprint) but each
 * raises a NON-blocking finding so a human sees that verification did not actually
 * run — advance-with-visibility.
 */
const FINDING_STATUSES: ReadonlySet<string> = new Set(['failed', 'low_confidence', 'timeout', 'skipped']);

/** The persisted columns of a verification_requests row the delivery reads by requestId. */
interface DeliveredRequestColumns {
  reportJson: string | null;
  taskJson: string | null;
  enqueueKey: string | null;
  errorMessage: string | null;
}

/**
 * Read the persisted columns a delivery needs to compose its report entry + finding
 * body (§5.6/§5.7). A plain read (not a chokepoint write) — the report/verdict were
 * committed atomically by the scheduler's markTerminal, so this observes them for
 * both the live delivery and the boot replay. Fail-soft: a minimal DB / read error
 * yields all-nulls (the delivery degrades to the legacy generic body).
 */
function readRequestColumns(db: DatabaseLike, requestId: string, logger?: LoggerLike): DeliveredRequestColumns {
  try {
    const row = db
      .prepare(
        `SELECT report_json AS reportJson, task_json AS taskJson,
                enqueue_key AS enqueueKey, error_message AS errorMessage
           FROM verification_requests WHERE id = ?`,
      )
      .get(requestId) as Partial<DeliveredRequestColumns> | undefined;
    return {
      reportJson: row?.reportJson ?? null,
      taskJson: row?.taskJson ?? null,
      enqueueKey: row?.enqueueKey ?? null,
      errorMessage: row?.errorMessage ?? null,
    };
  } catch (err) {
    logger?.debug('[verdictDelivery] could not read request columns (fail-soft)', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { reportJson: null, taskJson: null, enqueueKey: null, errorMessage: null };
  }
}

/** Parse persisted report_json into a VerificationReportV1; null on absent/malformed. */
function parseReport(reportJson: string | null): VerificationReportV1 | null {
  if (typeof reportJson !== 'string' || reportJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(reportJson);
    // Trust the scheduler's normalizer that wrote it — light shape check only.
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { behaviors?: unknown }).behaviors)) {
      return parsed as VerificationReportV1;
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse persisted task_json into a VerificationTaskV1 (via the strict validator); null otherwise. */
function parseTask(taskJson: string | null): VerificationTaskV1 | null {
  if (typeof taskJson !== 'string' || taskJson.length === 0) return null;
  try {
    const parsed = parseVerificationTaskV1(JSON.parse(taskJson));
    return parsed.ok ? parsed.task : null;
  } catch {
    return null;
  }
}

/**
 * Parse the attempt out of an enqueue_key (`${runId}:${taskRef}:${attempt}` — the
 * attempt is the LAST colon-segment; runId/taskRef may themselves contain colons,
 * §5.6). Returns null on an absent / malformed key so the caller falls back to the
 * lane store's attempt, else 1.
 */
export function parseAttemptFromEnqueueKey(enqueueKey: string | null): number | null {
  if (typeof enqueueKey !== 'string' || enqueueKey.length === 0) return null;
  const lastColon = enqueueKey.lastIndexOf(':');
  if (lastColon < 0) return null;
  const tail = enqueueKey.slice(lastColon + 1);
  const n = Number.parseInt(tail, 10);
  return Number.isInteger(n) && n >= 0 && String(n) === tail.trim() ? n : null;
}

/**
 * Map a VlmJudge issue severity ('low'|'medium'|'high') to the review_items
 * severity domain ('info'|'warning'|'error'). A finding with no issues (e.g. a
 * bare low_confidence verdict) defaults to 'warning'.
 */
function toReviewSeverity(issueSeverity: 'low' | 'medium' | 'high' | undefined): ReviewItemSeverity {
  if (issueSeverity === 'high') return 'error';
  if (issueSeverity === 'medium') return 'warning';
  if (issueSeverity === 'low') return 'info';
  return 'warning';
}

/** Severity rank so the WORST issue drives the finding's severity. */
const ISSUE_RANK: Record<'low' | 'medium' | 'high', number> = { low: 0, medium: 1, high: 2 };

/**
 * Pick the worst (highest-rank) issue severity from a verdict, or undefined when
 * none. A verdict-LESS FAIL (capture-fail / build-fail — `verdict` undefined) has
 * no issues to rank, so the caller falls back to the default 'warning' severity.
 */
function worstIssueSeverity(verdict: VerdictV1 | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!verdict) return undefined;
  let worst: 'low' | 'medium' | 'high' | undefined;
  for (const issue of verdict.issues) {
    if (worst === undefined || ISSUE_RANK[issue.severity] > ISSUE_RANK[worst]) {
      worst = issue.severity;
    }
  }
  return worst;
}

/**
 * Render the FAILED behaviors of an agent report as finding-body lines: each failed
 * behavior's id + description + expected (from the composing task where ids match)
 * + the evidence notes, so the re-delegated implement agent receives WHAT was
 * tested, WHAT was expected, and WHY it failed (the loop the investigation flagged,
 * §5.7). Behaviors that passed / were not testable are omitted from a FAIL body (the
 * report entry on the screenshots tab carries the full set). Returns an empty array
 * when the report has no failed behaviors.
 */
function renderFailedBehaviors(report: VerificationReportV1, task: VerificationTaskV1 | null): string[] {
  const meta = new Map<string, { description: string; expected: string }>();
  if (task) {
    for (const b of task.behaviors) meta.set(b.id, { description: b.description, expected: b.expected });
  }
  const lines: string[] = [];
  for (const b of report.behaviors) {
    if (b.result !== 'fail') continue;
    const m = meta.get(b.id);
    const head = m?.description ? `${b.id} (${m.description})` : b.id;
    const parts = [`- ${head}`];
    if (m?.expected) parts.push(`expected: ${m.expected}`);
    if (b.evidence.notes) parts.push(`observed: ${b.evidence.notes}`);
    lines.push(parts.join(' — '));
  }
  return lines;
}

/**
 * Build the human-facing finding title + body (§5.7). The body composes, in order
 * of specificity:
 *   - build_failed / launch_failed (verdict-less FAIL): the build/launch log
 *     excerpt PROMINENTLY (from report.buildLogExcerpt, else error_message) — a
 *     deliverable that cannot build from its own committed state is a smoke FAIL,
 *     frequently code-caused, so the excerpt is what re-implement needs.
 *   - a behavior FAIL with a report: the failed behaviors (id + notes) + feedback.
 *   - a FAIL with only a legacy verdict: verdict.feedback + per-issue lines.
 *   - a verdict-less FAIL with neither: the generic capture/judge-failure text.
 *   - low_confidence: "needs human review" + reason.
 *   - timeout / skipped: advance-with-visibility framing + the CONCRETE reason.
 */
function buildFindingText(args: {
  status: string;
  verdict: VerdictV1 | undefined;
  report: VerificationReportV1 | null;
  task: VerificationTaskV1 | null;
  errorMessage: string | null;
}): { title: string; body: string } {
  const { status, verdict, report, task, errorMessage } = args;

  // ---- build/launch failure (verdict-less FAIL; report.outcome or error_message) ----
  const buildFailed = report?.outcome === 'build_failed' || report?.outcome === 'launch_failed';
  if (status === 'failed' && buildFailed) {
    const kind = report?.outcome === 'launch_failed' ? 'launch' : 'build';
    const excerpt = (report?.buildLogExcerpt ?? errorMessage ?? '').trim();
    const parts = [
      `Visual verification could not ${kind} the deliverable from its own committed state — a smoke FAIL (frequently code-caused). The lane was sent back to re-implement.`,
    ];
    if (excerpt) parts.push(['Build/launch log excerpt:', '```', excerpt, '```'].join('\n'));
    if (report?.feedback) parts.push(report.feedback);
    return { title: `Visual verification failed (${kind} error)`, body: parts.join('\n\n') };
  }

  // ---- timeout: advance-with-visibility (no visual check ran) ----
  if (status === 'timeout') {
    const parts = [
      'Visual verification timed out before producing a verdict (the deployment never became ready, build/serve/drive/judge exceeded the deadline, or the request was orphaned by a process restart). The lane was advanced so the sprint is not wedged, but NO visual check actually ran — verify this deliverable manually or re-run verification.',
    ];
    if (errorMessage) parts.push(`Reason: ${errorMessage}`);
    return { title: 'Visual verification did not run (timed out)', body: parts.join('\n\n') };
  }

  // ---- skipped: advance-with-visibility (missing precondition) ----
  if (status === 'skipped') {
    const parts = [
      'Visual verification did not run (a missing precondition — an unhealthy or absent backend/agent engine, no capable rung for this deliverable, an exhausted budget, a queued-age deadline, or an unparseable deliverable — prevented it). The lane was advanced so the sprint is not wedged, but NO visual check actually ran — verify this deliverable manually or fix the environment and re-run verification.',
    ];
    if (errorMessage) parts.push(`Reason: ${errorMessage}`);
    return { title: 'Visual verification did not run (skipped)', body: parts.join('\n\n') };
  }

  // ---- low_confidence: never an auto-loop — needs a human ----
  if (status === 'low_confidence') {
    const parts = ['Visual verification could not reach a confident verdict — a human should review the deliverable visually.'];
    if (report) {
      const untested = report.behaviors.filter((b) => b.result === 'not_testable').map((b) => `- ${b.id}: ${b.evidence.notes || 'not testable'}`);
      if (untested.length > 0) parts.push(['Behaviors that could not be tested:', ...untested].join('\n'));
    }
    if (verdict?.feedback) parts.push(verdict.feedback);
    if (!report && !verdict && errorMessage) parts.push(`Reason: ${errorMessage}`);
    return { title: 'Visual verification needs human review (low confidence)', body: parts.join('\n\n') };
  }

  // ---- FAIL with a behavior report ----
  if (status === 'failed' && report) {
    const parts: string[] = [];
    const failed = renderFailedBehaviors(report, task);
    if (failed.length > 0) {
      parts.push(['Behaviors that failed:', ...failed].join('\n'));
    } else {
      parts.push('Visual verification failed. The lane was sent back to re-implement.');
    }
    if (report.feedback) parts.push(report.feedback);
    return { title: 'Visual verification failed', body: parts.join('\n\n') };
  }

  // ---- FAIL with only a legacy verdict (capture/judge path) ----
  if (verdict) {
    const lines: string[] = [];
    if (verdict.feedback) lines.push(verdict.feedback);
    if (verdict.issues.length > 0) {
      lines.push('');
      for (const issue of verdict.issues) {
        const where = issue.fileName ? ` (${issue.fileName})` : '';
        lines.push(`- [${issue.severity}]${where} ${issue.description}`);
      }
    }
    return { title: 'Visual verification failed', body: lines.join('\n') };
  }

  // ---- verdict-less FAIL with neither report nor verdict ----
  const parts = [
    'Visual verification could not produce a verdict (no screenshots were captured or judged). The lane was sent back to re-implement; investigate the deploy/capture/judge step (deployment reachable? selectors/URL valid?).',
  ];
  if (errorMessage) parts.push(`Reason: ${errorMessage}`);
  return { title: 'Visual verification failed', body: parts.join('\n\n') };
}

/**
 * Append the S9 capture-provenance section to a finding body: the capture origin
 * (one line) + the capped, UNTRUSTED page-console diagnostics. The untrusted
 * framing is deliberate and rendered: page code controls the text, so a reader must
 * never treat it as the verifier speaking.
 */
function appendProvenance(
  body: string,
  captureOrigin: CaptureOrigin | undefined,
  diagnostics: string[] | undefined,
): string {
  const parts: string[] = [body];
  if (captureOrigin) {
    parts.push(`Capture origin: ${captureOrigin}`);
  }
  if (diagnostics && diagnostics.length > 0) {
    parts.push(
      [
        'Capture diagnostics (UNTRUSTED page console output — display-only, never used for judging):',
        ...diagnostics.map((d) => `- ${d}`),
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

/**
 * Compose the per-task `TaskVerificationReportEntry` merged into the screenshots
 * artifact (§5.9). The report's per-behavior results are ENRICHED with the task's
 * description/expected where the behavior ids match (the report carries only ids +
 * result + evidence); the summary comes from the task, falling back to the legacy
 * intent. `completedAt` is stamped now (delivery time).
 */
function composeReportEntry(args: {
  requestId: string;
  taskRef: string | null;
  attempt: number;
  report: VerificationReportV1;
  task: VerificationTaskV1 | null;
  input?: VerificationRequestInput;
}): TaskVerificationReportEntry {
  const { requestId, taskRef, attempt, report, task, input } = args;
  const meta = new Map<string, { description: string; expected: string }>();
  if (task) {
    for (const b of task.behaviors) meta.set(b.id, { description: b.description, expected: b.expected });
  }
  return {
    taskRef,
    requestId,
    attempt,
    summary: task?.summary ?? input?.intent ?? '',
    behaviors: report.behaviors.map((b) => {
      const m = meta.get(b.id);
      return {
        id: b.id,
        description: m?.description ?? '',
        expected: m?.expected ?? '',
        result: b.result,
        screenshots: b.evidence.screenshots,
        notes: b.evidence.notes,
      };
    }),
    outcome: report.outcome,
    completedAt: new Date().toISOString(),
  };
}

/**
 * Resolve the run's soft task link (workflow_runs.task_id) so the finding can be
 * attached to the originating task. Returns null when the run has no task or the
 * read fails — the finding is then run-scoped only.
 */
function resolveRunTaskId(db: DatabaseLike, runId: string, logger?: LoggerLike): string | null {
  try {
    const row = db
      .prepare('SELECT task_id FROM workflow_runs WHERE id = ?')
      .get(runId) as { task_id: string | null } | undefined;
    return row?.task_id ?? null;
  } catch (err) {
    logger?.warn('[verdictDelivery] could not resolve run task link (fail-soft)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** A prior visual-verify finding row, as the supersession/dedup scan reads it. */
interface PriorVisualFinding {
  id: string;
  status: string;
  correlation: { taskRef: string | null; attempt: number; requestId: string } | null;
}

/**
 * Read this run's visual-verify findings (any status) with their parsed
 * (taskRef, attempt, requestId) correlation, for the dedup + supersession passes.
 * A read/parse failure yields [] (both passes then no-op — fail-open).
 */
function readPriorVisualFindings(db: DatabaseLike, runId: string, logger?: LoggerLike): PriorVisualFinding[] {
  try {
    const rows = db
      .prepare(
        `SELECT id, status, payload_json AS payloadJson
           FROM review_items
          WHERE run_id = ? AND kind = 'finding' AND source = 'visual-verify'`,
      )
      .all(runId) as Array<{ id: string; status: string; payloadJson: string | null }>;
    return rows.map((r) => ({ id: r.id, status: r.status, correlation: parseCorrelation(r.payloadJson) }));
  } catch (err) {
    logger?.debug('[verdictDelivery] could not read prior visual findings (fail-soft)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Parse a finding payload_json's `visualVerify` correlation block; null when absent/malformed. */
function parseCorrelation(
  payloadJson: string | null,
): { taskRef: string | null; attempt: number; requestId: string } | null {
  if (typeof payloadJson !== 'string' || payloadJson.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    const vv = parsed !== null && typeof parsed === 'object' ? (parsed as { visualVerify?: unknown }).visualVerify : undefined;
    if (vv === null || typeof vv !== 'object') return null;
    const v = vv as { taskRef?: unknown; attempt?: unknown; requestId?: unknown };
    if (typeof v.requestId !== 'string' || typeof v.attempt !== 'number') return null;
    return {
      taskRef: typeof v.taskRef === 'string' ? v.taskRef : null,
      attempt: v.attempt,
      requestId: v.requestId,
    };
  } catch {
    return null;
  }
}

/**
 * Build the concrete `OnVerdict` callback the scheduler fires after a terminal
 * outcome. Fail-soft end to end: a router error is logged and swallowed so a
 * delivery problem never wedges the drain loop or leaves a half-applied state.
 */
export function createVerdictDelivery(deps: VerdictDeliveryDeps): OnVerdict {
  const { db, logger } = deps;

  return async ({ requestId, runId, projectId, status, verdict, fileNames, input, captureOrigin, diagnostics }) => {
    // Read the columns the scheduler committed atomically with the terminal status.
    // Works identically for a live delivery and a delivery-outbox boot replay (both
    // observe the persisted report_json / enqueue_key / error_message).
    const cols = readRequestColumns(db, requestId, logger);
    const report = parseReport(cols.reportJson);
    const task = parseTask(cols.taskJson);
    const taskRef = input?.taskRef ?? task?.taskRef ?? null;
    // Attempt for correlation + supersession + the merge-gate replay guard: the
    // request's enqueue_key attempt, else the lane's current attempt, else 1 (§5.7).
    const attempt =
      parseAttemptFromEnqueueKey(cols.enqueueKey) ??
      resolveLaneAttempts(db, runId, input?.taskRef, logger) ??
      1;

    // ---- 1. ATOMIC merge into the SAME 'screenshots' artifact (§5.9) ----
    // Route through mergeScreenshots so a concurrent auto-mint scan cannot lose this
    // reports entry. Merge whenever there is something to add (verdict banner, a
    // report entry, or captured fileNames) — a bare skip with nothing captured
    // enriches nothing (never mints an empty artifact).
    const reportEntry = report
      ? composeReportEntry({ requestId, taskRef, attempt, report, task, input })
      : undefined;
    const hasFiles = Array.isArray(fileNames) && fileNames.length > 0;
    if (verdict || reportEntry || hasFiles) {
      try {
        // R7: thread the hydrated baselineKey THROUGH delivery so the screenshots-tab
        // Accept-as-baseline button files accepted PNGs under the SAME stable key the
        // SSIM pre-diff later resolves baselines by. Omitted when the request carried
        // no baselineKey.
        const enrichedVerdict: VerdictV1 | undefined =
          verdict && input?.baselineKey !== undefined && input.baselineKey.length > 0
            ? { ...verdict, baselineKey: input.baselineKey }
            : verdict;
        await ArtifactRouter.getInstance().mergeScreenshots(projectId, {
          op: 'merge-screenshots',
          runId,
          label: `${fileNames.length} screenshot${fileNames.length === 1 ? '' : 's'}`,
          ...(hasFiles ? { fileNames } : {}),
          ...(enrichedVerdict ? { verdict: enrichedVerdict } : {}),
          ...(reportEntry ? { report: reportEntry } : {}),
          ...(captureOrigin ? { captureOrigin } : {}),
          ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
          isNew: false,
          actor: 'orchestrator',
        });
      } catch (err) {
        logger?.error('[verdictDelivery] artifact merge failed (fail-soft)', {
          runId,
          projectId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ---- 2. MERGE-GATE: drive the sprint lane off `awaiting-verify` ----
    const gateAction = applyMergeGateVerdict({
      db,
      runId,
      status,
      verdict,
      taskRef: input?.taskRef,
      requestAttempt: attempt,
      logger,
    });

    // ---- 2b. SUPERSESSION: resolve prior lower-attempt visual findings (§5.7) ----
    // Runs for EVERY terminal verdict (incl. PASS): a recovered/passing lane leaves
    // no stale blocking item, and repeated failures keep only the latest live.
    const priorFindings = readPriorVisualFindings(db, runId, logger);
    for (const prior of priorFindings) {
      if (prior.status !== 'pending') continue;
      const c = prior.correlation;
      if (c === null) continue;
      if (c.requestId === requestId) continue; // never supersede THIS request's own (yet-to-be-created) finding
      if (c.taskRef !== taskRef) continue; // different lane
      if (c.attempt >= attempt) continue; // only LOWER attempts are superseded
      try {
        await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
          op: 'resolve',
          actor: 'orchestrator',
          reviewItemId: prior.id,
          runId,
          resolution: `superseded by visual verification attempt ${attempt}`,
        });
      } catch (err) {
        logger?.warn('[verdictDelivery] supersession resolve failed (fail-soft)', {
          runId,
          reviewItemId: prior.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ---- 3. Raise ONE finding ONLY on FAIL / low_confidence / timeout / skipped ----
    if (!FINDING_STATUSES.has(status)) return;

    // IDEMPOTENT (§5.6 replay): a finding already exists for THIS requestId → skip.
    if (priorFindings.some((p) => p.correlation?.requestId === requestId)) {
      logger?.debug('[verdictDelivery] finding already exists for request (skip duplicate)', { runId, requestId });
      return;
    }

    try {
      const taskId = resolveRunTaskId(db, runId, logger);
      const severity = toReviewSeverity(worstIssueSeverity(verdict));
      const { title, body: baseBody } = buildFindingText({
        status,
        verdict,
        report,
        task,
        errorMessage: cols.errorMessage,
      });
      const body = appendProvenance(baseBody, captureOrigin, diagnostics);
      const findingPayload: FindingPayload = {
        kind: 'finding',
        category: 'visual-regression',
        // Machine-readable correlation (§5.7): lets a later verdict supersede this
        // finding at a higher attempt, and makes creation idempotent by requestId.
        visualVerify: { runId, taskRef, attempt, requestId },
      };
      await ReviewItemRouter.getInstance().applyReviewItem(projectId, {
        op: 'create',
        actor: 'orchestrator',
        kind: 'finding',
        title,
        body,
        blocking: isMergeGateBlocking(gateAction),
        severity,
        source: 'visual-verify',
        entityType: taskId ? 'task' : null,
        entityId: taskId ?? null,
        runId,
        payload: findingPayload,
      });
    } catch (err) {
      logger?.error('[verdictDelivery] finding creation failed (fail-soft)', {
        runId,
        projectId,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
