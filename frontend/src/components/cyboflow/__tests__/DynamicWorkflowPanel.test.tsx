/**
 * DynamicWorkflowPanel tests — presentational rendering of one tracked
 * dynamic-workflow snapshot (no store wiring; the prop is the contract).
 *
 * Covers: running badge + live agent tally + elapsed, the static phase plan,
 * optional description, and the terminal block (summary + totals) replacing
 * the elapsed ticker once the workflow completes/fails.
 *
 * Expanded (canvas-takeover) variant: per-agent rows with model / token / tool
 * formatting, idle + elapsed hints, the excerpt-derived display-name fallback
 * chain, and graceful degradation when an older main build sends bare
 * {agentId, status} agents.
 */
import '@testing-library/jest-dom';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  DynamicWorkflowPanel,
  formatModelName,
  computeAgentDisplayNames,
} from '../DynamicWorkflowPanel';
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowRunState,
} from '../../../../../shared/types/dynamicWorkflows';

function makeState(overrides: Partial<DynamicWorkflowRunState> = {}): DynamicWorkflowRunState {
  return {
    wfRunId: 'wf_a',
    taskId: 'w1',
    runId: 'run-1',
    sessionId: 'sess-1',
    projectId: 1,
    sessionName: 'tester-mctest',
    name: 'refactor-blitz',
    phases: [],
    agents: [],
    status: 'running',
    startedAt: '2026-06-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('DynamicWorkflowPanel', () => {
  it('renders name, running status, agent tally and elapsed while running', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          agents: [
            { agentId: 'a1', status: 'running' },
            { agentId: 'a2', status: 'running' },
            { agentId: 'a3', status: 'done' },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-name')).toHaveTextContent('refactor-blitz');
    expect(screen.getByTestId('dynamic-workflow-status')).toHaveTextContent('running');
    expect(screen.getByTestId('dynamic-workflow-agent-tally')).toHaveTextContent(
      '2 running · 1 done',
    );
    // Elapsed ticker only exists while running.
    expect(screen.getByTestId('dynamic-workflow-elapsed')).toBeInTheDocument();
    // No terminal block yet.
    expect(screen.queryByTestId('dynamic-workflow-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dynamic-workflow-totals')).not.toBeInTheDocument();
  });

  it('renders the static phase plan as chips and the description when present', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          description: 'Parallel refactor of the parser',
          phases: [{ title: 'Plan' }, { title: 'Execute', detail: 'fan out' }],
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-description')).toHaveTextContent(
      'Parallel refactor of the parser',
    );
    const phases = screen.getByTestId('dynamic-workflow-phases');
    expect(phases).toHaveTextContent('plan');
    expect(phases).toHaveTextContent('1 · Plan');
    expect(phases).toHaveTextContent('2 · Execute');
  });

  it('omits the phase plan and description blocks when absent', () => {
    render(<DynamicWorkflowPanel state={makeState()} />);
    expect(screen.queryByTestId('dynamic-workflow-phases')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dynamic-workflow-description')).not.toBeInTheDocument();
  });

  it('renders summary + totals (and drops elapsed) once terminal', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          status: 'completed',
          completedAt: '2026-06-11T10:06:36.000Z',
          summary: 'Refactored 12 files across 3 agents.',
          agents: [
            { agentId: 'a1', status: 'done' },
            { agentId: 'a2', status: 'done' },
          ],
          totals: {
            agentCount: 3,
            totalTokens: 123456,
            totalToolCalls: 42,
            durationMs: 396_000,
          },
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-status')).toHaveTextContent('completed');
    expect(screen.queryByTestId('dynamic-workflow-elapsed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-summary')).toHaveTextContent(
      'Refactored 12 files across 3 agents.',
    );
    expect(screen.getByTestId('dynamic-workflow-total-agents')).toHaveTextContent('3');
    expect(screen.getByTestId('dynamic-workflow-total-tokens')).toHaveTextContent(
      (123456).toLocaleString(),
    );
    expect(screen.getByTestId('dynamic-workflow-total-tools')).toHaveTextContent('42');
    expect(screen.getByTestId('dynamic-workflow-total-duration')).toHaveTextContent('6m 36s');
  });

  it('shows the failed status without fabricating totals', () => {
    render(<DynamicWorkflowPanel state={makeState({ status: 'failed' })} />);
    expect(screen.getByTestId('dynamic-workflow-status')).toHaveTextContent('failed');
    expect(screen.queryByTestId('dynamic-workflow-totals')).not.toBeInTheDocument();
  });

  it('renders a dismiss button on a terminal card and fires onDismiss', () => {
    const onDismiss = vi.fn();
    render(
      <DynamicWorkflowPanel
        state={makeState({ status: 'completed' })}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByTestId('dynamic-workflow-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('never renders the dismiss button while running, even with onDismiss provided', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({ status: 'running' })}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('dynamic-workflow-dismiss')).not.toBeInTheDocument();
  });

  it('omits the dismiss button when no onDismiss is provided', () => {
    render(<DynamicWorkflowPanel state={makeState({ status: 'completed' })} />);
    expect(screen.queryByTestId('dynamic-workflow-dismiss')).not.toBeInTheDocument();
  });

  it('never renders agent rows in the default (compact) variant', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          agents: [{ agentId: 'a1', status: 'running', model: 'claude-fable-5' }],
        })}
      />,
    );
    expect(screen.queryByTestId('dynamic-workflow-agents')).not.toBeInTheDocument();
  });
});

describe('DynamicWorkflowPanel — expanded agent rows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function agentMeta(agentId: string): HTMLElement {
    const row = screen.getByTestId(`dynamic-workflow-agent-${agentId}`);
    return within(row).getByTestId('dynamic-workflow-agent-meta');
  }

  function agentName(agentId: string): HTMLElement {
    const row = screen.getByTestId(`dynamic-workflow-agent-${agentId}`);
    return within(row).getByTestId('dynamic-workflow-agent-name');
  }

  it('renders one row per agent with model / token / tool formatting', () => {
    render(
      <DynamicWorkflowPanel
        expanded
        state={makeState({
          agents: [
            {
              agentId: 'a1',
              status: 'running',
              model: 'claude-fable-5',
              outputTokens: 31_200,
              toolUses: 16,
              startedAt: '2026-06-11T10:00:05.000Z',
              lastActivityAt: new Date().toISOString(),
            },
            {
              agentId: 'a2',
              status: 'done',
              model: 'claude-opus-4-8',
              outputTokens: 980,
              toolUses: 1,
              startedAt: '2026-06-11T10:00:00.000Z',
              lastActivityAt: '2026-06-11T10:06:36.000Z',
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-agents')).toBeInTheDocument();
    // Running agent with fresh activity: no idle hint.
    expect(agentMeta('a1')).toHaveTextContent('Fable 5 · 31.2k tok · 16 tools');
    expect(agentMeta('a1')).not.toHaveTextContent('idle');
    // Done agent: singular "tool" + elapsed from startedAt → lastActivityAt.
    expect(agentMeta('a2')).toHaveTextContent('Opus 4.8 · 980 tok · 1 tool · 6m 36s');
  });

  it('flags a running agent as idle once activity is >30s stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T10:10:00.000Z'));
    render(
      <DynamicWorkflowPanel
        expanded
        state={makeState({
          agents: [
            {
              agentId: 'a1',
              status: 'running',
              lastActivityAt: '2026-06-11T10:09:11.000Z', // 49s ago
            },
          ],
        })}
      />,
    );
    expect(agentMeta('a1')).toHaveTextContent('idle 49s');
  });

  it('degrades to "agent N" rows with an em-dash when fields are absent (older main build)', () => {
    render(
      <DynamicWorkflowPanel
        expanded
        state={makeState({
          agents: [
            { agentId: 'a1', status: 'running' },
            { agentId: 'a2', status: 'done' },
          ],
        })}
      />,
    );
    expect(agentName('a1')).toHaveTextContent('agent 1');
    expect(agentName('a2')).toHaveTextContent('agent 2');
    expect(agentMeta('a1')).toHaveTextContent('—');
    expect(agentMeta('a2')).toHaveTextContent('—');
  });

  it('names agents by their excerpt tails after the shared prologue', () => {
    render(
      <DynamicWorkflowPanel
        expanded
        state={makeState({
          agents: [
            {
              agentId: 'a1',
              status: 'running',
              promptExcerpt: 'You are a refactor subagent for cyboflow. Task: parser cleanup',
            },
            {
              agentId: 'a2',
              status: 'running',
              promptExcerpt: 'You are a refactor subagent for cyboflow. Task: lexer hygiene',
            },
          ],
        })}
      />,
    );
    expect(agentName('a1')).toHaveTextContent('parser cleanup');
    expect(agentName('a2')).toHaveTextContent('lexer hygiene');
  });

  it('hides the agents block when the agents array is empty', () => {
    render(<DynamicWorkflowPanel expanded state={makeState({ agents: [] })} />);
    expect(screen.queryByTestId('dynamic-workflow-agents')).not.toBeInTheDocument();
  });
});

describe('DynamicWorkflowPanel — stage-bucketed agents', () => {
  const phases = [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }];

  function groupedState(): DynamicWorkflowRunState {
    return makeState({
      phases,
      agents: [
        { agentId: 'r1', status: 'done', promptExcerpt: 'review the bugs dimension' },
        { agentId: 'v1', status: 'running', promptExcerpt: 'Adversarially verify the claim' },
      ],
    });
  }

  it('renders a stage header per phase, with the running stage expanded and others collapsed', () => {
    render(<DynamicWorkflowPanel expanded state={groupedState()} />);
    expect(screen.getByTestId('dynamic-workflow-stage-0')).toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-stage-1')).toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-stage-2')).toBeInTheDocument();
    // Verify (running) opens by default → its agent is visible.
    expect(screen.getByTestId('dynamic-workflow-agent-v1')).toBeInTheDocument();
    // Review (done) starts collapsed → its agent is hidden until clicked.
    expect(screen.queryByTestId('dynamic-workflow-agent-r1')).not.toBeInTheDocument();
  });

  it("reveals a stage's agents when its header is clicked", () => {
    render(<DynamicWorkflowPanel expanded state={groupedState()} />);
    expect(screen.queryByTestId('dynamic-workflow-agent-r1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dynamic-workflow-stage-toggle-0'));
    expect(screen.getByTestId('dynamic-workflow-agent-r1')).toBeInTheDocument();
  });

  it('falls back to a flat list (no stage headers) when an agent is unrecognized', () => {
    render(
      <DynamicWorkflowPanel
        expanded
        state={makeState({
          phases,
          agents: [
            { agentId: 'r1', status: 'done', promptExcerpt: 'review x' },
            { agentId: 'x1', status: 'running', promptExcerpt: 'totally unrelated work' },
          ],
        })}
      />,
    );
    expect(screen.queryByTestId('dynamic-workflow-stage-0')).not.toBeInTheDocument();
    // Flat list: both rows visible immediately.
    expect(screen.getByTestId('dynamic-workflow-agent-r1')).toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-agent-x1')).toBeInTheDocument();
  });
});

describe('computeAgentDisplayNames', () => {
  function agent(
    agentId: string,
    promptExcerpt?: string,
    status: DynamicWorkflowAgent['status'] = 'running',
  ): DynamicWorkflowAgent {
    return { agentId, status, promptExcerpt };
  }

  it('strips the longest common prefix and trims tails to ~60 chars', () => {
    const prologue = 'Shared prologue every subagent prompt opens with. Focus: ';
    const longTail = 'x'.repeat(80);
    const names = computeAgentDisplayNames([
      agent('a1', `${prologue}parser cleanup`),
      agent('a2', `${prologue}${longTail}`),
    ]);
    expect(names.get('a1')).toBe('parser cleanup');
    expect(names.get('a2')).toBe('x'.repeat(60));
  });

  it('collapses whitespace in tails to a single line', () => {
    const names = computeAgentDisplayNames([
      agent('a1', 'Prefix: fix\n  the   parser'),
      agent('a2', 'Prefix: lint everything'),
    ]);
    expect(names.get('a1')).toBe('fix the parser');
  });

  it('a lone excerpt names itself — no prologue to strip', () => {
    const names = computeAgentDisplayNames([agent('a1', 'Verify the tracker end to end')]);
    expect(names.get('a1')).toBe('Verify the tracker end to end');
  });

  it('falls back to "agent N" by stable order for missing or fully-shared excerpts', () => {
    const names = computeAgentDisplayNames([
      agent('a1'),
      agent('a2', 'identical excerpt'),
      agent('a3', 'identical excerpt'),
    ]);
    expect(names.get('a1')).toBe('agent 1');
    expect(names.get('a2')).toBe('agent 2');
    expect(names.get('a3')).toBe('agent 3');
  });
});

describe('formatModelName', () => {
  it.each([
    ['claude-fable-5', 'Fable 5'],
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['fable-5', 'Fable 5'],
    ['claude-sonnet-4', 'Sonnet 4'],
    ['opus', 'Opus'],
  ])('formats %s as %s', (raw, expected) => {
    expect(formatModelName(raw)).toBe(expected);
  });
});
