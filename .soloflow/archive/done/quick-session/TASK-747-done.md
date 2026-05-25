---
id: TASK-747
sprint: SPRINT-037
epic: quick-session
status: done
summary: "Added Quick Chat / Quick Terminal buttons to WorkflowPicker with IPC → setActiveQuickSession → panelApi.createPanel flow; 7 component tests cover all ACs."
executor_loops: 0
code_review_rounds: 0
visual_mobile: not_applicable
visual_web: not_applicable
---

# TASK-747 — Quick Chat / Quick Terminal buttons

## What changed

- `frontend/src/components/cyboflow/WorkflowPicker.tsx` — added two buttons (Quick Chat → `toolType: 'claude'`, Quick Terminal → `toolType: 'none'`) below the existing Start Run button. New `handleQuickStart(toolType)` async handler: validates re-entry against `isQuickStarting` + `isStarting`, calls `window.electronAPI.sessions.createQuick({ prompt: '', projectId, toolType })`, on success creates a Claude or Terminal panel via `panelApi.createPanel`, calls `useCyboflowStore.getState().setActiveQuickSession(sessionId)`, fires `onWorkflowStarted(sessionId)`. Error path surfaces in the existing `role="alert"` red banner without navigating or creating panels.
- `frontend/src/components/cyboflow/__tests__/WorkflowPicker.test.tsx` — new file with 7 component tests covering button rendering, IPC invocation shape for both toolTypes, store + onWorkflowStarted side-effects, panel creation, in-flight disabled state, and error-path short-circuiting.

## Plan deviation

The plan's `TODO(TASK-745)` comment was obsolete by the time this task ran — TASK-745 has shipped `setActiveQuickSession`, so the handler uses it directly (rather than the plan's interim `setActiveRun(sessionId)`). The store-side atomic mutual-exclusion (`setActiveQuickSession` clears `activeRunId`; tears down stream subscription) is preserved.

## Verification

- L1 grep ACs: 7/7 met. `grep -nE 'Quick (Chat|Terminal)' WorkflowPicker.tsx` returns 4 matches; `grep -nE 'interface IPCResponse|as unknown as'` returns 0.
- L2 tests: 335/335 frontend tests pass (7 new + 5 sibling CyboflowRoot regressions, no regressions).
- L2 typecheck: `pnpm --filter frontend typecheck` exits 0.
- L3 visual: not_applicable / skipped — Vite renderer cannot bootstrap without Electron preload (`visual_web` non-functional per project CLAUDE.md); sprint did not start `pnpm dev` so Peekaboo capture (`visual_macos`) was unavailable. Component tests fully exercise rendering, click, IPC dispatch, disabled state, and error-path branches at unit level.

## Code review

CLEAN — no findings. Reviewer confirmed:
- `prompt: ''` is required by `CreateSessionRequest`'s mandatory `prompt: string` field; safe sentinel for both toolTypes.
- handler error path correctly short-circuits before any side effect.
- `panelApi.createPanel` payloads conform to `CreatePanelRequest`.
- Mutual-exclusion store invariant honored via `setActiveQuickSession`.
- Single test-stub `as any` is gated by a targeted eslint-disable with justification.
