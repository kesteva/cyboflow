import { describe, it, expect } from 'vitest';
import { agentsForDisplay, groupAgentsByPhase } from '../dynamicWorkflowGrouping';
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowPhase,
} from '../../../../shared/types/dynamicWorkflows';

const PHASES: DynamicWorkflowPhase[] = [
  { title: 'Review', detail: 'review dimensions' },
  { title: 'Verify', detail: 'adversarial verify' },
  { title: 'Synthesize' },
];

function agent(over: Partial<DynamicWorkflowAgent> & { agentId: string }): DynamicWorkflowAgent {
  return { status: 'done', ...over };
}

describe('groupAgentsByPhase', () => {
  it('buckets agents by phase-title word in their excerpts', () => {
    const result = groupAgentsByPhase(
      [
        agent({ agentId: 'a', promptExcerpt: 'review the bugs dimension', status: 'done' }),
        agent({ agentId: 'b', promptExcerpt: 'Adversarially verify the claim', status: 'running' }),
        agent({ agentId: 'c', promptExcerpt: 'review the perf dimension', status: 'done' }),
      ],
      PHASES,
    );
    expect(result.mode).toBe('phased');
    if (result.mode !== 'phased') return;
    expect(result.buckets.map((b) => b.agents.map((a) => a.agentId))).toEqual([
      ['a', 'c'], // Review
      ['b'], // Verify
      [], // Synthesize (not yet reached)
    ]);
  });

  it('derives per-bucket status (done / running / pending)', () => {
    const result = groupAgentsByPhase(
      [
        agent({ agentId: 'a', promptExcerpt: 'review x', status: 'done' }),
        agent({ agentId: 'b', promptExcerpt: 'verify y', status: 'running' }),
      ],
      PHASES,
    );
    if (result.mode !== 'phased') throw new Error('expected phased');
    expect(result.buckets.map((b) => b.status)).toEqual(['done', 'running', 'pending']);
  });

  it('falls back to flat when an agent matches no phase', () => {
    const result = groupAgentsByPhase(
      [
        agent({ agentId: 'a', promptExcerpt: 'review x' }),
        agent({ agentId: 'b', promptExcerpt: 'do something unrelated' }),
      ],
      PHASES,
    );
    expect(result.mode).toBe('flat');
  });

  it('falls back to flat when an agent is ambiguous (matches two phases)', () => {
    const result = groupAgentsByPhase(
      [agent({ agentId: 'a', promptExcerpt: 'review and verify together' })],
      PHASES,
    );
    expect(result.mode).toBe('flat');
  });

  it('falls back to flat when any agent has no excerpt (older main / pre-parse)', () => {
    const result = groupAgentsByPhase(
      [
        agent({ agentId: 'a', promptExcerpt: 'review x' }),
        agent({ agentId: 'b' }), // bare agent
      ],
      PHASES,
    );
    expect(result.mode).toBe('flat');
  });

  it('falls back to flat with fewer than two phases or no agents', () => {
    expect(groupAgentsByPhase([agent({ agentId: 'a', promptExcerpt: 'review' })], []).mode).toBe(
      'flat',
    );
    expect(groupAgentsByPhase([], PHASES).mode).toBe('flat');
    expect(
      groupAgentsByPhase([agent({ agentId: 'a', promptExcerpt: 'review' })], [{ title: 'Review' }])
        .mode,
    ).toBe('flat');
  });

});

describe('agentsForDisplay', () => {
  it('leaves a running workflow untouched', () => {
    const agents = [
      agent({ agentId: 'a', status: 'running' }),
      agent({ agentId: 'b', status: 'done' }),
    ];
    expect(agentsForDisplay(agents, 'running').map((a) => a.status)).toEqual(['running', 'done']);
  });

  it('coerces lingering running agents to done on a terminal workflow', () => {
    const agents = [
      agent({ agentId: 'a', status: 'running' }),
      agent({ agentId: 'b', status: 'done' }),
    ];
    expect(agentsForDisplay(agents, 'completed').map((a) => a.status)).toEqual(['done', 'done']);
    expect(agentsForDisplay(agents, 'failed').map((a) => a.status)).toEqual(['done', 'done']);
  });
});

describe('groupAgentsByPhase — word boundary', () => {
  it('does not over-match on substrings (word-boundary)', () => {
    // "preview" must NOT match the "Review" phase.
    const result = groupAgentsByPhase(
      [agent({ agentId: 'a', promptExcerpt: 'preview the layout only' })],
      PHASES,
    );
    expect(result.mode).toBe('flat');
  });
});
