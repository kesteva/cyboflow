---
id: TASK-731
sprint: SPRINT-033
epic: standalone-terminal-panels
status: done
summary: "Extract usePanelSurface hook from CyboflowRoot and ProjectView"
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-731 — Done

Eliminated the ~90-line panel-surface duplication between `frontend/src/components/cyboflow/CyboflowRoot.tsx` and `frontend/src/components/ProjectView.tsx` flagged by FIND-SPRINT-032-3.

New hook `frontend/src/hooks/usePanelSurface.ts` owns: main-repo session resolution, load-panels + auto-create-permanent-panels effect (flag-gated), `onPanelCreated` subscription, `useSessionStore.subscribe` sync block (load-bearing — `useIPCEvents.updateSession` mutates the main-repo session row mid-session), and the flag-gated `handlePanelClose` with the permanence guard + dashboard-fallback.

`CyboflowRoot.tsx` calls the hook with `autoCreatePermanentPanels: false` (run-centric shell — no auto-create, every panel closable). `ProjectView.tsx` calls it with `autoCreatePermanentPanels: true` (project-shell — dashboard + setup-tasks auto-create with permanence guard).

Code-review correction: removed a redundant `setActiveSession` call from a `ProjectView` effect introduced during the extraction. The hook already owns activation; ProjectView's effect now only flips `setIsLoadingSession(false)`. Without the fix, every IPC-driven main-repo session update re-fired through `sessionStore.activeMainRepoSession`, causing extraneous re-renders.

Test coverage: 16 tests in `usePanelSurface.test.tsx` covering criteria (a)–(e) from the plan + 3 sessionStore-subscribe behaviors (subscriber update, non-matching-id no-op, unmount cleanup). Existing `CyboflowRoot.test.tsx` stays green untouched.

Deferred: manual visual verification (`pnpm dev` confirming dashboard + setup-tasks tabs auto-create and are unclosable in ProjectView, while every tab is closable in CyboflowRoot) — already queued on `human-review-queue.md` from the first verification cycle.

Closes FIND-SPRINT-032-3.

Commits:
- 4739021 feat: add usePanelSurface hook
- 8744477 test: add usePanelSurface unit tests
- 2e805b3 refactor: migrate CyboflowRoot onto usePanelSurface
- 96c6ac8 refactor: migrate ProjectView onto usePanelSurface
- b55d5ad fix: remove redundant setActiveSession call from ProjectView
- c74a815 test: cover useSessionStore.subscribe block in usePanelSurface
