# Live Testing Checklist — 2026-05-22

`pnpm dev` is running (Vite at http://localhost:4521, Electron CDP on port 9223). Mark items as you go and add notes inline. Bring this file back when you're done — I'll convert PASS / FAIL into review-queue resolutions and refine FAILs into backlog tasks.

**Legend:** `[ ]` = not yet · `[x]` = PASS · `[F]` = FAIL (add a note) · `[~]` = partial / blocked · `[s]` = skipped (note why) · `[V]` = verified in code (sprint shipped — retest visually to promote to `[x]`)

---

## Update 2026-05-22 14:31 — post-SPRINT-032 relaunch

The dev server was restarted after merge `13c8b9d` (SPRINT-032 → main). `pnpm electron:rebuild` ran to fix a stale better-sqlite3 ABI from the previous Node version. Two changes landed that touch this checklist:

- **TASK-729 — `signature_delta` / `thinking_delta` accepted by `streamEventSchema`** (commit `c5bd8b7`). Renderer should no longer drop those events. Code-level proof: 72/72 stream-parser tests pass; `_typeCheck` parity with `shared/types/claudeStream.ts` is enforced.
- **TASK-693 — `+ Terminal` / `+ Claude` PanelTabBar wired into CyboflowRoot + ProjectView** (commits `8bf3ccd` → `2a85a8d`). Cmd/Ctrl+Shift+\` opens a terminal panel; Cmd/Ctrl+Shift+C opens a Claude panel. The "no way to access claude panel" and "I don't see a button for the terminal" blockers from the earlier pass should be resolved — items below previously marked with those notes are flipped to `[V]` (code-verified) and need visual retest.

## Update 2026-05-22 21:00 — approval-prompt regression hunt

Followed up on the user report "permissions prompts still aren't loading in the prune or planner sessions." Found two stacked bugs that together explain why approvals never reached the Review Queue:

1. **ApprovalRouter self-deadlock on RunQueueRegistry** — `RunLauncher.launch()` hosts `runExecutor.execute(runId)` on `runQueueRegistry.getOrCreate(runId)` (concurrency:1). The SDK's PreToolUse hook fires from inside that task, then `ApprovalRouter.requestApproval` was re-enqueueing on the same per-run queue — see `runQueueRegistry.ts` §"no-recursive-enqueue rule." PQueue serialized the new task behind the still-running execute() task — which was itself blocked waiting for the hook decision. The whole approval path hung silently. Fixed in commit `caf8685` by giving ApprovalRouter its own internal per-run queue map (`approvalQueues`). Hook now produces a pending row in ms.
2. **`trpc-electron@0.1.2` patch had drifted off** — `node_modules/.pnpm/trpc-electron@0.1.2_*/dist/main.{cjs,mjs}` still threw `"Symbol.asyncDispose already exists"` despite the entry in `package.json#pnpm.patchedDependencies` and the patch file in `patches/`. Renderer subscriptions died at boot (`[reviewQueueStore] onApprovalCreated subscription error`), so even after the backend produced approval rows the Review Queue never saw them. `pnpm install` re-applied the patch (the new pnpm store path now includes a `patch_hash=...` segment). Should investigate why the patch silently un-applied — possibly a `pnpm electron:rebuild` side effect.

End-to-end verification via CDP-driven workflow start + Peekaboo-replacement DOM check:
- Workflow `compound` started, PreToolUse hook fires for Bash → approval `c8e0b5a8` lands in DB as `pending`.
- Renderer Review Queue surfaces "1 pending" with Approve/Reject buttons.
- Clicking Approve → row flips to `approved`, `workflow_runs.status` → `running`, tool executes, `user` (tool_result) event lands, agent issues next Bash → new pending approval `44cbad5a` queued. The full loop works.

Items below in §Approvals & Review Queue can be re-tested visually.

---

## 🚀 App shell & first-run

- [x] **Renderer boots cleanly, no Discord popup** *(TASK-685)*
  - App opens; no Discord modal at start
  - `grep -iE "app:update-discord-shown|discord_shown" cyboflow-backend-debug.log` returns 0 hits
  - Notes:

- [X] **Sidebar projects expand to RUN rows, not session rows** *(TASK-687)*
  - Expand a project with ≥1 workflow_run
  - Rows are run rows (not legacy SessionListItems)
  - Clicking a run row navigates to CyboflowRoot/RunView (not legacy SessionView)
  - Notes:

- [X] **MCP health dot in StatusBar** *(SPRINT-013 / TASK-553)*
  - Bottom-bar dot cycles green/yellow/red with OrchestratorHealth status
  - Hover tooltip surfaces `lastError`
  - Notes:

- [ ] **OnboardingCard for first-time users** *(SPRINT-013 / TASK-551)*
  - First-launch: ReviewQueueView shows OnboardingCard with j/k/y/n hint
  - Dismisses on "Got it" button
  - Also dismisses on first y/n keypress
  - After dismissal, never re-appears (preference persists)
  - Notes: did not see this pop up

---

## 🏃 Workflow runs (start → stream → complete)

- [X] **WorkflowPicker shows 5 options** *(TASK-354)*
  - Select a project → picker shows 5 workflows
  - Start Run mounts CyboflowRoot/RunView
  - Notes:

- [X] **Workflow emits ≥2 distinct SDK event types** *(TASK-683 AC#17)*
  - Start `prune` workflow on the Tester project
  - RunView event log shows ≥2 unique `type` values beyond `run_started` (system/assistant/user/result/stream_event)
  - Notes:

- [ ] **workflow_runs status transitions** *(TASK-662)*
  - Watch `cyboflow-backend-debug.log` during a run
  - Status sequence: `starting → running → completed` (or `failed`)
  - RunView in renderer reflects each transition
  - Notes: didn't check, please review on your end

- [ ] **Stream events reach the renderer store** *(TASK-667)*
  - DevTools console during a `prune` run on Tester-mctest
  - Lines `[cyboflowApi] stream event #1`, `#2`, `#3` … up to at least `#25` appear
  - `useCyboflowStore.getState().streamEvents.length >= 3` once run reaches running state
  - Notes: didn't check, please review on your end

- [ ] **No "orchSocketProvider not yet wired" warnings** *(TASK-660)*
  - After a Start Run, fresh backend log entries are clean of that warning
  - Cmd: `grep "orchSocketProvider not yet wired" cyboflow-backend-debug.log` → 0 hits (post-startup timestamps)
  - Notes: didn't check, please review on your end

- [ ] **raw_events DB sink populated** *(TASK-572)*
  - After a Claude Code session run
  - `sqlite3 ~/Library/Application\ Support/cyboflow/cyboflow.db "select event_type, count(*) from raw_events group by event_type"`
  - Shows ≥1 row per active stream-json event_type (system, assistant, result, etc.)
  - Notes: didn't check, please review on your end

---

## ✅ Approvals & Review Queue

- [x] **Bash workflow → pending approval row** *(TASK-694)*
  - Trigger a workflow that uses Bash within seconds
  - Wait ~30s, then: `sqlite3 ~/.cyboflow/sessions.db -separator "|" "SELECT id, tool_name, status FROM approvals; SELECT id, status FROM workflow_runs;"`
  - Pending approvals row exists; matching workflow_runs row at `awaiting_review`
  - Notes: PASS after the two fixes above. Verified with `compound` workflow on Tester-mctest — Bash approval lands in `approvals` table with `status='pending'`, `workflow_runs.status='awaiting_review'`. Path is `~/.cyboflow/sessions.db` (despite the file naming, that's the canonical store — `cyboflow.db` is a 0-byte stub).

- [ ] **j/k nav, y/n decide, atomic group actions** *(SPRINT-017)*
  - In Review Queue:
    - `j` / `k` move focus
    - `y` on a group card fires single atomic `approveRestOfRun` mutation
    - `n` on a group card fires single atomic `rejectRestOfRun` mutation
  - Notes:

- [ ] **ReviewQueueView baseline render** *(SPRINT-010)*
  - Empty state when no pending approvals
  - PendingApprovalCard renders with a realistic approval payload
  - Blocking vs Pending sections partitioned correctly
  - j/k navigation focus ring visible (TASK-404)
  - approve-rest-of-run group action works (TASK-406)
  - Dock badge reflects pending count (TASK-407)
  - Notes:

- [ ] **Stuck detection — badge, cancel-and-restart, inspector** *(SPRINT-013 + SPRINT-023)*
  - Trigger a stuck run (e.g., long-running tool without progress)
  - StuckBadge surfaces on the PendingApprovalCard with `detectedAt` tooltip
  - Cancel-and-restart button fires `cancelAndRestart` mutation
  - On TASK-304 no-op: WARN logged
  - "Why stuck" button opens StuckInspectorModal with 4 sections:
    - transcript tail
    - approvals timeline
    - store snapshot
    - Cancel-and-restart CTA
  - useStuckNotifications fires desktop notification exactly once per session for first stuck event
  - Notes:

- [ ] **trpc subscriptions survive renderer close** *(TASK-695)*
  - Open app, allow renderer to subscribe to `cyboflow.events.onApprovalCreated` + `onStuckDetected`
  - Close the window
  - No `Symbol.asyncDispose` crash (TRPC-Electron@0.1.2 patch)
  - Notes:

- [ ] **Stuck state cleared on terminal status** *(SPRINT-025 / TASK-669)*
  - Take a stuck run to a terminal state (completed/failed/canceled)
  - Confirm `runReasonMap` and `runDetectedAtMap` entries clear (no stale tooltip/inspector content on next runs)
  - Notes:

---

## 🤖 Claude panel (SDK migration smokes — TASK-683)

- [V] **AC#13 Panel create + prompt + stream**
  - New Claude panel
  - Prompt: *"Say hello and explain in one sentence what file I am currently in."*
  - Streaming response renders
  - Backend log: `[ClaudeCodeManager] SDK query started` + ≥1 stream event
  - Notes: was "no way to access claude panel" — TASK-693 added the `+ Claude` button to CyboflowRoot/ProjectView and Cmd+Shift+C shortcut. Retest visually.

- [V] **AC#14 Tool intercept + approval**
  - Prompt: *"List the files in the current directory using the bash tool."*
  - Review Queue intercepts the bash call
  - Click approve; tool completes
  - Backend log contains: `routePreToolUseThroughApprovalRouter` + `ApprovalRouter.requestApproval`
  - Notes: was blocked on panel access — TASK-693 unblocked. Retest visually.

- [V] **AC#15 Session resume across panel restart**
  - Prompt 1: *"My favorite color is teal. Remember this."*
  - Close panel
  - Reopen for the same session
  - Prompt 2: *"What is my favorite color?"*
  - Response references teal
  - Backend log: `resuming with sessionId=`
  - Notes: was blocked on panel access — TASK-693 unblocked. Retest visually.

- [V] **AC#16 PATH isolation (no `claude` binary needed)**
  - In a new terminal, filter `claude` from PATH (`FILTERED_PATH` per `docs/sdk-migration-smoke-results.md §Smoke 4`)
  - `which claude` exits 1
  - Run `pnpm dev` in that PATH context
  - Repeat AC#13 — must succeed (SDK is bundled, no binary needed)
  - Notes: was blocked on panel access — TASK-693 unblocked. Retest visually.

- [V] **AC#18 No UX regressions in full user flow**
  - Walk: create panel → prompt → tool approval → resume → start workflow → complete workflow
  - Record any UX delta (none expected)
  - Notes: was blocked on panel access — TASK-693 unblocked. Retest visually.

- [V] **RichOutputView renders SDK stream messages without crash** *(SPRINT-024 / TASK-637)*
  - Open RichOutputView mid-run
  - No crashes on UnifiedMessage adapter shape mismatches (the `bb926cd` UnifiedMessage restoration should hold)
  - MessagesView still shows session_info cards in legacy mode (FIND-SPRINT-024-5)
  - Notes: TASK-729 (`signature_delta`/`thinking_delta` schema literals) closes a stream-event narrowing gap that fed RichOutputView. Code-verified by 72/72 stream-parser tests; retest visually mid-run.

---

## 🖥️ Standalone terminal panels (SPRINT-025)

- [V] **Add Terminal button in PanelTabBar** *(TASK-658)*
  - Click `+` / Add Terminal in **ProjectView** — new terminal panel appears + focuses
  - Click `+` / Add Terminal in **CyboflowRoot** (Option B mount, was missing in last pass) — new terminal panel appears + focuses
  - Notes: was "I don't see a button for the terminal". TASK-693 wired `<PanelTabBar onAddTerminal onAddClaude>` into CyboflowRoot below the run/empty-state region and confirmed the existing ProjectView button still works. 3 new Playwright cases in `tests/standalone-terminal-panels.spec.ts` cover both surfaces. Retest visually.

- [V] **Cmd+Shift+Backquote keybinding** *(TASK-659)*
  - With a session open, press Cmd+Shift+` (Ctrl+... on Linux/Windows)
  - Same behavior as the + button
  - TerminalPanel breadcrumb header shows the cwd
  - Notes: was "this failed". `useAddTerminalShortcut` (existed) + `useAddClaudeShortcut` (new, TASK-693, Cmd+Shift+C) are now both mounted in CyboflowRoot and ProjectView. 13 unit tests on the Claude shortcut, sibling test suite on the Terminal shortcut. Retest visually.

- [V] **`panels:initialize` round-trips `customState.cwd`** *(TASK-657)*
  - Open a session, set cwd in a terminal panel
  - Close and reopen the session
  - cwd is preserved (prefers `customState.cwd` on re-mount)
  - Notes: was blocked on the first two. Surface now exists — retest visually.

- [V] **Shell-arg quoting for paths with quotes/spaces** *(TASK-670)*
  - Create / open a project with a name like `my'project's worktree` (single quotes and spaces)
  - Exercise paths via worktreeManager / runCommandManager / ipc/file.ts
  - No shell errors
  - Notes: was blocked on the first two. Surface now exists — retest visually.

---

## 🔧 Permissions / project defaults

- [ ] **Project creation writes `.cyboflow/worktrees/` to .gitignore** *(SPRINT-013 / TASK-552)*
  - Create a new project
  - That project's `.gitignore` contains `.cyboflow/worktrees/` (or similar)
  - Project creation succeeds without error
  - Notes:

- [ ] **ToolResultBlock.content type-guard in frontend** *(SPRINT-020 ripple)*
  - Trigger a tool call whose result returns `Array<{type, text}>` content (not just string)
  - `frontend/src/utils/toolFormatter.ts` consumer + RichOutputView render without crash
  - Notes:

- [ ] **`default_permission_mode` fallback — no silent `'ignore'`** *(SPRINT-020)*
  - Create a session on a project with `default_permission_mode` null/undefined
  - `main/src/services/sessionManager.ts:453` should not silently default to `'ignore'` for main-repo auto-creation
  - Notes:

---

## 📦 Deferred (need built artifact — NOT testable in `pnpm dev`)

These require a packaged build. Skip during this session.

- [s] **TASK-056** Clean-account Gatekeeper acceptance for `Cyboflow-0.3.5-macOS-universal.dmg` (SHA256 6eda21e9…0494) — needs clean macOS user account or VM
- [s] **TASK-155** Fresh-install migration `006_cyboflow_schema.sql` applies exactly once — `rm -rf ~/.cyboflow && pnpm --filter main build && pnpm electron-dev`
- [s] **TASK-584** Packaged-build asarUnpack fix — needs `SKIP_NOTARIZE=1 pnpm build:mac:arm64` first
- [s] **SPRINT-028** `tests/cyboflow-day3-gate.spec.ts` vitest-in-playwright import — code fix, not a live test

---

## How to bring this back

When done, just hand the file back ("here's the testing notes") and I'll:
1. Mark PASS items as resolved in the review queue (remove + commit)
2. For FAIL items, refine each into a backlog TASK via `task-refiner` (parallel)
3. For `[~]` partial items, keep them deferred with your notes attached
4. Report a final tally
