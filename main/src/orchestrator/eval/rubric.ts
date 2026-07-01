/**
 * Code-Review Eval rubric v1.1 — the frozen, data-only transcription of
 * docs/proposals/code-review-eval-checklist.md that an out-of-loop judge runs
 * against a workflow's pre-human diff snapshot.
 *
 * This module is DATA + PURE HELPERS only — zero I/O, no Date/random. The judge
 * prompt is built from `serializeRubricForPrompt(RUBRIC)` and the resulting
 * string is hashed into `run_evals.prompt_hash`, so the serialization MUST be
 * deterministic (stable array ordering, no environment-dependent values).
 *
 * Faithfulness contract: 7 dimensions, weights 26/18/14/14/12/8/8 (sum 100),
 * 58 sub-checks (9+9+8+7+8+9+8). Every sub-check carries its verbatim *Applies*
 * scope and *Unknown* clause from the doc.
 */

export const RUBRIC_VERSION = '1.1';

/** Stable per-dimension keys — persisted in run_evals.dimensions_json. */
export type DimensionKey =
  | 'correctness'
  | 'security'
  | 'robustness'
  | 'design'
  | 'maintainability'
  | 'tests'
  | 'scope';

/**
 * Catastrophic-cap tier ("How scoring works"): a CONFIRMED finding of one of the
 * five catastrophic classes soft-caps the OVERALL score at Fair (<=69) and emits
 * a blocking review item. Four classes anchor to a specific sub-check
 * (ROB-3/ROB-4/ROB-5/SCP-1); the fifth — a high/critical security vuln — is a
 * Security-dimension-level cap (see RubricDimension.overallCapOnHighSeverity).
 * `'gated'` is reserved for the deterministic build/test/typecheck/lint gate,
 * which is NOT a rubric sub-check (see BANDS / GATED_SENTINEL).
 */
export type CapTrigger = 'overall_fair_cap' | 'gated' | null;

/** Named cap side-effect flag stamped on run_evals when the trigger fires. */
export type CapFlag = 'requirements_unmet' | 'security_flag' | null;

export interface RubricSubCheck {
  /** e.g. "COR-2". */
  readonly id: string;
  readonly dimension: DimensionKey;
  /** The sub-check proposition (the doc's `#### <id> · <text>` heading text). */
  readonly proposition: string;
  /** Verbatim *Applies* scope condition. Empty string never occurs (all have one). */
  readonly applies: string;
  /** Verbatim *Unknown* clause; may be empty when the doc states none. */
  readonly unknownWhen: string;
  /** Non-null only for the catastrophic-cap-tier sub-checks. */
  readonly capTrigger: CapTrigger;
  /** The named flag stamped when capTrigger fires (e.g. SCP-1 -> requirements_unmet). */
  readonly capFlag: CapFlag;
  /**
   * A per-dimension pass-fraction ceiling the doc mandates for this sub-check's
   * failure mode. COR-2: self-authored-green-tests only => dimension cannot
   * exceed the Good ceiling (0.89).
   */
  readonly specialCeiling: number | null;
}

export interface RubricDimension {
  readonly key: DimensionKey;
  /** Human display name from the doc's "Dimensions & weights" table. */
  readonly name: string;
  /** Weight (dimensions sum to 100). */
  readonly weight: number;
  /**
   * Security-only: any CONFIRMED high/critical finding across this dimension's
   * sub-checks is an advisory soft-cap on the OVERALL score at Fair (<=69) plus a
   * blocking review item — the fifth catastrophic-cap class, which is
   * dimension-level rather than tied to a single sub-check (doc: "SEC gate").
   */
  readonly overallCapOnHighSeverity: boolean;
  readonly subChecks: readonly RubricSubCheck[];
}

export interface Rubric {
  readonly version: string;
  readonly dimensions: readonly RubricDimension[];
}

/**
 * Scoring bands (uniform across dimensions), keyed on the sub-check pass-fraction
 * (PASS / (PASS + FAIL); UNKNOWN excluded). GATED is a reserved sentinel — the
 * only deterministic hard stop (build/test/typecheck/lint failure) — and is
 * excluded from the quality means, so it is not a fractional band.
 */
export interface Band {
  readonly name: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  /** Inclusive lower bound on the pass-fraction. */
  readonly minFraction: number;
  readonly scoreMin: number;
  readonly scoreMax: number;
}

export const BANDS: readonly Band[] = [
  { name: 'Excellent', minFraction: 0.9, scoreMin: 90, scoreMax: 100 },
  { name: 'Good', minFraction: 0.7, scoreMin: 70, scoreMax: 89 },
  { name: 'Fair', minFraction: 0.4, scoreMin: 40, scoreMax: 69 },
  { name: 'Poor', minFraction: 0, scoreMin: 0, scoreMax: 39 },
] as const;

/** Reserved sentinel: build/test/typecheck/lint failed (deterministic gate). */
export const GATED_SENTINEL = 'GATED' as const;

/**
 * Aggregation constants (doc: "How scoring works").
 *  - Overall /100 = weighted GEOMETRIC mean over ACTIVE dimensions (weights
 *    renormalized across the active set), each dimension entering floored at 1
 *    on the 0-100 scale (a forced/gated 0 drags without zeroing the overall).
 *  - Thin-evidence: a dimension with fewer than 2 applicable non-UNKNOWN
 *    sub-checks is marked INACTIVE (excluded; weights renormalize).
 *  - UNKNOWN sub-checks leave their dimension's denominator.
 *  - Any confirmed catastrophic-cap trigger caps the OVERALL at Fair (<=69).
 */
export const AGGREGATION = {
  /** Every dimension enters the geometric mean floored at 1 (0-100 scale). */
  DIMENSION_FLOOR: 1,
  /** Catastrophic caps cap the OVERALL score at the Fair ceiling. */
  OVERALL_CATASTROPHIC_CAP: 69,
  /** <2 applicable non-UNKNOWN sub-checks => dimension INACTIVE. */
  THIN_EVIDENCE_MIN_SUBCHECKS: 2,
  /** COR-2 self-authored-green-tests ceiling (mirrors that sub-check's specialCeiling). */
  SELF_AUTHORED_TEST_CEILING: 0.89,
} as const;

function subCheck(
  id: string,
  dimension: DimensionKey,
  proposition: string,
  applies: string,
  unknownWhen: string,
  opts: {
    capTrigger?: CapTrigger;
    capFlag?: CapFlag;
    specialCeiling?: number | null;
  } = {},
): RubricSubCheck {
  return {
    id,
    dimension,
    proposition,
    applies,
    unknownWhen,
    capTrigger: opts.capTrigger ?? null,
    capFlag: opts.capFlag ?? null,
    specialCeiling: opts.specialCeiling ?? null,
  };
}

const CORRECTNESS_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'COR-1',
    'correctness',
    'The primary changed logic (the riskiest behavioral hunk, judge-selected — not author-chosen) produces the behavior the task/entity body specifies for the stated happy-path inputs.',
    'always',
    'The body gives no concrete behavioral expectation for this path AND no pre-existing reference in the snapshot can be found to check against.',
  ),
  subCheck(
    'COR-2',
    'correctness',
    'Independent corroboration exists for the primary changed path — a pre-existing test, an explicit reference-spec statement, or judge line-by-line verification of demonstrably STRAIGHT-LINE logic — not only tests added in this same diff.',
    'always',
    'Judge cannot determine from the snapshot whether cited tests are pre-existing or newly added.',
    { specialCeiling: 0.89 },
  ),
  subCheck(
    'COR-3',
    'correctness',
    'Edge and boundary inputs are handled correctly (empty/null/undefined, empty collections, zero/negative/overflow, duplicate/absent keys, first/last iteration).',
    'always',
    'Reachability of the edge input depends on caller state not derivable even after grepping the snapshot.',
  ),
  subCheck(
    'COR-4',
    'correctness',
    'Error and failure inputs are handled per spec — invalid arguments, rejected promises, thrown exceptions, and failed lookups do not corrupt state or get silently swallowed.',
    'only when the diff introduces or modifies error handling, async/promise flow, or external calls that can fail',
    'An error path exists but whether it can corrupt state or must propagate depends on runtime conditions not derivable from the snapshot.',
  ),
  subCheck(
    'COR-5',
    'correctness',
    'No wrong-RESULT regression at an in-repo caller of a changed signature/return shape/enum: an existing call site now reads a dropped/renamed field, wrong arity/type, or old return semantics and therefore COMPUTES A WRONG OUTPUT.',
    'only when the diff changes a function/method signature, return shape, or exported enum/const consumed by in-repo callers',
    'Callers provably live outside the repo (external consumers) and cannot be enumerated from the snapshot.',
  ),
  subCheck(
    'COR-6',
    'correctness',
    'No hallucinated or non-existent API: called methods, imported symbols, config keys, MCP tool names, and DB columns referenced by the changed code actually exist (LLM-judged; the judge MUST grep the snapshot before verdict, advisory).',
    'always',
    "Resolution depends on a third-party dependency whose types are not vendored in the snapshot and cannot be inferred.",
  ),
  subCheck(
    'COR-7',
    'correctness',
    "Code↔schema column consistency: every column/table the diff's added or changed queries READ or WRITE is actually created by a migration present in the snapshot.",
    'only when the diff adds/edits a DB read/write or a query string',
    'The query targets a table whose migration definition is not in the snapshot and cannot be located by grep.',
  ),
  subCheck(
    'COR-8',
    'correctness',
    'Control-flow and state invariants hold: no unconditionally shadowed branch, no inverted boolean/guard, no unreachable-after-early-return, no mutation that violates a documented immutability invariant (e.g., a field the body marks write-once is re-UPDATEd).',
    'always',
    'The intended invariant is not stated in the body and cannot be inferred from surrounding snapshot code.',
  ),
  subCheck(
    'COR-9',
    'correctness',
    'No gross algorithmic-cost regression in the changed code: no obvious super-linear DB/loop cost (N+1 query in a loop, O(n^2) scan) on a hot path, no synchronous blocking call on the Electron main thread, and no unbounded in-memory accumulation on a per-event/per-stream path (LLM-judged, advisory).',
    'only when the diff adds/changes loops over collections, DB access, main-thread synchronous work, or per-event accumulation',
    'The call frequency / input size cannot be judged from the snapshot (path may be cold), so cost impact is indeterminate.',
  ),
];

const SECURITY_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'SEC-1',
    'security',
    'No command/shell injection: child_process/PTY/CLI spawns built from static args or a safe argv array, never string-concatenated with user- or agent-controlled input.',
    'only when the diff touches child_process, node-pty, spawn/exec helpers, or command-string construction',
    'The origin of an interpolated value cannot be traced through the snapshot to confirm/deny attacker control.',
  ),
  subCheck(
    'SEC-2',
    'security',
    'No SQL injection: all new/changed better-sqlite3 queries and migration DML use parameterized bindings, not string-interpolated runtime values.',
    'only when the diff touches SQL query strings, prepared statements, or migration DML',
    "An interpolated identifier's allowlist-safety can't be judged from the snapshot.",
  ),
  subCheck(
    'SEC-3',
    'security',
    'No XSS / unsafe DOM injection in changed renderer code: no new dangerouslySetInnerHTML/innerHTML/equivalent fed by non-constant/agent/user content.',
    'only when the diff touches frontend renderer/React/DOM code or a markdown/HTML rendering path',
    "The sink's input provenance/sanitization cannot be determined from the snapshot.",
  ),
  subCheck(
    'SEC-4',
    'security',
    'No unsafe deserialization/dynamic execution: no eval/new Function/vm on dynamic input, and JSON.parse of untrusted input is guarded (try/catch + shape validation).',
    'only when the diff adds eval/Function/vm or parses external/IPC/agent-supplied serialized data',
    "The parsed data's trust level can't be inferred from the snapshot.",
  ),
  subCheck(
    'SEC-5',
    'security',
    'Secret handling is clean: no hardcoded credentials/tokens/keys committed, and secrets/env values are not written to logs, debug files, or error payloads.',
    'always (a committed secret can appear in any file), with attention to env access, logging, telemetry, config',
    'A suspicious literal cannot be confirmed as a live secret vs placeholder/fixture.',
  ),
  subCheck(
    'SEC-6',
    'security',
    'Least-privilege preserved: changes to capability grants (MCP allow/deny lists, tool allowlists, permission modes, sandbox/spawn flags) do not silently widen what an agent/run can do beyond the task\'s requirement.',
    'only when the diff touches MCP config, tool allow/deny lists, permission modes, sandbox flags, or spawn env/argv privilege',
    "Whether the widening is task-required can't be judged from the spec.",
  ),
  subCheck(
    'SEC-7',
    'security',
    'Trust-boundary typing: new/changed IPC/tRPC payloads carrying attacker- or agent-controlled data are typed end-to-end (no `any`, no `unknown`-passthrough) so untrusted fields cannot REACH A SINK unvalidated.',
    'only when the diff touches an IPC/tRPC handler, its request/response interface, or a boundary DTO carrying untrusted data that reaches a sink',
    'The field provably does NOT reach any security-relevant sink (then it is Correctness/Robustness parity, not here).',
  ),
  subCheck(
    'SEC-8',
    'security',
    'New runtime dependency is justified and minimal (supply-chain): any added production dependency is necessary, reputable, and not replaceable by existing utilities.',
    'only when the diff adds/changes a production (non-dev) dependency in package.json or the lockfile',
    "The package's provenance can't be assessed from the snapshot.",
  ),
  subCheck(
    'SEC-9',
    'security',
    'No path traversal / arbitrary file access: fs read/write/delete (or worktree/debug-log/artifact path construction) built from agent/session/user-controlled input (worktree path, session name, branch, log filename) is normalized and contained to an allowed root.',
    'only when the diff touches fs read/write/delete or constructs a filesystem path from dynamic input',
    'The path variable\'s origin cannot be traced through the snapshot to confirm attacker control.',
  ),
];

const ROBUSTNESS_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'ROB-1',
    'robustness',
    'IPC/tRPC type-parity (SOLE OWNER of the silent-drop contract defect): every changed channel/handler\'s declared response T matches what it returns at runtime, request/response interfaces are edited SYMMETRICALLY on both frontend and main (confirmed by opening both files in the snapshot), no local IPCResponse/{success,data?,error?} is re-declared instead of importing from frontend/src/utils/api.ts, and tRPC onData types are AppRouter-inferred, not hand-mirrored.',
    'only when the diff touches an IPC handler, a tRPC router/subscription, or a request/response interface crossing main↔frontend',
    'The counterpart file genuinely does not exist in the snapshot (e.g. a brand-new channel with no consumer yet) so symmetry has no reference.',
  ),
  subCheck(
    'ROB-2',
    'robustness',
    'Backward-compat on untouched downstream callers: when the diff changes a shared/exported signature (params, return type, enum/union members, DB row shape, or a threaded positional-arg contract), all EXISTING callers found by grepping the snapshot remain type-valid and semantically correct.',
    'only when the diff modifies an exported/shared function signature, shared type, threaded positional-arg contract, or persisted row shape consumed beyond the diff',
    'The full caller set provably extends outside the repo (external consumers) and no positive evidence of breakage is derivable from the snapshot.',
  ),
  subCheck(
    'ROB-3',
    'robustness',
    'Migration safety (SOLE OWNER of destructiveness/idempotency/parity): any new migration is forward-only, uses idempotent CREATE (IF NOT EXISTS/guarded), performs no destructive/irreversible ALTER on existing tables (no column drop/rename, no NOT NULL without default/backfill), and carries the accompanying schema-parity update.',
    'only when the diff adds/edits a file under the migrations directory or the schema/parity snapshot',
    'The parity artifact\'s location cannot be located in the snapshot even by grep — exclude only the parity clause; still judge destructive/idempotent clauses from the SQL present.',
    { capTrigger: 'overall_fair_cap' },
  ),
  subCheck(
    'ROB-4',
    'robustness',
    'Migration chain/collision integrity: BEFORE verdict the judge MUST enumerate the migrations directory in the snapshot; the new migration number must be strictly greater than the current max, collide with no existing/sibling migration, and be contiguous with the chain.',
    'only when the diff adds a new migration file',
    'The migrations directory is genuinely absent from the snapshot so no existing numbers can be enumerated (should be rare).',
    { capTrigger: 'overall_fair_cap' },
  ),
  subCheck(
    'ROB-5',
    'robustness',
    'Chokepoint & concurrency safety (SOLE OWNER of off-chokepoint bypass): all writes to ideas/epics/tasks/review_items/artifacts go through TaskChangeRouter.applyChange / ReviewItemRouter / ArtifactRouter (no raw UPDATE/INSERT bypassing them, incl. raw-UPDATE-with-no-emit), and async write/read paths have no missing await, TOCTOU race, or re-entrant double-write.',
    'only when the diff touches an entity/review/artifact write path or introduces/edits async or concurrent control flow',
    'A called helper\'s routing cannot be confirmed because its body is genuinely absent from the snapshot — exclude that call; still FAIL on any raw SQL visible in the diff.',
    { capTrigger: 'overall_fair_cap' },
  ),
  subCheck(
    'ROB-6',
    'robustness',
    'Observability & error handling (SOLE OWNER of dropped-logger): errors are not silently swallowed, the optional logger contract is honored (a logger?/observability sink is passed where the surrounding code threads one, since omitting it no-ops diagnostics — TypedEventNarrowing/RawEventsSink/MessageProjection and peers), and fail-soft debug-log paths degrade without throwing.',
    'only when the diff adds/edits try/catch, error propagation, an observability/logger-consuming class, or a debug-log write path',
    'Whether a logger is available to thread at the call site cannot be determined even after opening the constructor signature in the snapshot.',
  ),
  subCheck(
    'ROB-7',
    'robustness',
    'Resource cleanup & unhandled rejections: PTY/child processes, subscriptions, timers, file handles, sockets, and event listeners opened in the diff are released on all exit paths (incl. error/cancel), and no newly-introduced async work is left as a floating unhandled promise.',
    'only when the diff acquires a process/subscription/timer/handle/listener or introduces new async fire-and-forget work',
    'Cleanup provably occurs in an out-of-diff owner whose body is absent from the snapshot and no evidence either way is derivable.',
  ),
  subCheck(
    'ROB-8',
    'robustness',
    'localStorage key renames use the sanctioned utility: any localStorage key rename in the diff goes through frontend/src/utils/migrateLocalStorageKey.ts with the mount-only call contract, not hand-rolled getItem/setItem rename logic.',
    'only when the diff renames or migrates a localStorage key',
    'The diff touches localStorage reads/writes but it cannot be determined from the snapshot whether a KEY RENAME (vs a normal new key) is occurring.',
  ),
];

const DESIGN_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'DES-1',
    'design',
    'No NEW parallel write ABSTRACTION: a write to ideas/epics/tasks/entity_events/review_items/artifacts is routed through the sanctioned chokepoint rather than a newly-introduced hand-rolled service/helper that duplicates the router\'s role.',
    'only when the diff adds a new code path that mutates entity, review_item, or artifact state',
    'The write target is ambiguous (helper whose table cannot be resolved even after opening it in the snapshot).',
  ),
  subCheck(
    'DES-2',
    'design',
    'SOLE OWNER of preserved-seam/hidden-code integrity: AbstractCliManager is not collapsed into ClaudeCodeManager; the LIVE dual-substrate PTY methods (spawnPtyProcess/setupProcessHandlers/killProcessTree) are not pruned or relabeled @cyboflow-hidden; @cyboflow-hidden code is neither deleted nor added to actively-called code.',
    'only when the diff touches AbstractCliManager, ClaudeCodeManager, interactiveClaudeManager, the substrate facade/seam, or any @cyboflow-hidden-annotated region',
    'Whether the annotated code is truly live/dead cannot be determined even after grepping call sites in the snapshot.',
  ),
  subCheck(
    'DES-3',
    'design',
    'No wrong-abstraction over-engineering: added interfaces, factories, generic type params, base classes, or indirection layers are justified by an actual current second caller/variant (found by grepping the snapshot) — not speculative generality.',
    'only when the diff introduces new interfaces, factories, abstract/base classes, generics, or indirection wrappers',
    'A second consumer would provably live outside the repo and the task spec is silent on multi-variant intent.',
  ),
  subCheck(
    'DES-4',
    'design',
    'Code is placed at the correct module boundary per the layer stack (shared/ types, main/orchestrator vs services vs db, frontend/): domain/orchestration logic is not embedded in a renderer component, and shared cross-boundary types live in shared/ rather than being redeclared per side.',
    'always (whenever the dimension is active)',
    'The file\'s architectural layer or the intended home of the logic cannot be determined from the path and snapshot.',
  ),
  subCheck(
    'DES-5',
    'design',
    'IPC/tRPC boundary is wired the sanctioned way (PLACEMENT only): no local re-declaration of IPCResponse/{success,data,error}; IPCResponse<T> callers pass an explicit T; request/response interfaces are shared (promoted to shared/types/ipc.ts) not mirrored divergently; tRPC onData types come from AppRouter inference.',
    'only when the diff adds or changes an IPC handler, tRPC procedure/subscription, or a request/response interface crossing main↔frontend',
    'The counterpart declaration is genuinely absent from the snapshot so placement cannot be assessed.',
  ),
  subCheck(
    'DES-6',
    'design',
    'Change extends an existing seam instead of forking a parallel mechanism: it reuses the established single-source pattern (e.g. substrate resolves ONCE at the CliManagerFactory/SubstrateDispatchFacade seam and threads via run.substrate; the workflow model pin threads through the existing createRun→spawner chain) rather than adding a second competing pathway for the same concern.',
    'only when the diff touches a concern with an established single-source seam (substrate resolution, run-config threading, spawn/facade wiring)',
    'Whether an existing canonical seam covers this concern cannot be established even after inspecting the referenced seam in the snapshot.',
  ),
  subCheck(
    'DES-7',
    'design',
    'New logger/collaborator-accepting classes are WIRED so they can structurally receive the sink: the diff does not construct such a class via a bespoke path that structurally cannot accept the injected observability collaborator.',
    'only when the diff introduces a new construction/wiring path for a class that accepts an optional logger or injected observability collaborator',
    'Whether the constructed class accepts the collaborator cannot be determined even after opening its signature in the snapshot.',
  ),
];

const MAINTAINABILITY_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'MTN-1',
    'maintainability',
    'Comments justify WHY (non-derivable intent/rationale/gotcha) rather than restating WHAT the next line already says.',
    'only when the diff adds or edits comments',
    'Hunks lack enough context to tell whether a comment restates its referent and the full file was not read.',
  ),
  subCheck(
    'MTN-2',
    'maintainability',
    'Identifiers (functions, vars, types, columns, props) are descriptive and self-explanatory at their scope, without cryptic abbreviations or misleading names.',
    'always (any authored code touch)',
    'The diff introduces 0-1 identifiers so a clarity judgment is not meaningful, or names reference domain terms not evaluable even with snapshot context.',
  ),
  subCheck(
    'MTN-3',
    'maintainability',
    'No comment-stuffing / banner noise: no redundant docblock padding, decorative separators, commented-out code, or TODO litter that inflate size without adding intent.',
    'only when the diff adds comments or removes/leaves commented-out code',
    'Cannot determine from the hunk whether a commented block is intentional documentation vs abandoned code, and the full file was not read.',
  ),
  subCheck(
    'MTN-4',
    'maintainability',
    'New/changed functions and files stay within reasonable size and single-responsibility; no sprawling mega-function or god-file introduced for in-scope work.',
    'only when the diff adds or substantially rewrites a function or file',
    'The function/file body is only partially shown and the judge did not open the full file in the snapshot to gauge true size.',
  ),
  subCheck(
    'MTN-5',
    'maintainability',
    'In-scope logic is expressed concisely — no redundant intermediate variables, duplicated blocks, or verbose restatement where an existing shared util/pattern reads cleaner.',
    'always (any authored code touch)',
    'Whether a cleaner shared util exists cannot be confirmed even after a snapshot grep the judge attempted.',
  ),
  subCheck(
    'MTN-6',
    'maintainability',
    'Type annotations aid readability without `any`: added TS uses `unknown`+guards or precise types, keeping call sites self-documenting (readability lens only; lint gate owns the hard penalty).',
    'only when the diff adds or edits TypeScript type annotations',
    'The annotation is generated/inferred and not visible in the hunk.',
  ),
  subCheck(
    'MTN-7',
    'maintainability',
    'Migration SQL and workflow-prompt markdown, when touched, are readable: migration has a clear intent (comment/name) and is not a wall of unexplained ALTERs; prompt edits stay coherent, not bloated with contradictory instructions.',
    'only when the diff touches a SQL migration or a workflow-prompt .md file',
    'The touched file\'s full text cannot be read from the snapshot to judge its clarity in context.',
  ),
  subCheck(
    'MTN-8',
    'maintainability',
    'No over-abstraction of in-scope code: the change does not wrap simple in-scope logic in gratuitous layers (single-use factories, one-line wrapper indirections, config objects for a fixed value) that add reading cost without payoff.',
    'only when the diff introduces a new local abstraction/wrapper for in-scope logic',
    'Whether the abstraction has other call sites (justifying it) cannot be confirmed even after a snapshot grep; if it plausibly reaches beyond the task it belongs to Design — mark UNKNOWN here.',
  ),
];

const TESTS_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'TST-1',
    'tests',
    'Behavior-changing diff ships at least one runnable test exercising the changed code path.',
    'always (when dimension active)',
    'Never for a behavioral change with no test file present — that is FAIL. UNKNOWN only when the judge confirms via the snapshot that an existing untouched test already fully covers the path.',
  ),
  subCheck(
    'TST-2',
    'tests',
    'Assertions pin INTENDED behavior, not implementation trivia or tautology.',
    'always (when dimension active)',
    'The test body is truly absent from the snapshot (referenced but file not present).',
  ),
  subCheck(
    'TST-3',
    'tests',
    'Edge and error cases for the changed logic are covered.',
    'only when the changed production code contains conditionals, guards, error handling, or nullable/optional inputs',
    'The changed logic has no branches/error paths (straight-line pure mapping) so edge cases are not applicable — exclude from denominator.',
  ),
  subCheck(
    'TST-4',
    'tests',
    'Defect-correcting diffs include a regression test that fails without the fix (keyed on whether the CODE corrects a defect, not the author\'s commit-type label).',
    'only when the diff\'s code changes correct a defect (judged from the code, not the label)',
    'The diff introduces genuinely new behavior with no identifiable pre-existing defect being corrected (pure feature) — exclude from denominator.',
  ),
  subCheck(
    'TST-5',
    'tests',
    'Migration / schema-parity changes carry the expected cyboflow-tier test.',
    'only when the diff adds/edits a migration or a type that a schema-parity test guards',
    'A parity-guarded type may be implicated but the parity suite cannot be located in the snapshot.',
  ),
  subCheck(
    'TST-6',
    'tests',
    'IPC/tRPC contract changes are covered by a test asserting the full runtime payload shape.',
    'only when the diff modifies an IPC/tRPC handler, channel, or a request/response interface crossing that boundary',
    'The payload shape is asserted only indirectly (e.g. through a consumer test) and equivalence to the declared T cannot be established from the snapshot.',
  ),
  subCheck(
    'TST-7',
    'tests',
    'Chokepoint/router writes are verified through the router, not bypassed in the test.',
    'only when the diff changes entity/review/artifact write logic routed through a chokepoint',
    'The test\'s setup helper\'s write path cannot be resolved from the snapshot to confirm router vs raw SQL.',
  ),
  subCheck(
    'TST-8',
    'tests',
    'Tests are deterministic and genuinely capable of failing (no always-green scaffolding).',
    'only when the diff adds or modifies test files',
    'Test bodies are truly absent from the snapshot — exclude from denominator.',
  ),
  subCheck(
    'TST-9',
    'tests',
    'No pre-existing real assertion was silently weakened or deleted to make the suite pass.',
    'only when the diff modifies or deletes existing (pre-existing) test files or their assertions',
    'The diff modifies no pre-existing test file — exclude from denominator.',
  ),
];

const SCOPE_SUBCHECKS: readonly RubricSubCheck[] = [
  subCheck(
    'SCP-1',
    'scope',
    'Every explicit OR clearly-implied acceptance criterion in the task spec (derived from prose where the body is not bullet-listed) is implemented by some hunk in the diff.',
    'always',
    'The spec is so vague that no discrete requirement can be responsibly derived even from the prose — reserve UNKNOWN for genuinely contentless goals, not merely un-bulleted ones.',
    { capTrigger: 'overall_fair_cap', capFlag: 'requirements_unmet' },
  ),
  subCheck(
    'SCP-2',
    'scope',
    'No user-facing feature, command, flag, endpoint, or UI surface is added that the task did not request.',
    'always',
    'Whether a surface is new vs pre-existing/moved cannot be determined even after grepping the snapshot.',
  ),
  subCheck(
    'SCP-3',
    'scope',
    'No out-of-scope refactor, rename, reformat, or drive-by cleanup inflates blast radius beyond what the task needs.',
    'always',
    'Whether a touched file is load-bearing for the task cannot be established from the diff + spec + snapshot.',
  ),
  subCheck(
    'SCP-4',
    'scope',
    'No silent design assumption substitutes for, contradicts, or narrows an explicit spec instruction.',
    'always',
    'The spec is silent on the point, so the choice is a legitimate gap-fill.',
  ),
  subCheck(
    'SCP-5',
    'scope',
    'A newly-added DB migration exists only because the task\'s data-model change requires it (no speculative/unrequested schema).',
    'only when the diff adds or edits files under a migrations directory',
    'The spec explicitly delegates schema shape to implementer discretion.',
  ),
  subCheck(
    'SCP-6',
    'scope',
    'Added tests / fixtures / scripts are scoped to the task and do not smuggle in unrequested product behavior.',
    'only when the diff adds or edits test, fixture, or build/script files',
    'Whether an added helper is genuinely exercised by the task\'s tests cannot be established from the snapshot.',
  ),
  subCheck(
    'SCP-7',
    'scope',
    'Preserved/guarded assets are not touched WITHOUT a task mandate: no unrequested deletion/mislabel of @cyboflow-hidden code and no unrequested collapse of AbstractCliManager.',
    'only when the diff touches @cyboflow-hidden-annotated code or AbstractCliManager/ClaudeCodeManager AND the change is not spec-mandated',
    'Whether the spec\'s prose mandates the touch is genuinely ambiguous.',
  ),
  subCheck(
    'SCP-8',
    'scope',
    'The change does not silently widen an IPC/tRPC contract with fields/channels nobody requested.',
    'only when the diff edits IPC/tRPC handlers, shared/types/ipc.ts, or request/response interfaces',
    'Whether the added field serves a requested behavior cannot be traced from the spec prose.',
  ),
];

export const RUBRIC: Rubric = {
  version: RUBRIC_VERSION,
  dimensions: [
    {
      key: 'correctness',
      name: 'Correctness & Logic Soundness',
      weight: 26,
      overallCapOnHighSeverity: false,
      subChecks: CORRECTNESS_SUBCHECKS,
    },
    {
      key: 'security',
      name: 'Security & Safety',
      weight: 18,
      // The fifth catastrophic-cap class: any confirmed high/critical finding
      // soft-caps the OVERALL score at Fair (<=69) + blocking review item.
      overallCapOnHighSeverity: true,
      subChecks: SECURITY_SUBCHECKS,
    },
    {
      key: 'robustness',
      name: 'Robustness & Contract Safety',
      weight: 14,
      overallCapOnHighSeverity: false,
      subChecks: ROBUSTNESS_SUBCHECKS,
    },
    {
      key: 'design',
      name: 'Design & Architecture Fit',
      weight: 14,
      overallCapOnHighSeverity: false,
      subChecks: DESIGN_SUBCHECKS,
    },
    {
      key: 'maintainability',
      name: 'Maintainability & Simplicity',
      weight: 12,
      overallCapOnHighSeverity: false,
      subChecks: MAINTAINABILITY_SUBCHECKS,
    },
    {
      key: 'tests',
      name: 'Test Meaningfulness',
      weight: 8,
      overallCapOnHighSeverity: false,
      subChecks: TESTS_SUBCHECKS,
    },
    {
      key: 'scope',
      name: 'Scope Fidelity',
      weight: 8,
      overallCapOnHighSeverity: false,
      subChecks: SCOPE_SUBCHECKS,
    },
  ],
};

/** Flattened sub-check list in stable dimension→sub-check order. */
export function allSubChecks(rubric: Rubric = RUBRIC): readonly RubricSubCheck[] {
  return rubric.dimensions.flatMap((d) => d.subChecks);
}

/** Total dimension weight — 100 for a well-formed rubric. */
export function totalWeight(rubric: Rubric = RUBRIC): number {
  return rubric.dimensions.reduce((sum, d) => sum + d.weight, 0);
}

/**
 * The band for a pass-fraction (PASS / (PASS + FAIL)). Bands are checked
 * high→low; Poor is the floor. This never returns the GATED sentinel — GATED is
 * the deterministic-gate outcome, orthogonal to the fractional bands.
 */
export function bandForFraction(fraction: number): Band {
  for (const band of BANDS) {
    if (fraction >= band.minFraction) return band;
  }
  // BANDS' last entry has minFraction 0, so this is unreachable for finite input.
  return BANDS[BANDS.length - 1];
}

/**
 * Deterministic, dependency-free serialization of the rubric for the judge
 * prompt. Its output is hashed into run_evals.prompt_hash, so it MUST be a pure
 * function of the rubric data (stable ordering, no Date/random/env). Any change
 * to the rubric shape or text changes the hash by construction.
 */
export function serializeRubricForPrompt(rubric: Rubric = RUBRIC): string {
  const lines: string[] = [];
  lines.push(`RUBRIC v${rubric.version}`);
  lines.push(`DIMENSIONS=${rubric.dimensions.length} WEIGHT_SUM=${totalWeight(rubric)}`);
  lines.push(
    'BANDS ' +
      BANDS.map((b) => `${b.name}>=${b.minFraction}(${b.scoreMin}-${b.scoreMax})`).join(' '),
  );
  lines.push(`SENTINEL ${GATED_SENTINEL}=deterministic-gate-failure`);
  lines.push(
    'AGGREGATION weighted-geometric-mean' +
      ` dimension_floor=${AGGREGATION.DIMENSION_FLOOR}` +
      ` overall_catastrophic_cap=${AGGREGATION.OVERALL_CATASTROPHIC_CAP}` +
      ` thin_evidence_min_subchecks=${AGGREGATION.THIN_EVIDENCE_MIN_SUBCHECKS}` +
      ` self_authored_test_ceiling=${AGGREGATION.SELF_AUTHORED_TEST_CEILING}` +
      ' unknown_excluded-from-denominator',
  );

  rubric.dimensions.forEach((dim, index) => {
    lines.push('');
    lines.push(
      `[${index + 1}] ${dim.key} :: ${dim.name} :: weight=${dim.weight} ::` +
        ` subchecks=${dim.subChecks.length}` +
        (dim.overallCapOnHighSeverity ? ' :: overall_cap_on_high_severity' : ''),
    );
    for (const check of dim.subChecks) {
      const flags: string[] = [];
      if (check.capTrigger !== null) flags.push(`cap=${check.capTrigger}`);
      if (check.capFlag !== null) flags.push(`cap_flag=${check.capFlag}`);
      if (check.specialCeiling !== null) flags.push(`ceiling=${check.specialCeiling}`);
      const flagStr = flags.length > 0 ? ` {${flags.join(' ')}}` : '';
      lines.push(`  ${check.id}${flagStr} :: ${check.proposition}`);
      lines.push(`    APPLIES: ${check.applies}`);
      lines.push(`    UNKNOWN: ${check.unknownWhen}`);
    }
  });

  return lines.join('\n');
}
