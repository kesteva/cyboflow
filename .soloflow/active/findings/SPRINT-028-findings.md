---
sprint: SPRINT-028
pending_count: 4
last_updated: 2026-05-21T00:00:00Z
---

# Findings Queue

- SPRINT-028 started with missing infra: playwright, peekaboo; tests deferred. Sprint-initiator infra_check reports "shadow agents stale" but Step 0.45 shadow-agents.js --mode check returned drifted:false (recorded_version 0.11.0 across all four). Probe disagreement looks like a SoloFlow inconsistency between scripts/sprint/initiator infra probe and scripts/init/shadow-agents.js drift check — worth investigating during /compound (FIND-SPRINT-028-1).

## FIND-SPRINT-028-2
- **source:** TASK-685 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/app.ts:28-33
- **description:** The `track-welcome-dismissed` IPC handler retains an inline comment "Our Discord popup logic handles this differently" — this comment is now stale after TASK-685 removed all Discord popup plumbing. Additionally, grep confirms the `track-welcome-dismissed` channel has no callers anywhere in `main/src/` or `frontend/src/`, so the handler itself appears to be dead code from the Crystal baseline. Out of scope for TASK-685's diff but adjacent to it.
- **suggested_action:** Either delete the `track-welcome-dismissed` handler entirely (verify no remaining callers in the renderer-facing surface) or, if intentionally preserved as a compatibility surface, refresh the comment to remove the stale Discord reference and explain what's actually being preserved.
- **resolved_by:**

## FIND-SPRINT-028-3
- **source:** TASK-685 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/ipc/app.ts:46-54 + main/src/database/database.ts:2834-2849
- **description:** After TASK-685, `app:record-open` and `app:get-last-open` IPC handlers (and the matching `recordAppOpen` / `getLastAppOpen` / `getLastAppVersion` database methods) have no preload-typed surface and zero frontend callers — grep across `frontend/src/` and `main/src/preload.ts` finds nothing. The only live caller is the internal `databaseService.recordAppOpen(false, currentVersion)` from `main/src/index.ts:741`. The IPC channels themselves are dead. Discovered while verifying signature-narrow propagation; out of TASK-685 scope but worth a follow-up.
- **suggested_action:** Consider deleting the two IPC handlers in `main/src/ipc/app.ts` and inlining `recordAppOpen` as a private DB call from `index.ts` (or keeping the DB methods and dropping just the IPC handlers). If retained for future analytics/diagnostics, document the rationale in `docs/ARCHITECTURE.md` so the next review pass doesn't flag it again.
- **resolved_by:**

## FIND-SPRINT-028-4
- **source:** TASK-686 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** docs/SHELL-LAYOUT.md:33
- **description:** The new `docs/SHELL-LAYOUT.md` "Cross-references" section lists "Current mount site: `frontend/src/App.tsx` lines 374-432." This line range was lifted verbatim from the TASK-686 plan, which captured App.tsx layout *before* TASK-684 (DiscordPopup removal) and TASK-685 (Discord IPC removal) deleted ~57 lines earlier in the same sprint. The actual three-column mount site post-50f33d7 lives at `frontend/src/App.tsx` lines 317-375 (the `<div className="flex flex-1 overflow-hidden">` containing `ReviewQueueView` → `Sidebar` → `CyboflowRoot|SessionView`). The doc still satisfies every TASK-686 acceptance criterion (none required accurate line numbers), but the stale pointer will mislead the next reader.
- **suggested_action:** Update line 33 of `docs/SHELL-LAYOUT.md` to read "Current mount site: `frontend/src/App.tsx` lines 317-375." Or rewrite it without absolute line numbers — e.g. "Current mount site: the `<div className=\"flex flex-1 overflow-hidden\">` block in `frontend/src/App.tsx`, annotated with a `docs/SHELL-LAYOUT.md` comment." The latter survives future churn better than absolute line numbers.
- **resolved_by:**
