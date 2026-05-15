---
id: TASK-354
sprint: SPRINT-009
epic: workflow-runs-and-day3-gate
status: done
summary: "Minimal Cyboflow frontend (WorkflowPicker + RunView + CyboflowRoot) wired through cyboflowApi/IPC handlers; mounted as primary App surface with Legacy Crystal toggle"
executor_loops: 0
code_review_rounds: 1
visual_mobile: not_applicable
visual_web: skipped_unable
---

# TASK-354 Done

## Outcome

- `frontend/src/utils/cyboflowApi.ts` — typed IPC wrappers (`listWorkflows`, `startRun`, `subscribeToStreamEvents`, `approveRun`); 4 named exports + `cyboflowApi` namespace object.
- `main/src/ipc/cyboflow.ts` + registration in `main/src/ipc/index.ts` — handlers for `cyboflow:listWorkflows` (auto-seeds 5 SoloFlow workflows on first call), `cyboflow:startRun` (delegates to `RunLauncher.launch`), `cyboflow:approveRun` (NOT_IMPLEMENTED stub for epic 7). Lazy singleton constructors for `WorkflowRegistry` + `RunLauncher`.
- `frontend/src/stores/cyboflowStore.ts` — Zustand slice with `activeRunId`, `streamEvents`, `setActiveRun`, `clearActiveRun`, `appendStreamEvent`.
- `frontend/src/components/cyboflow/{WorkflowPicker,RunView,CyboflowRoot}.tsx` — picker with 5-option dropdown + Start Run button; run view with subscription + "No active run" placeholder; root layout combining the two.
- `frontend/src/App.tsx` — mounts `<CyboflowRoot projectId={...} />` as primary surface when a project is active and the "Legacy Crystal view" toggle is off (default). `localStorage` key migration handled via `migrateLocalStorageKey` helper.
- `tests/cyboflow-picker.spec.ts` — Playwright smoke covering picker presence + 5 workflow options + Start Run + RunView placeholder.
- `main/src/ipc/__tests__/cyboflow.test.ts` — 10 vitest cases covering IPC layer (auto-seed, listWorkflows, startRun happy path).

Code-review round 1 fixed two undefined Tailwind tokens (`bg-accent`, `border-border`) that would have left the CTA and dividers invisible — swapped to the project's canonical `bg-interactive`/`border-border-primary` set.

## Verification

- Vitest: 219/219 across 22 files (10 new IPC tests + 1 new Playwright test).
- Typecheck: clean across `frontend`, `main`, `shared`.
- Lint: 0 errors; pre-existing warnings unchanged.
- Visual: `visual_web: skipped_unable` — Electron renderer dev server (http://localhost:4521) was not running; entry queued in `human-review-queue.md` for human re-verification with `pnpm dev` + `pnpm test`.

## Deferred

- Visual_web verification (medium severity, queued in review-queue) — human runs `pnpm dev` + `pnpm test` to exercise the picker/CTA/dividers visually.
- FIND-SPRINT-009-6 (high) — `main/src/preload.ts` whitelist drops `cyboflow:stream:*`; `subscribeToStreamEvents` is dead-on-arrival until preload allows the channel.
- FIND-SPRINT-009-7 (low) — `makeLoggerLike` drops the structured `context` argument when forwarding to the project Logger.
- FIND-SPRINT-009-3 still open — silent skip in `RunLauncher.launch` when MCP collaborators are undefined; epic-6 wiring task should require them.
- AC7 store unit test deferred — frontend workspace has no vitest runner; adding one is tooling setup that doesn't fit the test-writer guardrails. Backlog candidate.
- 3 Minor code-review notes accepted at retry cap (scroll behavior, named-vs-namespace export duplication, store-clear semantics note).
