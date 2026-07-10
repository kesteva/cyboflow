# Parallel Step UI Treatment Proposal

> **SUPERSEDED.** This proposal's two core assumptions — "orchestrated runs
> ignore `step.fanOut`" and "concurrency is shown as the fixed system cap, not
> an editable value" — were overturned by the fanOut consolidation: `fanOut`
> (plus the new `maxConcurrency` field) is now the single source of truth for
> stage parallelism on BOTH the programmatic and orchestrated planes. See
> `shared/types/workflows.ts` (`FanOutSpec`, `effectiveMaxConcurrency`) for the
> current contract. Left below for historical context; do not treat the
> "programmatic/batch-only" framing or the read-only-concurrency framing as
> current.

> Draft for review. This revision incorporates Claude review feedback: the UI
> must reflect the real `WorkflowStep.fanOut` contract, not the prototype's
> fictional stage-level/full-step model.

## Summary

Implement the selected 1a "container lane-band" treatment in the workflow
editor only, but bind it honestly to the current data model:

- Parallelism remains `WorkflowStep.fanOut`.
- The repeated inner chain remains `FanOutInnerStep[]`.
- Inner rows expose only fields that exist today.
- Concurrency is shown as the fixed system cap, not an editable value.
- Fan-out is labeled as programmatic/batch-only because orchestrated runs ignore
  `step.fanOut`.

Do not ship workflow-local agent override editing in this pass. The current
runtime override mechanisms are keyed by `agentKey`, while the design asks for
per-step overrides. Persisting step-keyed override data in `spec_json` without
runtime consumption would create dead configuration.

## Decisions

- **Inner-row inspector scope:** down-scope to the persisted
  `FanOutInnerStep` shape: `id`, `name`, `agent`, `optional`, and `loopback`.
  Do not show model, retries, MCP, or human-checkpoint controls for inner rows.
- **Agent overrides:** defer. A follow-up must decide whether overrides are
  per-step or per-agent and wire runtime consumption before presenting the UI as
  live.
- **Model vocabulary for any future override:** use `AgentModelAlias | null`
  from `shared/types/agents.ts`; `null` means inherit. Do not use prototype
  tokens like `opus-4.5`, `sonnet-4.5`, or `custom`.
- **Concurrency and loop cap:** do not persist or render editable controls.
  Display `system cap ${SPRINT_BATCH_CAP}` from `SPRINT_BATCH_CAP` as read-only.
  Do not show a loop-cap control; the current programmatic fan-out controller
  does not re-drive lane loopbacks.
- **Item source:** replace the free-text `over` input with a constrained picker.
  V1 only offers `tasks`.
- **Plane awareness:** the editor must not imply fan-out is universally live.
  Show copy such as `Programmatic batch runs only; orchestrated runs execute this
  step once.`

## Non-goals

- No runtime execution changes.
- No live run visualization changes.
- No stage-level `parallel` or `fanOut` fields.
- No extension of `FanOutInnerStep` in this pass.
- No workflow-local agent override UI in this pass.
- No per-step concurrency or loop-cap persistence.

## UI Changes

In `WorkflowEditorCanvas`, detect `step.fanOut !== undefined` and render the
owning step as a first-class fan-out template using the 1a visual language:

- Rust dashed fan-out frame around the owning step.
- Header chip/button bound to the existing `SET_STEP_FANOUT` reducer action.
- Meta bar:
  - `over tasks`
  - `system cap ${SPRINT_BATCH_CAP}`
  - `<fanOut.inner.length> inner`
  - `programmatic batch only`
- Multiplex shadow behind the inner-card stack.
- Rust head bars for inner cards while fan-out is enabled.
- Black head bars for normal sequential step cards.
- Selection outline consistent with the existing editor.

Inner cards represent `fanOut.inner` rows, not full `WorkflowStep` instances.
Selecting an inner card should switch the inspector into an inner-row editing
context, not reuse the normal step inspector.

In `WorkflowStepInspector`, replace the current low-fidelity fan-out section
with a 1a-style fan-out panel:

- Master switch bound to `step.fanOut`.
- Off state: explain that the step runs once unless fan-out is enabled.
- On state:
  - `over` select with only `tasks` for v1.
  - Read-only `system cap ${SPRINT_BATCH_CAP}`.
  - Runtime note that fan-out applies only when the programmatic host has a
    fan-out driver, currently batch-backed.
  - Inner-chain editor for `fanOut.inner`.

For an inner-row selection, show only persisted controls:

- Name.
- Id.
- Agent picker/free representation matching the current agent field behavior.
- Optional toggle.
- Loopback picker constrained to other inner rows in the same `fanOut.inner`
  chain, annotated as `reserved - not yet executed for lanes`.

Keep the outer-step `STEP / AGENT / MCP` tabs for normal `WorkflowStep` edits.
The inner-row inspector may reuse the same rail, but it must not expose controls
without a persistence target.

## Future Work: Real Full-Control Inner Steps

If the product still wants the prototype's promise that each inner row is a full
step, that requires a separate persisted-shape and runtime change:

- Extend `FanOutInnerStep` with the missing fields, likely `model`, `mcps`,
  `retries`, and `human`.
- Extend `fanOutSchema`.
- Update the programmatic fan-out controller and lane driver to consume those
  fields.
- Migrate or default existing `fanOut.inner` rows.
- Add tests proving inner controls persist and execute.

This should not be smuggled into a visual-only editor treatment.

## Future Work: Workflow-Local Agent Overrides

Do not add `WorkflowDefinition.agentOverrides` in this pass.

Existing override surfaces are:

- `agent_overrides`: per-project, keyed by `agent_key`.
- `workflow_variants.agent_overrides_json`: per-variant, keyed by `agentKey`.

A workflow-local override proposal needs an explicit product decision before
implementation:

- Per-step keying, e.g. `<stepId>` or `<outerStepId>/<innerId>`, gives each
  binding an independent fork but requires new runtime overlay plumbing.
- Per-agent keying reuses the variant-style shape but means all uses of an agent
  in a workflow share the override.

Any future override model field must use `AgentModelAlias | null` and avoid a
new type name that collides with `AgentOverrideRow` or
`WorkflowVariantAgentOverrides`.

The editor must not show a live "Customize for this workflow" affordance until
the saved override is actually applied to runs. If a preview-only UI is desired,
it must be labeled as preview/not applied.

## Testing

Update `frontend/src/components/cyboflow/__tests__/WorkflowEditorModal.test.tsx`
and focused reducer/schema tests as needed.

Required coverage:

- Header "Make parallel" enables `step.fanOut`.
- Inspector fan-out switch and header chip stay in sync.
- Fan-out meta bar uses `over`, inner count, fixed system cap, and
  programmatic-only copy.
- `over` is constrained to the recognized `tasks` source.
- Inner-row edits still save through `fanOut.inner`.
- Disabling fan-out still removes `step.fanOut`.
- Inner-row inspector does not expose model, retries, MCP, human-checkpoint, or
  other controls with no persistence target.
- Inner-row loopback, if shown, is annotated as reserved/not yet executed for
  lanes.
- Existing schema round-trips the unchanged `FanOutInnerStep` shape.

Verifier gate: `pnpm test:unit`.

## Assumptions

- This is an editor-only visual treatment over existing `WorkflowStep.fanOut`.
- Orchestrated-plane fan-out remains inert and must be disclosed in the editor.
- Runtime fan-out continues to require the programmatic host fan-out driver and
  a resolved item set.
- `SPRINT_BATCH_CAP` remains the only concurrency source and should be imported
  for display rather than duplicated as a literal.
- Workflow-local agent overrides are deferred until runtime semantics are
  designed and implemented.
