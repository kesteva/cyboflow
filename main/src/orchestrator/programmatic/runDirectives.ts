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
 * The per-LANE rewind directive (`laneRewinds`) follows the same live-read shape
 * one level down: the fan-out inner loop consumes it per lane, so the monitor can
 * pull ONE stuck sprint lane back to an earlier inner step without rewinding the
 * whole run. Its sibling `laneInterrupts` is the inverse direction — the
 * controller registers an unpark hook there so a lane parked on the async visual
 * merge-gate can be woken without firing the run-wide abort signal.
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
  /**
   * stepId → the SUPERVISOR's retry guidance: what the next attempt of that step
   * must do differently, written by the host when the monitor's triage returns
   * 'retry'.
   *
   * CONSUMED — read and then DELETED — by SpawnStepRunner on that step's next
   * spawn. That is the one thing that makes it different from `stepGuidance`
   * above, which is an operator preference and stays sticky for every later
   * spawn: this guidance describes ONE failed attempt's correction, so leaving it
   * attached would keep telling later (possibly successful, possibly re-driven
   * for an unrelated reason) attempts to fix a failure that is already behind
   * them. The two channels are deliberately separate maps for the same reason —
   * a consume-on-read `stepGuidance` would silently swallow the operator's steer.
   */
  readonly retryGuidance: Map<string, string>;
  /**
   * PER-LANE rewind requests: fan-out item id (the sprint task's opaque id) → the
   * INNER step id that lane must resume at. Written by the monitor's
   * `rewind_lane_to_step` action (laneRewindHandler), CONSUMED — and deleted — by
   * the controller's fan-out inner loop (`runFanOut`'s driveItem), which then
   * jumps that lane's chain index back to the target and continues.
   *
   * Deliberately NOT the whole-run `rewindRunHandler`: that aborts the walk,
   * purges `step_results`, and re-drives EVERY step from an OUTER target. A lane
   * rewind touches ONE lane's in-memory position inside a LIVE fan-out — sibling
   * lanes, the outer walk, the run status, and step_results are all untouched.
   *
   * Consumed at three points in the lane loop, so it lands whether the lane is
   * idle between inner steps, mid-agent-turn (the handler kills that lane's spawn
   * to force the step to return — the pending request is what stops the resulting
   * failure from failing the lane), or parked at the visual merge-gate (unparked
   * via `laneInterrupts`).
   *
   * An operator rewind deliberately does NOT bump the lane's attempt counter: it
   * must not consume the automatic loopback budget (FAN_OUT_LANE_ATTEMPT_CAP) the
   * lane still needs for genuine code-review / task-verify failures — the same
   * reasoning that makes an operator skip of a REQUIRED step advance the walk
   * instead of failing the run.
   */
  readonly laneRewinds: Map<string, string>;
  /**
   * Fan-out item id → an UNPARK hook the controller registers while that lane is
   * blocked on something no spawn abort can break (today: awaiting the async
   * visual merge-gate verdict at `awaiting-verify`). Written BY the controller
   * (registered on park, removed on unpark), fired BY the lane-rewind handler
   * after it records the request in `laneRewinds`.
   *
   * This is the one entry in this object written by the controller rather than by
   * an operator action — a lane parked on an async verdict has no other seam that
   * can wake it without canceling the whole run's walk signal.
   */
  readonly laneInterrupts: Map<string, () => void>;
}

/** A fresh, empty directives object (every step runs, no guidance, no lane rewinds). */
export function createRunDirectives(): RunDirectives {
  return {
    userSkippedStepIds: new Set<string>(),
    stepGuidance: new Map<string, string>(),
    retryGuidance: new Map<string, string>(),
    laneRewinds: new Map<string, string>(),
    laneInterrupts: new Map<string, () => void>(),
  };
}
