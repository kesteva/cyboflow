/**
 * Pure shared seam for layered visual verification (see
 * docs/proposals/visual-verification-design.md). Sibling to ./substrate.ts and
 * ./executionModel.ts: both the main process (resolver, scheduler, backends,
 * judge, registry) and the renderer (verify panel, settings) import from here.
 *
 * This file is the ONE place the verification taxonomy, the backend id set, the
 * capability matrix, and the fall-forward chains are declared — a wrong matrix
 * entry silently mis-routes a request, so the table is small + reviewed
 * (4 backends × 5 types). Keep it free of Node.js / Electron / IPC / runtime
 * imports so it can be imported in any environment (it is pure types + consts).
 *
 * CONTRACT NOTES (single contract split across files — widen together):
 *  - The VerificationType union, the FALLBACK_CHAINS keys, and the BACKEND_CAPABILITIES
 *    columns are one taxonomy. If a new type is ever added, widen all three.
 *  - The VisualBackendId union and the BACKEND_CAPABILITIES rows / FALLBACK_CHAINS
 *    members are one backend set. If a new backend is ever added, widen both.
 *  - REQUEST_STATUS mirrors the CHECK domain on verification_requests.status in
 *    migration 055 (defined in P3) — a single contract split across TypeScript +
 *    SQL, exactly as the CliSubstrate / migration 013 pairing.
 */

/**
 * What KIND of visual check a deliverable needs. Determined once via the override
 * ladder (agent-declared > project/AppConfig default > inferred from deliverable
 * kind); see visualVerificationResolver.ts. The type selects a FALLBACK_CHAINS
 * entry — the ordered, easy→hard backend list the scheduler walks.
 */
export type VerificationType =
  | 'static-render-snapshot' // render + roughly look right, no interaction
  | 'interactive-web-behavior' // navigate/click/type/wait-for; multi-step DOM
  | 'responsive-multi-viewport' // same web artifact across N widths
  | 'native-desktop' // the REAL running app (incl. cyboflow's OWN renderer)
  | 'mobile-flow'; // iOS/Android build, YAML flow

/**
 * All five VerificationType members, in taxonomy order. A single source of truth
 * for callers that need to iterate the type space (e.g. matrix/chain invariant
 * checks, UI pickers) without re-listing the union by hand.
 */
export const VERIFICATION_TYPES: readonly VerificationType[] = [
  'static-render-snapshot',
  'interactive-web-behavior',
  'responsive-multi-viewport',
  'native-desktop',
  'mobile-flow',
] as const;

/**
 * The capability ladder, cheapest→costliest rung (rung 0..3):
 *  - capturePage (0): in-process offscreen BrowserWindow.capturePage(); no lease.
 *  - playwright  (1): library in a child process; headless; cheap (CPU).
 *  - peekaboo    (2): MCP screen capture; the ONLY backend that sees cyboflow's
 *                     own renderer; single-screen serialized.
 *  - maestro     (3): mobile device/simulator via the `maestro` CLI; inert until
 *                     a simulator pool exists.
 */
export type VisualBackendId = 'capturePage' | 'playwright' | 'peekaboo' | 'maestro';

/**
 * The verification-AGENT engine's stamp member (redesign §5.8). A run stamped
 * `verify_chain: ['agent']` routes every request to the VerificationAgentRunner
 * instead of the capture-backend waterfall — the agent builds/serves/drives/judges
 * a `VerificationTaskV1` itself. `'agent'` is deliberately NOT a `VisualBackendId`
 * (it is not a capture rung and never appears in `BACKEND_CAPABILITIES` /
 * `FALLBACK_CHAINS`): it is a distinct engine selector that only ever occupies the
 * STAMPED chain. The stamped-chain type therefore widens the backend-id union with
 * this one member; the MCP handler's `parseStampedChain` drops unknown-to-it
 * entries, so an `'agent'` stamp yields an empty per-request `chain_json` — harmless
 * because dispatch keys on the RUN stamp, never on `chain_json`.
 */
export type VerifyChainEntry = VisualBackendId | 'agent';

/**
 * The single-member agent-engine stamp (`['agent']`). `resolveVisualVerification`
 * stamps this for every NEW verify-enabled run (unless `CYBOFLOW_VERIFY_LEGACY=1`),
 * and the scheduler dispatches a run whose stamp equals it to the agent runner.
 */
export const VERIFY_AGENT_CHAIN: readonly ['agent'] = ['agent'] as const;

/**
 * Which VerificationType each backend can satisfy (the design-doc waterfall
 * table). This is the compile-time capability gap encoder: capturePage is
 * already absent from the interactive-web chain because it cannot click. The
 * FALLBACK_CHAINS below MUST be a subset of these capabilities for every type —
 * the invariant test enforces it so a chain can never list a backend that the
 * matrix says cannot do that type.
 */
export const BACKEND_CAPABILITIES: Record<VisualBackendId, readonly VerificationType[]> = {
  // Rung 0 — render-only; cannot interact.
  capturePage: ['static-render-snapshot', 'responsive-multi-viewport'],
  // Rung 1 — headless browser; can interact.
  playwright: ['static-render-snapshot', 'interactive-web-behavior', 'responsive-multi-viewport'],
  // Rung 2 — screen capture of the real running app; only path to native-desktop.
  peekaboo: [
    'static-render-snapshot',
    'interactive-web-behavior',
    'responsive-multi-viewport',
    'native-desktop',
  ],
  // Rung 3 — mobile device/simulator only.
  maestro: ['mobile-flow'],
};

/**
 * The ordered easy→hard backend chain per VerificationType (mirrors the design
 * doc EXACTLY). The scheduler resolves the live chain as FALLBACK_CHAINS[type] ∩
 * {backends whose host-deps are available}, then walks it on a runtime-failure
 * fall-forward.
 *
 *  - interactive-web-behavior EXCLUDES capturePage (it cannot click).
 *  - native-desktop is ['peekaboo'] ONLY: for cyboflow's own renderer both
 *    capturePage and playwright fail identically (the renderer needs the
 *    preload-injected electronTRPC); Peekaboo wins because it screenshots the
 *    already-running app instead of bootstrapping it.
 *  - mobile-flow is ['maestro'] ONLY (and maestro is inert until a sim pool exists).
 */
export const FALLBACK_CHAINS: Record<VerificationType, VisualBackendId[]> = {
  'static-render-snapshot': ['capturePage', 'playwright', 'peekaboo'],
  'interactive-web-behavior': ['playwright', 'peekaboo'], // capturePage can't click
  'responsive-multi-viewport': ['capturePage', 'playwright', 'peekaboo'],
  'native-desktop': ['peekaboo'], // ONLY Peekaboo (see note)
  'mobile-flow': ['maestro'],
};

/**
 * The lifecycle of a row in verification_requests (migration 055). Mirrors the
 * CHECK domain on that column — a single contract split across TypeScript + SQL.
 *   queued  → enqueued, awaiting a free drain slot.
 *   leased  → a resource lease is held; capture about to start.
 *   running → a backend is capturing / the judge is judging.
 *   passed | failed | low_confidence → terminal verdict states.
 *   skipped → no backend could satisfy the type (missing precondition; never FAIL).
 *   timeout → per-request deadline (or orphan recovery) aborted it.
 */
export type RequestStatus =
  | 'queued'
  | 'leased'
  | 'running'
  | 'passed'
  | 'failed'
  | 'low_confidence'
  | 'skipped'
  | 'timeout';

/**
 * The string-literal members of RequestStatus, for runtime iteration / guards and
 * to keep the SQL CHECK domain in sync from one source.
 */
export const REQUEST_STATUS: readonly RequestStatus[] = [
  'queued',
  'leased',
  'running',
  'passed',
  'failed',
  'low_confidence',
  'skipped',
  'timeout',
] as const;

/**
 * Sentinel `requiredLease()` return that means "I need SOME pooled dev-server port
 * lease — pick any free configured one", WITHOUT naming a concrete port. The
 * scheduler's poolCandidatesFor expands this purely from the configured
 * devServerPorts pool (it does NOT append the sentinel as a phantom slot), so a
 * backend that wants a port can never invent an extra always-free count-1 lease
 * (which would defeat the dev-server concurrency cap and yield port 0 under
 * contention). A backend that genuinely wants a SPECIFIC port may still return a
 * concrete 'verify:port:<p>' name; this sentinel is the "any pooled port" case.
 */
export const VERIFY_PORT_ANY = 'verify:port:any';

/**
 * One capture viewport — a width/height pair plus an optional human label
 * (e.g. "mobile" / "desktop"), driving `responsive-multi-viewport` and
 * `VerificationTaskV1.viewports` (§5.1). Shared shape so a request's inline
 * viewport array and a composed task's viewport array can never drift.
 */
export interface ViewportSpec {
  width: number;
  height: number;
  label?: string;
}

/**
 * What a lane agent asks for. `intent` is the natural-language acceptance the
 * VLM judge is told to check. `typeOverride` is the agent-declared (highest
 * precedence) type. `url` / `htmlPath` point at the deliverable; `viewports`
 * drives responsive-multi-viewport; `baselineKey` selects a golden baseline (a
 * later layer — absent ⇒ intent-only judging).
 */
export interface VerificationRequestInput {
  intent: string;
  typeOverride?: VerificationType;
  url?: string;
  htmlPath?: string;
  viewports?: ViewportSpec[];
  /**
   * The ordered DOM steps for an interactive check (navigate/click/type/wait).
   * Mirrors DeliverableVerifyConfig.interactions — the lane agent may pass them
   * inline OR they may be hydrated from `.cyboflow/verify.json`. A non-empty list
   * is the signal the resolver's type-ladder rung C reads to infer
   * 'interactive-web-behavior' over the static type. Absent/empty ⇒ no inferred
   * interaction (a render-only check).
   */
  interactions?: Array<{
    action: 'click' | 'type' | 'navigate' | 'wait';
    target?: string;
    value?: string;
    ms?: number;
  }>;
  /**
   * The deliverable's `start` command (mirrors DeliverableVerifyConfig.start),
   * hydrated onto the request when a startable verify.json deliverable was matched.
   * Its PRESENCE is the signal the Rung-1 Playwright backend's requiredLease() reads
   * to ask for a `verify:port` lease (the scheduler then spawns + leases the dev
   * server, locked decision #1 / S2). Absent ⇒ a pre-existing static url, no lease.
   * The backend never runs this command (the scheduler owns the dev server); it only
   * reads its presence.
   */
  start?: string;
  /**
   * EXPLICIT deterministic assertions (mirrors DeliverableVerifyConfig.assertions).
   * The lane agent may pass them inline OR they are hydrated from the deliverable
   * recipe. When present + ALL pass, the Rung-1 Playwright backend sets a
   * deterministic PASS verdict and the scheduler skips the VLM (decision #3
   * conservative-skip). Absent ⇒ structural success alone never short-circuits.
   */
  assertions?: DeliverableAssertion[];
  baselineKey?: string;
  /**
   * The lane this request belongs to, for verdict→lane attribution in the visual
   * merge-gate (locked decision #2). The lane agent passes its OWN display ref
   * (e.g. "TASK-008") or opaque task id; the merge-gate driver resolves it through
   * SprintLaneStore (ref OR id, same as updateLane). Optional + carried inside
   * deliverable_json (no new column — migration 055 is frozen): absent for a
   * single-lane batch (attribution is unambiguous) or a non-sprint run (no gate).
   */
  taskRef?: string;
}

/**
 * The structured verdict the VlmJudge returns (V1). `status` drives the gate
 * (pass → advance, fail → re-implement, low_confidence → human review, never an
 * auto-loop). `confidence` is the judge's self-reported certainty; below the
 * configured threshold the status is forced to 'low_confidence'. `judgedFileNames`
 * are the PNGs actually shown to the model; `baselineUsed` records whether a
 * golden baseline was compared; `model` is the vision model id.
 */
export interface VerdictV1 {
  status: 'pass' | 'fail' | 'low_confidence';
  confidence: number;
  issues: Array<{
    severity: 'low' | 'medium' | 'high';
    description: string;
    fileName?: string;
  }>;
  feedback: string;
  judgedFileNames: string[];
  baselineUsed: boolean;
  model: string;
  /**
   * ADDITIVE baseline-comparison fields (S5 — folds VerdictV1BaselineExtension
   * onto V1 now that golden baselines + SSIM pre-diff land). Both OPTIONAL so an
   * S1..S4 verdict (no baseline) is byte-identical:
   *  - `verdictSource` records HOW the verdict was reached — `'ssim_match'` when
   *    the deterministic SSIM pre-diff matched an existing baseline (cheap; the
   *    paid VLM was skipped) or `'vlm_verdict'` when the vision judge produced it.
   *    Absent on a pre-S5 verdict / a backend deterministic verdict.
   *  - `ssimScore` is the structural-similarity score the SSIM pre-diff computed
   *    against the baseline (1.0 = identical), present only on an `'ssim_match'`.
   */
  verdictSource?: 'ssim_match' | 'vlm_verdict';
  ssimScore?: number;
  /**
   * The stable baseline handle this verdict's deliverable is filed under (R7 —
   * threaded from the delivered request's `input.baselineKey`, which R2 hydrates
   * from `.cyboflow/verify.json` as `deliverable.baselineKey ?? deliverable.id`).
   * Carried INSIDE the verdict block so the enrich chokepoint delivers it to the
   * screenshots-tab Accept-as-baseline button, which uses THIS key (not the opaque
   * per-run artifact row id) so accepted PNGs land in the SAME namespace the SSIM
   * pre-diff later resolves baselines by. OPTIONAL: absent when the request carried
   * no baselineKey (a raw inline request with no verify.json deliverable) — the
   * button is then disabled rather than minting an orphaned id-keyed baseline.
   */
  baselineKey?: string;
}

// ===========================================================================
// VerificationTaskV1 / VerificationReportV1 — the composed task-verify → agent
// contract (docs/proposals/verification-agent-redesign.md §5.1/§5.4). task-verify
// COMPOSES a VerificationTaskV1 on PASS; the centrally-deployed verification
// agent independently drives it and returns a VerificationReportV1. Both shapes
// travel as JSON (a markdown fence in the task-verify step output; the agent's
// `outputFormat: json_schema` result) so each ships a hand-rolled runtime
// validator here — no external schema lib, `unknown` + narrowing only.
// ===========================================================================

/**
 * The composed visual-verification task (§5.1). `behaviors` is the core
 * payload — the acceptance-criteria-derived steps the verification agent
 * independently drives and judges — and MAY be an empty array (a degenerate
 * task built from a bare `intent`, §5.2, has no behaviors). `build`/`serve`
 * are shell instructions run in the snapshot worktree (§5.5); `target` names a
 * pre-live deliverable for the degenerate path. `viewports`/`timeoutMs` are
 * capture/deadline knobs, both optional.
 */
export interface VerificationTaskV1 {
  version: 1;
  /** Lane attribution (unchanged semantics from VerificationRequestInput.taskRef). */
  taskRef?: string;
  /** Replaces the old one-sentence `intent` — a fuller task summary. */
  summary: string;
  /** Shell steps, run in the snapshot worktree, in order. */
  build?: string[];
  /** Optional long-running serve step. */
  serve?: {
    /** May reference `${PORT}`. */
    cmd: string;
    readyWhen?: { urlPath?: string; timeoutMs?: number };
    /**
     * When `'cdp'`, `cmd` launches the deliverable APP ITSELF exposing a
     * Chrome-DevTools-Protocol endpoint on the driver port (env
     * `VERIFY_DRIVER_PORT` — e.g. an Electron app passed
     * `--remote-debugging-port="$VERIFY_DRIVER_PORT"`); the bundled driver then
     * ATTACHES to that endpoint instead of launching its own headless chromium.
     * Absent/omitted = classic web serve (driver launches chromium and `goto`s
     * the served URL). Attach-mode still implies a serve (the app is launched by
     * `cmd`), so the port lease still rides along.
     */
    attach?: 'cdp';
  };
  /** Pre-live target (degenerate path — no build/serve). */
  target?: { url?: string; htmlPath?: string };
  behaviors: Array<{
    /** Stable within the task, e.g. "b1". */
    id: string;
    /** What behavior, in user terms. */
    description: string;
    /** How to exercise it (navigate/click/type/…). */
    steps?: string[];
    /** What must be observed for PASS. */
    expected: string;
  }>;
  viewports?: ViewportSpec[];
  /** Capped by scheduler config. */
  timeoutMs?: number;
}

/**
 * The verification agent's structured result (§5.4/§5.9), returned via
 * `outputFormat: json_schema` and re-validated harness-side (never trusted
 * verbatim). `behaviors[].id` must echo the task's ids; `outcome: 'pass'` with
 * any failing behavior is coerced to `'fail'` by {@link normalizeVerificationReportV1}
 * — the structured verdict, not prose, drives the merge gate.
 */
export interface VerificationReportV1 {
  version: 1;
  behaviors: Array<{
    id: string;
    result: 'pass' | 'fail' | 'not_testable';
    evidence: { screenshots: string[]; notes: string };
  }>;
  screenshots: Array<{ fileName: string; caption: string }>;
  outcome: 'pass' | 'fail' | 'build_failed' | 'launch_failed';
  /** Required when outcome is build_/launch_failed; see {@link normalizeVerificationReportV1}. */
  buildLogExcerpt?: string;
  /** 0..1; clamped by the normalizer. */
  confidence: number;
  /** Maps onto VerdictV1.feedback. */
  feedback: string;
  /** Reuses the existing VerdictV1 issue shape. */
  issues: VerdictV1['issues'];
}

/** True for a plain, non-array, non-null object — the base narrow every field check below builds on. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for a non-empty (post-trim) string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True for a finite number strictly greater than zero (viewport dims, timeouts). */
function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** True for an array whose every element is a string (an empty array counts). */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Strict runtime validator for a `VerificationTaskV1` fence payload (§5.1
 * contract). Rejects on the FIRST structural problem, naming the offending
 * path (e.g. `"behaviors[2].expected: expected non-empty string"`) so a
 * contract-error re-delegation can quote the exact defect. `behaviors` MAY be
 * an empty array; every other required field (`version`/`summary`/behavior
 * id·description·expected) must be a non-empty value of the right shape.
 * Behavior ids must be unique within the task. Unknown extra keys anywhere in
 * the payload are tolerated (forward compat) — this validator only checks the
 * fields it knows about.
 */
export function parseVerificationTaskV1(
  value: unknown,
): { ok: true; task: VerificationTaskV1 } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'root: expected an object' };
  if (value.version !== 1) return { ok: false, error: 'version: expected literal 1' };
  if (!isNonEmptyString(value.summary)) return { ok: false, error: 'summary: expected non-empty string' };
  const summary = value.summary;

  let taskRef: string | undefined;
  if (value.taskRef !== undefined) {
    if (!isNonEmptyString(value.taskRef)) return { ok: false, error: 'taskRef: expected non-empty string' };
    taskRef = value.taskRef;
  }

  let build: string[] | undefined;
  if (value.build !== undefined) {
    if (!isStringArray(value.build)) return { ok: false, error: 'build: expected an array of strings' };
    build = value.build;
  }

  let serve: VerificationTaskV1['serve'];
  if (value.serve !== undefined) {
    if (!isRecord(value.serve)) return { ok: false, error: 'serve: expected an object' };
    if (!isNonEmptyString(value.serve.cmd)) return { ok: false, error: 'serve.cmd: expected non-empty string' };
    const cmd = value.serve.cmd;
    let readyWhen: NonNullable<VerificationTaskV1['serve']>['readyWhen'];
    if (value.serve.readyWhen !== undefined) {
      if (!isRecord(value.serve.readyWhen)) {
        return { ok: false, error: 'serve.readyWhen: expected an object' };
      }
      const rw = value.serve.readyWhen;
      if (rw.urlPath !== undefined && typeof rw.urlPath !== 'string') {
        return { ok: false, error: 'serve.readyWhen.urlPath: expected string' };
      }
      if (rw.timeoutMs !== undefined && !isPositiveFiniteNumber(rw.timeoutMs)) {
        return { ok: false, error: 'serve.readyWhen.timeoutMs: expected positive finite number' };
      }
      readyWhen = {
        ...(rw.urlPath !== undefined ? { urlPath: rw.urlPath } : {}),
        ...(rw.timeoutMs !== undefined ? { timeoutMs: rw.timeoutMs } : {}),
      };
    }
    let attach: 'cdp' | undefined;
    if (value.serve.attach !== undefined) {
      if (value.serve.attach !== 'cdp') {
        return { ok: false, error: "serve.attach: expected the string 'cdp' when present" };
      }
      attach = value.serve.attach;
    }
    serve = {
      cmd,
      ...(readyWhen !== undefined ? { readyWhen } : {}),
      ...(attach !== undefined ? { attach } : {}),
    };
  }

  let target: VerificationTaskV1['target'];
  if (value.target !== undefined) {
    if (!isRecord(value.target)) return { ok: false, error: 'target: expected an object' };
    if (value.target.url !== undefined && typeof value.target.url !== 'string') {
      return { ok: false, error: 'target.url: expected string' };
    }
    if (value.target.htmlPath !== undefined && typeof value.target.htmlPath !== 'string') {
      return { ok: false, error: 'target.htmlPath: expected string' };
    }
    target = {
      ...(value.target.url !== undefined ? { url: value.target.url } : {}),
      ...(value.target.htmlPath !== undefined ? { htmlPath: value.target.htmlPath } : {}),
    };
  }

  if (!Array.isArray(value.behaviors)) return { ok: false, error: 'behaviors: expected an array' };
  const seenBehaviorIds = new Set<string>();
  const behaviors: VerificationTaskV1['behaviors'] = [];
  for (let i = 0; i < value.behaviors.length; i++) {
    const item = value.behaviors[i];
    const path = `behaviors[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${path}: expected an object` };
    if (!isNonEmptyString(item.id)) return { ok: false, error: `${path}.id: expected non-empty string` };
    if (seenBehaviorIds.has(item.id)) {
      return { ok: false, error: `${path}.id: duplicate behavior id "${item.id}"` };
    }
    seenBehaviorIds.add(item.id);
    if (!isNonEmptyString(item.description)) {
      return { ok: false, error: `${path}.description: expected non-empty string` };
    }
    if (!isNonEmptyString(item.expected)) {
      return { ok: false, error: `${path}.expected: expected non-empty string` };
    }
    if (item.steps !== undefined && !isStringArray(item.steps)) {
      return { ok: false, error: `${path}.steps: expected an array of strings` };
    }
    behaviors.push({
      id: item.id,
      description: item.description,
      expected: item.expected,
      ...(item.steps !== undefined ? { steps: item.steps } : {}),
    });
  }

  let viewports: ViewportSpec[] | undefined;
  if (value.viewports !== undefined) {
    if (!Array.isArray(value.viewports)) return { ok: false, error: 'viewports: expected an array' };
    const parsed: ViewportSpec[] = [];
    for (let i = 0; i < value.viewports.length; i++) {
      const item = value.viewports[i];
      const path = `viewports[${i}]`;
      if (!isRecord(item)) return { ok: false, error: `${path}: expected an object` };
      if (!isPositiveFiniteNumber(item.width)) {
        return { ok: false, error: `${path}.width: expected positive finite number` };
      }
      if (!isPositiveFiniteNumber(item.height)) {
        return { ok: false, error: `${path}.height: expected positive finite number` };
      }
      if (item.label !== undefined && typeof item.label !== 'string') {
        return { ok: false, error: `${path}.label: expected string` };
      }
      parsed.push({
        width: item.width,
        height: item.height,
        ...(item.label !== undefined ? { label: item.label } : {}),
      });
    }
    viewports = parsed;
  }

  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    if (!isPositiveFiniteNumber(value.timeoutMs)) {
      return { ok: false, error: 'timeoutMs: expected positive finite number' };
    }
    timeoutMs = value.timeoutMs;
  }

  const task: VerificationTaskV1 = {
    version: 1,
    summary,
    behaviors,
    ...(taskRef !== undefined ? { taskRef } : {}),
    ...(build !== undefined ? { build } : {}),
    ...(serve !== undefined ? { serve } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(viewports !== undefined ? { viewports } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return { ok: true, task };
}

/**
 * Strict runtime validator + normalizer for a `VerificationReportV1` result
 * (§5.4 validation paragraph). `expectedBehaviorIds` is the composing task's
 * behavior id set: every reported behavior id MUST be a member (an unknown id
 * is a hard error) but the report need not cover every expected id — an
 * uncovered id is the RUNNER's concern (treated as `not_testable` downstream),
 * not this validator's. `confidence` is clamped to `[0,1]` (clamping alone
 * does not set `coerced`). `buildLogExcerpt` is required (non-empty) exactly
 * when `outcome` is `'build_failed'`/`'launch_failed'`.
 *
 * COERCION (the one place this function mutates the reported shape): an
 * `outcome: 'pass'` alongside any `behaviors[].result === 'fail'` is coerced
 * to `outcome: 'fail'` with `coerced: true` — the structured per-behavior
 * verdict, not the agent's self-reported outcome, drives the merge gate.
 */
export function normalizeVerificationReportV1(
  value: unknown,
  expectedBehaviorIds: readonly string[],
): { ok: true; report: VerificationReportV1; coerced: boolean } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: 'root: expected an object' };
  if (value.version !== 1) return { ok: false, error: 'version: expected literal 1' };

  const expectedIds = new Set(expectedBehaviorIds);

  if (!Array.isArray(value.behaviors)) return { ok: false, error: 'behaviors: expected an array' };
  const behaviors: VerificationReportV1['behaviors'] = [];
  let anyBehaviorFailed = false;
  for (let i = 0; i < value.behaviors.length; i++) {
    const item = value.behaviors[i];
    const path = `behaviors[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${path}: expected an object` };
    if (!isNonEmptyString(item.id)) return { ok: false, error: `${path}.id: expected non-empty string` };
    if (!expectedIds.has(item.id)) {
      return { ok: false, error: `${path}.id: unknown behavior id "${item.id}"` };
    }
    if (item.result !== 'pass' && item.result !== 'fail' && item.result !== 'not_testable') {
      return { ok: false, error: `${path}.result: expected 'pass' | 'fail' | 'not_testable'` };
    }
    if (item.result === 'fail') anyBehaviorFailed = true;
    if (!isRecord(item.evidence)) return { ok: false, error: `${path}.evidence: expected an object` };
    if (!isStringArray(item.evidence.screenshots)) {
      return { ok: false, error: `${path}.evidence.screenshots: expected an array of strings` };
    }
    if (typeof item.evidence.notes !== 'string') {
      return { ok: false, error: `${path}.evidence.notes: expected string` };
    }
    behaviors.push({
      id: item.id,
      result: item.result,
      evidence: { screenshots: item.evidence.screenshots, notes: item.evidence.notes },
    });
  }

  if (!Array.isArray(value.screenshots)) return { ok: false, error: 'screenshots: expected an array' };
  const screenshots: VerificationReportV1['screenshots'] = [];
  for (let i = 0; i < value.screenshots.length; i++) {
    const item = value.screenshots[i];
    const path = `screenshots[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${path}: expected an object` };
    if (!isNonEmptyString(item.fileName)) {
      return { ok: false, error: `${path}.fileName: expected non-empty string` };
    }
    if (typeof item.caption !== 'string') return { ok: false, error: `${path}.caption: expected string` };
    screenshots.push({ fileName: item.fileName, caption: item.caption });
  }

  if (
    value.outcome !== 'pass' &&
    value.outcome !== 'fail' &&
    value.outcome !== 'build_failed' &&
    value.outcome !== 'launch_failed'
  ) {
    return { ok: false, error: "outcome: expected 'pass' | 'fail' | 'build_failed' | 'launch_failed'" };
  }
  let outcome: VerificationReportV1['outcome'] = value.outcome;

  const requiresBuildLog = outcome === 'build_failed' || outcome === 'launch_failed';
  let buildLogExcerpt: string | undefined;
  if (requiresBuildLog) {
    if (!isNonEmptyString(value.buildLogExcerpt)) {
      return {
        ok: false,
        error: 'buildLogExcerpt: required non-empty string when outcome is build_failed/launch_failed',
      };
    }
    buildLogExcerpt = value.buildLogExcerpt;
  } else if (value.buildLogExcerpt !== undefined) {
    if (typeof value.buildLogExcerpt !== 'string') {
      return { ok: false, error: 'buildLogExcerpt: expected string' };
    }
    buildLogExcerpt = value.buildLogExcerpt;
  }

  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) {
    return { ok: false, error: 'confidence: expected finite number' };
  }
  const confidence = Math.min(1, Math.max(0, value.confidence));

  if (typeof value.feedback !== 'string') return { ok: false, error: 'feedback: expected string' };
  const feedback = value.feedback;

  if (!Array.isArray(value.issues)) return { ok: false, error: 'issues: expected an array' };
  const issues: VerdictV1['issues'] = [];
  for (let i = 0; i < value.issues.length; i++) {
    const item = value.issues[i];
    const path = `issues[${i}]`;
    if (!isRecord(item)) return { ok: false, error: `${path}: expected an object` };
    if (item.severity !== 'low' && item.severity !== 'medium' && item.severity !== 'high') {
      return { ok: false, error: `${path}.severity: expected 'low' | 'medium' | 'high'` };
    }
    if (typeof item.description !== 'string') {
      return { ok: false, error: `${path}.description: expected string` };
    }
    if (item.fileName !== undefined && typeof item.fileName !== 'string') {
      return { ok: false, error: `${path}.fileName: expected string` };
    }
    issues.push({
      severity: item.severity,
      description: item.description,
      ...(item.fileName !== undefined ? { fileName: item.fileName } : {}),
    });
  }

  let coerced = false;
  if (outcome === 'pass' && anyBehaviorFailed) {
    outcome = 'fail';
    coerced = true;
  }

  const report: VerificationReportV1 = {
    version: 1,
    behaviors,
    screenshots,
    outcome,
    ...(buildLogExcerpt !== undefined ? { buildLogExcerpt } : {}),
    confidence,
    feedback,
    issues,
  };
  return { ok: true, report, coerced };
}

/**
 * Derive the legacy-shaped `VerificationRequestInput` a `VerificationTaskV1`
 * dual-writes (§5.2 dual-format contract). Every new request persists BOTH the
 * task AND this derived legacy shape so every pre-existing reader (legacy
 * capture/judge path, the recovery sweep, the Verify-Queue projection) keeps
 * working unchanged whether or not `task_json` is populated:
 *   - `intent` = `task.summary`.
 *   - `url` / `htmlPath` = `task.target.url` / `task.target.htmlPath`, when present
 *     (the degenerate pre-live path — a build/serve task has neither).
 *   - `viewports` = `task.viewports`, when present.
 *   - `taskRef` precedence is `task.taskRef ?? taskRef` (the explicit wire arg) —
 *     mirrors the design doc's "written identically into both columns" rule; the
 *     caller is responsible for any further single-lane default fallback.
 * Pure — no side effects, no defaulting beyond the stated precedence. Omits
 * absent fields entirely (never writes an `undefined` member onto the result).
 */
export function deriveLegacyInputFromTask(
  task: VerificationTaskV1,
  taskRef?: string,
): VerificationRequestInput {
  const input: VerificationRequestInput = { intent: task.summary };
  if (task.target?.url !== undefined) input.url = task.target.url;
  if (task.target?.htmlPath !== undefined) input.htmlPath = task.target.htmlPath;
  if (task.viewports !== undefined) input.viewports = task.viewports;
  const effectiveTaskRef = task.taskRef ?? taskRef;
  if (effectiveTaskRef !== undefined) input.taskRef = effectiveTaskRef;
  return input;
}

/**
 * The immutable context a backend receives for one capture attempt. `artifactsDir`
 * is the run's $CYBOFLOW_RUN_ARTIFACTS_DIR — backends write PNGs there. `requestId`
 * / `runId` thread provenance; `type` + `input` carry the resolved request.
 */
export interface CaptureContext {
  requestId: string;
  runId: string;
  artifactsDir: string;
  type: VerificationType;
  input: VerificationRequestInput;
}

/**
 * Where a request's capture was ultimately sourced from — stamped per attempt by
 * the scheduler as HUMAN-FACING provenance (S9). Purely additive metadata: it
 * never influences the verdict; it rides the onVerdict delivery into the review-
 * item finding body + the screenshots artifact payload. The five origins:
 *   - 'dev-server'    — the S2 scheduler-owned dev server was stood up on a leased port.
 *   - 'static-server' — the S9 ephemeral loopback static server served a built htmlPath.
 *   - 'url'           — the agent passed a pre-existing running `url` (no server stood up).
 *   - 'file'          — the raw file:// htmlPath capture (no server, no url).
 *   - 'agent'          — the verification-agent redesign's `VerificationAgentRunner`
 *     (proposal `docs/proposals/verification-agent-redesign.md` §5.4/§5.9) drove
 *     build/serve/capture itself inside a snapshot worktree — no scheduler-owned
 *     dev/static server and no bare pre-existing `url`/`file` capture.
 */
export type CaptureOrigin = 'dev-server' | 'static-server' | 'url' | 'file' | 'agent';

/**
 * The result of one backend capture attempt. `ok:false` (or an empty fileNames on
 * ok:true) is a runtime-failure fall-forward trigger — the scheduler advances to
 * the next rung in the chain. `fileNames` are relative to CaptureContext.artifactsDir.
 */
export interface CaptureResult {
  ok: boolean;
  fileNames: string[];
  error?: string;
  /**
   * DETERMINISTIC-FIRST signal channel (design decision #3). When a backend can
   * reach a verdict WITHOUT a paid vision call it sets this; the scheduler's
   * runChosen then USES it and SKIPS the VlmJudge. Left `undefined` by a backend
   * with no deterministic signal (capturePage / peekaboo) ⇒ the VLM runs exactly
   * as before (backward-compatible). The Playwright backend (Rung 1) sets it:
   *   - a deterministic FAIL (nav error / missing interaction target / uncaught
   *     page error) ALWAYS short-circuits the VLM — unambiguous.
   *   - a deterministic PASS is set ONLY when the deliverable declares EXPLICIT
   *     assertions and ALL pass exactly (conservative-skip rule); structural
   *     success WITHOUT declared assertions leaves this `undefined` so the VLM
   *     runs (NEVER a fabricated pass).
   * `null` is treated the same as `undefined` (no deterministic verdict).
   */
  deterministicVerdict?: VerdictV1 | null;
  /**
   * UNTRUSTED, human-facing capture diagnostics (S9 companion): error-level page
   * console lines and capture-side notes (file:// module-block warning, fold
   * truncation), capped by the backend. Page code controls this text, so it is
   * metadata for the HUMAN surfaces (result payload / review item) ONLY — it must
   * NEVER be threaded into VlmJudge inputs (prompt-injection surface) and never
   * determines pass/fail.
   */
  diagnostics?: string[];
}

/**
 * The narrow interface every capture backend implements. Injected into the
 * scheduler as a VerificationBackendRegistry (never imported there) so the
 * standalone-typecheck invariant holds — the scheduler stays free of electron /
 * better-sqlite3 / services imports.
 *
 *  - `rung` orders the ladder (0 cheapest).
 *  - `requiredLease(input)` returns the ResourceLeasePool lease name this backend
 *    needs for THIS request (e.g. 'verify:screen', a concrete 'verify:port:<p>',
 *    or the VERIFY_PORT_ANY sentinel = "any free pooled port"), or null when it is
 *    fully parallel and needs no lease (rung 0 / rung 1 sans dev server).
 *  - `healthCheck()` probes host-deps so the resolver can drop an unavailable
 *    backend from the chain (missing precondition ⇒ SKIP, never silent FAIL).
 *  - `capture(ctx, signal)` performs the capture, honoring the abort signal for
 *    per-request timeout / cancelForRun / teardown.
 */
export interface VisualBackend {
  readonly id: VisualBackendId;
  readonly rung: number;
  requiredLease(input: VerificationRequestInput): string | null;
  healthCheck(): Promise<boolean>;
  capture(ctx: CaptureContext, signal: AbortSignal): Promise<CaptureResult>;
}

/**
 * The injected backend set the scheduler dispatches over. Partial because a
 * backend whose host-deps are unavailable (no GUI/TCC for peekaboo, no simulator
 * pool for maestro) is simply absent — the resolver intersects FALLBACK_CHAINS
 * with the present keys.
 */
export type VerificationBackendRegistry = Partial<Record<VisualBackendId, VisualBackend>>;

/**
 * The orthogonal "Rung 4" judge — a stateless vision call applied after whichever
 * capture rung succeeded. Injected (never imported) into the scheduler so the
 * scheduler stays electron-free. Deterministic-assertion-first + a per-run call
 * cap bound its cost; below the confidence threshold it returns 'low_confidence'
 * (a human review_item) rather than a fabricated pass/fail.
 */
export interface VlmJudge {
  judge(
    args: {
      intent: string;
      artifactsDir: string;
      fileNames: string[];
      type: VerificationType;
      baselinePath?: string;
    },
    signal: AbortSignal,
  ): Promise<VerdictV1>;
}

/**
 * Runtime guard for an unknown value (config / agent frontmatter / per-request
 * override). Returns true only for a member of the VerificationType union, so the
 * resolver can reject + skip unrecognized values without casts (mirrors
 * isCliSubstrate / isExecutionModel).
 */
export function isVerificationType(v: unknown): v is VerificationType {
  return (
    v === 'static-render-snapshot' ||
    v === 'interactive-web-behavior' ||
    v === 'responsive-multi-viewport' ||
    v === 'native-desktop' ||
    v === 'mobile-flow'
  );
}

/**
 * The persisted `AppConfig.visualVerify` block (P2). Every member is OPTIONAL so
 * an absent block (the default) keeps config.json byte-identical — the
 * ConfigManager getter applies the floors below. Both the main process (resolver,
 * scheduler, judge) and the renderer (Settings) import this shape so it stays a
 * single contract. `defaultType` participates in the verification-type override
 * ladder (below the agent-declared type, above the inferred default).
 */
export interface VisualVerifyConfig {
  /** Global master switch. Default OFF — no request is ever enqueued when false. */
  enabled?: boolean;
  /** Project/AppConfig-default verification type (override-ladder rung). */
  defaultType?: VerificationType;
  /** Below this confidence the VlmJudge verdict is forced to 'low_confidence'. Default 0.7. */
  vlmConfidenceThreshold?: number;
  /**
   * Per-run cap on VlmJudge (vision) calls — bounds 2026 Agent-SDK billing.
   * Default 4. LEGACY-ENGINE ONLY (redesign §5.8): enforced by the in-memory
   * `cappedVlmJudge` decorator (main/src/index.ts) around the capture-backend +
   * VLM waterfall; the verification-AGENT deployment on the default v1 engine
   * never calls VlmJudge and does not consume this cap. Do not confuse with the
   * PERSISTED per-project verification budget
   * (`projects.visual_verify_budget_calls` /
   * `verification_requests.judge_calls_used`, migration 056), which DID
   * generalize to cover an agent deployment exactly like a legacy judge call —
   * see `VerificationScheduler.isProjectBudgetExhausted`.
   */
  maxPerRunJudgeCalls?: number;
  /** Dev-server port pool the ResourceLeasePool serializes web captures over (verify:port:<p>). */
  devServerPorts?: number[];
  /** Simulator device ids for the maestro/mobile pool. Default [] (mobile inert until provisioned). */
  simulatorDevices?: string[];
  /**
   * Enqueue-age ceiling (ms) covering a request's QUEUED + lease-wait time,
   * measured from `enqueued_at` (redesign §5.6). A row that has not acquired its
   * lease within this window is terminalized 'skipped' (fail-open, concrete lease
   * reason) instead of sitting `queued` forever while a merge-gate lane waits.
   * Default 15 min ({@link DEFAULT_QUEUED_AGE_CEILING_MS}).
   */
  queuedAgeCeilingMs?: number;
}

/**
 * The fully-resolved visualVerify block, every field present — the return shape
 * of ConfigManager.getVisualVerifyConfig(). Mirrors VisualVerifyConfig with all
 * optionals made required after the ConfigManager applies VISUAL_VERIFY_DEFAULTS.
 */
export interface ResolvedVisualVerifyConfig {
  enabled: boolean;
  defaultType: VerificationType;
  vlmConfidenceThreshold: number;
  maxPerRunJudgeCalls: number;
  devServerPorts: number[];
  simulatorDevices: string[];
  queuedAgeCeilingMs: number;
}

/**
 * The default dev-server port pool — 5 ports (= SPRINT_BATCH_CAP, one per
 * concurrent sprint lane) so port-bound web captures never out-contend the lane
 * fan-out. Users override via AppConfig.visualVerify.devServerPorts.
 *
 * Deliberately NOT the common dev ports (5173/3000/4173/8080/4321): since the
 * scheduler owns + binds these directly (the per-port lease guards the logical
 * slot, NOT the OS socket — see verificationScheduler.poolCandidatesFor), a port
 * a user already has Vite/Next/etc. squatting would make the spawned dev server
 * fail to bind or the readiness probe answer the WRONG server. So this is an
 * intentionally-uncommon block (mnemonic: CYBO → 2926 on a phone keypad → 2926x)
 * chosen to collide with as little as possible. It also sits below BOTH the Linux
 * ephemeral floor (32768) and the macOS ephemeral floor (49152) so the OS never
 * hands these out as outbound source ports.
 *
 * The slots step by 2 (not 1) so each leased port has an adjacent free port: dev
 * servers commonly grab a SECOND port next to the main one (e.g. Vite's HMR
 * websocket), and the +1 gap keeps that sidecar from landing on the next slot.
 */
export const DEFAULT_VERIFY_DEV_PORTS: readonly number[] = [29260, 29262, 29264, 29266, 29268] as const;

/**
 * The default enqueue-age ceiling — 15 minutes covering a request's QUEUED +
 * lease-wait time (redesign §5.6). Sized above the 10-minute default agent
 * deadline (a request that DID lease its slot may legitimately run ~10 min), so
 * this ceiling only bites a row that never got a lease at all (persistent
 * contention / a wedged pool) rather than one that is simply running long.
 */
export const DEFAULT_QUEUED_AGE_CEILING_MS = 15 * 60 * 1000;

/**
 * The floors ConfigManager.getVisualVerifyConfig() applies when a member of the
 * persisted block is absent. `enabled` floors to false (master switch OFF by
 * default); the rest mirror the design doc (#7). Kept here so the contract +
 * defaults live in one reviewed place.
 */
export const VISUAL_VERIFY_DEFAULTS: ResolvedVisualVerifyConfig = {
  enabled: false,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [...DEFAULT_VERIFY_DEV_PORTS],
  simulatorDevices: [],
  queuedAgeCeilingMs: DEFAULT_QUEUED_AGE_CEILING_MS,
};

// ===========================================================================
// Per-project `.cyboflow/verify.json` contract (read by verifyConfigLoader.ts)
//
// The per-deliverable "how to run this" product config that travels WITH the
// deliverable at PROJECT ROOT (sibling to `.cyboflow/artifacts`) — deliberately
// NOT in `.claude/settings.json` or the DB (design doc §"Config homes" + #6).
// Shared infra: consumed by the createRun stamp (project enablement +
// defaultType rungs), the S2 dev-server runner (`build` / `start` / `readyWhen`
// / `${PORT}`), and the S5 baselines (`baselineKey`). EVERY member is optional —
// an absent file (the common case) resolves to `null`, never a fatal error.
// ===========================================================================

/**
 * A single deliverable's verification recipe inside `.cyboflow/verify.json`.
 * `id` is the stable handle a lane agent references; the rest describe HOW to
 * stand the deliverable up + WHAT to check.
 *
 *  - `type` — per-deliverable type override (participates in the resolver ladder
 *    below the agent-declared type, above the inferred-from-kind rung).
 *  - `build` / `start` — shell commands the S2 dev-server runner runs (build once,
 *    then `start` long-lived); `${PORT}` in `start` is substituted with a leased
 *    `verify:port:<p>` from the pool.
 *  - `url` / `htmlPath` — the artifact the backend captures (`url` for a running
 *    dev server, `htmlPath` for a static file).
 *  - `readyWhen` — a readiness probe (e.g. an HTTP URL / log substring) the runner
 *    polls before declaring the server up.
 *  - `viewports` — widths for `responsive-multi-viewport`.
 *  - `interactions` — the ordered DOM steps for `interactive-web-behavior`; a
 *    non-empty list is what the resolver's rung-C inference reads to pick the
 *    interactive type over the static one.
 *  - `baselineKey` — selects a golden baseline for SSIM pre-diff (S5).
 *  - `assertions` — EXPLICIT deterministic checks the Rung-1 Playwright backend
 *    runs after the interactions play (decision #3 conservative-skip). When present
 *    and ALL pass exactly, the backend sets a deterministic PASS verdict and the
 *    scheduler SKIPS the (paid) VLM; any failing assertion is a deterministic FAIL.
 *    Absent ⇒ structural success alone never short-circuits the VLM.
 */
export interface DeliverableVerifyConfig {
  id: string;
  type?: VerificationType;
  build?: string;
  start?: string;
  url?: string;
  htmlPath?: string;
  /**
   * Explicit static-serve root for an `htmlPath` deliverable (S9). The scheduler-
   * owned static server confines itself to this directory (resolved against the
   * checkout root). Absent ⇒ dirname(htmlPath) — correct when the html sits at the
   * build root; declare this for layouts whose root-absolute assets live above the
   * html's own directory (e.g. `dist/docs/index.html` referencing `/assets/...`).
   */
  staticRoot?: string;
  readyWhen?: string;
  viewports?: Array<{ width: number; height: number; label?: string }>;
  interactions?: Array<{
    action: 'click' | 'type' | 'navigate' | 'wait';
    target?: string;
    value?: string;
    ms?: number;
  }>;
  baselineKey?: string;
  assertions?: DeliverableAssertion[];
}

/**
 * One EXPLICIT deterministic assertion (decision #3 conservative-skip rule). The
 * Rung-1 Playwright backend evaluates these after the interactions play; ALL must
 * pass for a deterministic PASS that skips the VLM, and any failure is a
 * deterministic FAIL. Kept a named export so the backend + verify.json authoring
 * share one shape.
 *   - 'visible' — `selector` must resolve to a visible element.
 *   - 'hidden'  — `selector` must resolve to a hidden/absent element.
 *   - 'text'    — `selector`'s text content must contain `text` (required for this kind).
 */
export interface DeliverableAssertion {
  kind: 'visible' | 'hidden' | 'text';
  selector: string;
  text?: string;
}

/**
 * The whole `.cyboflow/verify.json` document. `enabled` / `defaultType` feed the
 * PROJECT-config rungs of the resolver ladder (below per-run, above global);
 * `deliverables` is the per-deliverable recipe map. All optional — an empty
 * `{}` file is valid and resolves every rung to "unset → fall through".
 */
export interface VerifyConfigFile {
  enabled?: boolean;
  defaultType?: VerificationType;
  deliverables?: DeliverableVerifyConfig[];
}

/**
 * Metadata for an accepted golden baseline (S5 — declared now, no consumer until
 * then). `key` matches `DeliverableVerifyConfig.baselineKey`; `viewports` records
 * the widths the baseline PNGs were captured at; `acceptedAt` is the ISO accept
 * time; `notes` is an optional reviewer annotation. Persisted alongside the
 * baseline PNGs via the ArtifactRouter accept-baseline write (never a direct
 * table write).
 */
export interface BaselineMetadata {
  key: string;
  viewports: Array<{ width: number; height: number; label?: string }>;
  acceptedAt: string;
  notes?: string;
}

/**
 * Additive baseline-comparison fields the VlmJudge verdict gains once SSIM
 * pre-diff lands (S5 — declared now, no consumer until then). `ssimScore` is the
 * structural-similarity score against the baseline (1.0 = identical);
 * `verdictSource` records whether the verdict came from the deterministic SSIM
 * match (cheap, skips the vision call) or the VLM. Kept separate from VerdictV1
 * so the V1 shape stays frozen until S5 widens it.
 */
export interface VerdictV1BaselineExtension {
  ssimScore?: number;
  verdictSource?: 'ssim_match' | 'vlm_verdict';
}

/**
 * One row of the `verification_requests` table (migration 055, written in a
 * later slice) as read at the L6 verify-queue panel boundary (declared now for
 * S7/L6 — no consumer until then). Snake_case mirrors the SQLite columns; the
 * JSON columns (`deliverable_json` / `chain_json` / `verdict_json`) are stored as
 * TEXT and parsed by the reader into VerificationRequestInput / VisualBackendId[]
 * / VerdictV1 respectively. `current_backend` / `verdict_json` / lease+end times
 * are nullable until the request advances through its lifecycle.
 */
export interface VerificationRequestRow {
  id: string;
  run_id: string;
  project_id: number;
  status: RequestStatus;
  verify_type: VerificationType;
  deliverable_json: string;
  chain_json: string;
  current_backend: VisualBackendId | null;
  attempt: number;
  verdict_json: string | null;
  error_message: string | null;
  enqueued_at: string;
  leased_at: string | null;
  ended_at: string | null;
  /**
   * Migration-078 columns (verification-agent redesign §5.2/§5.6). All five are
   * additive nullable — NULL on every pre-078 row and on the legacy engine path:
   * `task_json` (the composed VerificationTaskV1), `report_json` (the agent's
   * VerificationReportV1 at terminal), `delivery_state` (the delivery-outbox
   * marker, 'pending' | 'delivered'), `snapshot_sha` (the §5.5 snapshot commit),
   * `enqueue_key` (the §5.3 idempotency key `runId:taskRef:attempt`).
   */
  task_json: string | null;
  report_json: string | null;
  delivery_state: string | null;
  snapshot_sha: string | null;
  enqueue_key: string | null;
}
