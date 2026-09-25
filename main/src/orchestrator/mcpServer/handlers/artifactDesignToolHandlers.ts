/**
 * ArtifactDesignToolHandlers — the run-artifact tool family (report / commit
 * through the ArtifactRouter chokepoint) and the Design Mode v0 design-scoped
 * ops (docs/ideas/design-mode.md), split out of mcpQueryHandler.ts (issue #19).
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import.
 */
import * as net from 'net';
import * as path from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'fs';
import type { DatabaseLike, LoggerLike } from '../../types';
import { getCyboflowSubdirectory } from '../../../utils/cyboflowDirectory';
import { ArtifactError, ArtifactRouter } from '../../artifactRouter';
import type { ArtifactActor } from '../../artifactRouter';
import { FeedbackError, FeedbackRouter } from '../../feedbackRouter';
import {
  ARTIFACT_POLICIES,
  MAX_PROTOTYPE_HTML_BYTES,
  PROTOTYPE_HTML_RELPATH,
} from '../../../../../shared/types/artifacts';
import type { ArtifactType } from '../../../../../shared/types/artifacts';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';

/**
 * The context McpQueryHandler composes this family with. `writeResponse` and
 * `resolveReviewItemRunContext` are private methods on the handler (the
 * review-queue and verify families share the latter), handed over as closures
 * so the moved bodies keep calling them as `this.<name>(...)` unchanged.
 */
export interface ArtifactDesignToolContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  /** Serialize one reply onto the requesting socket. */
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  /** Non-terminal run → (projectId, agent actor); the write guard the review-queue and verify families share. */
  resolveReviewItemRunContext(runId: string): { ok: true; projectId: number; actor: `agent:${string}` } | { ok: false; error: string };
}

/** A non-null object whose own keys can be safely indexed. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The run-artifact + Design Mode MCP tool family: `cyboflow_report_artifact`,
 * `cyboflow_commit_artifact` and the design-scoped `design_get_idea` /
 * `design_update_draft` / `design_ack_feedback` ops. Split out of McpQueryHandler
 * (issue #19) with every method body verbatim; the handler routes the five
 * message types here and supplies the shared run guard.
 */
export class ArtifactDesignToolHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: ArtifactDesignToolContext['writeResponse'];
  private readonly resolveReviewItemRunContext: ArtifactDesignToolContext['resolveReviewItemRunContext'];

  constructor(ctx: ArtifactDesignToolContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
    this.resolveReviewItemRunContext = ctx.resolveReviewItemRunContext;
  }

  /**
   * Create (or idempotently re-derive) a run artifact via the ArtifactRouter
   * chokepoint. Unlike report-finding this AWAITS the write so it can reply with
   * the artifact id (the agent needs it to enrich/commit later). The project +
   * actor are resolved from the run; the artifact is minted isNew so its tab
   * pulses until focused.
   */
  async handleReportArtifact(
    msg: Extract<McpQueryMessage, { type: 'mcp-report-artifact' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    // ctx.actor is `agent:${string}` (see resolveReviewItemRunContext) — a
    // strict subtype of ArtifactActor, so no 'linear'/'plane' coercion is
    // needed here: a review-item run-context actor is always agent-authored.
    const actor: ArtifactActor = ctx.actor;
    // Design Mode v0 (design-mode.md "Idea-bound artifact + read path"): stamp
    // source_ref AND session_id SERVER-SIDE from the session's validated
    // design_idea_id (NEVER from the agent payload) — source_ref makes the
    // prototype discoverable by its idea downstream (planner/sprint), session_id
    // is what the canvas's DesignApproveControl render gate + tRPC calls key on.
    // A non-design session (or a run without a session) resolves null → neither
    // field is set and behavior is unchanged.
    const designStamp = this.resolveSessionDesignStamp(msg.runId);
    try {
      // Content-blesser (IDEA-039 / Approach C), driven by the atype's
      // `blessing` policy in the artifact registry — the SOLE authority on
      // prototype/canvas payload content:
      //   - 'prototype-file' (ui-prototype AND interactive-prototype): REJECT any
      //     inline top-level `html` key (a mockup is an on-disk file, never inline
      //     bytes), validate the on-disk static document, and MINT the canonical
      //     `{ fileName: 'prototype/index.html' }` pointer — discarding whatever
      //     path/payload the producing agent claimed;
      //   - 'html-reject-only' (generic): reject inline `html`, otherwise pass the
      //     `{ url }` payload through unchanged;
      //   - 'none': no blessing (every templated atype).
      // An atype MISSING from the registry fails LOUDLY here (design-mode.md
      // acceptance) rather than slipping past to a byte-free commit. The run
      // artifacts dir is derived from the TRUSTED runId — CYBOFLOW_RUN_ARTIFACTS_DIR
      // is never read here.
      const policy = ARTIFACT_POLICIES[msg.atype as ArtifactType] as
        | (typeof ARTIFACT_POLICIES)[ArtifactType]
        | undefined;
      if (policy === undefined) {
        throw new ArtifactError('invalid_atype', `unknown artifact atype '${msg.atype}' (no policy in the artifact registry)`);
      }
      let payloadJson: string | null = msg.payloadJson ?? null;
      if (policy.blessing !== 'none') {
        const parsed = this.parseArtifactPayload(msg.payloadJson);
        if (parsed !== null && Object.prototype.hasOwnProperty.call(parsed, 'html')) {
          throw new ArtifactError(
            'invalid_payload',
            `inline 'html' is not accepted for atype '${msg.atype}' — write a self-contained static document to ${PROTOTYPE_HTML_RELPATH} and report a fileName pointer`,
          );
        }
        if (policy.blessing === 'prototype-file') {
          const validatedPath = this.validatePrototypeFile(msg.runId);
          // `contentHash` makes the minted payload change whenever the on-disk
          // bytes change: the ArtifactRouter's revision bump is delta-gated on
          // stored fields, and a bare `{ fileName }` pointer is byte-identical
          // across re-reports — so an in-place prototype edit would never
          // advance `revision`, freezing the counter the design-spec draft
          // binding and the feedback ack's applied_prototype_revision rely on.
          // An idempotent re-report (same bytes) still mints the same payload
          // and correctly does NOT bump.
          const contentHash = createHash('sha256').update(readFileSync(validatedPath)).digest('hex');
          payloadJson = JSON.stringify({ fileName: PROTOTYPE_HTML_RELPATH, contentHash });
        }
      }
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'create',
        runId: msg.runId,
        atype: msg.atype,
        label: msg.label,
        payloadJson,
        sourceRef: designStamp?.designIdeaId ?? null,
        ...(designStamp ? { sessionId: designStamp.sessionId } : {}),
        isNew: true,
        actor,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { artifactId, atype: msg.atype },
      });
    } catch (err) {
      this.writeArtifactError(client, msg.requestId, err);
    }
  }

  /**
   * Parse an artifact `payload_json` string into a plain object for the
   * content-blesser's `html`-key check. Fail-soft: unparseable / non-object /
   * absent JSON reads as `null` (no `html` key), so a malformed payload never
   * throws here — only an EXPLICIT top-level `html` member is rejected upstream.
   */
  private parseArtifactPayload(payloadJson: string | undefined): Record<string, unknown> | null {
    if (payloadJson === undefined) return null;
    try {
      const parsed = JSON.parse(payloadJson) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Validate the on-disk static `ui-prototype` document under the run's TRUSTED
   * artifacts dir (`getCyboflowSubdirectory('artifacts','runs',runId)` — NEVER
   * `process.env.CYBOFLOW_RUN_ARTIFACTS_DIR`): the canonical `prototype/index.html`
   * must exist, be a regular file (no symlink), stay inside the run artifacts root
   * (containment + realpath re-verify against an intermediate symlinked dir), and
   * sit at or below the size ceiling. Throws `ArtifactError('invalid_payload',
   * 'prototype_missing|prototype_invalid|prototype_too_large: …')` on any failure
   * so the report tool surfaces a precise reason to the producing agent.
   */
  /** Returns the validated, realpath'd absolute path of the prototype document. */
  private validatePrototypeFile(runId: string): string {
    const runRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'runs', runId));
    const target = path.resolve(runRoot, PROTOTYPE_HTML_RELPATH);
    // Containment on the resolved (pre-realpath) path — defense in depth even
    // though PROTOTYPE_HTML_RELPATH is a fixed constant.
    if (target !== runRoot && !target.startsWith(runRoot + path.sep)) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} escapes the run artifacts root`);
    }
    if (!existsSync(target)) {
      throw new ArtifactError('invalid_payload', `prototype_missing: ${PROTOTYPE_HTML_RELPATH} not found for run ${runId}`);
    }
    const lst = lstatSync(target);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} is not a regular file`);
    }
    // Realpath re-verify: an intermediate symlinked dir must not let the file
    // escape the run artifacts root (both sides realpath'd so a symlinked temp
    // root — e.g. macOS /tmp → /private/tmp — is not a false escape).
    const realRoot = realpathSync(runRoot);
    const realTarget = realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} resolves outside the run artifacts root`);
    }
    const st = statSync(realTarget);
    if (!st.isFile()) {
      throw new ArtifactError('invalid_payload', `prototype_invalid: ${PROTOTYPE_HTML_RELPATH} is not a regular file`);
    }
    if (st.size > MAX_PROTOTYPE_HTML_BYTES) {
      throw new ArtifactError('invalid_payload', `prototype_too_large: ${st.size} > ${MAX_PROTOTYPE_HTML_BYTES}`);
    }
    return realTarget;
  }

  /**
   * Commit a run artifact (flip committed) via the ArtifactRouter chokepoint.
   */
  async handleCommitArtifact(
    msg: Extract<McpQueryMessage, { type: 'mcp-commit-artifact' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    // ctx.actor is `agent:${string}` (see resolveReviewItemRunContext) — a
    // strict subtype of ArtifactActor, so no 'linear'/'plane' coercion is
    // needed here: a review-item run-context actor is always agent-authored.
    const actor: ArtifactActor = ctx.actor;
    try {
      // The tool's optional `payload_json` ("store a final payload alongside the
      // commit") is applied as a SEPARATE `update` FIRST — commit itself is
      // IDENTITY-ONLY so a byte pointer can't be stripped mid-commit right before
      // the durability snapshot (see ArtifactCommit). ui-prototype's required byte
      // is canonical regardless of payload, so this ordering can't lose content.
      if (msg.payloadJson !== undefined) {
        await ArtifactRouter.getInstance().apply(ctx.projectId, {
          op: 'update',
          artifactId: msg.artifactId,
          payloadJson: msg.payloadJson,
          actor,
        });
      }
      const { artifactId } = await ArtifactRouter.getInstance().apply(ctx.projectId, {
        op: 'commit',
        artifactId: msg.artifactId,
        actor,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { artifactId, committed: true },
      });
    } catch (err) {
      this.writeArtifactError(client, msg.requestId, err);
    }
  }

  // --------------------------------------------------------------------------
  // Design Mode v0 (docs/ideas/design-mode.md) — the design-scoped MCP ops.
  //
  // Both start from resolveDesignRunContext, which re-validates the session's
  // idea link on EVERY call (integrity is chokepoint-enforced, not FK-enforced;
  // migration 085). source_ref/session_id stamping for the design prototype
  // rides the shared handleReportArtifact path (resolveSessionDesignStamp).
  // --------------------------------------------------------------------------

  /**
   * The run's design-session stamp — `{ designIdeaId, sessionId }` — or null for
   * a non-design session (or a run without a session). Read via the SAME
   * `workflow_runs LEFT JOIN sessions` shape as resolveRunPermissionMode. Used
   * ONLY to stamp an artifact's source_ref AND session_id SERVER-SIDE (never
   * from the agent payload): source_ref makes a design prototype discoverable by
   * its idea downstream (design-mode.md "Idea-bound artifact + read path"), and
   * session_id is what the frontend DesignApproveControl render gate keys on
   * (ArtifactTabRenderer's CanvasBody needs `artifact.sessionId` to call
   * `cyboflow.design.draftStatus`/`approve` — without it the Approve control
   * never renders, which the v0 live smoke caught). A join miss / NULL
   * design_idea_id yields null → neither field is set, so the report path for a
   * non-design session stays byte-identical.
   */
  private resolveSessionDesignStamp(runId: string): { designIdeaId: string; sessionId: string } | null {
    const row = this.db
      .prepare(
        `SELECT s.design_idea_id AS designIdeaId, r.session_id AS sessionId
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { designIdeaId?: unknown; sessionId?: unknown } | undefined;
    const ideaId = row?.designIdeaId;
    const sessionId = row?.sessionId;
    if (typeof ideaId !== 'string' || ideaId.length === 0) return null;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    return { designIdeaId: ideaId, sessionId };
  }

  /**
   * Resolve + re-validate the design-session context for a design-scoped MCP op
   * (design-mode.md "Idea link — integrity contract"): EVERY design-scoped op
   * re-runs this so a cross-project id, a deleted/decomposed/archived idea, or a
   * non-design session is rejected at the write chokepoint. Steps:
   *   - the 'orchestrator' sentinel has no run row → design_requires_real_run;
   *   - a missing run row → run_not_found;
   *   - the run's session carries no design_idea_id → not_a_design_session;
   *   - the linked idea is missing / decomposed / archived → the user-visible
   *     'idea_link_broken: idea link broken — relink or end the design session'
   *     soft state (contract (c)); a cross-project idea id → wrong_project
   *     (contract (b)).
   * On success returns the project + session ids and the validated idea identity.
   */
  private resolveDesignRunContext(
    runId: string,
  ):
    | {
        ok: true;
        projectId: number;
        sessionId: string;
        ideaId: string;
        idea: { id: string; ref: string; title: string; body: string | null; version: number };
      }
    | { ok: false; error: string } {
    if (runId === 'orchestrator') {
      return { ok: false, error: 'design_requires_real_run' };
    }

    const runRow = this.db
      .prepare(
        `SELECT r.project_id AS projectId, r.session_id AS sessionId, s.design_idea_id AS designIdeaId
           FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
          WHERE r.id = ?`,
      )
      .get(runId) as { projectId?: unknown; sessionId?: unknown; designIdeaId?: unknown } | undefined;
    if (!runRow) {
      return { ok: false, error: 'run_not_found' };
    }

    const designIdeaId =
      typeof runRow.designIdeaId === 'string' && runRow.designIdeaId.length > 0 ? runRow.designIdeaId : null;
    if (designIdeaId === null) {
      return { ok: false, error: 'not_a_design_session' };
    }
    const projectId = typeof runRow.projectId === 'number' ? runRow.projectId : Number(runRow.projectId);
    const sessionId = typeof runRow.sessionId === 'string' ? runRow.sessionId : '';

    const ideaRow = this.db
      .prepare(
        `SELECT id, project_id AS projectId, ref, title, body, version,
                decomposed_at AS decomposedAt, archived_at AS archivedAt
           FROM ideas WHERE id = ?`,
      )
      .get(designIdeaId) as
      | {
          id?: unknown;
          projectId?: unknown;
          ref?: unknown;
          title?: unknown;
          body?: unknown;
          version?: unknown;
          decomposedAt?: unknown;
          archivedAt?: unknown;
        }
      | undefined;
    // The idea was deleted / decomposed / archived mid-session, or was never a
    // real idea — the same user-visible broken-link state either way.
    if (!ideaRow) {
      return { ok: false, error: 'idea_link_broken: idea link broken — relink or end the design session' };
    }
    const ideaProjectId = typeof ideaRow.projectId === 'number' ? ideaRow.projectId : Number(ideaRow.projectId);
    if (ideaProjectId !== projectId) {
      // Cross-project id — contract (b). Distinct from the soft broken-link state.
      return { ok: false, error: 'wrong_project' };
    }
    if (ideaRow.decomposedAt !== null && ideaRow.decomposedAt !== undefined) {
      return { ok: false, error: 'idea_link_broken: idea link broken — relink or end the design session' };
    }
    if (ideaRow.archivedAt !== null && ideaRow.archivedAt !== undefined) {
      return { ok: false, error: 'idea_link_broken: idea link broken — relink or end the design session' };
    }

    return {
      ok: true,
      projectId,
      sessionId,
      ideaId: designIdeaId,
      idea: {
        id: designIdeaId,
        ref: typeof ideaRow.ref === 'string' ? ideaRow.ref : '',
        title: typeof ideaRow.title === 'string' ? ideaRow.title : '',
        body: typeof ideaRow.body === 'string' ? ideaRow.body : null,
        version: typeof ideaRow.version === 'number' ? ideaRow.version : Number(ideaRow.version),
      },
    };
  }

  /**
   * Return the design session's linked idea (ref/title/body/version). Re-runs
   * the full integrity re-validation via resolveDesignRunContext, so a broken
   * link surfaces here too (the agent's contract is to stop writing on it).
   */
  handleDesignGetIdea(
    msg: Extract<McpQueryMessage, { type: 'mcp-design-get-idea' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveDesignRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        ref: ctx.idea.ref,
        title: ctx.idea.title,
        body: ctx.idea.body,
        version: ctx.idea.version,
      },
    });
  }

  /**
   * Persist the session's current design-spec draft with a per-session monotonic
   * draft_revision (COALESCE(MAX(draft_revision),0)+1), bound to the session's
   * CURRENT ui-prototype artifact (its id + `artifacts.revision`) so Approve can
   * CAS-reject a draft written against an older prototype (design-mode.md
   * "Design-spec draft"). The binding is NULL when no prototype exists yet (the
   * draft is not yet approvable). Replies { draftRevision, boundArtifactRevision }.
   */
  handleDesignUpdateDraft(
    msg: Extract<McpQueryMessage, { type: 'mcp-design-update-draft' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveDesignRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // The session's single current prototype — THE prototype-family selection
    // rule, mirrored verbatim in draftStatus (design.ts router) and
    // pickPrototype (DesignModeSurface); change all three together:
    //   1. payload-bearing beats the bytes-less re-entry stub;
    //   2. 'interactive-prototype' beats 'ui-prototype' — an explicit
    //      mid-session tier switch leaves BOTH rows payload-bearing, and the
    //      interactive tier is the live canvas from then on (the lo-fi row may
    //      hold a HIGHER revision from its earlier life, which is why revision
    //      alone must never break this tie);
    //   3. revision, then created_at, as residual tie-breaks (one artifact per
    //      atype makes these near-moot, kept for determinism).
    // NULLs when none exists yet.
    const proto = this.db
      .prepare(
        `SELECT id, revision FROM artifacts
         WHERE run_id = ? AND atype IN ('ui-prototype', 'interactive-prototype')
         ORDER BY (payload_json IS NOT NULL) DESC, (atype = 'interactive-prototype') DESC,
                  revision DESC, created_at DESC
         LIMIT 1`,
      )
      .get(msg.runId) as { id?: unknown; revision?: unknown } | undefined;
    const boundArtifactId = typeof proto?.id === 'string' ? proto.id : null;
    const boundArtifactRevision = typeof proto?.revision === 'number' ? proto.revision : null;

    const draftId = `dsd_${randomBytes(12).toString('hex')}`;
    let draftRevision = 0;
    // MAX + INSERT in one transaction so draft_revision stays monotonic under the
    // UNIQUE(session_id, draft_revision) constraint even if two writes race.
    const txn = this.db.transaction(() => {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(draft_revision), 0) AS maxRev FROM design_spec_drafts WHERE session_id = ?')
        .get(ctx.sessionId) as { maxRev: number };
      draftRevision = (maxRow.maxRev ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO design_spec_drafts
             (id, session_id, idea_id, draft_revision, spec_markdown, bound_artifact_id, bound_artifact_revision)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(draftId, ctx.sessionId, ctx.ideaId, draftRevision, msg.specMarkdown, boundArtifactId, boundArtifactRevision);
    });
    (txn as () => void)();

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { draftRevision, boundArtifactRevision },
    });
  }

  /**
   * Acknowledge a delivered design-feedback batch (Design Mode v1 —
   * design-mode.md "Design feedback v1 — acknowledged durable outbox"). The
   * revision turn carried the batch + attempt ids; the agent echoes them back
   * with the prototype artifact revision that now contains the change, and the
   * FeedbackRouter's ONE-RESULT CAS decides whether this ack is the winner.
   *
   * Guard chain, in order:
   *   - the full design-session integrity re-validation (resolveDesignRunContext),
   *     so a broken idea link / non-design session / cross-project id is rejected
   *     here exactly as on every other design-scoped op;
   *   - the batch must EXIST (`batch_not_found`) and must belong to THIS design
   *     session (`batch_not_in_session`) — a design session acking another
   *     session's batch would let one session close out another's feedback.
   *
   * The losing duplicate is DATA, not an error: `{ applied: false, note }`. Only
   * a genuinely malformed request or a chokepoint failure replies ok:false.
   */
  async handleDesignAckFeedback(
    msg: Extract<McpQueryMessage, { type: 'mcp-design-ack-feedback' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveDesignRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const batch = this.db
      .prepare('SELECT id, session_id AS sessionId FROM feedback_batches WHERE id = ?')
      .get(msg.batchId) as { id?: unknown; sessionId?: unknown } | undefined;
    if (!batch) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: `batch_not_found: no feedback batch ${msg.batchId}`,
      });
      return;
    }
    if (batch.sessionId !== ctx.sessionId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: `batch_not_in_session: feedback batch ${msg.batchId} does not belong to this design session`,
      });
      return;
    }

    try {
      const result = await FeedbackRouter.getInstance().applyBatchResult({
        batchId: msg.batchId,
        attemptId: msg.attemptId,
        prototypeRevision: msg.prototypeRevision,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: result.applied
          ? { applied: true }
          : {
              applied: false,
              note: 'already resolved — this batch was acknowledged by an earlier attempt; nothing further to do',
            },
      });
    } catch (err) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error:
          err instanceof FeedbackError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  /** Surface an ArtifactError code (or a generic message) as an ok:false reply. */
  private writeArtifactError(client: net.Socket, requestId: string, err: unknown): void {
    const error =
      err instanceof ArtifactError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
    this.writeResponse(client, { type: 'mcp-query-response', requestId, ok: false, error });
  }
}
