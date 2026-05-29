---
id: TASK-803
idea: IDEA-029
status: ready
created: 2026-05-29T00:00:00Z
source: IDEA-029
epic: mcp-runtime-step-tracking
files_owned:
  - main/src/orchestrator/prompts/planner-step-reporting.md
  - main/src/orchestrator/prompts/sprint-step-reporting.md
  - main/src/orchestrator/prompts/step-reporting-instructions.ts
  - main/src/orchestrator/prompts/__tests__/step-reporting-instructions.test.ts
  - main/src/index.ts
files_readonly:
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/workflowPromptReader.ts
  - shared/types/workflows.ts
  - main/src/orchestrator/stepTransitionBridge.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
acceptance_criteria:
  - criterion: "step-reporting-instructions.ts exports a pure generator that derives the step-reporting append text for a workflow name from WORKFLOW_DEFINITIONS step ids — no hardcoded step-id string literals duplicated from the definitions."
    verification: "grep -n 'WORKFLOW_DEFINITIONS' main/src/orchestrator/prompts/step-reporting-instructions.ts returns >=1 match; grep -nE \"'context'.*'research'.*'approve-idea'\" main/src/orchestrator/prompts/step-reporting-instructions.ts returns 0 matches (no inline id-list literal)."
  - criterion: "The generator returns text that names cyboflow_report_step and instructs the MAIN session to call it at each phase boundary with the flat step ids for the given workflow, in WORKFLOW_DEFINITIONS order."
    verification: "Unit test: buildStepReportingAppend('planner') contains 'cyboflow_report_step' and the substrings 'context','research','approve-idea','epics','tasks','approve-plan' in order; buildStepReportingAppend('sprint') contains 'implement' … 'human-review' in order."
  - criterion: "Every step id emitted by the generator for a workflow exists in WORKFLOW_DEFINITIONS[name] flat steps (no drift)."
    verification: "Unit test iterates SOLOFLOW_WORKFLOW_NAMES; for each, every step id the generator references is asserted ∈ the flat step ids of WORKFLOW_DEFINITIONS[name]."
  - criterion: "Unknown / non-SoloFlow workflow names produce empty append text (fail-soft, no throw)."
    verification: "Unit test: buildStepReportingAppend('not-a-workflow') returns '' and does not throw."
  - criterion: "planner-step-reporting.md and sprint-step-reporting.md exist as cyboflow-owned role/instruction assets that are ADAPTED (minimal, in-repo), not verbatim plugin copies, and each documents the v1 subagent limitation."
    verification: "test -f on both paths; grep -in 'cyboflow_report_step' on both returns >=1 match; grep -in 'subagent' on both returns >=1 match."
  - criterion: "The injected append text reaches a live run: the index.ts promptReader adapter concatenates buildStepReportingAppend(workflow.name) onto the systemPromptAppend it returns."
    verification: "grep -n 'buildStepReportingAppend' main/src/index.ts shows it called in the promptReader adapter and concatenated into the returned systemPromptAppend; pnpm typecheck passes."
  - criterion: "runExecutor.ts is unchanged by this task."
    verification: "git diff --stat main/src/orchestrator/runExecutor.ts shows 0 changed lines after the task."
  - criterion: "pnpm test:unit passes."
    verification: "Run pnpm test:unit; exit code 0."
depends_on: [TASK-799, TASK-800, TASK-802]
estimated_complexity: medium
test_strategy:
  needed: true
  justification: "step-reporting-instructions.ts is a pure generator with a cross-layer contract (its step ids MUST match WORKFLOW_DEFINITIONS). The generator's unit behavior (ordered ids, fail-soft empty for unknown names) is specified here; the broader prompt↔definition parity gate is TASK-804. No sibling test files exist under main/src/orchestrator/prompts/ (new directory)."
  targets:
    - behavior: "buildStepReportingAppend returns ordered, WORKFLOW_DEFINITIONS-derived step ids and the cyboflow_report_step instruction for 'planner' and 'sprint'."
      test_file: "main/src/orchestrator/prompts/__tests__/step-reporting-instructions.test.ts"
      type: unit
    - behavior: "Unknown workflow name returns '' (fail-soft, no throw)."
      test_file: "main/src/orchestrator/prompts/__tests__/step-reporting-instructions.test.ts"
      type: unit
---

# Own planner/sprint agent prompt assets natively + inject step-reporting instructions

## Objective

Bring the planner and sprint agent role text and per-phase step ids into cyboflow-owned, version-controlled prompt assets under `main/src/orchestrator/prompts/`, removing the dependency on the external SoloFlow plugin. Provide a pure generator (`step-reporting-instructions.ts`) that derives, from `WORKFLOW_DEFINITIONS`, the system-prompt append text instructing the MAIN orchestrating session to call `cyboflow_report_step` at each phase boundary with valid step ids. Wire the generator into the existing per-run `systemPromptAppend` seam at the `index.ts` `promptReader` adapter boundary — WITHOUT modifying `runExecutor.ts` (read-only for this task).

## Ownership note (escalation resolved)

The TASK-803 refinement surfaced that driving the generator end-to-end needs a one-line change to the `index.ts` `promptReader` adapter (it does not currently receive the workflow name), but `index.ts` is also edited by TASK-799 and `runExecutor.ts` is read-only. RESOLUTION: this task takes shared ownership of `main/src/index.ts` and `depends_on: [TASK-799]`, so the two tasks' index.ts edits are strictly sequenced (TASK-803 runs after TASK-799) and never concurrent. Do NOT modify `runExecutor.ts` — the append text rides the existing `pendingSystemPromptAppend` → `buildOptionsOverrides` → `composeSystemPromptAppend` chain unchanged.

## Implementation Steps

1. **Create `main/src/orchestrator/prompts/step-reporting-instructions.ts`** (new). Import `WORKFLOW_DEFINITIONS`, `SOLOFLOW_WORKFLOW_NAMES`, `SoloFlowWorkflowName` from `../../../../shared/types/workflows` (verify relative depth). Export:
   - A helper that flattens `WORKFLOW_DEFINITIONS[name].phases[].steps[].id` into an ordered `string[]`. Do NOT hardcode the id list.
   - `export function buildStepReportingAppend(workflowName: string): string`. If `workflowName` not in `SOLOFLOW_WORKFLOW_NAMES`, return `''` (fail-soft, mirrors `resolveInitialStepId`'s null branch). Otherwise build a short append block that: names `cyboflow_report_step`; states it is OBSERVATIONAL; instructs the MAIN session to call it with `step_id` set to each id, in order, as that phase begins; embeds the ordered ids derived from `WORKFLOW_DEFINITIONS`; includes the v1 subagent-limit note (Agent-tool sub-sessions don't inherit `mcpServers`, so only the main session can report). No `any`.

2. **Create `main/src/orchestrator/prompts/planner-step-reporting.md`** (new): a concise, cyboflow-owned, ADAPTED planner role/instruction asset (not a verbatim plugin copy). Cover the planner phase sequence (context → research → approve-idea → epics → tasks → approve-plan), the `cyboflow_report_step` instruction, and the v1 subagent limitation.

3. **Create `main/src/orchestrator/prompts/sprint-step-reporting.md`** (new): the ADAPTED sprint equivalent covering the sprint flat steps (implement → write-tests → code-review → task-verify → visual-verify → sprint-verify → sprint-review → human-review), the `cyboflow_report_step` instruction, and the v1 note.

4. **Wire into the `index.ts` promptReader adapter (~lines 567-569).** Make `promptReader.read(...)` resolve the workflow name and concatenate `buildStepReportingAppend(name)` onto the `systemPromptAppend` it returns, so `RunExecutor.getPrompt` stashes it into `pendingSystemPromptAppend` and `buildOptionsOverrides` (runExecutor.ts:423-429) forwards it through `ClaudeSpawnerOptions.systemPromptAppend` → `composeSystemPromptAppend` (claudeCodeManager.ts:478-485). If the adapter signature does not currently carry the workflow name, add the minimal change at the adapter (in index.ts) to obtain it — do NOT touch runExecutor.ts. Guard with the fail-soft empty-string contract so non-SoloFlow workflows inject nothing.

5. **Create `main/src/orchestrator/prompts/__tests__/step-reporting-instructions.test.ts`**: cover the generator's ordered-ids output for `planner`/`sprint` and the fail-soft empty string for an unknown name. (The broader prompt↔WORKFLOW_DEFINITIONS parity gate is TASK-804.)

6. Run `pnpm test:unit` (exit 0) and `pnpm typecheck`. Confirm `git diff --stat main/src/orchestrator/runExecutor.ts` shows 0 lines.

## Acceptance Criteria notes

- "no hardcoded step-id literals" means the generator reads ids from `WORKFLOW_DEFINITIONS`, not a copy-pasted array — the point of the in-repo parity contract (slice 6).
- `runExecutor.ts` must stay unchanged — the append text rides the existing forwarding chain.
- Fail-soft empty-string for unknown names mirrors `resolveInitialStepId` returning `null` so the wiring never injects garbage for non-SoloFlow workflows.

## Out of Scope

- Modifying `runExecutor.ts` (read-only — the forwarding chain already exists).
- Per-subagent step reporting (v1 limit — main session only; documented in the assets).
- The `cyboflow_report_step` tool/handler (TASK-802) and the run-id binding (TASK-800) — depended upon, not implemented here.
- Adding `failed`/`skipped` step states (deferred open question).
- The parity test + frontend forward-jump test (TASK-804).
