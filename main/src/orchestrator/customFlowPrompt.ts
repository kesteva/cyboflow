/**
 * customFlowPrompt — turn a custom workflow's resolved step graph into the
 * orchestrator prompt that a custom flow runs.
 *
 * A custom flow has no hand-authored orchestrator prose (the built-in planner /
 * sprint / compound flows do — see `main/src/orchestrator/workflows/*.md`). This
 * module supplies a fixed stock orchestrator preamble
 * (`CUSTOM_ORCHESTRATOR_HARNESS`) and renders the flow's
 * `WorkflowDefinition.phases` into a readable markdown step graph the agent can
 * follow, so a custom flow can actually drive its step graph to completion.
 *
 * Voice + invariants are deliberately aligned with the built-in prose:
 *   - the orchestrator is the SINGLE WRITER of cyboflow state (subagents never
 *     write it),
 *   - phases/steps run strictly IN ORDER (a fan-out step excepted — it dispatches
 *     its inner chain per-item per the appended fan-out execution instructions),
 *   - `cyboflow_report_step` drives the live timeline,
 *   - heavy steps are delegated via the Task tool with `subagent_type:
 *     "cyboflow-<agent>"`,
 *   - the orchestrator commits atomically, one commit per completed step,
 *   - human gates use **AskUserQuestion** — never a `cyboflow_*` "gate" tool.
 *
 * This module is PURE: no fs, no DB, no Electron imports, no Date/random — its
 * output is deterministic for a given definition so it is trivially testable in
 * plain vitest. It imports types/helpers only from `shared/types`.
 */
import type { WorkflowDefinition, WorkflowStep } from '../../../shared/types/workflows';
import { effectiveMaxConcurrency } from '../../../shared/types/workflows';
import { HUMAN_GATE_AGENT } from '../../../shared/types/agentIdentity';

/**
 * The fixed, hand-authored stock orchestrator preamble for custom flows.
 *
 * NOT user-editable in v1: a custom flow carries only a step graph, so this
 * harness supplies the orchestration contract the built-in flows express in
 * their own prose. Bound by `renderCustomFlowPrompt` ahead of the rendered
 * graph.
 */
export const CUSTOM_ORCHESTRATOR_HARNESS = `# Custom flow orchestrator

You are the orchestrator of a **custom multi-step workflow**. You run in the
project's git worktree and drive this flow to completion, step by step, exactly
as laid out in the **Workflow graph** below.

## How to run this flow

You **own all workflow state.** You are the **single writer** of cyboflow state:
persist every state change yourself via the \`cyboflow_*\` MCP tools. The
subagents you delegate to are **edit-only** and **never** write cyboflow state —
that is your job, so single-writer invariants hold.

Execute the phases and their steps **strictly in order** — top to bottom, one at
a time — EXCEPT a step that declares a **fan-out** (flagged in the graph below):
that step dispatches its inner chain per-item with bounded concurrency, following
the **fan-out execution instructions appended to this prompt**.

For **each** step:

1. **Report the step.** As you begin the step, call \`cyboflow_report_step\` with
   the step's exact \`id\` (the backticked id shown for the step in the graph
   below). This drives the live progress timeline, so report every step — even
   the ones whose work you delegate.
2. **Do the step.** If the step names an agent, **delegate** its work to a
   subagent with the **Task tool**, using \`subagent_type: "cyboflow-<agent>"\`
   (the matching agent bundle is already installed in this worktree). Pass the
   subagent the context it needs and what to return, and **read its result**
   before you proceed. Steps marked **HUMAN GATE** you run yourself, inline (see
   below) — only this session can ask the user a question.
3. **Commit atomically.** When the step's work is complete and coherent, *you*
   (the orchestrator, the single writer) make **ONE atomic git commit** for that
   step — \`<type>: <what changed>\` with a conventional type
   (\`feat\` / \`fix\` / \`refactor\` / \`test\` / \`chore\` / \`docs\` / \`style\`) —
   staging **only** the files that step touched. One commit per completed step;
   never batch multiple steps into a single commit. (The delegated subagents are
   edit-only; the orchestrator is the committer.)

## Hard rules

- **Single writer.** Only this session calls the \`cyboflow_*\` write tools;
  subagents return results and you persist them. Never write workflow state to
  disk.
- **In order, one at a time** — except a **fan-out** step, which fans its inner
  chain out per-item with bounded concurrency per the appended fan-out execution
  instructions.
- **Optional steps.** When a step is marked **optional** and it does not apply to
  this run, **skip it** and move on.
- **On failure.** If a step fails and it defines an **on failure → loop back**
  target, loop back to that step. Honor the step's **retries** budget; after the
  retries are exhausted, record the failure via \`cyboflow_*\` and either continue
  or stop per the flow's intent.
- **Human gates.** At a step marked **HUMAN GATE**, call the **AskUserQuestion**
  tool (e.g. options **Approve** / **Revise** / **Reject**) and do **not** proceed
  until the human approves. **AskUserQuestion is the only gate mechanism** — never
  invent or call a \`cyboflow_*\` "gate" tool. \`cyboflow_report_step\` is
  observational only and never substitutes for a gate (treating a report as a gate
  would let the flow run past the gate unchecked).
- **Completion.** When every step is done, post a short summary of what the flow
  accomplished and **stop**. Do not merge — the human reviews and merges the
  session from the UI.`;

/**
 * Separator between the harness and the rendered graph in the final prompt.
 * A blank line on each side keeps the two markdown blocks visually distinct.
 */
const PROMPT_SEPARATOR = '\n\n---\n\n';

/** A step is a human gate when `human === true` OR its agent is the human gate. */
function isHumanGate(step: WorkflowStep): boolean {
  return step.human === true || step.agent === HUMAN_GATE_AGENT;
}

/**
 * Render one step as a markdown bullet line plus indented annotation lines.
 *
 * Shape (deterministic):
 *   - `<id>` — <name> → delegate to `cyboflow-<agent>`     (or → HUMAN GATE (AskUserQuestion))
 *     <desc, if present>
 *     - optional                                            (only when optional)
 *     - retries: <n>                                        (only when retries > 0)
 *     - on failure → loop back to `<loopback>`              (only when loopback set)
 *     - fans out over `<over>` …                            (only when fanOut set)
 *
 * A fan-out step gets only a ONE-LINE pointer here (id + cap + inner count) — the
 * full per-item chain / dispatch / loopback block is appended to the prompt once
 * by the adapter (`buildFanOutAppend`), so it is not duplicated per step.
 */
function renderStep(step: WorkflowStep): string {
  const action = isHumanGate(step)
    ? 'HUMAN GATE (AskUserQuestion)'
    : `delegate to \`cyboflow-${step.agent}\``;

  const lines: string[] = [`- \`${step.id}\` — ${step.name} → ${action}`];

  if (step.desc !== undefined && step.desc.length > 0) {
    lines.push(`  ${step.desc}`);
  }
  if (step.optional === true) {
    lines.push('  - optional');
  }
  if (step.retries > 0) {
    lines.push(`  - retries: ${step.retries}`);
  }
  if (step.loopback !== undefined && step.loopback.length > 0) {
    lines.push(`  - on failure → loop back to \`${step.loopback}\``);
  }
  if (step.fanOut !== undefined) {
    const cap = effectiveMaxConcurrency(step.fanOut);
    lines.push(
      `  - fans out over \`${step.fanOut.over}\` — ${step.fanOut.inner.length}-step inner ` +
        `chain, at most ${cap} concurrent (see the appended fan-out execution instructions)`,
    );
  }

  return lines.join('\n');
}

/**
 * Render a `WorkflowDefinition`'s phases + steps as readable markdown the
 * orchestrator agent can follow: a section per phase, an ordered list of steps
 * within each. Each step shows its backticked `id` (so it lines up with
 * `cyboflow_report_step`), its `name`, and either its delegation target
 * (`cyboflow-<agent>`) or `HUMAN GATE (AskUserQuestion)`, plus the
 * optional / retries / loopback annotations when present.
 *
 * Deterministic: no Date, no randomness — output depends only on `def`.
 */
export function renderWorkflowGraph(def: WorkflowDefinition): string {
  const sections = def.phases.map((phase) => {
    const heading = `## ${phase.label}`;
    const steps = phase.steps.map(renderStep).join('\n');
    return `${heading}\n\n${steps}`;
  });

  return `# Workflow graph\n\n${sections.join('\n\n')}`;
}

/**
 * Build the full custom-flow orchestrator prompt: the fixed
 * `CUSTOM_ORCHESTRATOR_HARNESS` preamble, a separator, then the rendered step
 * graph for `def`. Deterministic for a given definition.
 */
export function renderCustomFlowPrompt(def: WorkflowDefinition): string {
  return `${CUSTOM_ORCHESTRATOR_HARNESS}${PROMPT_SEPARATOR}${renderWorkflowGraph(def)}`;
}
