/**
 * useRunStepModels.test.ts — targeted coverage for `indexStepModels`'s
 * key-collision fix (TASK-298).
 *
 * An inner `fanOut.inner` step's `id` can legally collide with an OUTER
 * step's `id` within the same phase (e.g. both named `code-review`). The map
 * `indexStepModels` builds must keep both rows independently addressable —
 * see `stepModelKey`'s extended 3-arg form in `shared/types/agents.ts` and
 * `main/src/orchestrator/runStepModels.ts`'s `fanOutStepId` discriminator.
 */
import { describe, it, expect } from 'vitest';
import { indexStepModels, type StepModelRow } from '../useRunStepModels';
import { stepModelKey } from '../../../../shared/types/agents';

describe('indexStepModels', () => {
  it('indexes an ordinary outer-step row (no fanOutStepId) by the plain 2-arg key', () => {
    const rows: StepModelRow[] = [
      {
        stepId: 'sprint-verify',
        stepName: 'Sprint verify',
        phaseId: 'verify',
        agentKey: 'sprint-verify',
        label: 'Sonnet 5',
        family: 'sonnet',
      },
    ];

    const map = indexStepModels(rows);

    expect(map.get(stepModelKey('verify', 'sprint-verify'))).toEqual({
      label: 'Sonnet 5',
      family: 'sonnet',
    });
  });

  it('keeps a fanOut inner-step row addressable independently of an outer-step row that collides on (phaseId, stepId)', () => {
    // Same phaseId + stepId ('execute' / 'code-review') on purpose — the
    // load-bearing regression this task fixes.
    const rows: StepModelRow[] = [
      {
        stepId: 'code-review',
        stepName: 'Outer code review',
        phaseId: 'execute',
        agentKey: 'opus-agent',
        label: 'Opus 5',
        family: 'opus',
      },
      {
        stepId: 'code-review',
        stepName: 'Inner code review',
        phaseId: 'execute',
        agentKey: 'codex-agent',
        label: 'gpt-5.6-sol',
        family: 'other',
        fanOutStepId: 'fan-step',
      },
    ];

    // Negative control — reproduced INLINE (never by editing production
    // code): the pre-fix indexing keyed every row by the bare 2-arg
    // `(phaseId, stepId)` pair regardless of `fanOutStepId`, so these two
    // rows really would collide into ONE Map entry, the later row silently
    // clobbering the earlier one.
    const buggyMap = new Map(
      rows.map((r) => [stepModelKey(r.phaseId, r.stepId), { label: r.label, family: r.family }]),
    );
    expect(buggyMap.size).toBe(1);
    expect(buggyMap.get(stepModelKey('execute', 'code-review'))).toEqual({
      label: 'gpt-5.6-sol',
      family: 'other',
    });

    // The real (fixed) indexing keeps both rows as distinct, correctly
    // addressable entries.
    const map = indexStepModels(rows);
    expect(map.size).toBe(2);
    expect(map.get(stepModelKey('execute', 'code-review'))).toEqual({
      label: 'Opus 5',
      family: 'opus',
    });
    expect(map.get(stepModelKey('execute', 'code-review', 'fan-step'))).toEqual({
      label: 'gpt-5.6-sol',
      family: 'other',
    });
  });
});
