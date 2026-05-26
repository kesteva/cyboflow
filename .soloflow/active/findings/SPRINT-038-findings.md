---
sprint: SPRINT-038
pending_count: 3
last_updated: "2026-05-25T21:40:00.000Z"
---
# Findings Queue

## FIND-SPRINT-038-1
- **type:** claude-md
- **severity:** low
- **source:** TASK-752 (verifier)
- **status:** open
- **description:** Peekaboo MCP visual_macos verification could not run: pnpm dev parent processes (concurrently + electron-dev) were alive but no Electron renderer window was present (no Electron/Cyboflow process in `ps`, no window in Peekaboo `list`). docs/VISUAL-VERIFICATION-SETUP.md describes Peekaboo+permissions but does not document the operator-level check that the Electron window is actually open before a verifier spawn. Consider adding a pre-flight note: `if visual_macos=true, confirm an Electron renderer process is running (e.g. `pgrep -lf "electron ."`) — concurrently parent alone is not sufficient`.
- **suggested_action:** Add an operator-check note to docs/VISUAL-VERIFICATION-SETUP.md describing how to confirm the Electron renderer window is open before running the verifier.
- **resolved_by:**

## FIND-SPRINT-038-2
- **source:** TASK-752 (code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** frontend/src/hooks/useQuickSession.ts:39-84
- **description:** The `useCallback` deps array `[opts.projectId, opts.onSuccess]` deliberately excludes `isStarting` with an `eslint-disable-next-line react-hooks/exhaustive-deps`. The justification comment ("setIsStarting is synchronous within the render cycle") is incorrect — `setState` schedules a re-render asynchronously, so the memoized callback's closure captures whatever `isStarting` was at first render and the in-hook guard `if (… || isStarting !== null) return;` cannot fire on a second invocation that happens between the first invocation's `setIsStarting('claude')` and the next render. Today this has zero practical impact because both consumers gate via UI-level `disabled` (`WorkflowPicker.tsx:121,129`) or unmount the buttons immediately on click (`CyboflowRoot.tsx:116,123` dismiss the picker before `start` runs). But the in-hook re-entry guard is effectively dead code, and if a future caller forgets the UI guard the hook will silently double-create sessions. Either (a) move the in-flight flag to a `useRef` so the closure sees current values, or (b) add `isStarting` to the deps and drop the `eslint-disable` — both make the in-hook guard real and let the misleading comment go away.
- **suggested_action:** Replace the `useState`-based `isStarting` flag inside the closure check with a `useRef<'claude' | 'none' | null>` (keeping the `useState` only for the React-rendered return value), OR add `isStarting` to the deps array and remove the `eslint-disable` + the incorrect justification comment.
- **resolved_by:**

## FIND-SPRINT-038-3
- **source:** TASK-753 (code-reviewer)
- **type:** anti-pattern
- **severity:** medium
- **status:** open
- **location:** main/src/types/session.ts:59-78 vs frontend/src/types/session.ts:126-145
- **description:** TASK-753 closed the `quickSession` / `branchName` parity gap from FIND-SPRINT-037-5, but a `diff` of the two `CreateSessionRequest` declarations still surfaces two pre-existing field-set divergences of the same class: (1) `isMainRepo?: boolean` is declared only on the frontend side and (2) `model?: string` is declared only on the main side. Both predate TASK-753 and were out of scope for the plan, but each is exactly the silent-drop pattern documented in CLAUDE.md's "IPC request-shape parity" rule — a field one side reads or sends that the twin does not declare. `model` on `CreateSessionRequest` is especially suspect because the request also carries a nested `claudeConfig.model` (declared on both sides), so a top-level `model` set only on the main type may be either dead or shadow the nested one; needs an ipc/session.ts handler audit to classify. `isMainRepo` on the frontend declaration may be dead, or may be a real send-side field the main handler ignores.
- **suggested_action:** Grep `main/src/ipc/session.ts` (and any other CreateSessionRequest consumer) for `request.model` and `request.isMainRepo` reads. For each field: if read on the server but missing from the frontend declaration (or vice-versa), add it to the twin; if neither side reads it, delete it. Resolve both gaps in a single follow-up task and consider whether the next IPC touch should finally promote `CreateSessionRequest` to `shared/types/ipc.ts` per the sync-warning comment.
- **resolved_by:**
