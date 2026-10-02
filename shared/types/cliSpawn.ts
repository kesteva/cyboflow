/**
 * Resolved value of a CLI-manager `spawnCliProcess` turn — the typed step-output
 * channel (verification-agent redesign §5.3). `resultText` is the step agent's
 * FINAL assistant result text, captured at the spawn seam per-turn (per-spawnKey,
 * so concurrent fan-out lanes never cross-attribute) and returned so the
 * programmatic controller can parse a step's typed output. `null` on a failed /
 * aborted turn and on a clean turn that produced no final text. The
 * abstract/interactive path resolves `void` (no capture); the Claude, Codex
 * and pi SDK managers resolve this shape (Codex since F1 of
 * docs/proposals/visual-verification-brittleness-fixes.md). Shared home so main-side spawner interfaces
 * (ClaudeSpawnerLike, AbstractCliManager, SubstrateDispatchFacade) and the SDK
 * manager all reference one declaration.
 */
export interface CliSpawnOutcome {
  resultText: string | null;
}

/**
 * The per-LANE spawn env of a programmatic fan-out lane step: its concurrency
 * slot's private build directory (`CYBOFLOW_LANE_SCRATCH_DIR`) and the
 * module-cache overrides pointed into it (main/src/orchestrator/programmatic/
 * laneBuildSlots.ts). Every manager a lane step can reach merges `laneEnv` LAST
 * into the agent's spawn env, so it wins over anything inherited. Absent (every
 * non-lane spawn, and a lane whose slot could not be prepared) ⇒ the env is
 * byte-identical.
 *
 * Shared home, like {@link CliSpawnOutcome}: the spawner options
 * (ClaudeSpawnerOptions) and each manager's own options type EXTEND this, so
 * there is one typed declaration. A manager options type missing it would still
 * accept the key through AbstractCliManager's `CliSpawnOptions` index signature
 * and read it as `unknown` — which is why it is extended, not re-declared.
 */
export interface LaneSpawnEnv {
  laneEnv?: Readonly<Record<string, string>>;
}
