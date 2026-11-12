/**
 * Pure merge-back state machine for remote sessions (migration 153). No I/O, no imports.
 * Error handling keeps the last good state and records last_error; it never invents a state.
 */
export const MERGE_BACK_STATES = [
  'bare_ready',
  'base_pushed',
  'remote_ready',
  'checkpointed',
  'import_intent',
  'imported',
  'local_ready',
  'merged',
  'cleaned',
  'abandoned',
] as const;

export type MergeBackState = (typeof MERGE_BACK_STATES)[number];

export const TERMINAL_MERGE_BACK_STATES: readonly MergeBackState[] = ['cleaned', 'abandoned'];

/** Target state -> the states it may follow. */
const PREDECESSORS: Record<MergeBackState, readonly MergeBackState[]> = {
  bare_ready: [],
  base_pushed: ['bare_ready'],
  // merged -> remote_ready: the post-merge resync (base := main, the remote worktree reset to it, local half removed);
  // the session keeps working on the environment and can merge again.
  remote_ready: ['base_pushed', 'merged'],
  checkpointed: ['remote_ready', 'checkpointed'],
  // imported / local_ready -> import_intent: the branch moved after an earlier import; S is re-recorded.
  import_intent: ['remote_ready', 'checkpointed', 'imported', 'local_ready'],
  imported: ['import_intent'],
  local_ready: ['imported'],
  // imported -> merged: the landed probe found the squash already on main.
  merged: ['local_ready', 'imported'],
  cleaned: ['merged', 'abandoned'],
  // From any non-terminal state.
  abandoned: MERGE_BACK_STATES.filter((s) => s !== 'cleaned' && s !== 'abandoned'),
};

export const ALLOWED_TRANSITIONS: Readonly<Record<MergeBackState, readonly MergeBackState[]>> = Object.fromEntries(
  MERGE_BACK_STATES.map((from) => [from, MERGE_BACK_STATES.filter((to) => PREDECESSORS[to].includes(from))]),
) as unknown as Record<MergeBackState, readonly MergeBackState[]>;

export function isMergeBackState(value: unknown): value is MergeBackState {
  return typeof value === 'string' && (MERGE_BACK_STATES as readonly string[]).includes(value);
}

export function isTerminalMergeBackState(state: MergeBackState): boolean {
  return TERMINAL_MERGE_BACK_STATES.includes(state);
}

export function canTransition(from: MergeBackState, to: MergeBackState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
