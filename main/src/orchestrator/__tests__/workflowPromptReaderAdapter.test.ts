/**
 * Unit tests for workflowPromptReaderAdapter.readWorkflowPromptForRow — the
 * concrete WorkflowPromptReaderLike.read logic extracted from main/src/index.ts.
 *
 * Behaviors covered:
 *  - non-null workflow_path (built-in / edited built-in): unchanged behavior —
 *    reads the `.md` body + frontmatter and concatenates the step-reporting
 *    append derived from the resolved definition.
 *  - null workflow_path + valid spec_json (custom flow): prompt is the rendered
 *    orchestrator harness + step graph; systemPromptAppend carries step-reporting.
 *  - null workflow_path + null/invalid spec_json (custom flow): throws
 *    WorkflowPromptReadError.
 *
 * Built-in `.md` reads use withTempDir for filesystem isolation (auto-cleanup);
 * everything else is pure.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { readWorkflowPromptForRow } from '../workflowPromptReaderAdapter';
import { WorkflowPromptReadError } from '../workflowPromptReader';
import { CUSTOM_ORCHESTRATOR_HARNESS } from '../customFlowPrompt';
import { withTempDir } from '../../__test_fixtures__/tmp';
import type { WorkflowRow } from '../../../../shared/types/workflows';

function makeWorkflowRow(overrides?: Partial<WorkflowRow>): WorkflowRow {
  return {
    id: 'wf-test',
    project_id: 1,
    name: 'sprint',
    workflow_path: '/fake/sprint.md',
    permission_mode: 'default',
    spec_json: '{}',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal structurally-valid custom-flow spec_json (id + one phase + one step). */
const VALID_CUSTOM_SPEC = JSON.stringify({
  id: 'my-custom-flow',
  phases: [
    {
      id: 'build',
      label: 'Build it',
      color: '#3b6dd6',
      steps: [
        { id: 'do-the-thing', name: 'Do the thing', agent: 'executor', mcps: [], retries: 0 },
      ],
    },
  ],
});

describe('readWorkflowPromptForRow — built-in / edited built-in (non-null workflow_path)', () => {
  it('reads the .md body and appends step-reporting for a built-in name', async () => {
    await withTempDir('wpra-test-', (tmpDir) => {
      const mdPath = join(tmpDir, 'sprint.md');
      writeFileSync(mdPath, '---\nsystem_prompt_append: "Be terse."\n---\nDo the sprint.');
      // name='sprint' is a built-in, so resolveWorkflowDefinition yields the
      // built-in def → step-reporting append is non-empty and concatenated.
      const result = readWorkflowPromptForRow(
        makeWorkflowRow({ name: 'sprint', workflow_path: mdPath, spec_json: '{}' }),
      );
      expect(result.prompt).toBe('Do the sprint.');
      expect(result.systemPromptAppend.startsWith('Be terse.')).toBe(true);
      // step-reporting append references cyboflow_report_step
      expect(result.systemPromptAppend).toContain('cyboflow_report_step');
    });
  });

  it('returns the bare base prompt when the resolved def yields no step ids (non-SoloFlow name)', async () => {
    await withTempDir('wpra-test-', (tmpDir) => {
      const mdPath = join(tmpDir, 'custom.md');
      writeFileSync(mdPath, '---\nsystem_prompt_append: "Keep it short."\n---\nBody here.');
      // name is NOT a built-in and spec_json is empty → resolveWorkflowDefinition
      // returns null → buildStepReportingAppend('') → '' → base returned unchanged.
      const result = readWorkflowPromptForRow(
        makeWorkflowRow({ name: 'not-a-builtin', workflow_path: mdPath, spec_json: '{}' }),
      );
      expect(result.prompt).toBe('Body here.');
      expect(result.systemPromptAppend).toBe('Keep it short.');
    });
  });

  it('bubbles WorkflowPromptReadError when the .md file is missing', () => {
    expect(() =>
      readWorkflowPromptForRow(
        makeWorkflowRow({ name: 'sprint', workflow_path: '/tmp/__cyboflow_nonexistent_wpra__/x.md' }),
      ),
    ).toThrow(WorkflowPromptReadError);
  });
});

describe('readWorkflowPromptForRow — custom flow (null workflow_path)', () => {
  it('renders the orchestrator harness + step graph from a valid spec_json', () => {
    const result = readWorkflowPromptForRow(
      makeWorkflowRow({ name: 'my-custom-flow', workflow_path: null, spec_json: VALID_CUSTOM_SPEC }),
    );
    // prompt = fixed harness preamble + the rendered graph for the spec
    expect(result.prompt.startsWith(CUSTOM_ORCHESTRATOR_HARNESS)).toBe(true);
    expect(result.prompt).toContain('# Workflow graph');
    expect(result.prompt).toContain('Build it');
    expect(result.prompt).toContain('`do-the-thing`');
    // step-reporting append rides on systemPromptAppend
    expect(result.systemPromptAppend).toContain('cyboflow_report_step');
    expect(result.systemPromptAppend).toContain('do-the-thing');
  });

  it('throws WorkflowPromptReadError when spec_json is empty ({})', () => {
    expect(() =>
      readWorkflowPromptForRow(
        makeWorkflowRow({ id: 'custom-empty', name: 'my-custom-flow', workflow_path: null, spec_json: '{}' }),
      ),
    ).toThrow(WorkflowPromptReadError);
    expect(() =>
      readWorkflowPromptForRow(
        makeWorkflowRow({ id: 'custom-empty', name: 'my-custom-flow', workflow_path: null, spec_json: '{}' }),
      ),
    ).toThrow(/custom-empty/);
  });

  it('throws WorkflowPromptReadError when spec_json is malformed JSON', () => {
    expect(() =>
      readWorkflowPromptForRow(
        makeWorkflowRow({ name: 'my-custom-flow', workflow_path: null, spec_json: '{not valid json' }),
      ),
    ).toThrow(WorkflowPromptReadError);
  });
});
