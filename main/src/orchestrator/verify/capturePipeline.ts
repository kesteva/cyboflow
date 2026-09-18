/**
 * CapturePipeline — the legacy (backend-capture + VLM) verification engine, split
 * out of verificationScheduler.ts (issue #19 step 7). See the class doc below;
 * the S-references are to the visual-verification slice plan and the §-references
 * to docs/proposals/visual-verification-design.md.
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron', 'fs',
 * 'better-sqlite3', or concrete main/src/services import — every collaborator is
 * injected as the shared-types seam it was already injected as at the scheduler.
 */
import type { LoggerLike } from '../types';
import type {
  CaptureContext,
  CaptureOrigin,
  DeliverableVerifyConfig,
  RequestStatus,
  ResolvedVisualVerifyConfig,
  VerdictV1,
  VerificationRequestInput,
  VerificationType,
  VisualBackend,
  VlmJudge,
} from '../../../../shared/types/visualVerification';
import type {
  BaselinePreDiffResolver,
  BaselinePreDiffResult,
  DevServerHandle,
  DevServerProvider,
  StaticHtmlContextResolver,
  StaticServerHandle,
  StaticServerProvider,
} from './verificationSchedulerContracts';
import { raceWithAbort } from './verificationLeases';
import type { LeaseHandle } from './verificationLeases';
import type { VerificationRequestRow } from './verificationRequestRows';
import type { TerminalDelivery } from './terminalDelivery';

/** What {@link CapturePipeline} is composed over — the scheduler passes its own deps + helpers through. */
export interface CapturePipelineDeps {
  judge: VlmJudge;
  logger?: LoggerLike;
  /** The scheduler's resolved config (vlmConfidenceThreshold gates the verdict → status map). */
  config: ResolvedVisualVerifyConfig;
  artifactsDirResolver: (runId: string) => string;
  /** Per-request capture+judge deadline — see DEFAULT_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs: number;
  /** S5 SSIM gate — see DEFAULT_SSIM_MATCH_THRESHOLD. */
  baselineMatchThreshold: number;
  devServerProvider?: DevServerProvider;
  staticServerProvider?: StaticServerProvider;
  staticHtmlContextResolver?: StaticHtmlContextResolver;
  baselinePreDiff?: BaselinePreDiffResolver;
  /** The terminal-write + delivery chokepoint every exit of runChosen goes through. */
  delivery: TerminalDelivery;
  /**
   * The scheduler's registry of in-flight AbortControllers, SHARED BY REFERENCE:
   * runChosen registers its controller here so cancelForRun / the per-request
   * timeout can reach in and abort the live capture; it deletes it in finally.
   */
  inFlight: Map<string, AbortController>;
  // Scheduler-owned helpers the pipeline shares with the drain + agent engine.
  /** Parse the integer port out of a 'verify:port:<p>' lease name; null otherwise. */
  portFromLease: (name: string | null) => number | null;
  /** Whether the request input declares a startable (dev-server) deliverable. */
  inputDeclaresDevServer: (input: VerificationRequestInput) => boolean;
  /** Acquire the L4 batch worktree-sync mutex for a batched run; null for a non-batch run. */
  acquireBatchMutex: (runId: string) => Promise<LeaseHandle | null>;
  /** S5 — the per-project verification budget cap (shared with the agent engine). */
  isProjectBudgetExhausted: (projectId: number) => boolean;
  /** Count a real vision call against this request's judge_calls_used. */
  incrementJudgeCallsUsed: (id: string) => void;
}

/**
 * The scheduler's LEGACY capture engine: the detached per-request work for a row
 * whose lease is already held and whose status is already 'running' — stand a
 * scheduler-owned dev (S2) or static (S9) server up, capture through the chosen
 * backend, reach a verdict deterministically / by SSIM pre-diff (S5) / by the
 * VLM under the per-project budget, and write the terminal status through the
 * delivery chokepoint, releasing every server and lease in one finally.
 * Extracted from VerificationScheduler (issue #19 step 7); the method bodies are
 * the scheduler's, unchanged — the scheduler now holds one `capture`
 * collaborator and drives it from processRow.
 */
export class CapturePipeline {
  private readonly judge: VlmJudge;
  private readonly logger?: LoggerLike;
  private readonly config: ResolvedVisualVerifyConfig;
  private readonly artifactsDirResolver: (runId: string) => string;
  private readonly requestTimeoutMs: number;
  private readonly baselineMatchThreshold: number;
  private readonly devServerProvider?: DevServerProvider;
  private readonly staticServerProvider?: StaticServerProvider;
  private readonly staticHtmlContextResolver?: StaticHtmlContextResolver;
  private readonly baselinePreDiff?: BaselinePreDiffResolver;
  private readonly delivery: TerminalDelivery;
  private readonly inFlight: Map<string, AbortController>;
  private readonly portFromLease: (name: string | null) => number | null;
  private readonly inputDeclaresDevServer: (input: VerificationRequestInput) => boolean;
  private readonly acquireBatchMutex: (runId: string) => Promise<LeaseHandle | null>;
  private readonly isProjectBudgetExhausted: (projectId: number) => boolean;
  private readonly incrementJudgeCallsUsed: (id: string) => void;

  constructor(deps: CapturePipelineDeps) {
    this.judge = deps.judge;
    this.logger = deps.logger;
    this.config = deps.config;
    this.artifactsDirResolver = deps.artifactsDirResolver;
    this.requestTimeoutMs = deps.requestTimeoutMs;
    this.baselineMatchThreshold = deps.baselineMatchThreshold;
    this.devServerProvider = deps.devServerProvider;
    this.staticServerProvider = deps.staticServerProvider;
    this.staticHtmlContextResolver = deps.staticHtmlContextResolver;
    this.baselinePreDiff = deps.baselinePreDiff;
    this.delivery = deps.delivery;
    this.inFlight = deps.inFlight;
    this.portFromLease = deps.portFromLease;
    this.inputDeclaresDevServer = deps.inputDeclaresDevServer;
    this.acquireBatchMutex = deps.acquireBatchMutex;
    this.isProjectBudgetExhausted = deps.isProjectBudgetExhausted;
    this.incrementJudgeCallsUsed = deps.incrementJudgeCallsUsed;
  }

  /**
   * The DETACHED capture work for a row whose lease is already held + status is
   * already 'running' (processRow did both synchronously). Runs capture → judge →
   * terminal verdict, releasing the lease in finally. A capture that fails (ok:false
   * or no PNG) is recorded as 'failed' for THIS slice (full fall-forward to the next
   * rung is L2+); a judge verdict drives passed/failed/low_confidence. The
   * per-request abort signal is plumbed to backend + judge for timeout / cancel.
   *
   * Before capture it may stand a scheduler-owned server up and thread its URL into
   * ctx.input.url — the S2 dev server for a startable deliverable (leased port) OR,
   * when none is spawned, the S9 ephemeral static server for a built htmlPath (the
   * file:// ES-module-block fix). The two are mutually exclusive (a startable
   * deliverable is S2's job) and BOTH are released in the SAME finally as the lease.
   *
   * Because the lease is held until this promise's finally, two SCREEN-lease rows
   * cannot run concurrently (the second couldn't acquire the lease in processRow),
   * while two NULL-lease rows both reach here and run in parallel.
   */
  async runChosen(
    row: VerificationRequestRow,
    type: VerificationType,
    input: VerificationRequestInput,
    backend: VisualBackend,
    lease: LeaseHandle,
    resolvedContext: { cwd: string; deliverable: DeliverableVerifyConfig } | null,
  ): Promise<void> {
    const controller = new AbortController();
    // Register the controller so cancelForRun(runId) + the per-request timeout can
    // reach in and `.abort()` THIS live capture/judge. Deleted in the finally.
    this.inFlight.set(row.id, controller);

    // Per-request deadline: on expiry abort the in-flight signal. The catch below
    // (or the abort-aware capture/judge) then unwinds; `timedOut` distinguishes a
    // deadline abort (→ 'timeout') from a genuine capture/judge throw (→ 'failed').
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      this.logger?.warn('[VerificationScheduler] request timed out — aborting', {
        requestId: row.id,
        backend: backend.id,
        timeoutMs: this.requestTimeoutMs,
      });
      controller.abort();
    }, this.requestTimeoutMs);
    // Do not let the timer keep the event loop / process alive on its own.
    if (typeof deadline === 'object' && deadline !== null && 'unref' in deadline) {
      (deadline as { unref: () => void }).unref();
    }

    let fileNames: string[] = [];
    // The scheduler-owned dev server (S2) for this request, if one is spawned. Held
    // for the WHOLE capture lifetime and released in the SAME finally as the lease.
    let devServerHandle: DevServerHandle | null = null;
    // The scheduler-owned static server (S9) for this request, if one is spawned. Held
    // for the WHOLE capture lifetime and released in the SAME finally as the dev
    // server. Null when no static server is stood up (a dev server was, or the request
    // is not a bare-htmlPath deliverable) → the raw url/htmlPath capture runs unchanged.
    let staticServerHandle: StaticServerHandle | null = null;
    // The batch worktree-sync mutex (L4) for a batched run, if this run carries a
    // batch_id. Held across capture+judge and released in the SAME finally as the
    // other leases. Null for a non-batch run (nothing acquired → nothing to release).
    let batchLease: LeaseHandle | null = null;
    // HUMAN-FACING capture provenance (Codex finding 9), stamped onto every terminal
    // payload. Computed ONCE per attempt and REFINED as each server spawns: it starts
    // as the best-known origin (a running url the agent passed, else the raw file://
    // htmlPath), is promoted to 'dev-server' if S2 stands one up, else to
    // 'static-server' if S9 does. This progressive form is what lets the abort checks
    // BEFORE the S9 spawn stamp the best-known origin (dev-server/url/file) without
    // restructuring the flow, and keeps it in scope for the catch block below.
    const originalUrlPresent = typeof input.url === 'string' && input.url.trim().length > 0;
    let captureOrigin: CaptureOrigin = originalUrlPresent ? 'url' : 'file';

    try {
      // S2 — stand a dev server up on the leased port when the deliverable recipe
      // has a `start` command. BEFORE building CaptureContext so the spawned baseUrl
      // can be threaded into ctx.input.url. A null handle (no provider / no start /
      // lease is not a port lease) leaves the static url/htmlPath capture unchanged.
      devServerHandle = await this.maybeSpawnDevServer(row, lease, resolvedContext, controller.signal);
      if (devServerHandle) {
        captureOrigin = 'dev-server';
      }
      // A timeout/cancel that fired DURING dev-server spawn: stop here, mark
      // 'timeout', releasing both the dev server (in finally) and the lease. (The S9
      // static server has not been attempted yet, so captureOrigin here is at most
      // dev-server/url/file — the best-known origin at this point.)
      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // S9 — when NO dev server was stood up, stand an ephemeral loopback static file
      // server up for a bare-htmlPath deliverable (the file:// ES-module-block fix).
      // Mutually exclusive with the dev server: a startable deliverable is S2's job, so
      // we only consider a static serve when devServerHandle is null. Its baseUrl is
      // threaded into ctx.input.url exactly like the dev server; released in the SAME
      // finally. A null handle (no static deps / no htmlPath / a running url / resolve
      // or spawn failed) leaves the raw url/htmlPath capture unchanged (pre-S9 behavior).
      staticServerHandle = devServerHandle
        ? null
        : await this.maybeSpawnStaticServer(row, input, resolvedContext, controller.signal);
      if (staticServerHandle) {
        captureOrigin = 'static-server';
      }
      // A timeout/cancel that fired DURING static-server spawn: stop here, mark
      // 'timeout', releasing both the static server (in finally) and the lease.
      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // L4 batch worktree-sync mutex (locked decision #5): AFTER the dev-server/
      // port lease, BEFORE capture. For a batched run this BLOCKS until any other
      // verification on the same batchId releases, so a capture never reads a
      // half-committed shared sprint worktree relative to a concurrent lane's
      // verification. A non-batch run acquires nothing (byte-identical to before).
      batchLease = await this.acquireBatchMutex(row.run_id);
      // A timeout/cancel that fired WHILE we waited on the batch mutex: stop here,
      // mark 'timeout'; the batch mutex (now held) is released in finally.
      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // Thread the scheduler-owned server's URL into the capture input: the S2 dev
      // server wins, else the S9 static server, else the raw url/htmlPath is captured.
      const captureInput: VerificationRequestInput = devServerHandle
        ? { ...input, url: devServerHandle.baseUrl }
        : staticServerHandle
          ? { ...input, url: staticServerHandle.baseUrl }
          : input;
      const ctx: CaptureContext = {
        requestId: row.id,
        runId: row.run_id,
        artifactsDir: this.artifactsDirResolver(row.run_id),
        type,
        input: captureInput,
      };

      // ABORT-BOUNDED (R1 #1a): race the capture against the deadline/cancel signal
      // so an abort-unaware backend that never settles can NEVER hang the drain. On
      // abort raceWithAbort rejects (→ catch, marked 'timeout'); the orphaned capture
      // is detached (its late settle is logged). The backend-side window teardown
      // (CapturePageBackend) prevents the leaked wedged renderer.
      const capture = await raceWithAbort(
        backend.capture(ctx, controller.signal),
        controller.signal,
        'capture',
        this.logger,
      );
      // A timeout/cancel that fired DURING capture: stop here, mark 'timeout',
      // regardless of what the (now-aborted) capture nominally returned.
      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          [],
          input,
        );
        return;
      }

      // UNTRUSTED capture diagnostics (Codex finding 7): error-level page console
      // lines + capture-side notes the backend surfaced. Capped defensively (page code
      // controls this text) and attached to the HUMAN-facing terminal payloads only —
      // the capture-failure and judged-outcome ones below. They MUST NOT reach the
      // VlmJudge inputs (prompt-injection surface); the judge call stays byte-identical.
      const cappedDiagnostics =
        Array.isArray(capture.diagnostics) && capture.diagnostics.length > 0
          ? this.capDiagnostics(capture.diagnostics)
          : undefined;

      if (!capture.ok || capture.fileNames.length === 0) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'failed',
          {
            backend: backend.id,
            error: capture.error ?? 'capture produced no images',
            captureOrigin,
            ...(cappedDiagnostics ? { diagnostics: cappedDiagnostics } : {}),
          },
          undefined,
          [],
          input,
        );
        return;
      }

      fileNames = capture.fileNames;

      // DETERMINISTIC-FIRST ORDER (decision #3, composing with S3 + S5):
      //
      //  (1) BACKEND DETERMINISTIC VERDICT — a backend that reached a verdict WITHOUT
      //      a vision call (the Rung-1 Playwright backend's a11y/assertion gate) sets
      //      captureResult.deterministicVerdict. When present, USE it and SKIP the
      //      rest. A null verdict is treated as absent (no deterministic signal). The
      //      skip is conservative by construction: a deterministic PASS only on
      //      all-pass explicit assertions, a deterministic FAIL always unambiguous.
      //
      //  (2) SSIM PRE-DIFF (S5) — if no backend verdict AND the request's baselineKey
      //      resolves to an accepted baseline PNG, compare the captured PNG(s) before
      //      spending a vision call. A near-pixel match (>= baselineMatchThreshold) is
      //      a CHEAP deterministic PASS (verdictSource:'ssim_match', NO VLM call).
      //      Otherwise fall through to the VLM with the resolved baselinePath.
      //
      //  (3) BUDGET / VLM — if no deterministic + no SSIM match, run the VLM, passing
      //      the resolved baselinePath. The per-project VERIFICATION budget (the SAME
      //      counter runAgentChosen checks for an agent deployment, §5.8) is enforced
      //      HERE (before the call): exhausted ⇒ a non-blocking low_confidence verdict
      //      (the SAME human-review finding path, never a FAIL / fabricated pass) with
      //      NO vision call. A real VLM call increments this request's judge_calls_used
      //      (the budget aggregation + cost-telemetry counter).
      //
      // The baseline PNGs are resolved ONCE per request here (from input.baselineKey).
      let verdict: VerdictV1;
      if (capture.deterministicVerdict != null) {
        verdict = capture.deterministicVerdict;
      } else {
        const preDiff = await this.resolveBaselinePreDiff(row, input, ctx, fileNames);
        if (controller.signal.aborted) {
          await this.delivery.markTerminalAndDeliver(
            row,
            'timeout',
            { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
            undefined,
            fileNames,
            input,
          );
          return;
        }
        if (preDiff?.match) {
          // SSIM short-circuit: a cheap deterministic PASS, NO vision call.
          verdict = {
            status: 'pass',
            confidence: 1,
            issues: [],
            feedback: `matched golden baseline (SSIM ${preDiff.ssimScore.toFixed(4)} ≥ ${this.baselineMatchThreshold})`,
            judgedFileNames: fileNames,
            baselineUsed: true,
            model: 'ssim-prediff',
            verdictSource: 'ssim_match',
            ssimScore: preDiff.ssimScore,
          };
        } else if (this.isProjectBudgetExhausted(row.project_id)) {
          // BUDGET-EXHAUSTION: route to the SAME non-blocking low_confidence finding
          // path — never a FAIL, never a fabricated pass, and NO vision call spent.
          verdict = {
            status: 'low_confidence',
            confidence: 0,
            issues: [],
            feedback: 'per-project visual-judge budget exhausted; needs human visual review',
            judgedFileNames: fileNames,
            baselineUsed: !!preDiff?.baselinePath,
            model: 'budget-exhausted',
            verdictSource: 'vlm_verdict',
          };
        } else {
          // A real vision call: count it against the budget BEFORE judging (the
          // counter UPDATE is this request's OWN row — consistent with markTerminal,
          // within the no-direct-router-table-write rule).
          this.incrementJudgeCallsUsed(row.id);
          // ABORT-BOUNDED (R1 #1a): a hung vision call can no more wedge the drain
          // than a hung capture — race it against the deadline/cancel signal.
          const vlmVerdict = await raceWithAbort(
            this.judge.judge(
              {
                intent: input.intent,
                artifactsDir: ctx.artifactsDir,
                fileNames,
                type,
                ...(preDiff?.baselinePath ? { baselinePath: preDiff.baselinePath } : {}),
              },
              controller.signal,
            ),
            controller.signal,
            'judge',
            this.logger,
          );
          // Stamp provenance: a VLM-produced verdict is 'vlm_verdict' (+ the SSIM
          // score when a baseline was compared but did not match, for telemetry).
          verdict = {
            ...vlmVerdict,
            verdictSource: 'vlm_verdict',
            ...(preDiff ? { ssimScore: preDiff.ssimScore } : {}),
          };
        }
      }

      // A timeout/cancel that fired DURING judging: mark 'timeout', drop the verdict.
      if (controller.signal.aborted) {
        await this.delivery.markTerminalAndDeliver(
          row,
          'timeout',
          { backend: backend.id, error: timedOut ? 'request timed out' : 'aborted', captureOrigin },
          undefined,
          fileNames,
          input,
        );
        return;
      }

      const status = this.statusFromVerdict(verdict);
      await this.delivery.markTerminalAndDeliver(
        row,
        status,
        {
          backend: backend.id,
          verdict,
          captureOrigin,
          ...(cappedDiagnostics ? { diagnostics: cappedDiagnostics } : {}),
        },
        verdict,
        fileNames,
        input,
      );
    } catch (err) {
      // An abort-aware backend/judge that THROWS on abort (vs. returning) lands
      // here. If the signal was aborted (deadline or cancel) it is a 'timeout', not
      // a 'failed' — a genuine capture/judge error keeps 'failed'.
      const aborted = controller.signal.aborted;
      controller.abort();
      const message = err instanceof Error ? err.message : String(err);
      const status: RequestStatus = aborted ? 'timeout' : 'failed';
      this.logger?.error('[VerificationScheduler] capture/judge error', {
        requestId: row.id,
        backend: backend.id,
        aborted,
        error: message,
      });
      await this.delivery.markTerminalAndDeliver(
        row,
        status,
        {
          backend: backend.id,
          error: aborted ? (timedOut ? 'request timed out' : 'aborted') : message,
          captureOrigin,
        },
        undefined,
        fileNames,
        input,
      );
    } finally {
      clearTimeout(deadline);
      this.inFlight.delete(row.id);
      // Tear the dev server down BEFORE releasing the port lease — release() kills
      // the process tree that was holding the leased port. Guard on null (no dev
      // server was spawned). Fail-soft: a teardown error must never leave the lease
      // un-released, so it is logged, not propagated.
      if (devServerHandle) {
        try {
          await devServerHandle.release();
        } catch (err) {
          this.logger?.error('[VerificationScheduler] dev-server teardown threw', {
            requestId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Tear the S9 static server down (closes the listener + force-destroys open
      // sockets). Guarded on null (none spawned). Fail-soft in the SAME shape as the
      // dev-server teardown: a release() throw is logged, never propagated, so it can
      // never leave the port/screen lease un-released below.
      if (staticServerHandle) {
        try {
          await staticServerHandle.release();
        } catch (err) {
          this.logger?.error('[VerificationScheduler] static-server teardown threw', {
            requestId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Release the L4 batch worktree-sync mutex (independent named mutex — reverse
      // order vs. the port lease is not required). Guarded on null: a non-batch run
      // acquired nothing, so there is nothing to release.
      if (batchLease) {
        batchLease.release();
      }
      lease.release();
    }
  }

  /**
   * Stand a scheduler-owned dev server up for this request when its resolved
   * deliverable recipe has a `start` command (S2 / locked decision #1). Returns the
   * live DevServerHandle (the caller threads handle.baseUrl into ctx.input.url and
   * release()s it in finally), or null when no dev server is spawned:
   *   - no provider injected (static-capture deployment), OR
   *   - the held lease is NOT a port lease (rung 0 / null lease — nothing to run on), OR
   *   - no verify.json / no matching deliverable / no `start` command, OR
   *   - the worktree cwd could not be resolved.
   * In every null case the static url/htmlPath capture path is preserved unchanged.
   *
   * S8 — the verify.json deliverable was already resolved ONCE in processRow (used to
   * hydrate `input` BEFORE lease selection) and is THREADED in here as
   * `resolvedContext`, so verify.json is loaded a single time per request (no second
   * devServerContextResolver call). A null resolvedContext is the same fail-soft
   * "no dev server" path as before.
   *
   * A spawn FAILURE (build/start/readiness reject) propagates so runChosen marks the
   * request failed/timeout (the provider has already torn down what it spawned).
   */
  private async maybeSpawnDevServer(
    row: VerificationRequestRow,
    lease: LeaseHandle,
    resolvedContext: { cwd: string; deliverable: DeliverableVerifyConfig } | null,
    signal: AbortSignal,
  ): Promise<DevServerHandle | null> {
    if (!this.devServerProvider) {
      return null;
    }
    // A dev server is bound to a leased PORT. A rung-0 / null lease (no port) cannot
    // host one — the request is a static url/htmlPath capture.
    const port = this.portFromLease(lease.name);
    if (port === null) {
      return null;
    }

    if (!resolvedContext) {
      return null;
    }
    const { cwd, deliverable } = resolvedContext;
    if (!deliverable.start || deliverable.start.trim().length === 0) {
      // No start command — nothing to stand up; capture the static target as-is.
      return null;
    }

    this.logger?.debug('[VerificationScheduler] spawning dev server', {
      requestId: row.id,
      port,
      deliverable: deliverable.id,
    });
    return this.devServerProvider.spawn({ config: deliverable, port, cwd, signal });
  }

  /**
   * Stand a scheduler-owned STATIC file server up for this request when it targets a
   * BUILT html file with no running url and no dev-server recipe (S9 / the file://
   * ES-module-block fix). Returns the live StaticServerHandle (the caller threads
   * handle.baseUrl into ctx.input.url and release()s it in the SAME finally as the S2
   * dev server), or null when no static server is stood up — and in EVERY null case
   * the request captures its raw url/htmlPath UNCHANGED (pre-S9 file:// behavior), so
   * a non-static request is byte-identical to before this layer:
   *   - EITHER dep absent (staticServerProvider / staticHtmlContextResolver): a
   *     deployment wired without the S9 seam — the static-capture path is preserved.
   *   - the request carries no htmlPath (empty after trim): there is nothing to serve.
   *   - the request already declares a running `url`: the agent pointed at a live
   *     server, so we capture that url directly and NEVER shadow it with a static serve.
   *   - the request declares a dev server (non-empty `start`): a STARTABLE deliverable
   *     is S2's job (maybeSpawnDevServer stands it up on a leased port); statically
   *     serving the UNBUILT source html would be wrong. inputDeclaresDevServer is the
   *     SAME signal the dev-server selection gate keys off, so the two seams are
   *     mutually exclusive by construction (runChosen also skips S9 when a dev server
   *     was already spawned).
   *   - the resolver returns null / THROWS: the html could not be worktree-resolved or
   *     does not exist. Fail-soft (debug log) to the raw-htmlPath capture — the rung-0
   *     backend's own file:// module-block diagnostic breadcrumb explains the resulting
   *     blank styled shell to a human.
   *   - the provider.spawn THROWS (bind failure / abort mid-listen): warn + return
   *     null. A static-serve failure must NEVER wedge the request — capturing the raw
   *     htmlPath (blank though it may render) is strictly better than a fabricated FAIL,
   *     and the same file:// diagnostic breadcrumb covers the confusion.
   *
   * The confining static root rides `resolvedContext` (the matched verify.json
   * deliverable's explicit `staticRoot`, when it declares one) rather than the request
   * input — staticRoot is a serve-time concern, not an input field. The resolver
   * defaults it to dirname(html) when absent.
   */
  private async maybeSpawnStaticServer(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    resolvedContext: { cwd: string; deliverable: DeliverableVerifyConfig } | null,
    signal: AbortSignal,
  ): Promise<StaticServerHandle | null> {
    if (!this.staticServerProvider || !this.staticHtmlContextResolver) {
      return null;
    }
    const htmlPath = input.htmlPath?.trim() ?? '';
    if (htmlPath.length === 0) {
      return null;
    }
    // A running url the agent passed is captured directly — never shadowed by a static
    // serve of a build output.
    if (typeof input.url === 'string' && input.url.trim().length > 0) {
      return null;
    }
    // A startable deliverable is the dev-server seam's job (S2), not ours.
    if (this.inputDeclaresDevServer(input)) {
      return null;
    }

    // Resolve the absolute html path + confining static root (fs work lives in the
    // injected closure). A throw is the same fail-soft "no static server" path as a
    // null return — the raw htmlPath capture runs unchanged.
    let context: { absoluteHtmlPath: string; staticRoot: string } | null;
    try {
      context = await this.staticHtmlContextResolver({
        runId: row.run_id,
        projectId: row.project_id,
        htmlPath,
        staticRoot: resolvedContext?.deliverable?.staticRoot,
      });
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] static html context resolve threw; capturing raw htmlPath', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!context) {
      this.logger?.debug('[VerificationScheduler] no static html context; capturing raw htmlPath', {
        requestId: row.id,
      });
      return null;
    }

    // Stand the server up. A bind/abort failure fail-softs to the raw htmlPath capture
    // (never a request FAIL) — the rung-0 file:// diagnostic breadcrumb covers it.
    try {
      this.logger?.debug('[VerificationScheduler] spawning static server', {
        requestId: row.id,
        absoluteHtmlPath: context.absoluteHtmlPath,
        staticRoot: context.staticRoot,
      });
      return await this.staticServerProvider.spawn({
        absoluteHtmlPath: context.absoluteHtmlPath,
        staticRoot: context.staticRoot,
        signal,
      });
    } catch (err) {
      this.logger?.warn('[VerificationScheduler] static server spawn threw; capturing raw htmlPath (fail-soft)', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Bound UNTRUSTED capture diagnostics (Codex finding 7) before they ride a terminal
   * payload to the human surfaces: cap at 10 entries AND 2000 total chars. Entries are
   * taken in order; the entry that would overflow the char budget is TRUNCATED to the
   * remaining budget and every entry after it is DROPPED. Page code controls this text
   * (prompt-injection surface), so it is defensively bounded here and NEVER threaded
   * into VlmJudge inputs — it is metadata for the result payload / review item only.
   */
  private capDiagnostics(diagnostics: string[]): string[] {
    const MAX_ENTRIES = 10;
    const MAX_TOTAL_CHARS = 2000;
    const capped: string[] = [];
    let total = 0;
    for (const entry of diagnostics.slice(0, MAX_ENTRIES)) {
      const remaining = MAX_TOTAL_CHARS - total;
      if (remaining <= 0) break;
      if (entry.length <= remaining) {
        capped.push(entry);
        total += entry.length;
      } else {
        // The overflowing entry is truncated to fit the budget; the rest are dropped.
        capped.push(entry.slice(0, remaining));
        break;
      }
    }
    return capped;
  }

  /**
   * S5 — resolve + run the golden-baseline SSIM pre-diff for a request, or null when
   * there is nothing to compare (no resolver injected / no baselineKey / no accepted
   * baseline for any captured viewport). Fail-soft: a resolver throw degrades to null
   * (run the VLM with no baseline) rather than wedging the drain. The `match` flag is
   * re-derived against THIS scheduler's threshold so the gate is owned here even if a
   * resolver reports its own.
   */
  private async resolveBaselinePreDiff(
    row: VerificationRequestRow,
    input: VerificationRequestInput,
    ctx: CaptureContext,
    fileNames: string[],
  ): Promise<BaselinePreDiffResult | null> {
    if (!this.baselinePreDiff) return null;
    if (!input.baselineKey || input.baselineKey.trim().length === 0) return null;
    try {
      const result = await this.baselinePreDiff({
        projectId: row.project_id,
        runId: row.run_id,
        input,
        artifactsDir: ctx.artifactsDir,
        fileNames,
      });
      if (!result) return null;
      // Own the gate: re-derive `match` against this scheduler's threshold.
      return { ...result, match: result.ssimScore >= this.baselineMatchThreshold };
    } catch (err) {
      this.logger?.debug('[VerificationScheduler] baseline pre-diff failed; running VLM', {
        requestId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Map a judge VerdictV1 to a terminal request status, applying the confidence
   * floor: a 'pass'/'fail' below vlmConfidenceThreshold is demoted to
   * 'low_confidence' (a human review_item, never an auto-loop / fabricated verdict).
   */
  private statusFromVerdict(verdict: VerdictV1): RequestStatus {
    if (verdict.status === 'low_confidence') return 'low_confidence';
    if (verdict.confidence < this.config.vlmConfidenceThreshold) return 'low_confidence';
    return verdict.status === 'pass' ? 'passed' : 'failed';
  }
}
