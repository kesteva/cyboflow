/**
 * Pure shared seam for layered visual verification (see
 * docs/visual-verification-design.md). Sibling to ./substrate.ts and
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
 *    migration 036 (defined in P3) — a single contract split across TypeScript +
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
 * The lifecycle of a row in verification_requests (migration 036). Mirrors the
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
  viewports?: Array<{ width: number; height: number; label?: string }>;
  baselineKey?: string;
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
 * The result of one backend capture attempt. `ok:false` (or an empty fileNames on
 * ok:true) is a runtime-failure fall-forward trigger — the scheduler advances to
 * the next rung in the chain. `fileNames` are relative to CaptureContext.artifactsDir.
 */
export interface CaptureResult {
  ok: boolean;
  fileNames: string[];
  error?: string;
}

/**
 * The narrow interface every capture backend implements. Injected into the
 * scheduler as a VerificationBackendRegistry (never imported there) so the
 * standalone-typecheck invariant holds — the scheduler stays free of electron /
 * better-sqlite3 / services imports.
 *
 *  - `rung` orders the ladder (0 cheapest).
 *  - `requiredLease(input)` returns the ResourceLeasePool lease name this backend
 *    needs for THIS request (e.g. 'verify:screen', 'verify:port:<p>'), or null
 *    when it is fully parallel and needs no lease (rung 0 / rung 1 sans dev server).
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
