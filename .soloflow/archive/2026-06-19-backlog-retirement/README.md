# SoloFlow backlog retirement — 2026-06-19

The cyboflow app advanced substantially via direct development that was **not** tracked
in this SoloFlow dev-plugin backlog. An audit cross-checked every active backlog item
against the live codebase (not the stale `status:` fields or the 2026-05-29 checkpoint)
and found the backlog ~95% obsolete: implemented, or superseded by reworks the backlog
never recorded (the `review_items` inbox replacing the old ApprovalRouter, the tRPC
transport cutover, the dual-substrate seam).

This folder preserves the retired content (ideas / plans / findings / research /
roadmaps / human-review-queue). Nothing was deleted; everything is recoverable here.
The sprint execution history (`.soloflow/active/sprints/`, 43 sprints) was **left in
place** — it is a historical record, not backlog.

## What was acted on before retiring (committed to `main`)

The audit surfaced a small set of items that were still live and worth fixing. These
were implemented via sub-agents and landed as atomic commits:

- **Tier 1 — `console-message` handler broken on Electron 37** (`main/src/index.ts`).
  Used the legacy positional signature; on Electron 37 the args were `undefined`, so the
  first renderer log threw and silently disabled `cyboflow-frontend-debug.log` capture.
  Fixed to the event-object signature. *(was FIND-SPRINT-016-10)*
- **Tier 2a — TASK-755**: pruned dead `model` / `isMainRepo` from the dual-declared
  `CreateSessionRequest` (a live instance of the IPC request-shape-parity dead-field
  hazard, FIND-SPRINT-037-5).
- **Tier 2b — FIND-SPRINT-016-3**: removed the never-populated top-level `runId` from the
  `StreamEvent` envelope type (plus the runtime-dead `e.runId` filter that read it).
- **Tier 2c — TASK-692** (legacy Crystal DB tables): **audit-only, no change**. All four
  candidate tables (`session_outputs`, `conversation_messages`, `prompt_markers`,
  `execution_diffs`) are still referenced by live code — dropping nothing was the correct,
  safe outcome. They are NOT orphaned.

## Preserved as future ideas (archived here, not promoted)

These are genuinely un-built and may be worth re-filing into the app's own backlog later:

- **IDEA-015 — Multi-provider support (OpenAI Codex)**. The only unbuilt feature idea;
  the intended payoff of the deliberately-preserved `AbstractCliManager` extension point.
  Its open questions (billing, tool-use protocol, gating, auth) need a fresh research pass.
- **IDEA-009 — Review-queue UX details**: keyboard nav (j/k navigate, y/n decide) and
  collapse-repeated-approvals. The queue shell shipped; these two fatigue-reduction
  behaviors were never built into the `review_items` rebuild.

## Everything else

Verified shipped or obsoleted — see the per-item audit in the conversation that produced
this retirement. Safe to ignore unless resurrecting a specific idea.
