/**
 * TranscriptSource — the Shannon-swap SEAM for IDEA-013's interactive substrate.
 *
 * A `TranscriptSource` is whatever knows how to surface a no-`-p` interactive
 * `claude` session's structured output as ALREADY-NORMALIZED, stream-json-shaped
 * panel objects. The current implementation (`transcriptTailSource.ts`) tails the
 * on-disk `~/.claude/projects/<key>/<uuid>.jsonl` transcript and runs each line
 * through the mandatory normalizer; a future `ShannonTranscriptSource` would be a
 * single factory-branch swap behind THIS interface (the "Shannon Decision").
 *
 * HARD SEAM CONSTRAINT (grep-enforced by the task AC):
 *   This module imports nothing but type aliases — no PTY backend, no Claude
 *   Agent SDK, no stream-parser barrel, and no event-narrowing layer. It also
 *   does NOT import the normalizer implementation, only the structural result
 *   discriminant it produces. PTY spawning, event-narrowing, and the panel
 *   `emit('output')` call live in the S3 manager (TASK-808), not here.
 *
 * The `onLine` callback receives objects that have ALREADY been reshaped by the
 * normalizer into the stream-json wire shape the manager will later type-check.
 * Turn-end markers (`stop_hook_summary` / `turn_duration`) are surfaced out of
 * band via `onTurnEnd` so they are NOT forwarded as panel events.
 */

/** A normalized, stream-json-shaped panel object ready for the manager to narrow. */
export type NormalizedPanelObject = unknown;

/** Secondary turn-end markers observed on the interactive transcript (Probe E). */
export type TurnEndMarker = 'stop_hook_summary' | 'turn_duration';

/** Callback invoked for each normalized panel object, in transcript order. */
export type OnLineCallback = (obj: NormalizedPanelObject) => void;

/**
 * Callback invoked when a turn-boundary marker is observed. SECONDARY signal for
 * S3 completion (the `Stop` shell hook is PRIMARY — Probe C); surfaced here only
 * so the S3 manager can consume it, never forwarded as a panel envelope.
 */
export type OnTurnEndCallback = (marker: TurnEndMarker) => void;

export interface TranscriptSource {
  /**
   * Begin discovery + tailing. `onLine` receives normalized panel objects in
   * order; the optional `onTurnEnd` receives turn-boundary markers out of band.
   * Resolves once discovery + the tail loop are wired (not when the session ends).
   */
  start(onLine: OnLineCallback, onTurnEnd?: OnTurnEndCallback): Promise<void>;

  /** Tear down all watchers / intervals so the tail loop exits and nothing leaks. */
  stop(): void;

  /**
   * Resolve once the session's transcript file has been discovered and bound.
   * Rejects (LOUD diagnostic, never a silent hang) if no transcript appears
   * within `timeoutMs`.
   */
  waitForFirstLine(timeoutMs: number): Promise<void>;
}
