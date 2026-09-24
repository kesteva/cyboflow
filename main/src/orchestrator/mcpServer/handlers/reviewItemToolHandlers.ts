/**
 * ReviewItemToolHandlers — the review-queue tool family (finding writes and
 * resolves through the ReviewItemRouter chokepoint, plus the read-only finding
 * and eval readouts), split out of mcpQueryHandler.ts (issue #19).
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import.
 */
import * as net from 'net';
import type { DatabaseLike, LoggerLike } from '../../types';
import { ReviewItemError, ReviewItemRouter } from '../../reviewItemRouter';
import type { ReviewItemCreate, ReviewItemTriage } from '../../reviewItemRouter';
import { selectFindingForSeed, selectRunFindingsForRuns } from '../../reviewItemListing';
import { selectSessionRunScope } from '../../sessionRunScope';
import { selectEvalReadout } from '../../evalReadout';
import {
  RESOLUTION_PREFIX_FIXED,
  RESOLUTION_PREFIX_PROMOTED,
  RESOLUTION_PREFIX_TRIAGED,
} from '../../../../../shared/types/reviews';
import type {
  FindingPayload,
  FindingProposedTarget,
  ReviewItemKind,
  ReviewItemPayload,
} from '../../../../../shared/types/reviews';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';

/**
 * The context McpQueryHandler composes this family with. `writeResponse` and
 * `resolveReviewItemRunContext` are private methods on the handler (the artifact
 * and verify families share the latter), handed over as closures so the moved
 * bodies keep calling them as `this.<name>(...)` unchanged.
 */
export interface ReviewItemToolContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  /** Serialize one reply onto the requesting socket. */
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  /** Non-terminal run → (projectId, agent actor); the write guard the artifact and verify families share. */
  resolveReviewItemRunContext(runId: string): { ok: true; projectId: number; actor: `agent:${string}` } | { ok: false; error: string };
}

/** A non-null object whose own keys can be safely indexed (the handler's same-named guard). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Structured finding-extras mapping (snake_case wire -> camelCase payload).
//
// The cyboflow_report_finding tool accepts optional category / locations /
// suggested_fix / impact alongside the legacy payload_json. They arrive on the
// query message UNVALIDATED (typed `unknown`); the guards below narrow each shape
// and the builder DROPS any malformed member rather than erroring — an agent typo
// must never fail a non-blocking finding write (the whole point of the inbox).
// ---------------------------------------------------------------------------

/**
 * Narrow `unknown` to FindingPayload['locations'], keeping only well-formed
 * entries ({ path: string, line?: number }) and dropping malformed ones. Returns
 * undefined when the input is not an array OR no entry survives.
 */
function parseFindingLocations(v: unknown): FindingPayload['locations'] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<FindingPayload['locations']> = [];
  for (const entry of v) {
    if (!isRecord(entry) || typeof entry.path !== 'string') continue; // drop malformed
    out.push(typeof entry.line === 'number' ? { path: entry.path, line: entry.line } : { path: entry.path });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Narrow `unknown` to FindingPayload['impact'], keeping only the numeric/string
 * members that are present and well-typed. Returns undefined when the input is
 * not an object OR no member survives.
 */
function parseFindingImpact(v: unknown): FindingPayload['impact'] | undefined {
  if (!isRecord(v)) return undefined;
  const impact: NonNullable<FindingPayload['impact']> = {};
  if (typeof v['ran_count'] === 'number') impact.ranCount = v['ran_count'];
  if (typeof v['caught_regressions'] === 'number') impact.caughtRegressions = v['caught_regressions'];
  if (typeof v['token_delta'] === 'number') impact.tokenDelta = v['token_delta'];
  if (typeof v['note'] === 'string') impact.note = v['note'];
  return Object.keys(impact).length > 0 ? impact : undefined;
}

/**
 * Build the FindingPayload extras from a report-finding message, dropping any
 * malformed member. Returns only the keys that survived narrowing (so the caller
 * can spread them over a base payload without clobbering with undefined).
 */
function buildFindingExtras(
  msg: Extract<McpQueryMessage, { type: 'mcp-report-finding' }>,
): Partial<Omit<FindingPayload, 'kind'>> {
  const extras: Partial<Omit<FindingPayload, 'kind'>> = {};
  if (typeof msg.category === 'string') extras.category = msg.category;
  if (typeof msg.suggestedFix === 'string') extras.suggestedFix = msg.suggestedFix;
  // proposedTarget must be one of the four routing literals ('fix' = a quick
  // in-place fix, added with the findings-triage redesign); anything else is
  // DROPPED (same agent-typo-can-never-fail-a-write discipline as the rest).
  if (['backlog', 'docs', 'prompt', 'fix'].includes(msg.proposedTarget as string)) {
    extras.proposedTarget = msg.proposedTarget as FindingProposedTarget;
  }
  const locations = parseFindingLocations(msg.locations);
  if (locations !== undefined) extras.locations = locations;
  const impact = parseFindingImpact(msg.impact);
  if (impact !== undefined) extras.impact = impact;
  return extras;
}

/**
 * The review-queue MCP tool family: `cyboflow_report_finding`,
 * `cyboflow_get_selected_findings`, `cyboflow_get_eval`,
 * `cyboflow_list_run_findings` and `cyboflow_resolve_finding`. Split out of
 * McpQueryHandler (issue #19) with every method body verbatim; the handler
 * routes the five message types here and supplies the shared run guard.
 */
export class ReviewItemToolHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: ReviewItemToolContext['writeResponse'];
  private readonly resolveReviewItemRunContext: ReviewItemToolContext['resolveReviewItemRunContext'];

  constructor(ctx: ReviewItemToolContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
    this.resolveReviewItemRunContext = ctx.resolveReviewItemRunContext;
  }

  // --------------------------------------------------------------------------
  // Review-item write (cyboflow_report_finding)
  //
  // Findings (and decisions / human_tasks) emitted by Sprint agents route
  // through the SINGLE review-queue chokepoint ReviewItemRouter.applyReviewItem —
  // they NEVER INSERT review_items directly. The item is NON-BLOCKING by default
  // (a finding never pauses the run): the handler validates the run context +
  // payload SYNCHRONOUSLY (so a bad request surfaces immediately), then enqueues
  // the create and writes the ok:true response WITHOUT awaiting the per-project
  // queue — the agent's run continues regardless of inbox contention. The soft
  // entity-link and per-kind-payload-discriminant validations are enforced INSIDE
  // applyReviewItem and surface as ReviewItemError.code via writeReviewItemError.
  // --------------------------------------------------------------------------

  /**
   * READ-ONLY sibling of {@link resolveReviewItemRunContext}: resolves the
   * project without the terminal-run refusal.
   *
   * The `run_not_active` gate exists to stop a settled run WRITING — a finding
   * filed or resolved after the human's gate closed lands where nobody looks.
   * Applying it to a READ was collateral damage, and it lands squarely on the
   * case that matters: the code-review eval fires at SETTLE (terminalEvalSubscriber
   * grades on awaiting_review|completed), so by the time its verdict exists the
   * run it graded is frequently already `completed` — and the human's very next
   * move is to open a chat and say "fix what the eval found". That ask was
   * refused outright, on a run whose findings were sitting in the table.
   *
   * A read cannot corrupt a settled run, so the only checks kept are the two that
   * say the request is meaningless: the 'orchestrator' sentinel (no run row at
   * all) and an unknown id. Writes keep the full guard — see
   * {@link resolveTargetInScope} for how a chat still resolves a settled sibling
   * run's finding without reviving that run.
   */
  private resolveReadOnlyRunContext(
    runId: string,
  ): { ok: true; projectId: number } | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'finding_requires_real_run' };
    }
    const row = this.db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId?: unknown } | undefined;
    if (!row) {
      return { ok: false, error: 'run_not_found' };
    }
    const projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
    if (!Number.isFinite(projectId)) {
      return { ok: false, error: 'run_not_found' };
    }
    return { ok: true, projectId };
  }

  /**
   * Report a finding/decision/human_task into the unified review queue.
   *
   * NON-BLOCKING contract: the run is never paused on the inbox. This handler
   * validates the run context AND parses/validates payload_json SYNCHRONOUSLY
   * (so a bad request fails fast), then fires ReviewItemRouter.applyReviewItem
   * and writes the ok:true response IMMEDIATELY — it does NOT await the
   * per-project queue. A late chokepoint rejection (e.g. invalid_entity from the
   * soft-link guard) is logged but cannot retroactively block the already-replied
   * run; the synchronous validations below catch the common misuse before reply.
   */
  handleReportFinding(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-finding' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    // 'notification' is orchestrator-minted only (agents cannot file one), so the
    // MCP report_finding tool excludes it alongside 'permission'.
    const kind: Exclude<ReviewItemKind, 'permission' | 'notification'> = msg.kind ?? 'finding';

    // Soft entity-link guard (both set together or both omitted) — surfaced
    // synchronously through writeReviewItemError so the caller gets the SAME
    // 'invalid_entity' code the chokepoint would have thrown, but BEFORE we reply
    // ok:true (the non-blocking create cannot un-reply the run after the fact).
    if ((msg.entityType === undefined) !== (msg.entityId === undefined)) {
      this.writeReviewItemError(
        client,
        msg.requestId,
        new ReviewItemError('invalid_entity', 'entityType and entityId must be set together or both omitted'),
      );
      return;
    }

    // Parse + validate the per-kind payload BEFORE the async create. The
    // discriminant must equal `kind` (the same check the chokepoint runs); doing
    // it here keeps the malformed-payload rejection synchronous.
    let payload: ReviewItemPayload | null = null;
    if (msg.payloadJson !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payloadJson);
      } catch {
        this.writeReviewItemError(
          client,
          msg.requestId,
          new ReviewItemError('invalid_payload', 'payload_json is not valid JSON'),
        );
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as { kind?: unknown }).kind !== kind
      ) {
        this.writeReviewItemError(
          client,
          msg.requestId,
          new ReviewItemError('invalid_payload', `payload.kind does not match item kind '${kind}'`),
        );
        return;
      }
      payload = parsed as ReviewItemPayload;
    }

    // Fold the structured finding extras (category / locations / suggestedFix /
    // impact) into the FindingPayload. These arrive UNVALIDATED from the MCP tool
    // (typed `unknown`); each shape is guarded and a malformed member is DROPPED
    // rather than erroring — an agent typo must never fail a non-blocking finding
    // write. Extras only apply to kind='finding'; for other kinds they are ignored.
    // An explicit payloadJson (parsed above) is the base; extras override per-field.
    if (kind === 'finding') {
      const extras = buildFindingExtras(msg);
      if (Object.keys(extras).length > 0) {
        const base: FindingPayload =
          payload !== null && payload.kind === 'finding' ? payload : { kind: 'finding' };
        payload = { ...base, ...extras };
      }
    }

    const create: ReviewItemCreate = {
      op: 'create',
      actor: ctx.actor,
      kind,
      title: msg.title,
      body: msg.body,
      blocking: msg.blocking ?? false,
      severity: msg.severity ?? null,
      source: ctx.actor,
      entityType: msg.entityType ?? null,
      entityId: msg.entityId ?? null,
      runId: msg.runId,
      payload,
    };

    // Fire-and-forget: the run is NEVER gated on the inbox. A late failure is
    // logged (it cannot un-reply the run), but the synchronous validations above
    // already caught the common misuse, so this path is for genuine DB faults.
    void ReviewItemRouter.getInstance()
      .applyReviewItem(ctx.projectId, create)
      .catch((err) => {
        this.logger?.error('[Cyboflow MCP Query] review-item create failed (non-blocking)', {
          runId: msg.runId,
          error: err instanceof ReviewItemError ? err.code : err instanceof Error ? err.message : String(err),
        });
      });

    // Reply IMMEDIATELY — do not await the queue.
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { accepted: true, kind, blocking: msg.blocking ?? false },
    });
  }

  // --------------------------------------------------------------------------
  // Compound-run findings (cyboflow_get_selected_findings / _resolve_finding)
  //
  // The triage tray seeds a compound run with the EXACT findings the human
  // selected (workflow_runs.seed_finding_ids, migration 034). These two handlers
  // let the seeded compound agent re-read that set and resolve each finding as it
  // acts on it. get-selected-findings is READ-ONLY; resolve-finding routes the
  // resolve through the SINGLE review-item chokepoint and is AWAITED (so a failed
  // resolve surfaces — diverging from the fire-and-forget report-finding path).
  // Both reuse the run-context guard, so they are callable only mid-run
  // (resolveReviewItemRunContext rejects terminal runs with run_not_active).
  // --------------------------------------------------------------------------

  /**
   * Return the findings the human seeded into THIS compound run, read from
   * workflow_runs.seed_finding_ids and shaped via selectFindingForSeed. Read-only
   * — never writes. Replies { findings: [] } when the column is null/unparseable
   * or no id resolves to a finding (a fail-soft empty set, not an error).
   */
  handleGetSelectedFindings(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-selected-findings' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const runRow = this.db
      .prepare('SELECT seed_finding_ids AS seedFindingIds FROM workflow_runs WHERE id = ?')
      .get(msg.runId) as { seedFindingIds?: unknown } | undefined;
    const seedJson =
      typeof runRow?.seedFindingIds === 'string' && runRow.seedFindingIds.length > 0
        ? runRow.seedFindingIds
        : null;

    let ids: string[] = [];
    if (seedJson) {
      try {
        const parsed: unknown = JSON.parse(seedJson);
        if (Array.isArray(parsed)) {
          ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
      } catch {
        // Unparseable seed → fail-soft empty set (no error to the agent).
        ids = [];
      }
    }

    const findings = ids
      .map((id) => selectFindingForSeed(this.db, id))
      .filter((f): f is NonNullable<typeof f> => f !== null);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { findings },
    });
  }

  /**
   * Return the code-review eval's FULL verdict for a run in this session — the
   * score, band, CI, per-dimension breakdown, cap triggers, the sub-checks the
   * jury failed with its evidence, and every finding it raised cross-linked to
   * its review item.
   *
   * WHY IT EXISTS. The verdict lives in `run_evals`, and nothing in the run
   * tool scope read that table. What reached an agent instead was a filtered
   * slice via `review_items`: net-new or majority-catastrophic findings only,
   * deduped, advisory-capped at ten — and no score at all, because the one
   * summary item carrying the rollup is written only for `origin = 'adhoc'`,
   * which an automatic or A/B-tagged flow eval never is. So an agent asked to
   * fix what the eval flagged could see at most ten of the findings and never
   * the verdict, and had no way to discover that the rest existed.
   *
   * SCOPE. `targetRunId` is optional and usually omitted: a chat turn's own run
   * id is a `__quick__` sentinel that was never graded, so the default walks the
   * session's runs ({@link selectSessionRunScope}) and returns the first graded
   * one. Named explicitly, the target must belong to the caller's PROJECT —
   * a tighter check than the sibling `mcp-get-run`, which reads any run row by
   * id, and the right one here because this payload carries review content.
   *
   * NOT gated on a live run, by design: the eval fires AT settle, so the run it
   * graded is usually already terminal by the time anyone can ask about it.
   * Read-only throughout — no router, no write.
   */
  handleGetEval(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-eval' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReadOnlyRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    if (msg.targetRunId !== undefined) {
      const target = this.resolveReadOnlyRunContext(msg.targetRunId);
      if (!target.ok) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: target.error,
        });
        return;
      }
      if (target.projectId !== ctx.projectId) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: 'run_not_in_project',
        });
        return;
      }
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          runScope: [msg.targetRunId],
          evaluation: selectEvalReadout(this.db, msg.targetRunId),
        },
      });
      return;
    }

    // Default: the first GRADED run in this session's scope. Scope order puts
    // the caller's own run first and then walks the session chronologically, so
    // a chat sentinel (never graded) falls through to the flow run behind it.
    const runScope = selectSessionRunScope(this.db, msg.runId);
    let evaluation = null;
    for (const candidate of runScope) {
      evaluation = selectEvalReadout(this.db, candidate);
      if (evaluation !== null) break;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { runScope, evaluation },
    });
  }

  /**
   * Return the still-open findings THIS run filed itself, each carrying the
   * `review_items.id` that `cyboflow_resolve_finding` needs. Read-only.
   *
   * This is the READ half of the report→act→resolve loop for a run acting on its
   * OWN findings (the sprint/ship `address-review` step). `report_finding` is
   * fire-and-forget by design — it never returns the minted id — so an agent
   * cannot resolve what it filed from memory alone. Reading back from the DB is
   * also the truer set: it spans every lane's `code-review` pass plus
   * `sprint-review` and the eval jury, including findings filed by a subagent
   * chain whose context is long gone.
   *
   * SCOPED TO THE SESSION'S RUNS, not to `msg.runId` alone. A flow step's run id
   * is its own, so nothing changes there; a CHAT turn's run id is the session's
   * `__quick__` sentinel, which by construction filed nothing, so the unwidened
   * read replied `{ findings: [] }` to every "go fix this run's findings" ask and
   * gave the agent no way to tell that empty apart from a genuinely clean run.
   * See selectSessionRunScope for the link and its fail-soft narrowing.
   *
   * READABLE AFTER SETTLE, unlike get-selected-findings / resolve-finding: it
   * takes the read-only run context, which drops the `run_not_active` refusal.
   * The eval fires AT settle, so gating this read on a live run refused exactly
   * the "the run finished, now go fix what review found" ask it exists to serve.
   * The write path keeps the full guard.
   *
   * AWAITED, unlike its read-only sibling get-selected-findings: this read must
   * observe the run's OWN prior `report_finding` writes, and those are enqueued
   * on the ReviewItemRouter's per-project queue and replied to BEFORE they
   * commit. Selecting straight from the table races them — the findings most
   * likely to still be in flight are the ones sprint-review filed moments ago,
   * i.e. exactly the ones this read exists to return. Draining the queue first
   * costs nothing on the common path (an idle queue resolves immediately) and
   * turns a silent under-read into a correct one.
   */
  async handleListRunFindings(
    msg: Extract<McpQueryMessage, { type: 'mcp-list-run-findings' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReadOnlyRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    await ReviewItemRouter.getInstance().awaitProjectWritesSettled(ctx.projectId);

    // SESSION scope, not this one run id. In a flow step the two are the same
    // set; in a CHAT turn they are never the same, because chatSentinelProvider
    // binds the turn to the session's `__quick__` sentinel — a run that filed
    // nothing — while the findings sit on the flow run the same session owns.
    // `runScope` rides along in the reply so the agent can see what was covered
    // rather than infer it from an empty list.
    const runScope = selectSessionRunScope(this.db, msg.runId);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { findings: selectRunFindingsForRuns(this.db, runScope), runScope },
    });
  }

  /**
   * Resolve a finding the compound run consumed. Builds the resolution string
   * from resolutionKind using the SHARED prefix consts (never hand-typed, so the
   * parseResolutionKind convention cannot drift), routes the resolve through the
   * ReviewItemRouter chokepoint, and AWAITs it — a failed resolve must surface to
   * the agent rather than silently leave the finding pending.
   *
   * Mid-run-only: resolveReviewItemRunContext returns run_not_active for a
   * terminal run, so the agent must call this immediately after each finding's
   * action lands (NOT batched at run end); the RunExecutor terminal-seam close-out
   * is the safety net for whatever was missed.
   *
   * SCOPE-GUARDED (see resolveTargetInScope): the router validates only
   * (projectId, status='pending'), so without this check a single mistyped or
   * hallucinated id would silently close ANY pending item in the project — an
   * unrelated run's finding, a `decision` gate row, a `human_task`. That was
   * tolerable while `resolve_finding` was a rare compound-only call; the
   * sprint/ship address-review step now calls it N times per run with ids the
   * model transcribed from a list, so the blast radius is no longer theoretical.
   */
  /**
   * Guard `resolve_finding`'s target: it must be a `kind='finding'` row that
   * THIS run is entitled to close. Three disjoint entitlements, matching the
   * tool's legitimate callers:
   *
   *  - the run FILED it (`run_id = runId`) — sprint/ship's address-review closing
   *    out its own code-review findings;
   *  - the run was SEEDED with it (`workflow_runs.seed_finding_ids`) — a compound
   *    run acting on findings a human selected, which by definition belong to
   *    EARLIER runs. This arm is why an ownership check cannot simply be
   *    `run_id = runId`: that would break compound entirely; or
   *  - a run in the caller's OWN SESSION filed it — a chat turn closing out the
   *    findings of the flow run it is sitting on top of. Without this arm the
   *    widened read is half a loop: the agent can now SEE the flow run's
   *    findings, fix them, and then be refused `finding_not_in_run_scope` on
   *    every single resolve, because a chat's run id is the `__quick__` sentinel
   *    and never the run that filed them.
   *
   * The third arm deliberately does NOT relax the CALLER's liveness check in
   * {@link handleResolveFinding}: the caller is the sentinel, which
   * chatSentinelProvider revives to 'running' for the turn, so a chat resolves a
   * settled sibling run's finding without that run being revived or written to.
   * Session membership is the entitlement, session-mate liveness is not.
   *
   * Anything else — another run's finding, a `decision` gate, a `human_task`, a
   * missing id — is refused rather than silently closed. Read-only; the actual
   * status transition stays the router's job.
   */
  private resolveTargetInScope(
    runId: string,
    reviewItemId: string,
  ): { ok: true } | { ok: false; error: string } {
    const row = this.db
      .prepare(`SELECT kind, run_id AS runId FROM review_items WHERE id = ?`)
      .get(reviewItemId) as { kind?: string; runId?: string | null } | undefined;

    // Keep the router's existing 'not_found' code for a missing id — agents and
    // tests already key on it; only the NEW refusals get new codes.
    if (row === undefined) return { ok: false, error: 'not_found' };
    if (row.kind !== 'finding') return { ok: false, error: 'not_a_finding' };
    if (row.runId === runId) return { ok: true };

    // Same-session arm. Checked before the seed arm because it is the common
    // case for a chat turn and needs no JSON parse.
    if (
      typeof row.runId === 'string' &&
      row.runId.length > 0 &&
      selectSessionRunScope(this.db, runId).includes(row.runId)
    ) {
      return { ok: true };
    }

    // Seeded arm: the compound path. Unparseable / absent seed json ⇒ no
    // entitlement (fail closed), mirroring handleGetSelectedFindings' fail-soft
    // read but in the refusing direction, since this one is a WRITE.
    const runRow = this.db
      .prepare('SELECT seed_finding_ids AS seedFindingIds FROM workflow_runs WHERE id = ?')
      .get(runId) as { seedFindingIds?: unknown } | undefined;
    const seedJson =
      typeof runRow?.seedFindingIds === 'string' && runRow.seedFindingIds.length > 0
        ? runRow.seedFindingIds
        : null;
    if (seedJson !== null) {
      try {
        const parsed: unknown = JSON.parse(seedJson);
        if (Array.isArray(parsed) && parsed.includes(reviewItemId)) return { ok: true };
      } catch {
        // fall through to refusal
      }
    }
    return { ok: false, error: 'finding_not_in_run_scope' };
  }

  async handleResolveFinding(
    msg: Extract<McpQueryMessage, { type: 'mcp-resolve-finding' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: ctx.error,
      });
      return;
    }

    const scope = this.resolveTargetInScope(msg.runId, msg.reviewItemId);
    if (!scope.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: scope.error,
      });
      return;
    }

    // Build the resolution from the matching prefix const. 'promoted' carries the
    // minted task id (mirrors the promote-to-task path); 'fixed'/'triaged' carry
    // the optional free-text note (e.g. 'compound') when present.
    let resolution: string;
    if (msg.resolutionKind === 'promoted') {
      const tail = msg.taskId ?? msg.note ?? '';
      resolution = `${RESOLUTION_PREFIX_PROMOTED}${tail}`;
    } else if (msg.resolutionKind === 'fixed') {
      resolution = `${RESOLUTION_PREFIX_FIXED}${msg.note ?? ''}`;
    } else {
      resolution = `${RESOLUTION_PREFIX_TRIAGED}${msg.note ?? ''}`;
    }

    const triage: ReviewItemTriage = {
      op: 'resolve',
      actor: ctx.actor,
      reviewItemId: msg.reviewItemId,
      resolution,
      runId: msg.runId,
    };

    try {
      // AWAIT — a failed resolve must surface (diverges from fire-and-forget
      // report-finding so the agent can retry rather than silently move on).
      await ReviewItemRouter.getInstance().applyReviewItem(ctx.projectId, triage);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { resolved: true, review_item_id: msg.reviewItemId },
      });
    } catch (err) {
      this.writeReviewItemError(client, msg.requestId, err);
    }
  }

  /**
   * Surface a review-item failure as an ok:false response. A ReviewItemError maps
   * to its discriminated .code (mirrors writeTaskChangeError); anything else is
   * logged and collapsed to the opaque 'review_item_failed'.
   *
   * Used by the SYNCHRONOUS pre-create validations on the report-finding path
   * (entity-link + payload-discriminant), which construct ReviewItemError so the
   * codes are single-sourced from the chokepoint's error type. The async create
   * itself is fire-and-forget (the run is already replied to), so a late
   * chokepoint rejection there is logged, not written through this helper.
   */
  private writeReviewItemError(client: net.Socket, requestId: string, err: unknown): void {
    if (err instanceof ReviewItemError) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId,
        ok: false,
        error: err.code,
      });
      return;
    }
    this.logger?.error('[Cyboflow MCP Query] review item failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId,
      ok: false,
      error: 'review_item_failed',
    });
  }
}
