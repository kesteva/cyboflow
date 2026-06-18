/**
 * workflowPromptReaderAdapter — the concrete `WorkflowPromptReaderLike.read`
 * logic that `RunExecutor.getPrompt` drives, extracted from `main/src/index.ts`
 * so it is unit-testable without bootstrapping Electron.
 *
 * It branches on the run's workflow row:
 *   - Built-in / edited built-in flow (non-null `workflow_path`): read the `.md`
 *     body + its `system_prompt_append` frontmatter via `readWorkflowPrompt`,
 *     then (TASK-803) concatenate the per-run cyboflow step-reporting
 *     instructions derived from the EFFECTIVE definition
 *     (`resolveWorkflowDefinition(name, spec_json)` — honoring user edits in
 *     spec_json, never `WORKFLOW_DEFINITIONS[name]` directly). Fail-soft: a
 *     non-SoloFlow / broken-spec workflow yields '' so nothing extra is injected.
 *   - Custom flow (null `workflow_path`, graph in `spec_json`): there is no `.md`
 *     prose, so render the orchestrator prompt from the resolved step graph via
 *     `renderCustomFlowPrompt`. The step-reporting append still rides on
 *     `systemPromptAppend`. An unresolvable definition is a hard error
 *     (`WorkflowPromptReadError`) — the run cannot proceed without a graph.
 *
 * Depends only on `fs` (transitively, via `readWorkflowPrompt`) + pure helpers —
 * no Electron / DB imports — so it is trivially testable in plain vitest.
 */
import type { WorkflowRow } from '../../../shared/types/workflows';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import {
  readWorkflowPrompt,
  WorkflowPromptReadError,
  type WorkflowPrompt,
} from './workflowPromptReader';
import { buildStepReportingAppend } from './prompts/step-reporting-instructions';
import { renderCustomFlowPrompt } from './customFlowPrompt';

/**
 * Resolve the run-prompt (+ systemPromptAppend) for a workflow row. See the
 * module doc for the built-in vs custom-flow branch contract.
 *
 * @throws {WorkflowPromptReadError} when a built-in `.md` is missing/empty
 *   (bubbled from `readWorkflowPrompt`) or when a custom flow has no resolvable
 *   definition.
 */
export function readWorkflowPromptForRow(workflow: WorkflowRow): WorkflowPrompt {
  if (workflow.workflow_path) {
    const base = readWorkflowPrompt(workflow.workflow_path);
    const resolvedDef = resolveWorkflowDefinition(workflow.name, workflow.spec_json);
    const stepReportingAppend = buildStepReportingAppend(resolvedDef);
    if (stepReportingAppend === '') return base;
    const systemPromptAppend =
      base.systemPromptAppend.length > 0
        ? `${base.systemPromptAppend}\n\n${stepReportingAppend}`
        : stepReportingAppend;
    return { prompt: base.prompt, systemPromptAppend };
  }

  const def = resolveWorkflowDefinition(workflow.name, workflow.spec_json);
  if (def === null) {
    throw new WorkflowPromptReadError(
      `promptReader.read: custom flow ${workflow.id} has no resolvable definition`,
    );
  }
  return {
    prompt: renderCustomFlowPrompt(def),
    systemPromptAppend: buildStepReportingAppend(def),
  };
}
