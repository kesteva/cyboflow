# Custom-Flow Execution Plan — stock orchestrator harness + injected graph

> **ARCHIVED — shipped.** Custom-flow execution landed on `main` (option B fixed-harness +
> injected `spec_json` graph). This document is kept for historical context only; the
> "planned, not started" framing below is no longer current.

Fixes the ship blocker on the Workflows + Agents pane: custom flows are created but cannot
execute their step graph. See `docs/archive/workflows-agents-pane-plan.md` for the feature
this completes.

## Goal

Make a custom flow (one with `workflows.workflow_path = NULL` and its definition in
`spec_json`) actually run — delegating to the agents its steps name, pausing at its
human gates, and advancing its progress timeline — **without** building a graph
interpreter and **without** touching the working built-in flows.

## Approach (chosen: option B, fixed-harness form)

The orchestrator is, and stays, a single Claude agent driven by a **prose** prompt;
the `spec_json` step graph is UI/validation metadata, not an execution driver. Rather
than compile bespoke prose per flow (a maintenance sink) or have the runner dispatch
the graph directly (option A — forks the execution model, big blast radius, can't
reproduce the built-ins anyway), we:

> Feed a **single, hand-authored, non-editable stock orchestrator harness** to the
> agent, with the flow's resolved graph **rendered and injected** as the data it
> executes. The harness supplies the orchestration *judgment* (delegation mechanism,
> single-writer invariant, gate handling, `report_step` discipline); the graph
> supplies the *structure*; the agent bridges them.

Built-ins keep their bespoke `.md` prose (`workflow_path` set). Only custom flows ride
the harness. **Bimodal at the prompt source (file vs harness+graph); unimodal at
execution (still one orchestrator agent reading prose).**

## What the preflight verified (and why the fix is small)

Three readers traced gates, `resolveWorkflowDefinition`, and the run pipeline. Result:
**the only hard blocker is one `throw`.** Everything else already tolerates a custom
flow.

1. **Human gates are workflow-origin-agnostic.** `AskUserQuestion` → SDK PreToolUse
   hook → `QuestionRouter.requestQuestion` (`questionRouter.ts:257-342`) gates on
   `workflow_runs.status` + `runId` only — never `workflow_path` or name. The harness
   gate instructions are **identical** to `planner.md:42-45/56-59`. No gate code
   changes.

2. **`resolveWorkflowDefinition(name, spec_json)` already returns the custom
   definition.** `shared/types/workflows.ts:571-579`:
   `parseWorkflowDefinition(spec_json) ?? (isCyboflowWorkflowName(name) ? WORKFLOW_DEFINITIONS[name] : null)`.
   A valid custom `spec_json` is returned **before** name is consulted. Fail-soft
   (never throws; `null` on empty/malformed). Needs only `name` + `spec_json`, both
   on the `WorkflowRow` that `getPrompt` already holds.

3. **The pipeline tolerates custom flows everywhere except `getPrompt`.**
   - **Hard blocker:** `runExecutor.ts:650-651` throws when `workflow_path` is null.
   - **Agents reach the worktree anyway:** `installWorkflowBundle` writes an empty
     bundle for a null path (`workflowBundleInstall.ts:62` → `resolveWorkflowBundle(null)`
     → `EMPTY_BUNDLE`), **but** `installAgentOverlay` (`agentOverlayWriter.ts:88`,
     P1) runs right after, is **not** gated by `workflow_path`, and writes the full
     effective agent set (all builtins verbatim + overrides + customs). So every
     `cyboflow-<key>` a custom step names is present. ✔
   - **Both substrates work — the fix is substrate-agnostic** (verified by a follow-up
     trace). `getPrompt` is the single prompt source: `execute()` computes it once
     (`runExecutor.ts:382`) and `SubstrateDispatchFacade.spawnCliProcess` forwards the
     same options unchanged to the SDK or interactive manager. `interactiveClaudeManager`
     has no independent prompt source — it delivers the string verbatim as a positional
     arg (`:808-811`). It also injects the cyboflow MCP server
     (`writeInteractiveMcpConfig`, `:521-560`; `--mcp-config` at `:485-488`) so the
     orchestrator can call `cyboflow_report_step` / `cyboflow_*`, and installs the same
     `'*'` PreToolUse gate hook (`:734-751`) routing `AskUserQuestion` →
     `QuestionRouter` → `awaiting_input`. Agents reach the PTY worktree via the same
     `installAgentOverlay` (un-gated by path). No substrate special-casing needed (see
     resolved D1).
   - **Seed-idea / sprint-batch / initial-step-id** all skip cleanly for custom flows
     (`runExecutor.ts:713,753,1001`; `stepTransitionBridge.ts:74-79` returns null →
     timeline advances on the first `report_step`).
   - **`report_step` validation works:** `stepTransitionBridge.ts:101-112` validates
     ids against `resolveWorkflowDefinition`, which returns the custom def. ✔

## Design

### Seam: generalize the prompt reader to take the row

`getPrompt` (`runExecutor.ts:646`) already has the full `WorkflowRow`. Today it passes
only `workflow.workflow_path` to the injected `WorkflowPromptReaderLike.read()`, and the
index.ts adapter looks the row back up by path. We change the seam to pass the **row**:

- **Interface** (`WorkflowPromptReaderLike` in `runExecutor.ts`): `read(workflow: WorkflowRow): WorkflowPrompt`
  (was `read(workflowPath: string)`).
- **`getPrompt`**: delete the `if (!workflow.workflow_path) throw` block; call
  `this.promptReader.read(workflow)`. Everything after `read()` (nudge / resume /
  seed-tasks / seed-idea branches) is unchanged and already skips cleanly for custom
  flows.
- **Adapter** (`index.ts:690-707`): branch on `workflow.workflow_path`:
  - **non-null (built-in / edited built-in):** current behavior — `readWorkflowPrompt(path)`
    + `buildStepReportingAppend(resolveWorkflowDefinition(name, spec_json))`. (Drop the
    now-redundant `SELECT … WHERE workflow_path = ?`; the row is passed in.)
  - **null (custom):** `def = resolveWorkflowDefinition(name, spec_json)`; if `null`,
    throw `WorkflowPromptReadError` (fail loud — a custom flow with an unresolvable
    graph must not launch silently). Else
    `prompt = renderCustomFlowPrompt(def)`, `systemPromptAppend = buildStepReportingAppend(def)`.

Rationale: keeps `runExecutor` free of fs / concrete-module imports (the adapter
pattern's whole point); reuses `buildStepReportingAppend` so custom flows get the
**same** `report_step` instructions as built-ins; removes a DB round-trip.
*(Alternative considered: add a second `readCustom(row)` method to avoid changing the
existing `read(string)` signature — rejected as it splits the seam; the single
row-typed `read` is cleaner and the test churn is small.)*

### New module: `customFlowPrompt.ts` (pure, testable)

`main/src/orchestrator/customFlowPrompt.ts` — no fs, no DB. Exports
`renderCustomFlowPrompt(def: WorkflowDefinition): string`, composed of:

1. **`CUSTOM_ORCHESTRATOR_HARNESS`** (a documented constant — the stock harness). v1
   is **not** user-editable; the future B+ step moves it to a file/DB. It instructs
   the agent to:
   - act as the orchestrator of a multi-step custom workflow;
   - **be the single writer** of cyboflow state via `cyboflow_*` MCP tools — subagents
     never write state;
   - for each agent-bearing step, **delegate** the step's work by spawning a subagent
     via the Task tool with `subagent_type: "cyboflow-<agent-key>"`, then read its
     result before proceeding;
   - **call `cyboflow_report_step` with the step's id as it begins each step** (pairs
     with the valid-id list in `systemPromptAppend`);
   - at a **human gate**, call **`AskUserQuestion`** (Approve / Revise / Reject) and
     not proceed until approved — *never* invent a `cyboflow_*` gate tool (gates fail
     open otherwise; verified content risk);
   - **skip** `optional` steps that don't apply; on failure honor a step's `loopback`
     target / `retries` budget, then continue or escalate;
   - execute phases and steps **in order** (no parallel fan-out in v1);
   - stop when all steps are done (the human reviews/merges the session).
2. **`renderWorkflowGraph(def)`** — readable markdown, one block per phase, each step
   as: `id`, name, `→ cyboflow-<agent>` (or **HUMAN GATE**), `desc`, and any
   `optional` / `loopback: <id>` / `retries: <n>` annotations. Markdown (not raw JSON)
   so the agent can follow it and the step ids line up with `report_step`.

## Implementation steps (atomic commits)

1. **`feat: render custom-flow orchestrator prompt from spec_json graph`** — add
   `customFlowPrompt.ts` (`CUSTOM_ORCHESTRATOR_HARNESS` + `renderWorkflowGraph` +
   `renderCustomFlowPrompt`) and its unit tests. Pure module; no wiring yet.
2. **`feat: execute custom flows via the stock harness at the prompt seam`** — change
   `WorkflowPromptReaderLike.read` to take `WorkflowRow`; remove the `getPrompt` throw
   and pass the row; branch the index.ts adapter (built-in path unchanged, custom path
   → `renderCustomFlowPrompt` + `buildStepReportingAppend`). Update affected mocks/tests
   (incl. the existing "throws on null path" assertions → new behavior).
3. **`test: end-to-end custom-flow getPrompt + adapter coverage`** — adapter tests
   (null path + valid spec → harness+graph; null path + null/invalid spec → throws;
   non-null path → unchanged) and a `getPrompt` test proving no-throw + pass-through of
   the post-read branches.
4. **Gate** — `pnpm rebuild better-sqlite3` → `pnpm typecheck` + `pnpm test:unit` +
   `pnpm lint` (0 errors). Then `pnpm dev` smoke (see Verification).

## Tests

- **Unit (`customFlowPrompt.test.ts`):** harness preamble present; every phase/step
  rendered with id + agent/GATE; gate steps render `AskUserQuestion`, not a tool call;
  `optional`/`loopback`/`retries` annotations emitted; deterministic output.
- **Unit (adapter / `getPrompt`):** the three branches above; reuse of
  `buildStepReportingAppend` for custom flows; post-read branches still apply.
- **Regression:** existing built-in `getPrompt` tests stay green (path unchanged).

## Verification (live smoke, `pnpm dev` + Peekaboo)

1. Duplicate `planner` → custom flow; Run it → it launches (no throw), delegates to
   `cyboflow-context`, hits the `approve-idea` gate (AskUserQuestion), and the progress
   timeline advances via `report_step`.
2. New blank flow with one custom-agent step → that custom agent is delegated to.
3. Run a custom flow on the **interactive** substrate (e.g. under the PTY lock) → it
   launches, delegates, gates, and advances its timeline the same as on SDK. Confirm
   `installAgentOverlay` writes the agent set into the PTY worktree.

## Open decisions

- **D1 — substrate. RESOLVED: no special-casing.** A follow-up trace overturned the
  preflight's "interactive is stub-only" claim. `getPrompt` is the single prompt source
  for both substrates; the interactive manager injects the cyboflow MCP server and the
  `'*'` PreToolUse gate hook (file:line in the verified-facts section). A custom flow
  runs correctly on whichever substrate resolves — SDK or interactive — so the substrate
  pin/guard is dropped.
- **D2 — orchestrator commit behavior.** Should the harness instruct the agent to
  commit per step / at the end, or leave commits to the human-merged session (built-in
  default)? Recommend: leave commits to the session (match built-ins); revisit if a
  custom flow needs per-step commits.

## Honest v1 limits

- The graph can't express conditionals, dynamic concurrency, or attempt-tracked
  re-delegation, so a custom flow won't auto-reproduce sprint's advanced behavior. It
  delivers solid **linear / gated / optional / simple-loopback** flows. Built-ins keep
  bespoke prose for the hard cases.
- The harness is **not** user-editable in v1 (constant). Future B+ moves it to a
  file/DB and exposes a prose editor for power users — at which point `spec_json` could
  gain a `body` and `getPrompt`'s null branch reads it.
- No drift risk: `spec_json` is the single source for both the timeline UI and the
  injected prompt. The fix is substrate-agnostic — works on SDK and interactive (D1).

## Risk / rollback

Low blast radius: one pure module + one seam change; built-in prompt path byte-for-byte
unchanged. Rollback = revert the two feature commits; built-ins unaffected. The seam
signature change (`read(string)` → `read(row)`) is the only interface touch; its sole
production caller is `getPrompt`.
