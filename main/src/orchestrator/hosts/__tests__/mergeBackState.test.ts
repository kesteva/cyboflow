import { describe, it, expect } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  MERGE_BACK_STATES,
  canTransition,
  isMergeBackState,
  type MergeBackState,
} from '../mergeBackState';

const EDGES: Array<[MergeBackState, MergeBackState]> = [
  ['bare_ready', 'base_pushed'],
  ['base_pushed', 'remote_ready'],
  ['remote_ready', 'checkpointed'],
  ['checkpointed', 'checkpointed'],
  ['remote_ready', 'import_intent'],
  ['checkpointed', 'import_intent'],
  ['import_intent', 'imported'],
  ['imported', 'local_ready'],
  ['local_ready', 'merged'],
  ['imported', 'merged'],
  ['merged', 'cleaned'],
  ['abandoned', 'cleaned'],
  ...MERGE_BACK_STATES.filter((s) => s !== 'cleaned' && s !== 'abandoned').map((s): [MergeBackState, MergeBackState] => [s, 'abandoned']),
];

describe('merge-back transition table', () => {
  it('allows exactly the specified edges (exhaustive over all 100 pairs)', () => {
    const allowed = new Set(EDGES.map(([a, b]) => `${a}>${b}`));
    for (const from of MERGE_BACK_STATES) {
      for (const to of MERGE_BACK_STATES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('cleaned is a dead end and nothing re-enters bare_ready', () => {
    expect(ALLOWED_TRANSITIONS.cleaned).toEqual([]);
    for (const s of MERGE_BACK_STATES) expect(canTransition(s, 'bare_ready')).toBe(false);
  });

  it('validates state names', () => {
    expect(isMergeBackState('merged')).toBe(true);
    expect(isMergeBackState('nope')).toBe(false);
    expect(isMergeBackState(3)).toBe(false);
  });
});
