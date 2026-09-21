/**
 * VerifyToolHandlers — the visual-verification + ad-hoc-eval MCP tool family,
 * split out of mcpQueryHandler.ts (issue #19). Every §-reference is to
 * docs/proposals/verification-setup-flow.md unless it names another doc.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import — the scheduler, the
 * runbook store and the eval snapshot arrive through McpQueryHandlerDeps.
 */
import * as net from 'net';
import type { DatabaseLike, LoggerLike } from '../../types';
import { VERIFY_SETUP_WORKFLOW_NAME } from '../../../../../shared/types/workflows';
import { resolveRunFrozenSpec } from '../../runFrozenSpec';
import { QUICK_WORKFLOW_NAME } from '../../workflowRegistry';
import {
  AGENT_REQUEST_TIMEOUT_CEILING_MS,
  VerificationScheduler,
} from '../../verify/verificationScheduler';
import {
  SHIPPED_VERIFY_BACKENDS,
  resolveVisualVerification,
} from '../../visualVerificationResolver';
import { loadVerifyConfig } from '../../verifyConfigLoader';
import { laneEnqueueKeyFor, prepareVerificationEnqueue } from '../../verify/enqueueFromTask';
import {
  captureSnapshotSha,
  isRunbookCommittedAtHead,
  isWorktreeDirty,
} from '../../verify/snapshotProvisioner';
import {
  VERIFY_RUNBOOK_MODALITIES,
  VERIFY_RUNBOOK_RELATIVE_PATH,
  isVerifyRunbookModality,
} from '../../../../../shared/types/verifyRunbook';
import {
  FALLBACK_CHAINS,
  deriveLegacyInputFromTask,
  isVerificationType,
  parseVerificationTaskV1,
  resolveTaskModality,
} from '../../../../../shared/types/visualVerification';
import type {
  VerificationRequestInput,
  VerificationTaskV1,
  VerificationType,
  VerifyChainEntry,
  VisualBackendId,
} from '../../../../../shared/types/visualVerification';
import type { AdHocSnapshotResult } from '../../eval/snapshotRunForEval';
import { SprintLaneStore } from '../../sprintLaneStore';
import type { SprintLaneRow } from '../../../../../shared/types/sprintBatch';
import { runHasControllerVisualVerify } from '../../laneChainResolution';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';

/**
 * The context the McpQueryHandler composes this family with. `writeResponse`
 * and the four readers are private methods on the handler, handed over as
 * closures so they stay private there while the moved bodies keep calling
 * them as `this.<name>(...)` unchanged.
 */
export interface VerifyToolContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
  /** Non-terminal run → (projectId, agent actor); the same guard the review-item family uses. */
  resolveReviewItemRunContext(
    runId: string,
  ): { ok: true; projectId: number; actor: `agent:${string}` } | { ok: false; error: string };
  /** The run's worktree_path, or null when the run row is absent. */
  resolveRunWorktree(runId: string): string | null;
  /** The project's on-disk path, or null when unreadable. */
  resolveProjectPath(projectId: number): string | null;
  /** workflow_runs.execution_model, or null when the run row is absent. */
  readExecutionModel(runId: string): string | null;
}

/** A non-null object whose own keys can be safely indexed (the handler's same-named guard). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Wire error per ad-hoc-eval rejection reason (`cyboflow_run_eval`). Keyed by the
 * AdHocSnapshotResult reason union, so a new reason fails the build here instead
 * of silently degrading to an undefined error string. Each value is
 * `<code>: <human-readable explanation>` — the calling agent gets a machine token
 * to branch on AND enough prose to decide whether to stop asking.
 */
const AD_HOC_EVAL_REJECTION_ERRORS: Record<
  Extract<AdHocSnapshotResult, { outcome: 'rejected' }>['reason'],
  string
> = {
  run_not_found: 'run_not_found: this session has no workflow_runs row to grade.',
  tagged_run:
    'adhoc_eval_tagged_run_rejected: this run is part of an A/B experiment or variant rotation. ' +
    'Tagged runs auto-grade at settle so both arms are scored under identical conditions; an ' +
    'ad-hoc eval would replace that canonical score and distort the comparison.',
  exists_auto:
    'adhoc_eval_exists_auto: this run already has its canonical automatic eval, which is never ' +
    "overwritten. See the run's quality panel (or retry it there) instead.",
  no_diff:
    'adhoc_eval_no_diff: no diff was captured for this run (no worktree, or nothing changed since ' +
    'its base), so there is nothing to grade.',
};

/**
 * Default wait budget for `cyboflow_await_verification` when the caller names
 * none (docs/proposals/verification-setup-flow.md §5.2 seam 2). Fifteen minutes
 * sits deliberately between the agent engine's 10-minute default deadline and its
 * 20-minute ceiling ({@link AGENT_REQUEST_TIMEOUT_CEILING_MS}, which is also this
 * tool's clamp): long enough that an ordinary proof run — cold build, boot,
 * drive, judge — is awaited to completion rather than abandoned one minute short,
 * and short enough that a wedged request cannot hold a flow's turn hostage for
 * longer than the request could legally live.
 */
const AWAIT_VERIFICATION_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

// --------------------------------------------------------------------------
// Visual verification request (cyboflow_request_verification)
//
// FIRE-AND-CONTINUE producer seam (docs/proposals/visual-verification-design.md §"The
// collision story" #1): resolve the run's IMMUTABLY-stamped verify posture
// (migration 055 verify_enabled / verify_type / verify_chain), enqueue ONE
// verification_requests row via the VerificationScheduler chokepoint, and reply
// { requestId } SYNCHRONOUSLY — the lane is never held on the verdict. The
// scheduler drains on its OWN setImmediate loop (NOT RunQueueRegistry), captures
// + judges, and delivers the verdict asynchronously.
//
// Two invariants enforced here:
//  - A run with verify_enabled=0 replies { skipped:true } — NEVER an error (a
//    disabled run must not wedge a lane; mirrors the resolver's disabled posture).
//  - typeOverride only NARROWS: the effective chain is intersected with the run's
//    stamped verify_chain, so an override can neither enable a disabled run nor
//    introduce a backend the host lacks (the stamped chain is the host-available
//    set the resolver already filtered).
// --------------------------------------------------------------------------

/**
 * The visual-verification + ad-hoc-eval MCP tool family: `cyboflow_request_verification`,
 * `cyboflow_await_verification`, `cyboflow_get_verifications`,
 * `cyboflow_register_verify_runbook` and `cyboflow_run_eval`. Split out of
 * McpQueryHandler (issue #19) with every method body verbatim; the handler
 * routes the five message types here and supplies the shared readers.
 */
export class VerifyToolHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: VerifyToolContext['writeResponse'];
  private readonly resolveReviewItemRunContext: VerifyToolContext['resolveReviewItemRunContext'];
  private readonly resolveRunWorktree: VerifyToolContext['resolveRunWorktree'];
  private readonly resolveProjectPath: VerifyToolContext['resolveProjectPath'];
  private readonly readExecutionModel: VerifyToolContext['readExecutionModel'];

  constructor(ctx: VerifyToolContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
    this.resolveReviewItemRunContext = ctx.resolveReviewItemRunContext;
    this.resolveRunWorktree = ctx.resolveRunWorktree;
    this.resolveProjectPath = ctx.resolveProjectPath;
    this.readExecutionModel = ctx.readExecutionModel;
  }

  /**
   * Narrow the camelCase viewports wire value to VerificationRequestInput.viewports,
   * keeping only well-formed entries ({ width:number, height:number, label?:string })
   * and dropping malformed ones. Returns undefined when the input is not an array OR
   * no entry survives — an agent typo never fails a fire-and-continue request.
   */
  private parseViewports(v: unknown): VerificationRequestInput['viewports'] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out: NonNullable<VerificationRequestInput['viewports']> = [];
    for (const entry of v) {
      if (!isRecord(entry) || typeof entry.width !== 'number' || typeof entry.height !== 'number') continue;
      out.push(
        typeof entry.label === 'string'
          ? { width: entry.width, height: entry.height, label: entry.label }
          : { width: entry.width, height: entry.height },
      );
    }
    return out.length > 0 ? out : undefined;
  }

  /**
   * Enqueue a visual-verification request for the run and reply { requestId }, or
   * { skipped:true } when the run has verify disabled. Synchronous (no await on the
   * verdict). Guards mirror the other run-bound writes (sentinel / missing /
   * terminal run reject via resolveReviewItemRunContext). Fully fail-soft: any
   * unexpected error is surfaced as an ok:false reply rather than throwing.
   *
   * DUAL-FORMAT (redesign §5.2): when `msg.task` is present it is strictly
   * validated (parseVerificationTaskV1) — an invalid task replies ok:false with
   * `invalid_verification_task: <error>` and enqueues nothing. A valid task is
   * authoritative: the legacy `deliverable_json` shape is DERIVED from it
   * (deriveLegacyInputFromTask) rather than from `intent`/`url`/`htmlPath`, and
   * both the derived input AND the task are passed to the scheduler so
   * `task_json` dual-writes alongside `deliverable_json`. `msg.task` absent ⇒ this
   * method's behavior is byte-identical to the pre-redesign legacy path.
   *
   * PHASE 2 (docs/proposals/verification-setup-flow.md §5.2 seams 1+3, §7.2)
   * inserts ONE shared step between validation and enqueue —
   * `prepareVerificationEnqueue`, the same function the programmatic
   * `enqueueTaskVerification` seam calls — which (a) REJECTS a task whose
   * build/serve mutates dependencies, with `forbidden_dependency_command: …`
   * named exactly like the `invalid_verification_task` rejection above, and (b)
   * injects the project's PROVEN runbook revision + its content-addressed pin.
   * Sharing it is the point: two enqueue paths applying two versions of one rule
   * is how a guard stops covering half the traffic.
   *
   * ASYNC as of that step (the runbook status re-validates a file against a
   * hash, an input-hash and a host fingerprint — all filesystem work). The reply
   * is still written before any verdict exists, so the fire-and-continue
   * contract the tool advertises is unchanged.
   *
   * SETUP PROOF (§3.6/§5.3). `setupProof` + the `runbookHash`/`runbookLocalVersion`
   * pin are the phase-2 setup flow's channel through this SAME handler rather
   * than a parallel one. Together they say "this request exists to PROVE the
   * revision I just registered": the row is stamped budget-exempt and
   * lower-priority, the §3.2 "no proven runbook" gate is bypassed (a project
   * cannot prove a runbook if being unproven blocks the proof), and a PASS is
   * what the ENGINE — never the flow — turns into `markProven`. The pin is
   * supplied rather than resolved for the same reason: the revision under proof
   * is by construction not yet proven, so the lookup would find nothing.
   *
   * `setupProof:true` is a self-declared EXEMPTION from both of those gates, so
   * (Codex adversarial-review finding 4) it is itself gated: authorized against
   * the run's FROZEN workflow identity (must be `verify-setup`) and required to
   * carry a pin that resolves to a draft actually registered via
   * `cyboflow_register_verify_runbook` — see the `msg.setupProof === true`
   * block below for the two checks and their reasoning.
   *
   * ORDINARY REQUESTS NEVER CARRY A WIRE PIN. A caller-supplied pin is
   * meaningful ONLY inside that authorized envelope; without `setupProof:true`
   * the `runbookHash`/`runbookLocalVersion` wire fields are dropped before
   * `prepareVerificationEnqueue` sees them, so the engine-resolved PROVEN
   * revision is the only pin an ordinary request can end up with. Otherwise the
   * pin's "authoritative, skip the lookup" semantics would let any caller
   * suppress the injection with an invented hash and ride the resulting
   * runbook/sha mismatch into an advancing skip (round-3 finding 1; the full
   * argument sits at the `wirePin` parse below).
   *
   * SNAPSHOT SHA is captured here too, from the run's worktree, so an
   * MCP-enqueued request gets the same lane-isolated snapshot build as a
   * programmatically enqueued one (round-3 finding 2; see the capture below).
   */
  async handleRequestVerification(
    msg: Extract<McpQueryMessage, { type: 'mcp-request-verification' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // OWNERSHIP GUARD: when a programmatic run's workflow controller owns the
    // enqueue it is the ONLY legitimate enqueuer, and it goes through its direct
    // host capability (verify/enqueueFromTask.ts) — never this socket path. An
    // MCP-path call on such a run is therefore a step turn firing the tool it was
    // told not to (the per-spawn disallowedTools denial only reaches the Claude
    // SDK manager; Codex and interactive turns ignore it), so reject it here —
    // provider-independently — before a rogue keyless request can race the
    // controller's own enqueue at the merge gate. Fail-soft read: a missing /
    // pre-schema execution_model resolves null and falls through.
    //
    // SCOPED by `runHasControllerVisualVerify`, not by the execution model alone.
    // "Programmatic" was only ever a proxy for "the controller enqueues", and
    // `verify-setup` is the counterexample: programmatic, no fan-out, no
    // controller-owned visual-verify step, and its `prove` step's entire
    // deliverable is firing a `setup_proof` request through THIS path. Guarding
    // on the execution model alone rejected it, leaving the flow that bootstraps
    // verification unable to prove anything (live dogfood run, 2026-07-31). A run
    // with no such step has no controller enqueue to race. The predicate
    // fail-CLOSES on an unresolvable definition, so an unreadable run keeps the
    // old deny posture. Every other authorization below is unchanged — a
    // `setup_proof` claim still has to be a verify-setup run with a registered pin.
    if (
      this.readExecutionModel(msg.runId) === 'programmatic' &&
      runHasControllerVisualVerify(this.db, msg.runId)
    ) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error:
          'programmatic_run_verification_rejected: verification enqueues on this run are ' +
          'controller-owned (its chain has a visual-verify step). Do not fire this tool — print the ' +
          'visual-verification contract as TEXT in your final message and the controller will enqueue it.',
      });
      return;
    }

    // The run's FROZEN workflow identity, resolved ONCE up here because two
    // things below need it: the `__quick__` late-binding branch immediately
    // after, and the `setup_proof` authorization further down (which used to
    // make this call itself, inside its own block).
    const frozenSpec = resolveRunFrozenSpec(this.db, msg.runId);
    const isQuickRun = frozenSpec?.workflowName === QUICK_WORKFLOW_NAME;

    // Read the run's IMMUTABLE verify stamp (migration 055). Read defensively — a
    // pre-036 DB lacking the columns degrades to a disabled posture (skipped).
    let enabled = false;
    let stampedType: VerificationType | null = null;
    let stampedChain: VisualBackendId[] = [];
    try {
      const row = this.db
        .prepare(
          `SELECT verify_enabled AS verifyEnabled, verify_type AS verifyType, verify_chain AS verifyChain
             FROM workflow_runs WHERE id = ?`,
        )
        .get(msg.runId) as { verifyEnabled?: unknown; verifyType?: unknown; verifyChain?: unknown } | undefined;
      enabled = row?.verifyEnabled === 1 || row?.verifyEnabled === true;
      stampedType = isVerificationType(row?.verifyType) ? row.verifyType : null;
      stampedChain = this.parseStampedChain(row?.verifyChain);
    } catch {
      // Pre-migration-036 DB (no verify columns) — keep the disabled default.
      enabled = false;
    }

    // QUICK-SESSION LATE BINDING: a `__quick__` chat sentinel resolves its posture
    // NOW instead of reading the stamp above. See `getVisualVerifyConfig` on
    // McpQueryHandlerDeps for why the stamp cannot serve here (minted once per
    // session, no UPDATE path — a session predating the master switch would be
    // disabled forever).
    //
    // This honors the EXISTING enablement ladder rather than adding a setting:
    // the same `resolveVisualVerification` `createRun` calls, fed the same global
    // rung and the same project rung — just read at call time. The chain it
    // returns is used VERBATIM (not intersected) further down; that resolved
    // chain is what the scheduler's request-level dispatch key reads.
    let quickResolvedChain: VerifyChainEntry[] | null = null;
    if (isQuickRun && this.deps.getVisualVerifyConfig !== undefined) {
      const globalConfig = this.deps.getVisualVerifyConfig();
      // PROJECT RUNG, WORKTREE-FIRST — matching the runtime resolution order in
      // verifyConfigLoader's resolveDeliverableContext. A quick session editing
      // its own `.cyboflow/verify.json` must see that edit take effect without
      // merging first; reading the project checkout instead would make the
      // session's own config change inert, which is precisely the case this
      // late binding exists to serve. Falls back to the project checkout when the
      // worktree has no (or an unparseable) config.
      const worktreePath = this.resolveRunWorktree(msg.runId);
      let projectVerifyConfig = worktreePath === null ? null : await loadVerifyConfig(worktreePath, this.logger);
      if (projectVerifyConfig === null) {
        const projectPath = this.resolveProjectPath(ctx.projectId);
        if (projectPath !== null) projectVerifyConfig = await loadVerifyConfig(projectPath, this.logger);
      }

      const resolved = resolveVisualVerification({
        // No `setupFlowBootstrap` rung: a quick session is not the setup flow and
        // must not inherit its deadlock-breaking exemption.
        requestedEnabled: null,
        projectConfigEnabled: projectVerifyConfig?.enabled ?? null,
        globalDefaultEnabled: globalConfig.enabled,
        requestedType: isVerificationType(msg.typeOverride) ? msg.typeOverride : null,
        projectConfigDefaultType: projectVerifyConfig?.defaultType ?? null,
        globalDefaultType: globalConfig.defaultType,
        deliverable: null,
        availableBackends: SHIPPED_VERIFY_BACKENDS,
        // MUST be passed, exactly as createRun does (workflowRegistry.ts:1422).
        // Omitting it defaults to the AGENT engine, which would mint an agent
        // posture on a host explicitly rolled back to the legacy waterfall.
        legacyEngine: process.env.CYBOFLOW_VERIFY_LEGACY === '1',
      });
      enabled = resolved.enabled;
      stampedType = resolved.type;
      quickResolvedChain = resolved.enabled ? resolved.chain : null;
    }

    // Disabled run → no-op SKIP (never an error). A typeOverride cannot enable it.
    //
    // The ack ALWAYS names its reason. A bare `{ skipped: true }` is not a usable
    // answer for the caller: at least three different conditions skip a request
    // (this branch, plus the scheduler's §3.2 no-proven-runbook degrade and its
    // capability suppressions), and an agent handed an unlabelled skip has no way
    // to tell them apart — so it GUESSES, and the guess reads to a human as a
    // diagnosis. That is not hypothetical: a quick session skipped here for a
    // plain disabled switch reported "no proven verification runbook" to the user,
    // because that was the only skip reason named anywhere in its context.
    if (!enabled || stampedType === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { skipped: true, reason: this.disabledSkipReason(isQuickRun, enabled) },
      });
      return;
    }

    // Effective type: a valid typeOverride NARROWS to its own type; otherwise the
    // run's stamped type. (Validity is already guaranteed by the wire union, but we
    // re-guard since the field flows in untrusted across the socket.)
    const effectiveType: VerificationType = isVerificationType(msg.typeOverride) ? msg.typeOverride : stampedType;

    // Effective chain = FALLBACK_CHAINS[effectiveType] ∩ the run's stamped chain
    // (the host-available set the resolver already filtered). The intersection is
    // why typeOverride can only NARROW — it can never reach a backend the host lacks.
    // Order follows FALLBACK_CHAINS (easy→hard). An empty intersection still enqueues
    // (the scheduler treats an empty chain as a SKIP, never a fabricated fail).
    //
    // QUICK RUNS write their CALL-TIME-RESOLVED chain VERBATIM instead. This is
    // what makes the feature reachable at all: `VerificationScheduler.processRow`
    // decides the engine via `isAgentEngineRequest`, whose first rung is the
    // request's own `chain_json`. Intersecting here would erase the resolved
    // `['agent']` selector ('agent' is not a VisualBackendId, so it survives no
    // intersection), the row would fall to the legacy waterfall, select no
    // candidate, and terminate `skipped: 'no usable backend'` behind a
    // healthy-looking `{ requestId }` reply.
    //
    // FLOW RUNS ARE UNCHANGED — byte-for-byte. `quickResolvedChain` is null for
    // every non-quick run, and an agent-stamped flow run's intersection already
    // evaluates to `[]` today (parseStampedChain narrows to VisualBackendId[],
    // which drops 'agent'), so its dispatch still resolves off the run stamp
    // exactly as before.
    const chain =
      quickResolvedChain !== null
        ? [...quickResolvedChain]
        : FALLBACK_CHAINS[effectiveType].filter((backend) => stampedChain.includes(backend));

    // DUAL-FORMAT CONTRACT (redesign §5.2): when `task` is present it is
    // authoritative for the deliverable. Strictly validate it FIRST — an invalid
    // task must never fall through to a bogus legacy-shaped enqueue.
    let task: VerificationTaskV1 | undefined;
    if (msg.task !== undefined) {
      const parsed = parseVerificationTaskV1(msg.task);
      if (!parsed.ok) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `invalid_verification_task: ${parsed.error}`,
        });
        return;
      }
      task = parsed.task;
    }

    let input: VerificationRequestInput;
    if (task) {
      // taskRef precedence: task.taskRef ?? the wire task_ref arg (§5.2 "written
      // identically into both columns"). deriveLegacyInputFromTask applies exactly
      // this precedence; the legacy per-field url/htmlPath/baselineKey/viewports
      // wire args are superseded by the task (task is authoritative).
      const wireTaskRef = typeof msg.taskRef === 'string' && msg.taskRef.length > 0 ? msg.taskRef : undefined;
      input = deriveLegacyInputFromTask(task, wireTaskRef);
      // Neither the task nor the wire carried a taskRef: fall back to the existing
      // single-lane default (same mitigation as the legacy path below), and
      // reflect the defaulted value into BOTH the persisted input AND the task
      // object so deliverable_json and task_json agree (§5.2).
      if (input.taskRef === undefined) {
        const defaulted = this.defaultTaskRefForRun(msg.runId);
        if (defaulted !== undefined) {
          input.taskRef = defaulted;
          task = { ...task, taskRef: defaulted };
        }
      } else if (task.taskRef !== input.taskRef) {
        task = { ...task, taskRef: input.taskRef };
      }
    } else {
      // Build the deliverable input, dropping any malformed optional members.
      input = { intent: msg.intent };
      if (typeof msg.url === 'string') input.url = msg.url;
      if (typeof msg.htmlPath === 'string') input.htmlPath = msg.htmlPath;
      if (typeof msg.baselineKey === 'string') input.baselineKey = msg.baselineKey;
      // taskRef threads the lane attribution into deliverable_json so the async
      // merge-gate verdict can be driven onto the right lane (multi-lane batches).
      // When the agent OMITS it, best-effort default it from the lane context WHEN
      // unambiguous (a single-lane batch) — a belt-and-suspenders mitigation for the
      // gate's strict attribution (locked decision #2). A multi-lane batch CANNOT be
      // defaulted here (the wire carries no itemId), so it stays absent and the
      // gate's single-lane-only rule for a taskRef-less event is the invariant.
      if (typeof msg.taskRef === 'string' && msg.taskRef.length > 0) {
        input.taskRef = msg.taskRef;
      } else {
        const defaulted = this.defaultTaskRefForRun(msg.runId);
        if (defaulted !== undefined) input.taskRef = defaulted;
      }
      const viewports = this.parseViewports(msg.viewports);
      if (viewports !== undefined) input.viewports = viewports;
    }

    // §7.2 guard + §5.2 seam-3 injection, shared with the programmatic seam. A
    // rejection replies ok:false and enqueues NOTHING (mirroring the
    // invalid_verification_task posture above); an injection replaces the task's
    // build/serve/attestation with the proven runbook's and hands back the pin to
    // stamp. The legacy intent-only path (no `task`) passes through untouched.
    //
    // A CALLER-SUPPLIED PIN SHORT-CIRCUITS THE LOOKUP (§5.2/§5.3): the setup
    // flow's proof run pins the DRAFT it is trying to prove, which by definition
    // is not proven yet — requiring a proven record for it would be the same
    // bootstrap deadlock §3.6 exempts it from at the degrade gate. Both halves
    // must arrive together; half a pin is dropped rather than stamped, since the
    // runner's CAS would have nothing to validate against.
    //
    // PARSED HERE, THREADED ONLY UNDER THE SETUP-PROOF ENVELOPE (Codex round-3
    // finding 1). `prepareVerificationEnqueue`'s rule — "a caller-supplied pin
    // is authoritative, stamp it verbatim, skip the proven-runbook lookup" — was
    // written for the setup flow, whose pin the block below authorizes. Handing
    // an ORDINARY request the same short-circuit turns two optional wire fields
    // into a silent kill switch for verification itself: any orchestrated agent
    // sending `runbook_hash: 'bogus'` suppresses the engine's proven-revision
    // injection, the runner's CAS then rejects the pin as a runbook/sha
    // mismatch, and the mismatch env-SKIPS — and a skip ADVANCES the lane. No
    // real hash is needed, which is the whole point: the attack costs a string.
    // So the wire pin is parsed unconditionally (the authorization block needs
    // it to validate) but reaches the engine ONLY inside the authorized
    // setup-proof envelope; an ordinary request's pin fields are DROPPED, making
    // the engine-resolved proven revision the only pin such a request can ever
    // carry. Enforced at THIS seam because this is where untrusted input
    // crosses — the shared function has an in-process caller that was never the
    // threat model, and gating it there too would be a second belt.
    const wirePin =
      typeof msg.runbookHash === 'string' &&
      msg.runbookHash.length > 0 &&
      typeof msg.runbookLocalVersion === 'number' &&
      Number.isFinite(msg.runbookLocalVersion)
        ? { hash: msg.runbookHash, localVersion: msg.runbookLocalVersion }
        : undefined;

    // SETUP-PROOF AUTHORIZATION (Codex adversarial-review finding 4). The MCP
    // socket is the UNTRUSTED seam: any orchestrated agent's tool call — a
    // prompt-injected one, a copy-pasted example, an ordinary sprint/ship/
    // compound lane reaching for `setup_proof:true` because it read the
    // verify-setup workflow prompt once — can set this flag with no
    // authorization at all, and until this gate existed it was honored
    // unconditionally. `setupProof:true` BYPASSES both the §3.2 "no proven
    // runbook" degrade gate and the project's lifetime verification budget
    // (see the SETUP PROOF paragraph in this method's doc-comment above), so
    // an unauthorized claim is not a quota nuisance — it is a way to make
    // every subsequent verification for the project silently free and
    // gate-exempt. Enforced HERE, once, at the seam an untrusted caller
    // actually crosses.
    //
    // IN-PROCESS ENGINE CALLERS STAY FREE. `prepareVerificationEnqueue` is
    // shared with `enqueueTaskVerification` (verify/enqueueFromTask.ts), the
    // programmatic controller's direct host-capability seam — but that seam
    // takes no wire input for `setupProof`; only the socket path above threads
    // an agent-supplied flag through at all, and the ownership guard earlier
    // in this method already rejects any MCP call on a programmatic run
    // outright. Gating the shared function too would be a second enforcement
    // point for a caller that was never the threat model — "belt and
    // suspenders, not two belts and three suspenders."
    if (msg.setupProof === true) {
      // (1) AUTHORIZE from the run's FROZEN workflow identity, never the
      // agent's own say-so. resolveRunFrozenSpec is the same workflow_runs →
      // workflows.name lookup handleReportStep uses (keyed off the
      // (workflow_id, spec_hash) pair stamped at createRun), so a live edit to
      // `workflows.name` mid-run can never be raced into passing this check.
      // Only the verify-setup flow ever proves a runbook; any other workflow
      // asking for the exemption is rejected, and the error names the run's
      // ACTUAL workflow so a legitimate caller can see immediately why it was
      // denied rather than guessing.
      // `frozenSpec` is resolved ONCE near the top of this method (the quick-run
      // branch needs it too). Same lookup, same guarantee: it is keyed off the
      // (workflow_id, spec_hash) pair stamped at createRun, so a live edit to
      // `workflows.name` mid-run cannot be raced into passing this check.
      const actualWorkflow = frozenSpec?.workflowName ?? 'unknown';
      if (actualWorkflow !== VERIFY_SETUP_WORKFLOW_NAME) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `setup_proof_not_authorized: this run's workflow is '${actualWorkflow}', not '${VERIFY_SETUP_WORKFLOW_NAME}' — setup_proof is verify-setup-flow-only`,
        });
        return;
      }

      // (2) REQUIRE the pin. A setup_proof request with no registered draft
      // behind it can never actually be marked proven — VerifyRunbookStore's
      // proof flip has no record to flip — so an unpinned "proof" carries no
      // corresponding upside; it IS the budget/gate bypass and nothing else.
      // Require both wire halves (mirroring the `wirePin` parse above) AND
      // that the hash resolve through the SAME store the runner later
      // validates the pin against (§5.2 seam 3) — a hash nobody registered is
      // not a draft, whatever the caller claims about it. `modality` is
      // derived exactly as `prepareVerificationEnqueue` derives it below, so
      // this check resolves the identical (project, modality) record the pin
      // will actually be validated against.
      const store = this.deps.verifyRunbookStore;
      const modality = resolveTaskModality(effectiveType, task ?? null);
      const pinned =
        wirePin !== undefined && store !== undefined
          ? store.getByHash(ctx.projectId, modality, wirePin.hash)
          : null;
      if (wirePin === undefined || store === undefined || pinned === null) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error:
            'setup_proof_requires_pin: setup_proof requires both runbookHash and runbookLocalVersion, ' +
            'and the hash must resolve to a draft registered via cyboflow_register_verify_runbook',
        });
        return;
      }
    }

    // The ONLY pin that leaves this handler for the engine. Past the block
    // above, `msg.setupProof === true` means the claim was authorized against
    // the run's frozen workflow identity AND `wirePin` resolved to a registered
    // draft — so this is exactly "a validated setup-proof pin, or nothing". An
    // ordinary request lands on `undefined` no matter what it put on the wire,
    // and `prepareVerificationEnqueue` then resolves the project's proven
    // revision itself (see the PARSED HERE note above for why that matters).
    const authorizedPin = msg.setupProof === true ? wirePin : undefined;

    const prepared = await prepareVerificationEnqueue({
      projectId: ctx.projectId,
      runId: msg.runId,
      type: effectiveType,
      ...(task !== undefined ? { task } : {}),
      ...(authorizedPin !== undefined ? { pin: authorizedPin } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
    });
    if (!prepared.ok) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: prepared.error,
      });
      return;
    }
    // A merged task supersedes both persisted columns, so the legacy input is
    // re-derived from it — `deliverable_json` must never describe a shape
    // `task_json` no longer carries.
    if (prepared.task !== undefined && prepared.task !== task) {
      task = prepared.task;
      input = deriveLegacyInputFromTask(task, input.taskRef);
    }

    // SNAPSHOT SHA (§5.5) — captured at ENQUEUE time, mirroring step (2) of the
    // programmatic seam (verify/enqueueFromTask.ts `enqueueTaskVerification`)
    // exactly, because a request row's isolation posture must not depend on
    // which of the two enqueue paths minted it (Codex round-3 finding 2). Until
    // this landed the MCP path never stamped one, so EVERY orchestrated
    // verification — the whole orchestrated plane, including verify-setup's own
    // proof runs — ran the runner's dirty live-worktree FALLBACK: no clone
    // isolation from sibling lanes still editing the shared worktree, and the
    // fallback's build/launch_failed→skipped carve-out (which exists to keep a
    // KNOWN-dirty tree from failing a lane on someone else's half-written file)
    // promoted from rare degradation to the normal path — i.e. an agent
    // reporting `build_failed` advanced its lane. Recording a sha ALWAYS
    // snapshots, so stamping one is what closes that carve-out.
    //
    // FAIL-SOFT, same posture as the programmatic seam: a missing worktree row
    // or a `git rev-parse` failure (not a repo, unborn HEAD) degrades to null —
    // the pre-existing fallback — rather than refusing the enqueue. This is a
    // capture, not a gate; hard-failing here would turn "cannot resolve HEAD"
    // into a lost verification, which is strictly worse than a dirty one. The
    // worktree LOOKUP is inside the same catch on purpose: this block sits
    // OUTSIDE the enqueue's try, so an escaping throw here would leave the
    // caller's socket with no reply at all — the one failure mode a
    // fire-and-continue seam must never have.
    let snapshotSha: string | null = null;
    let snapshotWorktreePath: string | null = null;
    // Does the worktree carry uncommitted work the snapshot at `snapshotSha`
    // will NOT contain? Probed for QUICK runs only — a sprint lane commits before
    // it verifies, so the answer there is both uninteresting and (with siblings
    // mid-edit in the shared worktree) usually a false alarm. Reported to the
    // caller rather than blocking: see `isWorktreeDirty`.
    let dirtyWorktree = false;
    try {
      snapshotWorktreePath = this.resolveRunWorktree(msg.runId);
      if (snapshotWorktreePath === null) {
        this.logger?.warn('[Cyboflow MCP Query] request-verification: no run worktree; enqueuing without a snapshot', {
          runId: msg.runId,
        });
      } else {
        snapshotSha = await captureSnapshotSha(snapshotWorktreePath);
        if (isQuickRun) dirtyWorktree = await isWorktreeDirty(snapshotWorktreePath);
      }
    } catch (err) {
      this.logger?.warn('[Cyboflow MCP Query] request-verification: snapshot sha capture failed', {
        runId: msg.runId,
        worktreePath: snapshotWorktreePath,
        error: err instanceof Error ? err.message : String(err),
      });
      snapshotSha = null;
    }

    // Key the row to its lane attempt when the taskRef names a lane of this
    // run's batch (see laneEnqueueKeyFor for why, and for the dedup it implies);
    // anything else enqueues unkeyed as before. A setup proof is never lane
    // traffic, keyed or not.
    const lanes = msg.setupProof === true || input.taskRef === undefined ? null : this.lanesForRun(msg.runId);
    const enqueueKey =
      lanes !== null && input.taskRef !== undefined
        ? laneEnqueueKeyFor(msg.runId, input.taskRef, lanes)
        : undefined;

    try {
      const requestId = VerificationScheduler.getInstance().enqueue({
        runId: msg.runId,
        projectId: ctx.projectId,
        type: effectiveType,
        input,
        chain,
        task,
        snapshotSha,
        ...(enqueueKey !== undefined ? { enqueueKey } : {}),
        ...(msg.setupProof === true ? { setupProof: true } : {}),
        ...(prepared.pin
          ? { runbookHash: prepared.pin.hash, runbookLocalVersion: prepared.pin.localVersion }
          : {}),
      });
      // Reply SYNCHRONOUSLY (the lane continues), then kick the drain loop. enqueue
      // already nudges; the extra nudge is harmless (coalesced) and makes the
      // fire-and-continue contract explicit.
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        // `snapshotSha` + `dirtyWorktree` travel WITH the ack so the caller learns
        // what is actually being verified at the moment it fires, not after the
        // verdict. A PASS on a dirty tree certifies `snapshotSha`, not the working
        // copy, and the tool description requires both be stated alongside any
        // verdict relayed to the user.
        data: { requestId, type: effectiveType, snapshotSha, dirtyWorktree },
      });
      VerificationScheduler.getInstance().nudge();
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] request-verification enqueue failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_enqueue_failed',
      });
    }
  }

  /**
   * Request an AD-HOC code-review eval of the CALLING run's current diff
   * (cyboflow_run_eval) and reply synchronously with the queue status — the jury
   * grades asynchronously and posts its verdict to the review queue.
   *
   * Guards:
   *   - the 'orchestrator' sentinel runId has no workflow_runs row and no diff
   *     (mirrors resolveTaskRunContext's first guard) → eval_requires_real_run;
   *   - the dep being absent → eval_unavailable (the established degrade pattern
   *     shared with the workflowConfig / agentThreadStore tools).
   *
   * DELIBERATELY NOT resolveTaskRunContext: that helper also rejects TERMINAL
   * runs, but a quick session's sentinel run is 'running' for the whole chat and
   * a flow run may legitimately want a grade after settling. Run EXISTENCE is
   * checked inside the snapshot (rejected/run_not_found), which is the only part
   * of that guard this tool needs.
   */
  async handleRunEval(
    msg: Extract<McpQueryMessage, { type: 'mcp-run-eval' }>,
    client: net.Socket,
  ): Promise<void> {
    if (msg.runId === 'orchestrator') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error:
          'eval_requires_real_run: an ad-hoc eval grades a specific run\'s diff, and the ' +
          'global-agent sentinel has neither a run row nor a worktree.',
      });
      return;
    }

    const runAdHocEval = this.deps.runAdHocEval;
    if (!runAdHocEval) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'eval_unavailable: the code-review eval worker is not wired in this process.',
      });
      return;
    }

    let result: AdHocSnapshotResult;
    try {
      result = await runAdHocEval(msg.runId);
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] ad-hoc eval request failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'eval_request_failed',
      });
      return;
    }

    if (result.outcome !== 'rejected') {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { status: result.outcome, rubricVersion: result.rubricVersion },
      });
      return;
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: false,
      error: AD_HOC_EVAL_REJECTION_ERRORS[result.reason],
    });
  }

  /**
   * BLOCK until a verification request settles, then reply with its verdict
   * (docs/proposals/verification-setup-flow.md §5.2 seam 2 — "the setup flow's
   * test-execute step needs a wait-for-verdict seam, bounded, with the verdict
   * surfaced inline").
   *
   * THIS IS THE ONE VERIFICATION CALL THAT DOES NOT RETURN IMMEDIATELY, and the
   * asymmetry is deliberate. `mcp-request-verification` is fire-and-continue
   * because a sprint lane's turn ENDS at the enqueue — the verdict arrives later
   * and is driven onto the parked lane by the merge gate, with no live turn to
   * hand it to. The setup flow inverts that: "derive → prove by running →
   * diagnose → adjust → re-prove" is a loop inside a single turn, and each arrow
   * consumes the previous outcome. Long-blocking MCP calls are precedented here —
   * `handleRequestUserInput` holds this same socket open across an unbounded human
   * decision — and unlike that gate this one is BOUNDED by the caller's own
   * deadline.
   *
   * RUN-BOUND, like every other tool on this socket: the request must belong to
   * THIS run. Cross-run awaits are rejected as `not_your_request` rather than
   * served — a flow blocking on another run's request would both leak that run's
   * verdict and hold a socket for a deadline it does not control.
   *
   * TIMING OUT IS NOT CANCELING. On expiry the reply carries the request's CURRENT
   * (non-terminal) status with `errorMessage: 'await timeout'`; the request keeps
   * draining and still delivers its verdict to the screenshots artifact + the
   * review queue through the normal path. The flow's correct response is to report
   * that it stopped waiting — never to treat it as a failure of the deliverable.
   */
  async handleAwaitVerification(
    msg: Extract<McpQueryMessage, { type: 'mcp-await-verification' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    if (typeof msg.verificationRequestId !== 'string' || msg.verificationRequestId.length === 0) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'invalid_arguments: request_id must be a non-empty verification request id',
      });
      return;
    }

    // OWNERSHIP GUARD (run-bound). A read failure is reported as not-found rather
    // than swallowed: awaiting a request this handler cannot even see would block
    // for the full deadline and then report a status it never read.
    let ownerRunId: string | null = null;
    try {
      const row = this.db
        .prepare('SELECT run_id FROM verification_requests WHERE id = ?')
        .get(msg.verificationRequestId) as { run_id?: unknown } | undefined;
      ownerRunId = typeof row?.run_id === 'string' ? row.run_id : null;
    } catch (err) {
      this.logger?.warn('[Cyboflow MCP Query] await-verification ownership read failed', {
        runId: msg.runId,
        error: err instanceof Error ? err.message : String(err),
      });
      ownerRunId = null;
    }
    if (ownerRunId === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_request_not_found',
      });
      return;
    }
    if (ownerRunId !== msg.runId) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'not_your_request',
      });
      return;
    }

    // Clamp the wait budget. The ceiling is the AGENT request deadline itself:
    // waiting longer than the longest a request may legally run cannot surface a
    // verdict that does not exist, it only holds the socket. A non-positive /
    // malformed value falls back to the default rather than resolving instantly,
    // which would silently turn the blocking tool into a poll.
    const requested = typeof msg.timeoutMs === 'number' && Number.isFinite(msg.timeoutMs) ? msg.timeoutMs : NaN;
    const timeoutMs =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, AGENT_REQUEST_TIMEOUT_CEILING_MS)
        : AWAIT_VERIFICATION_DEFAULT_TIMEOUT_MS;

    const scheduler = VerificationScheduler.tryGetInstance();
    if (scheduler === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_unavailable',
      });
      return;
    }

    try {
      const outcome = await scheduler.awaitTerminal(msg.verificationRequestId, timeoutMs);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          status: outcome.status,
          failureClass: outcome.failureClass,
          feedback: outcome.feedback,
          errorMessage: outcome.errorMessage,
        },
      });
    } catch (err) {
      this.logger?.error('[Cyboflow MCP Query] await-verification failed', {
        runId: msg.runId,
        verificationRequestId: msg.verificationRequestId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_await_failed',
      });
    }
  }

  /**
   * List THIS run's verification requests — the NON-BLOCKING cold read behind
   * `cyboflow_get_verifications`.
   *
   * WHY IT EXISTS. `awaitTerminal` already returns instantly for an
   * already-terminal request, so `cyboflow_await_verification` doubles as a
   * later-turn read — but ONLY while the caller still holds the request id. A
   * quick chat session fires-and-continues, and after a context compaction the
   * ids are gone; without this tool the agent that fired a verification cannot
   * find out what happened to it, while the human can see it in the artifacts
   * pane. That asymmetry is the gap this closes.
   *
   * RUN-SCOPED IN SQL (`listRequestsForRun`), not by post-filtering: a foreign
   * `request_id` yields an empty list rather than another run's verdict, and no
   * cross-run row is ever materialized. There is deliberately no `not_your_request`
   * error here — unlike `await`, which must distinguish "not yours" from "not
   * found" so a flow does not block on an id it will never be told about, a
   * listing's honest answer for a row it may not see is simply that the row is
   * not in the list.
   */
  handleGetVerifications(
    msg: Extract<McpQueryMessage, { type: 'mcp-get-verifications' }>,
    client: net.Socket,
  ): void {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const scheduler = VerificationScheduler.tryGetInstance();
    if (scheduler === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'verification_unavailable',
      });
      return;
    }

    const narrowTo =
      typeof msg.verificationRequestId === 'string' && msg.verificationRequestId.length > 0
        ? msg.verificationRequestId
        : undefined;
    const verifications = scheduler.listRequestsForRun(msg.runId, narrowTo);

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { verifications },
    });
  }

  /**
   * Register (or refresh) the MACHINE-LOCAL half of this project's verification
   * runbook from the portable file committed in THIS run's worktree (§5.2 seam 1),
   * replying `{ hash, version }` — the content-addressed hash of the portable half
   * and the CAS version of the local record.
   *
   * THE WORKTREE IS THE SOURCE, NOT THE WIRE. The tool takes no runbook content:
   * the store reads `.cyboflow/verify-runbook.json` from the run's own worktree
   * itself. That is what makes the returned hash mean something — it addresses the
   * file the flow actually committed, not a payload the flow retyped, so a request
   * pinned to that hash executes the revision a human can `git show`.
   *
   * ERRORS COME BACK VERBATIM. `registerDraft` returns (never throws) messages
   * like "portable runbook is not valid JSON: …" and "portable runbook declares no
   * \"cdp-app\" modality", each naming the offending path or key. Collapsing those
   * into an opaque code would leave the setup flow guessing at a file it just
   * wrote; passing them through is what lets it fix the file and retry in the same
   * turn.
   *
   * `bindings_json` is validated as PARSEABLE JSON here and stored opaquely — the
   * store has no schema for it (§5.3 leaves the machine-local bindings shape to
   * the modality), but persisting text that is not even JSON would guarantee a
   * later reader fails on data this handler could have rejected at the door.
   */
  async handleRegisterVerifyRunbook(
    msg: Extract<McpQueryMessage, { type: 'mcp-register-verify-runbook' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = this.resolveReviewItemRunContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    if (!isVerifyRunbookModality(msg.modality)) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        // mobile is registrable too — it declares build[] + app + a
        // bundle-identity attestation and no serve (see VERIFY_RUNBOOK_MODALITIES).
        error: `invalid_modality: expected ${VERIFY_RUNBOOK_MODALITIES.map((m) => `'${m}'`).join(' | ')}`,
      });
      return;
    }

    if (msg.bindingsJson !== undefined) {
      try {
        JSON.parse(msg.bindingsJson);
      } catch (err) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: `invalid_bindings_json: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    const store = this.deps.verifyRunbookStore;
    if (!store) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'runbook_store_unavailable',
      });
      return;
    }

    const worktreePath = this.resolveRunWorktree(msg.runId);
    if (worktreePath === null) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'run_worktree_unavailable',
      });
      return;
    }

    try {
      const result = await store.registerDraft(
        ctx.projectId,
        worktreePath,
        msg.modality,
        msg.bindingsJson,
      );
      if ('error' in result) {
        this.writeResponse(client, {
          type: 'mcp-query-response',
          requestId: msg.requestId,
          ok: false,
          error: result.error,
        });
        return;
      }
      // Migration-105 provenance: THIS registration came through the Verify
      // Setup flow, where a human reviews the proposal and every repo change it
      // wants before anything is touched. The lane bootstrap stamps
      // 'lane-bootstrap' on its own registrations, and a human deciding whether
      // to trust a proven runbook needs to be able to tell the two apart — both
      // are proven by the same engine-enforced run, and they did not earn the
      // same amount of trust. Fail-soft: a badge that could not be written must
      // never undo a registration that succeeded.
      store.setOrigin(ctx.projectId, msg.modality, 'setup-flow');
      // COMMITTED-AT-HEAD backstop. registerDraft reads the WORKING TREE, but
      // the proof runs against a detached snapshot at a commit — so a runbook
      // that never reached HEAD registers cleanly and then proves against a
      // snapshot that does not contain it. The common cause is mundane and
      // silent: many repos ignore or locally-exclude `.cyboflow/` (it is where
      // cyboflow keeps worktrees and local state), which makes a plain
      // `git add .cyboflow/verify-runbook.json` a no-op (observed live
      // 2026-07-31). Surface it here, where the flow can still fix it with
      // `git add -f`, rather than letting it resurface as an inexplicable proof
      // failure ten minutes later. Advisory only — the registration itself is
      // valid and stands.
      const committed = await isRunbookCommittedAtHead(worktreePath, VERIFY_RUNBOOK_RELATIVE_PATH);
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: {
          hash: result.hash,
          version: result.version,
          committed,
          ...(committed
            ? {}
            : {
                warning:
                  `${VERIFY_RUNBOOK_RELATIVE_PATH} is not present at HEAD, so the proof's detached ` +
                  'snapshot will not contain it. Commit it before proving — if `git add` appears to ' +
                  'do nothing, this project ignores or excludes `.cyboflow/`, so use `git add -f`.',
              }),
        },
      });
    } catch (err) {
      // registerDraft is total by contract; this is the belt-and-braces path so a
      // future non-total collaborator cannot take the socket down with it.
      this.logger?.error('[Cyboflow MCP Query] register-verify-runbook failed', {
        runId: msg.runId,
        modality: msg.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'runbook_register_failed',
      });
    }
  }

  /**
   * Best-effort default for an OMITTED task_ref (locked decision #2 mitigation):
   * the sole lane's display ref (or opaque task id) when the calling run is a
   * batched sprint run with EXACTLY ONE lane — the only case a taskRef-less
   * request is unambiguous. A non-batch run, a run whose batch has zero or 2+
   * lanes, or any read failure returns undefined (the request stays taskRef-less
   * and the gate's strict attribution applies). Fully fail-soft — a defaulting
   * hiccup never fails a fire-and-continue request.
   */
  private defaultTaskRefForRun(runId: string): string | undefined {
    const lanes = this.lanesForRun(runId);
    if (lanes === null || lanes.length !== 1) return undefined; // multi-lane cannot be defaulted; non-lane run has none
    const only = lanes[0];
    return typeof only.ref === 'string' && only.ref.length > 0 ? only.ref : only.taskId;
  }

  /**
   * The sprint lanes of the run's batch, or `null` for a run with no batch
   * (a quick chat, a planner/verify-setup run) or when the lane store cannot
   * answer — both callers treat that as "no lane context", never as an error.
   */
  private lanesForRun(runId: string): SprintLaneRow[] | null {
    try {
      const runRow = this.db
        .prepare('SELECT batch_id AS batchId FROM workflow_runs WHERE id = ?')
        .get(runId) as { batchId?: unknown } | undefined;
      const batchId =
        typeof runRow?.batchId === 'string' && runRow.batchId.length > 0 ? runRow.batchId : null;
      if (!batchId) return null;
      return SprintLaneStore.getInstance().listLanes(batchId);
    } catch {
      return null;
    }
  }

  /** Parse the run's stamped verify_chain JSON into a VisualBackendId[]; [] on null/malformed. */
  private parseStampedChain(v: unknown): VisualBackendId[] {
    if (typeof v !== 'string' || v.length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * The human-readable reason for a DISABLED-posture verification skip.
   *
   * Three conditions land in that one branch and they are not interchangeable —
   * each has a different fix, and only the caller can carry that to the user:
   *
   *   - a QUICK session whose posture resolved off ⇒ the master switch (or the
   *     project's `.cyboflow/verify.json`) is off. Fixable in Settings, and the
   *     late binding means it takes effect on the NEXT call — no restart, no new
   *     session. Naming that is the whole point: the fix is one toggle away.
   *   - a FLOW run stamped disabled ⇒ the stamp is immutable (migration 055, no
   *     UPDATE path), so no setting change rescues THIS run; it needs a new one.
   *   - enabled but no type resolved ⇒ a posture that survived the enablement
   *     ladder yet named no verification type. Rare, and worth saying plainly
   *     rather than folding into "disabled", which would be a lie.
   *
   * Deliberately NOT a reason this function can emit: anything about runbooks.
   * The runbook gate lives in the scheduler and fires only AFTER a row exists —
   * a request skipped here never reached it, so claiming it did would invent
   * evidence.
   */
  private disabledSkipReason(isQuickRun: boolean, enabled: boolean): string {
    if (enabled) {
      return (
        'visual verification is enabled but resolved no verification type — nothing was enqueued. ' +
        'Check the project/global visualVerify defaultType.'
      );
    }
    if (isQuickRun) {
      return (
        'visual verification is turned OFF — nothing was enqueued, no budget spent. ' +
        'Enable it in Settings (or in this project/worktree\'s .cyboflow/verify.json); a quick ' +
        'session reads the switch on every call, so the next request picks it up with no restart ' +
        'and no new session. This skip says NOTHING about whether the project has a runbook.'
      );
    }
    return (
      "this run's visual-verification posture was stamped disabled when the run was created, and " +
      'that stamp is immutable — changing the setting now cannot enable THIS run; a new run is ' +
      'required. This skip says NOTHING about whether the project has a runbook.'
    );
  }
}
