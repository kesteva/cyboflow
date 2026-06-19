# Agents/Workflows pane — 3 approved polish fixes (execute post-compact)

Branch `bajada-badlands` (HEAD `675cda30`, 22 commits ahead of local `main`, tree clean).
Dev app running on this build at CDP `:9223`. All three plans APPROVED by the user 2026-06-19.
Grounded by 1 dynamic workflow (`wf_10499199-2aa`) + 2 background investigation agents.

**Standing constraints:** atomic commits (one per concern, `git add <files>` not `.`, no auto-push);
`any` forbidden (eslint error); gate = `pnpm typecheck` + `pnpm test:unit` + `pnpm lint`
(run `pnpm rebuild better-sqlite3` for host ABI before vitest; dev app is on Electron ABI).
Two-substrate dispatch + the `cyboflow-<key>` name are load-bearing — do NOT change them.

---

## Plan 1 — Strip `cyboflow-` prefix from agent names (DISPLAY-ONLY, render bare `agentKey`)

Decision: `ui-strip-render-agentKey` (NOT regex replace, NOT storage/injection). `AgentEntry` already
carries bare `agentKey` next to prefixed `name` (`shared/types/agents.ts:44-56`). Backend prefix is
invariant (agentMarkdown.ts:39-44, effectiveAgents.ts:56,84, agentOverrideRouter.ts:231,304,
sprintLaneStore exact-string lane map) — leave all of it untouched.

Change list (3 render sites, frontend-only):
1. `frontend/src/components/workflows/AgentCard.tsx:45` — render `{entry.id}` instead of `{entry.name}`
   (`AgentGalleryEntry.id === entry.agentKey`, set in `workflowsStore.ts:120`). Leave the store mapping as-is.
2. `frontend/src/components/cyboflow/agents/AgentEditorModal.tsx:249` — title:
   `mode === 'create' ? 'New agent' : \`Edit agent · ${agentKey}\`` (drop `entry?.name`; `agentKey` is
   already a prop). Drop `entry?.name` from that useMemo's deps, keep `agentKey`.
3. `frontend/src/components/cyboflow/agents/AgentEditorModal.tsx:368` — duplicate default:
   `defaultValue={\`${agentKey}-copy\`}` (was `entry?.name ? \`${entry.name}-copy\` : ''`).

Do NOT touch: `workflowsStore.ts` toAgentGalleryEntry mapping, `AgentEditorForm.tsx` name `<input>`
(create-mode value is the user's plain name → flows to createCustom; stripping corrupts the write),
`useAgentEditorState.ts` draftFromEntry, or `DynamicWorkflowAgentCard.tsx` (different data path).
Caveat accepted: customs show the kebab key (`my-helper`), original casing lost (no display_name column).
Tests: update any AgentCard/AgentEditorModal test asserting the prefixed name in those 3 spots.
Commit: `fix: show agent names without the cyboflow- prefix in the gallery + editor`.

---

## Plan 2 — Custom agents missing from the workflow step "agent" picker

Root cause: the AGENT-tab `<select>` options are the static constant
`AGENT_OPTIONS = [...CANONICAL_AGENT_KEYS, HUMAN_GATE_AGENT]` (`frontend/src/components/cyboflow/workflowEditorOptions.ts:22`),
used by `WorkflowStepInspector.tsx:234-249`; it never reads the live agent list. Dispatch of a
custom-agent step ALREADY works end-to-end (spec schema `workflowDefinitionSchema.ts:45` accepts any
string; `customFlowPrompt.ts:119` renders `cyboflow-${step.agent}`; `agentOverlayWriter.ts:88-129`
writes every effective custom as `.claude/agents/cyboflow-<key>.md`). No backend/schema/overlay change.

Decision: include customs ALWAYS (simplest, harmless; only effective in custom flows since built-ins
use prose). Self-contained variant (preferred — avoids prop-drilling through 4 call sites):
1. `frontend/src/components/cyboflow/agents/...` n/a — fetch in the editor:
   `frontend/src/components/cyboflow/WorkflowEditorModal.tsx` — in the seed `useEffect` (~`:176-229`),
   add `trpc.cyboflow.agents.list.query({ projectId })` to the Promise.all; store
   `customAgentKeys = entries.filter(e => e.isCustom).map(e => e.agentKey)` in local state; pass
   `customAgentKeys` to `<WorkflowStepInspector …/>` (~`:597`).
2. `frontend/src/components/cyboflow/WorkflowStepInspector.tsx` — add `customAgentKeys?: string[]` to
   props (`:22-26`), thread into `AgentTab` (`:124-126`, `:224`); build options as
   `[...AGENT_OPTIONS, ...customAgentKeys]` (dedupe) at `:227-249`; keep the free-text fallback `:243-245`;
   the `agentInList` check `:227` must test the merged list. Optional "(custom)" suffix on custom options.

Project scoping (the one real risk): fetch by the modal's `projectId` so a chosen custom key always has
an overlay at runtime (a foreign-project custom key → no `cyboflow-<key>.md` → dispatch fails for that
step). The self-contained fetch variant gets this right by construction.
Tests: extend `WorkflowStepInspector`/editor tests to assert a custom key appears + is selectable.
Commit: `feat: offer the project's custom agents in the workflow step agent picker`.

---

## Plan 3 — Delete workflows (3A) + auto-prune phantom per-project built-ins (3B)

### 3A — Delete affordance (no delete path exists anywhere today)
Cascade hazard: `workflow_runs.workflow_id` + `workflow_revisions.workflow_id` are `ON DELETE CASCADE`
off `workflows.id` (`schema.sql:76`, `030_global_workflows.sql:33-34`) — deleting a flow-with-runs
silently destroys run + Insights history. Decision: **block delete when runs exist** (safe v1).

Change list (~4 files):
1. `main/src/orchestrator/workflowRegistry.ts` — new `deleteWorkflow(workflowId)` (~near createCustom `:430`):
   - `getById` → throw NOT_FOUND if missing.
   - throw (BAD_REQUEST-mappable) if `row.project_id === null && isCyboflowWorkflowName(row.name)`
     (global built-in — re-seeds) OR `row.name === QUICK_WORKFLOW_NAME` (`__quick__`).
   - `SELECT COUNT(*) FROM workflow_runs WHERE workflow_id=?` → throw a distinguishable
     "has run history" error (→ CONFLICT) if `> 0`.
   - else `DELETE FROM workflows WHERE id=?` in a txn (zero-run guarantee = no run cascade; the flow's
     own `workflow_revisions` may cascade — acceptable, note in dialog).
2. `main/src/orchestrator/trpc/routers/workflows.ts` — new `delete` mutation after `createCustom` (~`:192`):
   input `{ workflowId: z.string().min(1) }`, returns `{ ok: true }`; map registry errors →
   NOT_FOUND / BAD_REQUEST / CONFLICT following the `updateSpec`/`resetSpec` idiom (`:117-122`,`:142-146`).
   Check the frontend `IPCResponse`/router type parity per CLAUDE.md.
3. `frontend/src/components/workflows/WorkflowCard.tsx` — add `onDelete?: (entry) => void` to props (`:24-38`);
   add a danger `MiniButton` "Delete" (testid `workflow-card-delete-${row.id}`) after `:144`, rendered ONLY
   when deletable: `!(row.project_id === null && isCyboflowWorkflowName(row.name)) && row.name !== '__quick__'`.
4. `frontend/src/components/workflows/WorkflowsView.tsx` — `onDeleteWorkflow(entry)` handler near
   `onDuplicateWorkflow` (`:247`): open a confirm modal → `trpc.cyboflow.workflows.delete.mutate({ workflowId })`
   → `useWorkflowsStore.getState().refresh()` (`:276` pattern). Thread `onDeleteWorkflow` through
   `GalleryStacked` → `WorkflowCard` (parallel to `onDuplicateWorkflow` `:369`). Build a small local confirm
   from `components/ui/Modal` primitives — do NOT reuse `Backlog/DeleteConfirmDialog.tsx` (hard-bound to tasks).
Commit: `feat: delete workflows from the gallery (blocked when run history exists)`.

### 3B — Auto-prune phantom per-project built-ins (defensive invariant)
Root cause CONFIRMED: migration 030 ran + deleted them correctly; the reappeared rows
(`wf-{1,2,3}-{planner,sprint,compound}`, created 43 min after the global rows, `spec_json='{}'`, 0 runs)
were re-seeded by a STALE pre-`9e643648` main build sharing `~/.cyboflow/sessions.db` across worktrees.
NOT a bug in current source (no live path mints `wf-<projectId>-<name>`; `seed()` `workflowRegistry.ts:147-179`
has zero production callers). Fix = make the cleanup a continuous invariant:
1. In `WorkflowRegistry.ensureGlobalBuiltIns` (`workflowRegistry.ts:204-237`) — after upserting the globals,
   also run migration-030-step-4's prune: `DELETE FROM workflows WHERE name IN ('planner','sprint','compound')
   AND project_id IS NOT NULL AND spec_json='{}'`. Guarded exactly so edited project copies + the
   `wf-<proj>-custom-*` save-as-project-copy rows (name != built-in) are never touched. Idempotent + safe
   (targets only 0-run phantom rows; history already re-pointed to globals by mig 030 step 3).
2. One-time cleanup of the current 9 leaked rows happens automatically on next `workflows.list` once (1) lands.
Tests: extend `workflowRegistry.test.ts` — seed a phantom `wf-1-planner` (spec '{}') + an edited `wf-2-sprint`
(spec non-empty), call ensureGlobalBuiltIns, assert phantom pruned + edited preserved + globals intact.
Commit: `fix: prune re-seeded per-project built-ins on reconcile (shared-DB hardening)`.

---

## Execution order, gate, smoke
Order: Plan 2, Plan 1, Plan 3A, Plan 3B (or any order — mostly independent). NOTE file overlaps:
`WorkflowsView.tsx` (Plan 2 + 3A), `AgentEditorModal.tsx` (Plan 1 + already-touched). Do sequentially,
NOT parallel edit-agents (they'd collide). 4–5 atomic commits total.
Gate after all: `pnpm rebuild better-sqlite3` → `pnpm typecheck` → `pnpm test:unit` → `pnpm lint` (0 errors).
No new migration needed (3B reuses mig-030's prune as runtime logic).
Live smoke (Vite HMR for frontend; `pnpm build:main` + relaunch for the backend bits — registry/tRPC):
drive via Playwright-over-CDP `:9223` — (1) agent cards show bare keys; (2) custom agent appears in a
step's agent dropdown; (3) Delete button on a 0-run custom card removes it + Delete blocked/absent on
globals; (3B) the 9 phantom per-project cards are gone after a reconcile.
Push: still unauthorized — do not push.
