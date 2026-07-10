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
 * item finding body + the screenshots artifact payload. The four origins:
 *   - 'dev-server'    — the S2 scheduler-owned dev server was stood up on a leased port.
 *   - 'static-server' — the S9 ephemeral loopback static server served a built htmlPath.
 *   - 'url'           — the agent passed a pre-existing running `url` (no server stood up).
 *   - 'file'          — the raw file:// htmlPath capture (no server, no url).
 */
export type CaptureOrigin = 'dev-server' | 'static-server' | 'url' | 'file';

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
  /** Per-run cap on VlmJudge (vision) calls — bounds 2026 Agent-SDK billing. Default 4. */
  maxPerRunJudgeCalls?: number;
  /** Dev-server port pool the ResourceLeasePool serializes web captures over (verify:port:<p>). */
  devServerPorts?: number[];
  /** Simulator device ids for the maestro/mobile pool. Default [] (mobile inert until provisioned). */
  simulatorDevices?: string[];
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
}
