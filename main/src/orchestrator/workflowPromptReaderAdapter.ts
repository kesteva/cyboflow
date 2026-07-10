/**
 * workflowPromptReaderAdapter — the concrete `WorkflowPromptReaderLike.read`
 * logic that `RunExecutor.getPrompt` drives, extracted from `main/src/index.ts`
 * so it is unit-testable without bootstrapping Electron.
 *
 * It branches on the run's workflow row:
 *   - Built-in / edited built-in flow (non-null `workflow_path`): read the `.md`
 *     body + its `system_prompt_append` frontmatter via `readWorkflowPrompt`,
 *     then concatenate the per-run cyboflow prompt appends derived from the
 *     EFFECTIVE definition (`resolveWorkflowDefinition(name, spec_json)` —
 *     honoring user edits in spec_json, never `WORKFLOW_DEFINITIONS[name]`
 *     directly): the step-reporting instructions (TASK-803) followed by the
 *     fan-out execution instructions derived from each step's `fanOut` spec.
 *     Fail-soft: a non-SoloFlow / broken-spec workflow yields '' for both so
 *     nothing extra is injected.
 *   - Custom flow (null `workflow_path`, graph in `spec_json`): there is no `.md`
 *     prose, so render the orchestrator prompt from the resolved step graph via
 *     `renderCustomFlowPrompt`. The step-reporting + fan-out appends still ride on
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
import { buildFanOutAppend } from './prompts/fan-out-instructions';
import { renderCustomFlowPrompt } from './customFlowPrompt';

/** Join the non-empty prompt-append fragments with a blank-line separator. */
function joinAppends(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Resolve the run-prompt (+ systemPromptAppend) for a workflow row. See the
 * module doc for the built-in vs custom-flow branch contract.
 *
 * @throws {WorkflowPromptReadError} when a built-in `.md` is missing/empty
 *   (bubbled from `readWorkflowPrompt`) or when a custom flow has no resolvable
 *   definition.
 */
export function readWorkflowPromptForRow(workflow: WorkflowRow): WorkflowPrompt {
  const resolvedDef = resolveWorkflowDefinition(workflow.name, workflow.spec_json);
  // Per-run cyboflow appends, both derived from the SAME resolved definition:
  // step-reporting first, then the fan-out execution instructions. Either is ''
  // (fail-soft) when the def is null / carries no matching steps.
  const workflowAppends = [buildStepReportingAppend(resolvedDef), buildFanOutAppend(resolvedDef)];

  if (workflow.workflow_path) {
    const base = readWorkflowPrompt(workflow.workflow_path);
    const systemPromptAppend = joinAppends([base.systemPromptAppend, ...workflowAppends]);
    return { prompt: base.prompt, systemPromptAppend };
  }

  if (resolvedDef === null) {
    throw new WorkflowPromptReadError(
      `promptReader.read: custom flow ${workflow.id} has no resolvable definition`,
    );
  }
  return {
    prompt: renderCustomFlowPrompt(resolvedDef),
    systemPromptAppend: joinAppends(workflowAppends),
  };
}
