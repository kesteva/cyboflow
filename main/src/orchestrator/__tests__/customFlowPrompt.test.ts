/**
 * Unit tests for the pure custom-flow prompt builder
 * (`main/src/orchestrator/customFlowPrompt.ts`).
 *
 * Behaviors covered:
 * 1. CUSTOM_ORCHESTRATOR_HARNESS carries each required orchestration instruction:
 *    single-writer, subagent_type delegation, cyboflow_report_step,
 *    atomic-commit-per-step, AskUserQuestion-only human gates.
 * 2. renderWorkflowGraph emits a section per phase and, per step, the backticked
 *    id + name + either `cyboflow-<agent>` delegation OR HUMAN GATE, with the
 *    optional / retries / loopback annotations on a fixture definition.
 * 3. A human gate (via `human: true` OR `agent: 'human'`) renders
 *    AskUserQuestion, never a tool/delegation call.
 * 4. renderCustomFlowPrompt concatenates the harness + the rendered graph.
 *
 * The module is pure (no fs/DB/Electron, no Date/random) so the output is
 * asserted directly.
 */
import { describe, it, expect } from 'vitest';
import {
  CUSTOM_ORCHESTRATOR_HARNESS,
  renderWorkflowGraph,
  renderCustomFlowPrompt,
} from '../customFlowPrompt';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';

/**
 * Fixture exercising every annotation branch:
 *  - a delegated step with desc + retries + loopback,
 *  - an optional delegated step,
 *  - a human gate via `human: true`,
 *  - a human gate via `agent: 'human'` (no `human` flag).
 */
function makeFixture(): WorkflowDefinition {
  return {
    id: 'custom-flow',
    phases: [
      {
        id: 'build',
        label: 'Build',
        color: '#3b6dd6',
        steps: [
          {
            id: 'implement-thing',
            name: 'Implement the thing',
            agent: 'implement',
            mcps: ['filesystem'],
            retries: 2,
            loopback: 'implement-thing',
            desc: 'Write the code for the thing.',
          },
          {
            id: 'research-thing',
            name: 'Research the thing',
            agent: 'research',
            mcps: ['web-search'],
            retries: 0,
            optional: true,
          },
        ],
      },
      {
        id: 'review',
        label: 'Review',
        color: '#5a4ad6',
        steps: [
          {
            id: 'approve-thing',
            name: 'Approve the thing',
            agent: 'human',
            mcps: [],
            retries: 0,
            human: true,
            desc: 'You approve, revise, or reject.',
          },
          {
            id: 'sign-off',
            name: 'Sign off',
            // Gate via agent === HUMAN_GATE_AGENT, without the human flag.
            agent: 'human',
            mcps: [],
            retries: 0,
          },
        ],
      },
    ],
  };
}

describe('CUSTOM_ORCHESTRATOR_HARNESS', () => {
  it('instructs single-writer ownership of cyboflow state', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('single writer');
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('cyboflow_*');
    // subagents must be told they never write cyboflow state
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/never\b[\s\S]*write cyboflow state/i);
  });

  it('instructs subagent_type delegation via the Task tool', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('Task tool');
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('subagent_type: "cyboflow-<agent>"');
  });

  it('instructs cyboflow_report_step on each step', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('cyboflow_report_step');
  });

  it('instructs an atomic commit per completed step, never batched', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('atomic git commit');
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('One commit per completed step');
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/never batch/i);
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('<type>: <what changed>');
  });

  it('instructs AskUserQuestion as the ONLY human-gate mechanism', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('AskUserQuestion');
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toContain('AskUserQuestion is the only gate mechanism');
    // must forbid inventing a cyboflow_* gate tool
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/never\s+invent or call a[\s\S]*gate[\s\S]*tool/i);
  });

  it('instructs strictly-in-order execution and optional-step skipping', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/in order/i);
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/optional/i);
  });

  it('carves out the fan-out exception to the strictly-in-order rule', () => {
    // A fan-out step is no longer "no parallel steps" — it dispatches per-item.
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/fan-out/i);
    expect(CUSTOM_ORCHESTRATOR_HARNESS).not.toContain('There are no parallel steps');
    expect(CUSTOM_ORCHESTRATOR_HARNESS).not.toContain('No parallel steps in v1');
  });

  it('instructs loopback + retries handling on failure', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/loop back/i);
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/retries/i);
  });

  it('instructs completion: summarize and stop without merging', () => {
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/stop/i);
    expect(CUSTOM_ORCHESTRATOR_HARNESS).toMatch(/do not merge/i);
  });
});

describe('renderWorkflowGraph', () => {
  it('emits a section heading per phase using the phase label', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('# Workflow graph');
    expect(graph).toContain('## Build');
    expect(graph).toContain('## Review');
  });

  it('renders a delegated step with backticked id, name, and cyboflow-<agent> target', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('- `implement-thing` — Implement the thing → delegate to `cyboflow-implement`');
  });

  it('includes the step desc when present', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('Write the code for the thing.');
  });

  it('annotates retries (only when > 0) and loopback', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('- retries: 2');
    expect(graph).toContain('- on failure → loop back to `implement-thing`');
  });

  it('annotates optional steps and omits retries when 0', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('- `research-thing` — Research the thing → delegate to `cyboflow-research`');
    expect(graph).toContain('- optional');
    // research-thing has retries: 0 — no retries annotation should appear for it
    expect(graph).not.toContain('- retries: 0');
  });

  it('renders a human-flag gate step as HUMAN GATE (AskUserQuestion), not a delegation', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('- `approve-thing` — Approve the thing → HUMAN GATE (AskUserQuestion)');
    expect(graph).not.toContain('cyboflow-human');
  });

  it('renders an agent==="human" gate (no human flag) as a HUMAN GATE too', () => {
    const graph = renderWorkflowGraph(makeFixture());
    expect(graph).toContain('- `sign-off` — Sign off → HUMAN GATE (AskUserQuestion)');
  });

  it('is deterministic for a given definition', () => {
    const def = makeFixture();
    expect(renderWorkflowGraph(def)).toBe(renderWorkflowGraph(def));
  });

  it('renders a one-line fan-out pointer (over + inner count + cap) for a fanOut step', () => {
    const def: WorkflowDefinition = {
      id: 'fanout-flow',
      phases: [
        {
          id: 'execute',
          label: 'Execute',
          color: '#c96442',
          steps: [
            {
              id: 'run-each',
              name: 'Run each item',
              agent: 'implement',
              mcps: [],
              retries: 0,
              fanOut: {
                over: 'tasks',
                maxConcurrency: 3,
                inner: [
                  { id: 'build', agent: 'implement', name: 'Build' },
                  { id: 'check', agent: 'task-verify', name: 'Check', loopback: 'build' },
                ],
              },
            },
          ],
        },
      ],
    };
    const graph = renderWorkflowGraph(def);
    expect(graph).toContain('- `run-each` — Run each item → delegate to `cyboflow-implement`');
    // One-line pointer: item source, inner-chain length, and the cap.
    expect(graph).toContain('fans out over `tasks`');
    expect(graph).toContain('2-step inner');
    expect(graph).toContain('at most 3 concurrent');
    // The full per-item block is NOT duplicated in the graph (adapter appends it).
    expect(graph).not.toContain('## Fan-out execution');
  });
});

describe('renderCustomFlowPrompt', () => {
  it('concatenates the harness and the rendered graph', () => {
    const def = makeFixture();
    const prompt = renderCustomFlowPrompt(def);
    expect(prompt.startsWith(CUSTOM_ORCHESTRATOR_HARNESS)).toBe(true);
    expect(prompt).toContain(renderWorkflowGraph(def));
    // harness precedes the graph
    expect(prompt.indexOf(CUSTOM_ORCHESTRATOR_HARNESS)).toBeLessThan(
      prompt.indexOf('# Workflow graph'),
    );
  });

  it('is deterministic for a given definition', () => {
    const def = makeFixture();
    expect(renderCustomFlowPrompt(def)).toBe(renderCustomFlowPrompt(def));
  });
});
