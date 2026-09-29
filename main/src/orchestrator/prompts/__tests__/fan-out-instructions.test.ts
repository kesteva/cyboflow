/**
 * Unit tests for fan-out-instructions.ts — the pure generator that derives the
 * per-run fan-out execution instruction block from a resolved WorkflowDefinition's
 * `fanOut` specs.
 *
 * Behaviors covered:
 *  1. Canonical 5-step chain + no explicit maxConcurrency → the default cap (5),
 *     DAG-wave + same-file-guard dispatch, all 5 lane ids + the 4 delegated
 *     `cyboflow-<agent>` names (visual-verify is orchestrator-fired, not
 *     delegated), the task-verify output contract, the awaiting-verify park,
 *     and the loopback/attempt protocol.
 *  2. Explicit maxConcurrency 3 → "at most 3" and no cap-5 text.
 *  3. maxConcurrency 1 → strictly-serial dispatch (no DAG waves / same-file guard).
 *  4. A custom 2-step chain (custom ids, one explicit loopback + one defaulted)
 *     → the generic fallback texture, the explicit loopback target, and the
 *     first-inner-step default loopback.
 *  5. Fail-soft: a def with no fanOut-bearing step, and a `null` def, both → ''.
 *
 * The module is pure (no fs/DB/Electron, no Date/random) so output is asserted
 * directly.
 */
import { describe, it, expect } from 'vitest';
import { buildFanOutAppend } from '../fan-out-instructions';
import { fanOutBatchWorkflowName } from '../fanOutStageScript';
import { WORKFLOW_DEFINITIONS, type WorkflowDefinition } from '../../../../../shared/types/workflows';
import {
  DEFAULT_FAN_OUT_DISPATCH,
  INTERACTIVE_FAN_OUT_DISPATCH_DEFAULT,
} from '../../../../../shared/types/fanOutDispatch';

/**
 * Build a single-phase def whose one step declares the canonical sprint fan-out
 * chain, with an overridable `maxConcurrency`.
 */
function canonicalFanOutDef(maxConcurrency?: number): WorkflowDefinition {
  return {
    id: 'sprint-fixture',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: ['filesystem'],
            retries: 3,
            fanOut: {
              over: 'tasks',
              ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
              inner: [
                { id: 'implement', agent: 'implement', name: 'Implement' },
                { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
                { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
                { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
                {
                  id: 'visual-verify',
                  agent: 'visual-verify',
                  name: 'Visual check',
                  optional: true,
                  loopback: 'implement',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * A custom 2-step fan-out over a non-'tasks' source: `alpha` carries an EXPLICIT
 * loopback to `beta`; `beta` has no loopback, so it defaults to the first inner
 * step (`alpha`).
 */
function customFanOutDef(): WorkflowDefinition {
  return {
    id: 'custom-fixture',
    phases: [
      {
        id: 'run',
        label: 'Run',
        color: '#3b6dd6',
        steps: [
          {
            id: 'do-each',
            name: 'Do each item',
            agent: 'alpha-agent',
            mcps: [],
            retries: 0,
            fanOut: {
              over: 'items',
              inner: [
                { id: 'alpha', agent: 'alpha-agent', name: 'Alpha', loopback: 'beta' },
                { id: 'beta', agent: 'beta-agent', name: 'Beta' },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('buildFanOutAppend — canonical chain, default cap', () => {
  const block = buildFanOutAppend(canonicalFanOutDef());

  it('governs the fanOut step and names its item source', () => {
    expect(block).toContain('## Fan-out execution — `execute-tasks`');
    expect(block).toContain('one lane per task');
  });

  it('uses the default cap of 5 and DAG-wave + same-file-guard dispatch', () => {
    expect(block).toContain('at most **5**');
    expect(block).toContain('DAG waves');
    expect(block).toContain('same file');
  });

  it('lists all 5 lane ids and the 4 delegated cyboflow-<agent> names', () => {
    for (const id of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(block).toContain(`\`${id}\``);
    }
    for (const id of ['implement', 'write-tests', 'code-review', 'task-verify']) {
      expect(block).toContain(`cyboflow-${id}`);
    }
  });

  it('enforces the task-verify visual-verification output contract on PASS', () => {
    expect(block).toContain('visual-verification output contract');
    expect(block).toContain('## Visual verification task');
    expect(block).toContain('VISUAL-VERIFICATION: NOT-APPLICABLE');
    expect(block).toContain('output-contract failure');
  });

  it('parks the visual merge-gate at awaiting-verify, fired by the orchestrator itself', () => {
    expect(block).toContain('awaiting-verify');
    expect(block).toContain('async visual merge-gate');
    // The dispatcher subagent is retired: the orchestrator fires the request
    // directly with the composed task; there is no cyboflow-visual-verify delegate.
    expect(block).not.toContain('cyboflow-visual-verify');
    expect(block).toContain('cyboflow_request_verification');
    expect(block).toContain('NO subagent to delegate');
  });

  it('emits the loopback + attempt protocol', () => {
    expect(block).toContain('Loopback + attempt protocol');
    expect(block).toContain('attempt: <n>');
    expect(block).toContain('Stuck subagents');
    expect(block).toContain('On task success');
  });

  it('guards against filing a loopback-eligible defect as a finding (Item 1)', () => {
    // The prohibition renders once per loopback-bearing canonical entry (write-tests,
    // code-review, task-verify). It never appears on the re-entry target (implement)
    // or the agentless visual-verify step.
    const occurrences = block.split('the loopback IS the response').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(3);
    // Code-review keys on BOTH the `## Blocking` section and the new REVIEW: BLOCKING
    // verdict line (Item 0), and names the shared-state hazard exception.
    expect(block).toContain('REVIEW: BLOCKING');
    expect(block).toContain('Do NOT record a `## Blocking` defect as a finding');
  });

  it('dedups code-review findings against the run before filing', () => {
    expect(block).toContain('Before filing, call `cyboflow_list_run_findings`');
  });

  it("relays write-tests' `## Tests` section to code-review and task-verify", () => {
    const codeReview = block.slice(block.indexOf('**`code-review`**'), block.indexOf('**`task-verify`**'));
    const taskVerify = block.slice(block.indexOf('**`task-verify`**'), block.indexOf('**`visual-verify`**'));
    expect(codeReview).toContain("write-tests' `## Tests` section VERBATIM");
    expect(taskVerify).toContain("write-tests' `## Tests` section VERBATIM");
  });

  it('never names write-tests output when the chain has no write-tests step', () => {
    const def = canonicalFanOutDef();
    const fanOut = def.phases[0].steps[0].fanOut!;
    fanOut.inner = fanOut.inner.filter((s) => s.id !== 'write-tests');
    const withoutWriteTests = buildFanOutAppend(def);
    expect(withoutWriteTests).toContain('**`code-review`**');
    expect(withoutWriteTests).not.toContain('## Tests');
  });
});

describe('buildFanOutAppend — explicit maxConcurrency', () => {
  it('cap 3 → "at most 3", and no cap-5 text', () => {
    const block = buildFanOutAppend(canonicalFanOutDef(3));
    expect(block).toContain('at most **3**');
    expect(block).not.toContain('**5**');
  });

  it('cap 1 → strictly serial: no DAG waves / same-file guard', () => {
    const block = buildFanOutAppend(canonicalFanOutDef(1));
    expect(block).toContain('one at a time');
    expect(block).toContain('one lane at a time');
    expect(block).not.toContain('DAG waves');
    expect(block).not.toContain('same file');
  });
});

describe('buildFanOutAppend — custom chain (generic fallback)', () => {
  const block = buildFanOutAppend(customFanOutDef());

  it('names the generic item source for a non-tasks over key', () => {
    expect(block).toContain('the resolved item set (`items`)');
  });

  it('delegates each custom inner step generically with its files-touched context', () => {
    expect(block).toContain('cyboflow-alpha-agent');
    expect(block).toContain('cyboflow-beta-agent');
    expect(block).toContain('running files-touched list');
  });

  it('names the EXPLICIT loopback target (alpha → beta)', () => {
    expect(block).toContain('id `beta`');
  });

  it('defaults a missing loopback to the FIRST inner step (beta → alpha)', () => {
    expect(block).toContain('id `alpha`');
    // The protocol paragraph also documents the first-inner default.
    expect(block).toContain('THE FIRST');
  });

  it('carries the finding-vs-loopback guardrail into the generic fallback (Item 1)', () => {
    expect(block).toContain('the loopback IS the response');
  });
});

describe('buildFanOutAppend — fail-soft', () => {
  it("returns '' for a definition with no fanOut-bearing step (built-in planner)", () => {
    expect(buildFanOutAppend(WORKFLOW_DEFINITIONS.planner)).toBe('');
  });

  it("returns '' for a null definition", () => {
    expect(buildFanOutAppend(null)).toBe('');
  });

  it('emits a section for the built-in sprint definition (real fanOut step)', () => {
    const block = buildFanOutAppend(WORKFLOW_DEFINITIONS.sprint);
    expect(block).toContain('## Fan-out execution — `execute-tasks`');
    expect(block).toContain('at most **5**');
  });
});

// ---------------------------------------------------------------------------
// Stage-major workflow dispatch (opts.dispatch === 'workflow')
// ---------------------------------------------------------------------------

describe('buildFanOutAppend — dispatch mode', () => {
  const def = canonicalFanOutDef();

  // LOAD-BEARING, not incidental. `workflowPromptReaderAdapter` (the SDK prompt
  // composer) calls buildFanOutAppend(def) with NO opts, while claudeCodeManager
  // installs the workflow bundle with 'prose' EXPLICITLY. So if the no-opts
  // default ever became 'workflow', the SDK orchestrator would be instructed to
  // dispatch to `.claude/workflows/cyboflow-*.js` scripts that were never written
  // to its worktree — a prompt/disk mismatch no typecheck can see.
  //
  // The shipped-ON default for INTERACTIVE runs lives in
  // INTERACTIVE_FAN_OUT_DISPATCH_DEFAULT (read by ConfigManager.getFanOutDispatch)
  // precisely so it cannot reach this call site. Do not "fix" this test by
  // retargeting it at 'workflow'.
  it('defaults to prose — byte-identical to an explicit prose request', () => {
    expect(buildFanOutAppend(def)).toBe(buildFanOutAppend(def, { dispatch: 'prose' }));
  });

  it('pins the two defaults apart: neutral floor prose, interactive workflow', () => {
    expect(DEFAULT_FAN_OUT_DISPATCH).toBe('prose');
    expect(INTERACTIVE_FAN_OUT_DISPATCH_DEFAULT).toBe('workflow');
  });

  it('the prose arm never mentions the Workflow tool', () => {
    expect(buildFanOutAppend(def)).not.toContain('Workflow({');
  });

  describe('workflow arm', () => {
    const block = buildFanOutAppend(def, { dispatch: 'workflow', workflowName: 'sprint' });

    it('dispatches the whole non-gated sub-chain as ONE batch', () => {
      const batchName = fanOutBatchWorkflowName('sprint', 'execute-tasks', 'implement');
      expect(batchName).not.toBeNull();
      expect(block).toContain(`Workflow({ name: '${batchName as string}'`);
      // ONE dispatch, not one per stage.
      expect(block.match(/Workflow\(\{ name:/g)).toHaveLength(1);
      expect(block).toContain('dispatched as ONE batch, no orchestrator gate between them');
    });

    it('names the Workflow tool explicitly so the agent does not try Skill first', () => {
      expect(block).toContain('use the **Workflow tool** (not Skill, not Bash)');
    });

    it('keeps the firm visual gate on the prose path', () => {
      const gateName = fanOutBatchWorkflowName('sprint', 'execute-tasks', 'visual-verify');
      expect(block).not.toContain(`name: '${gateName as string}'`);
      expect(block).toContain('cyboflow_request_verification');
      expect(block).toContain('there is NO subagent to delegate');
    });

    it('states the lane-granularity trade explicitly', () => {
      expect(block).toContain('does not');
      expect(block).toContain('tick per stage');
      expect(block).toContain('backfill');
    });

    it('reconciles domain outcomes rather than assuming success', () => {
      expect(block).toContain('outcome: "ok"');
      expect(block).toContain('outcome: "failed"');
      expect(block).toContain('failedStage');
    });

    it('keeps every cyboflow write with the orchestrator', () => {
      expect(block).toContain('SOLE writer of cyboflow');
      expect(block).toContain('The script writes NO cyboflow state by design');
      expect(block).toContain('cyboflow_report_finding');
    });

    it('retains the shared dispatch + loopback protocol', () => {
      expect(block).toContain('at most **5** concurrently');
      expect(block).toContain('Loopback + attempt protocol');
      expect(block).toContain('ONE git commit for that task');
    });

    it('falls back to prose for a batch whose name cannot be slugged', () => {
      const weird = buildFanOutAppend(def, { dispatch: 'workflow', workflowName: '***' });
      expect(weird).not.toContain('Workflow({');
      expect(weird).toContain('cyboflow-implement');
    });
  });
});
