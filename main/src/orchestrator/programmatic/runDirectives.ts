/**
 * RunDirectives — per-run, in-memory, MUTABLE operator steering that the
 * WorkflowController reads LIVE during a walk.
 *
 * Unlike the constructor-frozen `resumeFromStepId` / `completedStepIds` (seeded
 * ONCE at run start), a run's directives are consulted MID-FLIGHT: the controller
 * loop head re-reads `userSkippedStepIds` before each not-yet-run step (and per
 * inner step of a fan-out), and SpawnStepRunner's `stepGuidance` thunk re-reads
 * `stepGuidance` each time a step spawns. Written by monitor actions via
 * RunExecutor's mutator accessors (addUserSkip / removeUserSkip / setStepGuidance),
 * read by the controller — so the monitor can skip / un-skip / steer a
 * not-yet-reached step of an IN-FLIGHT programmatic run WITHOUT stopping it. This
 * copies the two existing live-read precedents: a by-reference mutable object (the
 * skip set, read at the controller loop head) and a resolver thunk (the steer
 * guidance, read by SpawnStepRunner exactly like `agentPermissionMode`).
 *
 * The registry lives in RunExecutor (a `Map<runId, RunDirectives>`): a run's entry
 * persists ACROSS execute() re-drives (a steer set before a retry survives) and is
 * cleared at TERMINAL close-out alongside the monitor inject plumbing
 * (disposeMonitorResources), NOT at walk-drain (teardownRun) — the operator can
 * steer a run resting between turns, exactly as the monitor stays reachable then.
 *
 * Standalone-typecheck invariant: no imports (a pure data holder), mirroring the
 * sibling protocol types' "shared types only" rule — this module needs none.
 */
export interface RunDirectives {
  /**
   * Step ids the operator asked to SKIP. Consulted at the controller loop head
   * for a not-yet-reached step (and per inner step of a fan-out); a step that has
   * already run or settled is a natural no-op. An operator skip of a REQUIRED step
   * ADVANCES the walk (it does NOT fail the run) — the operator explicitly chose
   * it.
   */
  readonly userSkippedStepIds: Set<string>;
  /**
   * stepId → operator guidance text, appended to that step's composed prompt the
   * next time it spawns (via SpawnStepRunner's per-step `stepGuidance` thunk).
   */
  readonly stepGuidance: Map<string, string>;
}

/** A fresh, empty directives object (every step runs, no guidance). */
export function createRunDirectives(): RunDirectives {
  return { userSkippedStepIds: new Set<string>(), stepGuidance: new Map<string, string>() };
}
