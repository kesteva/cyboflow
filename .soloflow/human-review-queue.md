---
pending_count: 40
buckets:
  decisions: 2
  actions: 5
  testing: 28
  deferred_visual: 5
items: []
---
# Human Review Queue

## Decisions

- task: TASK-571
  type: HUMAN_NEEDED
  bucket: decisions
  plan_ref: .soloflow/active/plans/typed-stream-event-schema/TASK-571-plan.md
  verdict_notes: "Verifier confirmed AC1 verbatim _reverseCheck form (bare z.infer<typeof claudeStreamEventSchema>) is unimplementable: .passthrough() schemas add [k: string]: unknown to inferred types, and concrete TS interfaces in shared/types/claudeStream.ts (files_readonly) lack index signatures, producing TS2322. The executor workaround DeepKnownFields<z.infer<...>> compiles but FAILS to catch optional-field TS->Zod drift — the primary scenario the plan was written to solve. Empirically: adding bogus_optional_drift?: string to SystemCompactEvent produces ZERO typecheck errors. _reverseCheck as implemented adds essentially zero net drift-detection vs _typeCheck alone for the optional-field case. Required-field drift IS caught."
  action: "Pick one path forward before merge: (1) accept gap, update plan to AC the DeepKnownFields form and update the bridge comment to admit the optional-field gap; (2) adopt option B from plan (export type ClaudeStreamEvent = z.infer<typeof schema>) which eliminates drift surface but requires touching 50+ consumer sites; (3) drop .passthrough() in non-leaf schemas (requires relaxing files_readonly to allow editing schemas.test.ts assertion of passthrough preservation). The executor logged FIND-SPRINT-020-2; verifier added FIND-SPRINT-020-3."
  severity: medium
  level: design

- task: SPRINT-028
  type: cross_task_regression
  bucket: decisions
  ref: REG-SPRINT-028-1
  plan_ref: .soloflow/active/sprints/SPRINT-028/sprint.json
  verdict_notes: "Cross-task regression caught at sprint level (per-task verification missed it). TASK-687 added handleRunClick in frontend/src/components/DraggableProjectTreeView.tsx:849-852 which calls useNavigationStore.getState().navigateToSessions(). navigateToSessions (frontend/src/stores/navigationStore.ts:27-30) sets {activeView: 'sessions', activeProjectId: null}. TASK-688 made CyboflowRoot the only host of RunView in App.tsx:338 and gated it on activeProjectId !== null. Net effect: clicking a workflow-run row in the Sidebar sets activeRunId but unmounts CyboflowRoot, so RunView never renders on this path — the user lands on the legacy SessionView. Per-task tests missed this: DraggableProjectTreeView.runs.test.tsx:352 only asserts setActiveRun was called and mocks navigationStore; CyboflowRoot.test.tsx renders the component directly with an injected projectId and bypasses the App-shell gate."
  action: "Pick one: (1) replace navigateToSessions() in handleRunClick with setActiveProjectId(run.project_id) or otherwise preserve activeProjectId — run rows already carry project context via ProjectWithRuns; (2) remove the navigation call entirely if CyboflowRoot is the always-on home view when a project is active; (3) widen App.tsx:338 to also render CyboflowRoot when activeRunId !== null (independent of activeProjectId). Whichever route is chosen, extend DraggableProjectTreeView.runs.test.tsx to assert that activeProjectId is non-null after the click OR render the full App shell and assert RunView is in the DOM. Also confirm App.tsx's activeView=='sessions' branch behavior is intentional vs legacy crystal carry-over."
  severity: high
  level: cross_task
  created_at: "2026-05-21T09:00:00.000Z"
  affected_tasks:
    - TASK-687
    - TASK-688

## Actions

- task: SPRINT-015
  type: config_gap
  bucket: actions
  dedup_key: visual_web_electron_unreachable
  plan_ref: .soloflow/active/sprints/SPRINT-015/sprint.json
  action: "verification.visual_web is true and playwright_target.kind is 'electron', but the Playwright MCP tools cannot launch an Electron app — they drive a Chromium browser only. Navigating to http://localhost:4521 fails per CLAUDE.md (renderer depends on preload-injected electronTRPC and cannot bootstrap standalone). To unblock visual verification: either (a) set verification.visual_web=false for this repo, (b) add a launch script that exposes the Electron renderer over CDP for Playwright to attach to, or (c) run the existing tests/*.spec.ts suite manually via `pnpm test` after `pnpm dev`."
  blocked_checks:
    - Pass 1 visual_web — TASK-630 cascading IPCResponse type-narrowing across 22 UI component files cannot be exercised end-to-end by the sprint verifier under the current tooling
    - Level 2 visual_web — RunView SDK discriminator branch rendering not exercised in live Electron renderer
    - Level 2 visual_web — TerminalPanel.tsx displayCwd render path (hasCwdString true/false branches) not exercised in live Electron renderer
    - AC10 — No new console warnings in cyboflow-frontend-debug.log
  level: sprint
  severity: medium
  created_at: "2026-05-18T00:00:00.000Z"
  affected_tasks:
    - SPRINT-015
    - TASK-682
    - TASK-677
    - TASK-688
    - SPRINT-028
  updated_at: "2026-05-21T09:00:00.000Z"

- task: SPRINT-017
  type: config_gap
  bucket: actions
  dedup_key: visual_web_electron_unreachable
  plan_ref: .soloflow/active/sprints/SPRINT-017/sprint.json
  action: "[Recurrence — already filed under SPRINT-015] verification.visual_web=true with playwright_target.kind='electron'; Playwright MCP cannot drive Electron renderer (preload-injected electronTRPC missing on standalone Vite port 4521). To unblock for future sprints: set verification.visual_web=false, OR add a launch script exposing CDP for Playwright attach, OR add a Playwright-Electron driver path."
  blocked_checks:
    - Pass 1 visual_web — SPRINT-017 review-queue flows not exercised
  level: sprint
  severity: low
  created_at: "2026-05-18T22:05:00.000Z"
  affected_tasks:
    - TASK-611
    - TASK-612
    - TASK-614
    - TASK-616

- task: SPRINT-020
  type: config_gap
  bucket: actions
  dedup_key: visual_web_electron_unreachable
  plan_ref: .soloflow/active/sprints/SPRINT-020/sprint.json
  action: "[Recurrence — already filed under SPRINT-015/SPRINT-017] verification.visual_web=true with playwright_target.kind='electron'; Playwright MCP cannot drive the Electron renderer. Navigated to http://localhost:4521 (Vite was up because user has pnpm dev running), but the page renders empty and the console shows 'Could not find electronTRPC global. Check that exposeElectronTRPC has been called in your preload file.' — exactly the limitation CLAUDE.md documents. SPRINT-020 sprint-level Pass 1 visual_web was therefore not run. Same three resolution paths still apply: (a) set verification.visual_web=false, (b) launch the Electron app with CDP exposure for Playwright to attach, or (c) run tests/*.spec.ts manually via `pnpm test` after `pnpm dev`."
  blocked_checks:
    - Pass 1 visual_web — SPRINT-020 create-session/Settings/CLI-panel flows touched by TASK-569 not exercised end-to-end
    - Pass 1 visual_web — SPRINT-020 review-queue interaction with deny-on-terminate (TASK-597) not exercised end-to-end
    - Pass 1 visual_web — SPRINT-020 stream rendering for widened ToolResultContent (TASK-570 ripple) not exercised in the live Electron renderer
  level: sprint
  severity: low
  created_at: "2026-05-19T15:35:00.000Z"
  affected_tasks:
    - TASK-569
    - TASK-570
    - TASK-596
    - TASK-597

- task: TASK-672
  type: config_issue
  bucket: actions
  dedup_key: visual_macos_unavailable
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-672-plan.md
  action: "Verifier could not run macOS visual verification despite visual_macos=true. Peekaboo MCP reachable (Screen Recording granted) but Accessibility permission NOT granted — cannot drive UI events (click/type/menu). Grant Accessibility to the Peekaboo MCP host (Claude Code) in System Settings > Privacy & Security > Accessibility. See docs/VISUAL-VERIFICATION-SETUP.md."
  blocked_checks:
    - Level 2 visual verification for macOS
    - Level 2 visual_macos — RunView discriminator branch rendering not exercised via Electron app driver
  level: visual
  severity: medium
  created_at: "2026-05-20T18:53:08.744Z"
  updated_at: "2026-05-20T19:21:49.509Z"
  affected_tasks:
    - TASK-672
    - TASK-682

- task: SPRINT-028
  type: config_gap
  bucket: actions
  dedup_key: visual_macos_grants_missing
  plan_ref: .soloflow/active/sprints/SPRINT-028/sprint.json
  action: "verification.visual_macos=true but visual_macos verification could not run because: (1) pnpm dev was not running at sprint-verifier time (no Electron/Vite process; port 4521 returned 000); (2) Peekaboo MCP reports Accessibility permission NOT granted (only Screen Recording is granted). Per CLAUDE.md L41 and docs/VISUAL-VERIFICATION-SETUP.md, both grants are required for Peekaboo to drive UI events. Resolution: grant Accessibility to the Peekaboo MCP host (Claude Code) in System Settings > Privacy & Security > Accessibility, AND start pnpm dev before re-running sprint verification. This is closely related to the TASK-672 entry above (dedup_key: visual_macos_unavailable) but separately scoped because TASK-672 was filed against an individual task while this entry is sprint-level and also covers the 'pnpm dev not running' precondition."
  blocked_checks:
    - Pass 1 visual_macos — Discord modal absence (TASK-684 + TASK-685)
    - "Pass 1 visual_macos — Sidebar project > runs list rendering + status dots + 'No runs yet' empty state (TASK-687)"
    - "Pass 1 visual_macos — Run-row click -> CyboflowRoot RunView round trip (TASK-687 x TASK-688; also see REG-SPRINT-028-1)"
    - Pass 1 visual_macos — WorkflowPicker modal open/select/start/close round trip (TASK-688)
  level: sprint
  severity: medium
  created_at: "2026-05-21T09:00:00.000Z"
  affected_tasks:
    - SPRINT-028
    - TASK-684
    - TASK-685
    - TASK-687
    - TASK-688

## Testing

- task: TASK-056
  type: manual_acceptance_test
  bucket: testing
  plan_ref: .soloflow/active/plans/apple-signing-notarization-setup/TASK-056-plan.md
  doc_ref: docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md
  action: "Clean-account Gatekeeper acceptance test for Cyboflow-0.3.5-macOS-universal.dmg (SHA256 6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494). Follow the 10-step procedure already scaffolded into docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md (create clean macOS user account or VM; copy DMG via /Users/Shared/; verify quarantine flag; mount/drag to /Applications; run spctl --assess on test account; double-click verify no Gatekeeper modal; create session inside app; check ps for PTY child; check Console.app for codesign errors; verify ~/.cyboflow/cyboflow.db or ~/.crystal/crystal.db written; fill placeholders; commit; re-run /soloflow:review-queue --testing-only to re-verify)."
  verdict_notes: "Executor completed mechanical prep (DMG SHA256, macOS version, full procedure scaffolded); manual portion requires user on a clean macOS account. Plan test_strategy.needed=false per design."
  level: ground_truth
  severity: medium

- task: TASK-155
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/cyboflow-schema-migration/TASK-155-plan.md
  action: "AC-1 fresh-install manual Electron boot: run `rm -rf ~/.cyboflow; pnpm --filter main build; pnpm electron-dev`; tail `crystal-backend-debug.log` (note: project may now log to `cyboflow-backend-debug.log` per CLAUDE.md) and confirm the line `[Database] Applied file-based migration 006_cyboflow_schema.sql` appears exactly once on first boot. Quit, relaunch, confirm the line does NOT appear on second boot (idempotency)."
  blocked_checks:
    - AC-1 manual fresh-install verification under real Electron __dirname/fs conditions
  level: requirements
  severity: medium

- task: TASK-205
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/stream-parser-to-main/TASK-205-plan.md
  action: "Manually open Cyboflow, start a Claude session, and confirm the Claude panel renders messages without throwing TypeError. The renderer-side parser was removed in TASK-205 (replaced with an identity passthrough) but the main-side MessageProjection is NOT wired into the data path that feeds the renderer (`panels:get-json-messages` still returns raw stream-json — see FIND-SPRINT-005-9). The epic explicitly puts orchestrator integration in a future epic. Without the wiring, the Claude panel will throw `Cannot read properties of undefined (reading 'some')` at line 440 of RichOutputView.tsx because raw stream-json objects lack the `.segments` property the rendering code accesses. Either confirm the panel is broken (and accept the cross-epic gap until the next epic wires `MessageProjection`), or verify by running through the UI that messages still render."
  blocked_checks:
    - End-to-end Claude panel rendering after TASK-205 stub reduction
  level: goal_backward
  severity: high

- task: TASK-255
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/orchestrator-and-trpc-router/TASK-255-plan.md
  action: "Run pnpm dev to launch Electron, open DevTools console, and run trpcClient.cyboflow.runs.list.query({}). Confirm the returned error contains NOT_IMPLEMENTED (proves end-to-end IPC link is alive). Plan Implementation Step 7 documents this manual smoke as the e2e gate; the smoke-test global was correctly never committed."
  blocked_checks:
    - "AC6: renderer can call trpcClient.cyboflow.runs.list.query() and receive NOT_IMPLEMENTED through the IPC bridge"
  level: requirements
  severity: medium

- task: TASK-568
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/wire-sprint-005-services/TASK-568-plan.md
  action: "Manual smoke test for AC-2: run `pnpm dev`, create a session with a prompt, wait for output, open the Claude panel. Verify `cyboflow-frontend-debug.log` contains no TypeError matching /Cannot read properties of undefined .*'some'/. This task fixes FIND-SPRINT-005-9; final confirmation requires a live Electron run that the verifier cannot perform."
  blocked_checks:
    - AC-2 manual Claude-panel smoke test (no renderer TypeError after MessageProjection wiring)
  level: requirements
  severity: high

- task: TASK-572
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/wire-sprint-005-services/TASK-572-plan.md
  action: "Manual smoke test of raw_events population: run pnpm dev, create+run a Claude Code session, then inspect ~/Library/Application Support/cyboflow/cyboflow.db (macOS) with sqlite3 cyboflow.db \"select event_type, count(*) from raw_events group by event_type;\". Confirm at least one row per active stream-json event_type (system, assistant, result, etc.). This validates AC#7 end-to-end (parser feed → router dispatch → sink persistence)"
  blocked_checks:
    - "AC#7 — sqlite raw_events smoke after fresh session"
  level: requirements
  severity: medium

- task: TASK-595
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-595-plan.md
  action: "Run human smoke per TASK-596 spec in docs/sdk-migration-smoke-results.md §Follow-up: launch app under filtered PATH, drive Claude panel through Signals 1+2+3+9, capture 4 screenshots under docs/screenshots/sdk-migration/, grep backend log for [ClaudeCodeManager] SDK query started and Using resume for panel, then update the results document to flip Signals 1/2/3/9 from FAIL to PASS."
  blocked_checks:
    - "AC#5 file existence (panel-stream + review-queue screenshots actually present on disk)"
    - "AC#6 resume screenshot file present on disk"
    - "EPIC success Signals 1, 2, 3, 9 (UI-driven verification)"
  level: requirements
  severity: high

- task: TASK-354
  type: action_required
  bucket: testing
  dedup_key: visual_web_unavailable
  plan_ref: .soloflow/active/plans/workflow-runs-and-day3-gate/TASK-354-plan.md
  action: "Verifier could not run web visual verification despite visual_web=true. The Electron renderer dev server (http://localhost:4521) was not running during verification (connection refused). To verify the WorkflowPicker/RunView/CyboflowRoot UI: run `pnpm dev` in one shell, then `pnpm test` (Playwright spec tests/cyboflow-picker.spec.ts) in another, or open the running renderer and confirm the workflow select with 5 options appears when a project is selected."
  blocked_checks:
    - Level 2 visual_web verification of WorkflowPicker rendering 5 options
    - Level 2 visual_web verification of Start Run + CyboflowRoot mount
    - Level 2 visual verification for web (review queue keyboard focus ring + scroll-into-view)
    - "Level 2 visual verification of Sidebar MCP dot rendering, color states, and tooltip"
    - Level 2 visual verification for web (Electron renderer)
  level: visual
  severity: medium
  created_at: "2026-05-15T06:37:20.926Z"
  updated_at: "2026-05-20T18:53:05.276Z"
  affected_tasks:
    - TASK-354
    - TASK-404
    - TASK-455
    - TASK-672

- task: TASK-455
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/cyboflow-mcp-server/TASK-455-plan.md
  action: "AC6 manual smoke: run `pnpm dev` and observe the Sidebar bottom — confirm an MCP status dot appears with label 'MCP'. The dot will currently show YELLOW (status: starting) because the OrchestratorHealth and McpServerLifecycle singletons are not yet instantiated in main/src/index.ts (deferred to a later orchestrator wire-up task). After the lifecycle wire-up lands, re-run this smoke to confirm yellow→green transition within 5s. To simulate failure path (red dot + tooltip error): temporarily edit the lifecycle init to point CYBOFLOW_ORCH_SOCKET at a nonexistent path; expect dot=red and `title` tooltip to read 'MCP server: failed — <error>'."
  blocked_checks:
    - AC6 end-to-end visible yellow→green transition
    - AC6 failure-path tooltip surfacing
  level: visual
  severity: medium

- task: SPRINT-017
  type: action_required
  bucket: testing
  dedup_key: sprint_017_review_queue_visual_flow
  plan_ref: .soloflow/active/sprints/SPRINT-017/sprint.json
  action: "Visually verify the review-queue triage flow on the running `pnpm dev` Electron window: (a) press `j`/`k` to navigate the queue; (b) press `y` on a group card and confirm a single atomic `approveRestOfRun` mutation fires; (c) press `n` on a group card and confirm a single atomic `rejectRestOfRun` mutation fires (TASK-616 — symmetric to approve); (d) confirm pressing `y`/`n` while an input or button has focus is a no-op (TASK-614 focus guard); (e) confirm the group-card Reject button (mouse) dispatches `rejectRestOfRun` exactly once, not per-item. Per-task unit tests cover each of these at the component/hook level, but Pass 1 visual verification was unable to drive the Electron renderer (see dedup_key=visual_web_electron_unreachable)."
  blocked_checks:
    - Pass 1 visual_web — sprint-touched flows for TASK-612/614/616/611 not exercised end-to-end
  level: sprint
  severity: medium
  created_at: "2026-05-18T22:05:00.000Z"
  affected_tasks:
    - TASK-611
    - TASK-612
    - TASK-614
    - TASK-616

- task: TASK-584
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/apple-signing-notarization-setup/TASK-584-plan.md
  action: "Manual packaged-build verification of the asarUnpack fix. Prereq: fix pre-existing TS error in frontend/vite.config.ts (the `test:` config block conflicts with `UserConfigExport` — likely needs `defineConfig` import from `vitest/config` instead of `vite`). After the build runs cleanly: (1) run `SKIP_SIGNING=1 pnpm run build:mac:arm64` (or with full signing creds); (2) confirm `find dist-electron/*.app -path \"*app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js\"` returns 1 match; (3) launch the packaged app, create a Claude session, verify backend logs at `~/.cyboflow/logs/` do NOT contain the ASAR-extraction warning from scriptPath.ts (`Detected ASAR packaging, extracting script` is gone), and that the spawned MCP subprocess loads directly from `app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js`. Plan AC #2 and AC #3 are blocked on this."
  blocked_checks:
    - "AC #2 — Post-unpack filesystem layout under app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js"
    - "AC #3 — Runtime smoke confirming scriptPath.ts does not hit its ASAR-extraction fallback in the packaged build"
  level: requirements
  severity: medium

- task: SPRINT-020
  type: action_required
  bucket: testing
  dedup_key: sprint_020_toolresult_widen_frontend_ripple
  plan_ref: .soloflow/active/plans/typed-stream-event-schema/TASK-570-plan.md
  action: "Cross-task ripple from TASK-570: shared/types/claudeStream.ts:46-51 ToolResultBlock.content is now `string | Array<{type, text}>`. TASK-570 fixed `main/src/utils/formatters.ts` with a type-guard and tests, but the two frontend consumers were NOT updated and have NO test coverage: (1) `frontend/src/utils/formatters.ts:38` does `Tool result: ${item.content}` — when content is now an array this stringifies to `[object Object],[object Object]` instead of the joined text. (2) `frontend/src/utils/toolFormatter.ts:281-315 and 417-423` make repeated `toolResult.content.includes('error:')`, `JSON.parse(toolResult.content)`, and `makePathsRelative(toolResult.content)` calls — when content is an array, `.includes('error:')` silently returns false (Array.prototype.includes checks array membership of the literal string, not substring match), `JSON.parse(array)` throws ('Unexpected token o in JSON' or similar via toString coercion), and makePathsRelative most likely also breaks. The TypeScript checker doesn't catch these because `Array<X>.includes(string)` is structurally valid (returns false for any string). Verify in the live Electron renderer with a real Bash/Edit tool_result that produces array-form content: confirm error tinting still works (or doesn't) and confirm no console-side TypeError or `[object Object]` rendering in `cyboflow-frontend-debug.log`. If broken: port the formatters.ts type-guard (`typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)`, or join the array's .text fields) into both frontend files and add tests mirroring main/src/utils/formatters.test.ts."
  blocked_checks:
    - "End-of-sprint cross-task verification: widened ToolResultContent does not break tool-result rendering in the frontend (frontend/src/utils/formatters.ts:38 + frontend/src/utils/toolFormatter.ts:281-315 + :417-423)"
  level: requirements
  severity: medium
  created_at: "2026-05-19T15:35:00.000Z"
  affected_tasks:
    - TASK-570

- task: SPRINT-020
  type: action_required
  bucket: testing
  dedup_key: sprint_020_permission_mode_sessionmanager_fallback
  plan_ref: .soloflow/active/plans/approval-router-and-permission-fix/TASK-569-plan.md
  action: "Residual app-layer 'ignore' default after TASK-569's flip — `main/src/services/sessionManager.ts:453` falls back to `'ignore'` when `project.default_permission_mode` is null/undefined for main-repo session auto-creation (`project.default_permission_mode || 'ignore'`). TASK-569's verification grep used pattern `defaultPermissionMode\\s*\\|\\|\\s*['\"]ignore['\"]` (camelCase) which does NOT match the snake-case attribute access here, so the sweep missed it. Same issue at `main/src/database/database.ts:1523` (`createProject(... defaultPermissionMode || 'ignore' ...)`) — though that path was excluded by plan as a 'schema contract', the runtime fallback in `createProject` is an APP default that fires when callers omit the arg. Effect: legacy projects whose `default_permission_mode` column is NULL (or older projects created before TASK-569's flip) will still spawn main-repo sessions with `permissionMode='ignore'`, bypassing the approve-by-default intent of the epic. Decide: (a) flip the runtime fallback at sessionManager.ts:453 to `'approve'` and update the inline comment, (b) accept the gap as 'legacy behaviour preserved' and document it in the epic plan, or (c) add a one-shot DB migration that backfills default_permission_mode='approve' for any project where it's null. Same call applies to database.ts:1523 createProject fallback."
  blocked_checks:
    - "End-of-sprint approve-by-default invariant: every newly-spawned session — including main-repo auto-creation paths and legacy projects with NULL default_permission_mode — defaults to permissionMode='approve'"
  level: requirements
  severity: medium
  created_at: "2026-05-19T15:35:00.000Z"
  affected_tasks:
    - TASK-569

- task: TASK-660
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/orchestrator-and-trpc-router/TASK-660-plan.md
  action: "Manual smoke: run `pnpm dev`, click Start Run on the seeded prune workflow, then `grep \"orchSocketProvider not yet wired\" cyboflow-backend-debug.log` should return zero matches against entries timestamped AFTER the TASK-660 commits (a3d2c50 / 02fc7df / 596948b). The current log file has stale entries from before the fix landed (lines 151-152, 393-394 dated 18:53Z and 19:15Z — commits land on branch created 19:37Z) so the file must be retruncated by a fresh `pnpm dev` launch before the assertion is meaningful."
  blocked_checks:
    - AC5 — no orchSocketProvider sentinel error in cyboflow-backend-debug.log post-fix
  level: requirements
  severity: medium

- task: TASK-662
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/orchestrator-and-trpc-router/TASK-662-plan.md
  action: "Run pnpm dev and click Start Run on the seeded \"prune\" workflow. Watch cyboflow-backend-debug.log for the workflow_runs UPDATE lines: status='starting' → 'running' (on first SDK message via onFirstMessage) → 'completed' on normal terminate (or 'failed' if the SDK errors). Confirm the RunView in the renderer reflects the same status flips in real time. This is the end-to-end gate for IDEA-018 closing."
  blocked_checks:
    - "AC9 — end-to-end manual smoke: workflow_runs status transitions starting → running → completed|failed under pnpm dev"
  level: requirements
  severity: medium

- sprint: SPRINT-023
  type: deferred
  bucket: testing
  dedup_key: visual_web_electron_unreachable
  level: ground_truth
  severity: medium
  action: "Launch `pnpm dev` (full Electron with Vite dev server at http://localhost:4521), then manually verify these sprint-touched flows: (1) Review Queue stuck-aware card swap + tooltip with detectedAt (TASK-622/623/624); (2) Cancel-and-restart button tooltip + WARN log on TASK-304 no-op (TASK-627); (3) OnboardingCard dismissal via onDecide for both keyboard and click paths (TASK-625); (4) StatusBar is the sole MCP health surface — Sidebar no longer shows MCP dot (TASK-626); (5) commit footer presence in a fresh cyboflow run commit (TASK-628). Also confirm the pre-existing `useStuckNotifications subscription error: No \"subscription\"-procedure on path \"cyboflow.events.onStuckDetected\"` warning (observed in pre-sprint debug log) does not regress — TASK-623 aligned the hook with the canonical StuckDetectedEvent schema."
  blocked_checks:
    - "visual_web — Electron renderer at http://localhost:4521 unreachable (no `pnpm dev` session running); per CLAUDE.md the renderer cannot bootstrap standalone."
    - "visual_macos — Peekaboo MCP available with both permissions granted, but no cyboflow UI window discoverable (macOS UI session at loginwindow); cannot attach to / capture an unmounted Electron window."
  flows_deferred:
    - Review Queue stuck-aware card swap + StuckBadge tooltip (TASK-622/623/624)
    - Cancel-and-restart tooltip + WARN log (TASK-627)
    - OnboardingCard dismissal via onDecide — keyboard + click paths (TASK-625)
    - Sidebar MCP dot removed; StatusBar is single MCP surface (TASK-626)
    - Commit footer composition for cyboflow runs (TASK-628)
    - "Sprint-wide cross-task: App.tsx top-level subscribeToStuckEvents mount with TASK-623 useStuckNotifications — no duplicate subscriptions / missed events"
    - Stuck inspector modal reason+detectedAt persistence through reviewQueueSlice (TASK-624)
  created_at: "2026-05-19T19:15:00.000Z"

- task: TASK-667
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/orchestrator-and-trpc-router/TASK-667-plan.md
  action: "Manual smoke: in `pnpm dev`, against the Tester-mctest project, start the prune workflow and watch the renderer DevTools console. Confirm `[cyboflowApi] stream event #1`, `#2`, `#3` all appear (up to at least `#25`), and `useCyboflowStore.getState().streamEvents.length >= 3` by the time the run reaches `completed`. The architectural fix (subscription moved from RunView useEffect to cyboflowStore module-level singleton) was verified by unit tests but the end-to-end envelope-flow gate (AC8 — Phase 4 step 12) was not run by the executor."
  blocked_checks:
    - "AC8 — renderer receives N>=3 envelopes on a fresh run"
    - Phase 4 step 12 — diagnostic re-run with fix in place
  level: goal_backward
  severity: medium

- task: TASK-683
  type: manual_smoke
  bucket: testing
  level: requirements
  severity: medium
  action: "AC#13 Manual smoke 1 — panel create + prompt + stream. Run pnpm dev, create a new Claude panel, send the prompt 'Say hello and explain in one sentence what file I am currently in.' Confirm streaming response appears. Read cyboflow-backend-debug.log for [ClaudeCodeManager] SDK query started + >=1 stream/assistant event. Checklist: docs/sdk-migration-smoke-results.md §Smoke 1."
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md
  verdict_notes: Manual UI verification deferred — autonomous session cannot drive Electron UI.

- task: TASK-683
  type: manual_smoke
  bucket: testing
  level: requirements
  severity: medium
  action: "AC#14 Manual smoke 2 — tool intercept + approval. Send 'List the files in the current directory using the bash tool.' Review queue should intercept; click approve; tool completes. Confirm cyboflow-backend-debug.log contains routePreToolUseThroughApprovalRouter and ApprovalRouter.requestApproval. Sanity SELECT FROM approvals. Checklist: docs/sdk-migration-smoke-results.md §Smoke 2."
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md
  verdict_notes: Manual UI verification deferred.

- task: TASK-683
  type: manual_smoke
  bucket: testing
  level: requirements
  severity: medium
  action: "AC#15 Manual smoke 3 — session resume across panel restart. Send 'My favorite color is teal. Remember this.' Close panel; reopen for same session; send 'What is my favorite color?' Response must reference teal. Backend log contains 'resuming with sessionId='. Checklist: docs/sdk-migration-smoke-results.md §Smoke 3."
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md
  verdict_notes: Manual UI verification deferred.

- task: TASK-683
  type: manual_smoke
  bucket: testing
  level: requirements
  severity: medium
  action: "AC#16 Manual smoke 4 — PATH isolation. Filter claude from PATH (FILTERED_PATH per smoke-results §Smoke 4), confirm 'which claude' exits 1, then pnpm dev. Repeat smoke 1 in this PATH context. Must succeed — no claude binary needed. Checklist: docs/sdk-migration-smoke-results.md §Smoke 4."
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md
  verdict_notes: Manual UI verification deferred.

- task: TASK-683
  type: manual_smoke
  bucket: testing
  level: goal_backward
  severity: high
  action: "AC#17 Manual smoke 5 — workflow run emits >=2 distinct real SDK event types. Start a workflow run from the cyboflow tab; RunView event log must show >=2 unique 'type' values beyond run_started (system/assistant/user/result/stream_event). If only run_started appears, RunExecutor is not wired — file finding and halt. Programmatic check: SELECT DISTINCT type FROM raw_events WHERE run_id=<id> returns >=2. Checklist: docs/sdk-migration-smoke-results.md §Smoke 5."
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md
  verdict_notes: "HIGH severity — gates 'real SDK events flow' validation for the epic. Manual UI verification deferred."

- task: TASK-683
  type: manual_smoke
  bucket: testing
  level: requirements
  severity: medium
  action: "AC#18 Manual smoke 6 — no UX regressions in full user flow. Walk: create panel → prompt → tool approval → resume → workflow run start → workflow run complete. Record any UX deltas (none expected). Checklist: docs/sdk-migration-smoke-results.md §Smoke 6."
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-683-plan.md
  verdict_notes: Manual UI verification deferred.

- task: TASK-685
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-685-plan.md
  action: "AC11 manual launch verification: run `pnpm dev` and confirm (a) the renderer bootstraps without crashing, (b) no DiscordPopup modal renders at app start, and (c) `grep -iE \"app:update-discord-shown|updateLastAppOpenDiscordShown|discord_shown\" cyboflow-backend-debug.log` returns 0 matches against entries timestamped AFTER commit 2afbf2e. Verifier ran static gates (typecheck + lint + 8 grep-based ACs all green) but cannot drive a live Electron launch from this autonomous session. Pre-existing cyboflow-backend-debug.log dates from 11:17 (before TASK-685 commit at 21:30) so it must be retruncated by a fresh `pnpm dev` launch before the grep assertion is meaningful."
  blocked_checks:
    - "AC11 — manual launch: pnpm dev → no DiscordPopup modal → debug log clean of deleted-symbol mentions"
  level: visual
  severity: medium

- task: TASK-687
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/cyboflow-shell-architecture/TASK-687-plan.md
  action: "Run pnpm dev with a project that has ≥1 workflow_run; expand the project in the sidebar and confirm: (AC1) children render as run rows (not SessionListItems), no Crystal-session rows appear; (AC2) clicking a run row navigates the main pane via setActiveRun — observe cyboflow-frontend-debug.log for a stream-event subscription on the clicked runId."
  blocked_checks:
    - "AC1: DraggableProjectTreeView renders run rows under expanded project (visual)"
    - "AC2: Clicking run row triggers stream subscription via setActiveRun (visual)"
  level: visual
  severity: medium

- task: SPRINT-028
  type: config_gap
  bucket: testing
  dedup_key: playwright_full_run_blocked_by_day3_gate_spec
  plan_ref: .soloflow/active/sprints/SPRINT-028/sprint.json
  action: "tests/cyboflow-day3-gate.spec.ts imports from 'vitest' (line 17) but is collected by Playwright when 'pnpm test' is run without a spec filter — Playwright fails with 'Vitest cannot be imported in a CommonJS module using require()'. This blocks running the full Playwright suite; sprint verifiers and CI must filter by spec name to make progress. Spec is unchanged in SPRINT-028 (last touched in TASK-605); pre-existing limitation. Resolution: either (a) move cyboflow-day3-gate.spec.ts out of the Playwright testDir into a vitest config (it already has a dedicated test:gate script that uses vitest.config.gate.ts), (b) add a Playwright testIgnore for *-gate.spec.ts in playwright.config.ts, or (c) rewrite the spec to use Playwright's test runner instead of vitest. Currently noted as low-severity informational because the per-spec workaround works."
  blocked_checks:
    - Full pnpm test (Playwright) run — collection blocked by cyboflow-day3-gate.spec.ts vitest import
  level: sprint
  severity: low
  created_at: "2026-05-21T09:00:00.000Z"
  affected_tasks:
    - SPRINT-028

- task: TASK-694
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/approval-router-and-permission-fix/TASK-694-plan.md
  action: "Run pnpm dev, trigger a real workflow that uses Bash within seconds, wait 30s, then verify: (1) sqlite3 ~/.cyboflow/cyboflow.db -separator | \"SELECT id, tool_name, status FROM approvals; SELECT id, status FROM workflow_runs;\" shows a pending approvals row and the matching workflow_runs row at awaiting_review; (2) grep -c \"\\[DIAG-approval\\]\" cyboflow-backend-debug.log returns >= 6. These ACs were deferred because parallel-worktree execution disables visual_verify which requires single-process pnpm dev focus."
  blocked_checks:
    - AC4 (sqlite3 approvals INSERT + workflow_runs.status=awaiting_review after live run)
    - AC5 (cyboflow-backend-debug.log DIAG-approval checkpoint sequence)
  level: visual
  severity: high

- task: TASK-695
  type: action_required
  bucket: testing
  plan_ref: .soloflow/active/plans/approval-router-and-permission-fix/TASK-695-plan.md
  action: "Run pnpm dev (full Electron) and exercise two end-to-end paths that the integration test suite cannot drive: (1) the trpc-electron@0.1.2 Symbol.asyncDispose patch — open the app, allow the renderer to subscribe to cyboflow.events.onApprovalCreated and cyboflow.events.onStuckDetected, then close the window and reopen; confirm cyboflow-frontend-debug.log does NOT contain any 'AsyncIterableIterator does not have Symbol.asyncDispose' or related TRPC link errors. (2) the new onStuckDetected subscription wired in main/src/orchestrator/trpc/routers/events.ts + frontend/src/stores/reviewQueueSlice.ts — start a workflow that stalls long enough to trigger a stuck event, confirm a desktop notification fires and reviewQueueSlice.runStatusMap reflects the stuck state. Per-task verification deferred these because parallel-worktree execution disables visual_verify; sprint-level verifier could not run them because pnpm dev had Electron exited at verification time."
  blocked_checks:
    - AC4 (trpc-electron patch — no Symbol.asyncDispose errors in cyboflow-frontend-debug.log under a full launch+close+relaunch cycle)
    - AC5 (events.onStuckDetected subscription delivers a stuck event and reviewQueueSlice updates)
  level: visual
  severity: high
  created_at: "2026-05-21T21:50:00.000Z"
  affected_tasks:
    - TASK-695

## Deferred Visual

- sprint: SPRINT-007
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  action: "Live Electron end-of-sprint smoke. Prereq: run `pnpm electron:rebuild` (resolves better-sqlite3 NODE_MODULE_VERSION mismatch). Then `pnpm dev`, create a session, run a prompt, open the Claude panel, and confirm `cyboflow-frontend-debug.log` contains no TypeError matching /Cannot read properties of undefined .*'some'/ and the panel renders messages. NOTE (2026-05-19 review-queue run): verification attempted but blocked. There is currently NO UI affordance to add a Claude panel to an existing session — PanelTabBar (frontend/src/components/panels/PanelTabBar.tsx) has no `+`/add button, the legacy session-input bar that lazily created a Claude panel was removed (SessionView.tsx:484 'Legacy session-level prompt bar removed - now handled by panels'), and ProjectView.ensureClaudePanel() only fires from git operations. The Test session in DB has only a Diff panel; clicking it shows just File Changes. This add-panel-UI dead-end is in scope of IDEA-017's slice 'Cut the legacy Create New Session dialog and the play button' / 'Retire useLegacyCrystalView'. Once IDEA-017 settles the new shell, either (a) re-test if a Claude panel surface still exists in cyboflow, or (b) dismiss this entry if Claude panels are cut along with SessionView."
  blocked_checks:
    - "End-of-sprint cross-task verification: opening the Claude panel after a Claude run does not throw .some-of-undefined (FIND-SPRINT-005-9 closure)"
  level: requirements
  severity: low
  updated_at: "2026-05-19T19:00:00.000Z"

- sprint: SPRINT-010
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  dedup_key: visual_web_electron_renderer_needs_full_electron
  action: "End-of-sprint visual smoke for the review-queue-ui epic (TASK-401..TASK-407). The Vite renderer at http://localhost:4521 cannot bootstrap standalone — it requires Electron's preload-injected `electronTRPC` global. Run `pnpm dev` to launch Electron, then drive the six flows: (1) ReviewQueueView empty state, (2) PendingApprovalCard render with a realistic approval payload, (3) Blocking vs Pending section partitioning and the group variant, (4) j/k navigation focus ring (TASK-404), (5) y/n approve/reject keyboard, (6) approveRestOfRun group-card action (TASK-406). Confirm `cyboflow-frontend-debug.log` shows no errors and the dock badge reflects pending count (TASK-407). NOTE (2026-05-19 review-queue run): the prior 'Alternative' note is now actionable — Peekaboo MCP capture works and `verification.visual_macos=true` is set in .soloflow/config.json (commit d189263). Next attempt should use `pnpm dev` + `mcp__peekaboo__image` with `app_target: 'Electron:WINDOW_TITLE:Cyboflow'` to capture each flow. Also note IDEA-017 may restructure the review-queue rail/shell — re-validate flow IDs against any layout changes before re-testing."
  blocked_checks:
    - "End-of-sprint cross-task visual verification of review-queue-ui flows (ReviewQueueView, PendingApprovalCard, group variant, j/k/y/n keyboard, approveRestOfRun, dock-badge sync)"
  level: visual
  severity: medium
  created_at: "2026-05-15T18:30:00.000Z"
  updated_at: "2026-05-19T19:00:00.000Z"

- sprint: SPRINT-013
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  dedup_key: visual_web_electron_renderer_needs_full_electron_sprint013
  action: "End-of-sprint visual smoke for the stuck-detection + onboarding + MCP-health-indicator sprint (TASK-501..504, TASK-551..553). Run `pnpm dev` to launch Electron, then drive the seven flows: (1) StuckBadge surfaces on a PendingApprovalCard when a stuck event fires (TASK-501+502). (2) Cancel-and-restart button on a stuck card triggers the cancelAndRestart mutation and the card transitions to a new run within the per-run p-queue (TASK-502). (3) useStuckNotifications system notification fires once per session for the first stuck event (TASK-503). (4) 'Why stuck' button on a stuck card opens StuckInspectorModal with the four sections (transcript tail / approvals timeline / store snapshot / Cancel-and-restart CTA) rendered from getStuckInspection (TASK-504). (5) OnboardingCard renders for first-time users in ReviewQueueView, shows j/k/y/n hint, dismisses on 'Got it' AND on first y/n keypress, then never re-appears after preference write (TASK-551). (6) Creating a new project auto-writes `.cyboflow/worktrees/` to that project's .gitignore (TASK-552 — verifiable via filesystem, but UI confirmation that project creation succeeds without error is part of the same flow). (7) MCP server health dot in the StatusBar at the app shell footer cycles green/yellow/red with the live OrchestratorHealth status, tooltip surfaces lastError (TASK-553). NOTE (2026-05-19 review-queue run): Peekaboo MCP capture is now working and `verification.visual_macos=true` is set (commit d189263) — use `mcp__peekaboo__image` with `app_target: 'Electron:WINDOW_TITLE:Cyboflow'` to capture each flow. Stuck-detection flows (1-4) require triggering a stuck event — confirm getStuckInspection is reachable before scheduling; if not, dismiss the stuck-related checks. Additional signal seen during today's run: `useStuckNotifications.ts:59` logs `TRPCClientError: No subscription-procedure on path cyboflow.events.onStuckDetected` on first restart (then absent on Tier-2 restart) — likely an init-order race, worth a closer look before flow 3 is rechecked."
  blocked_checks:
    - "End-of-sprint cross-task visual verification of stuck-detection flows (StuckBadge surface, cancel-and-restart button, useStuckNotifications fire, StuckInspectorModal 4 sections)"
    - "End-of-sprint cross-task visual verification of onboarding flow (OnboardingCard mount, 'Got it' dismiss path, y/n keypress dismiss path, never-re-appear preference contract)"
    - "End-of-sprint cross-task visual verification of MCP health indicator in StatusBar (green/yellow/red transitions, lastError tooltip)"
    - "Project creation gitignore-write smoke (project:create succeeds and `.cyboflow/worktrees/` appears in the project's .gitignore)"
  level: visual
  severity: medium
  created_at: "2026-05-17T17:35:00.000Z"
  updated_at: "2026-05-19T19:00:00.000Z"
  affected_tasks:
    - TASK-501
    - TASK-502
    - TASK-503
    - TASK-504
    - TASK-551
    - TASK-552
    - TASK-553

- sprint: SPRINT-024
  type: human_needed
  bucket: deferred_visual
  dedup_key: electron_renderer_unreachable
  verdict_notes: "Sprint verifier could not bring up the Electron app to run UI smoke for the TASK-637 parseJsonMessage adapter changes (MessagesView + RichOutputView). Orchestrator directive forbids spawning pnpm dev; an existing zombie Electron process (PID 22778, ~11h uptime) has 0 windows and Vite at :4521 is not listening. visual_web and visual_macos both classified skipped_unable."
  action: "Launch `pnpm dev` (full Electron with Vite dev server at http://localhost:4521), then manually verify the UI rendering surface that depends on TASK-637's parseJsonMessage adapter: (1) RichOutputView renders Claude SDK stream messages without crashing (confirm bb926cd's UnifiedMessage restoration holds — the adapter is shape-mismatched at the StreamEvent level but RichOutputView consumes UnifiedMessage); (2) MessagesView still shows session_info cards in the legacy mode (was flagged FIND-SPRINT-024-5 as empty); (3) confirm stale IPC type decls flagged in FIND-SPRINT-024-4 didn't surface a regression in panel:get-json-messages consumers after TASK-648 deleted the divergent sessions:get-json-messages handler."
  blocked_checks:
    - "visual_web — no live Vite renderer (port 4521 not listening; existing Electron PID 22778 has 0 windows, ~11.5h elapsed, debug logs stale from 17:38)"
    - visual_macos — peekaboo CLI not installed; Peekaboo MCP reachable but Electron app shows 0 windows so nothing to capture
    - "playwright E2E (`pnpm test`) — webServer config requires `pnpm electron-dev`, same constraint as visual"
  flows_deferred:
    - RichOutputView Claude SDK output rendering (TASK-637 + bb926cd fix)
    - MessagesView session_info card population (FIND-SPRINT-024-5)
    - "panels:get-json-messages consumer path still works after sessions:get-json-messages deletion (TASK-648)"
  severity: medium
  created_at: "2026-05-19T23:45:00.000Z"

- sprint: SPRINT-025
  type: human_needed
  bucket: deferred_visual
  dedup_key: electron_renderer_unreachable
  verdict_notes: "End-of-sprint visual verification could not run any of the 7 affected UI flows. Playwright MCP and Peekaboo MCP are both technically present in this session but neither can drive the live cyboflow renderer: Playwright at http://localhost:4521 hits the documented `electronTRPC` preload constraint (CLAUDE.md) and renders a blank body; Peekaboo MCP enumerates the cyboflow Electron window (PID 76201, ID 6335) and reports Screen Recording + Accessibility granted, but the actual ScreenCaptureKit stream fails with `Failed to start stream due to audio/video capture failure` / `No displays available for capture`. Per-task visual was SKIPPED for the whole sprint (parallel-mode); this end-of-sprint pass is therefore the single missed visual verification. Integration tests + typecheck + lint are clean (net delta vs base: -1 pre-existing failure)."
  action: "Launch `pnpm dev` (full Electron), then manually verify these sprint-touched flows: (1) TASK-657 — open a session/project and confirm `panels:initialize` round-trips `customState.cwd` and prefers it on re-mount; (2) TASK-658 — click the new + / Add Terminal button in PanelTabBar (test in both ProjectView and SessionView contexts), confirm a new terminal panel appears and is focused; (3) TASK-659 — press Cmd+Shift+Backquote (Ctrl+... on Linux/Windows) with a session open, confirm same behavior as the button, then verify TerminalPanel breadcrumb header shows the cwd; (4) TASK-668 — trigger a stuck detection on a run, confirm desktop notification fires exactly once and Review Queue UI reflects stuck state via reviewQueueSlice.runStatusMap; (5) TASK-669 — take a stuck run to a terminal state (completed/failed/canceled), confirm runReasonMap and runDetectedAtMap entries are cleared (no stale tooltip/inspector content); (6) TASK-670 — exercise paths that go through worktreeManager/runCommandManager/ipc/file.ts with single quotes and spaces (e.g. project named `my'project's worktree`), confirm no shell errors. NOTE: TASK-667's end-to-end envelope-flow gate is already separately queued in the existing TASK-667 action_required entry above."
  blocked_checks:
    - "visual_web — Playwright MCP works but Vite renderer at http://localhost:4521 is blank without Electron preload (electronTRPC missing). The standalone-terminal-panels.spec.ts added by TASK-658 fails for this same root cause when run via `pnpm test`; not a regression but degraded coverage."
    - "visual_macos — Peekaboo MCP enumerates the Electron window and reports both permissions granted, but ScreenCaptureKit stream itself rejects: `Failed to start stream due to audio/video capture failure` (window-target) and `No displays available for capture` (screen-target). TCC grant is present at the policy layer but capture-stream not authorized for this Claude Code host process."
    - "playwright E2E (`pnpm test`) — `tests/cyboflow-day3-gate.spec.ts` imports vitest and breaks `playwright test` collection (pre-existing, unrelated to sprint); even when excluded, all other specs hit the same `electronTRPC` constraint."
  flows_deferred:
    - null

## Overridden

- task: TASK-652
  type: overridden
  bucket: actions
  dedup_key: main_workspace_better_sqlite3_abi_mismatch
  plan_ref: .soloflow/active/plans/orchestrator-and-trpc-router/TASK-652-plan.md
  action: "Run `pnpm electron:rebuild` to resolve better-sqlite3 NODE_MODULE_VERSION 136 vs 127 mismatch. After rebuild, re-run `cd main && pnpm exec vitest run src/orchestrator/__tests__/workflowRegistry.test.ts` to confirm the 25 DB-bootstrap failures (all on `new Database(:memory:)`) clear. Pre-existing env drift, identical failure mode on parent commit; TASK-652 is a pure-extraction refactor and only modified frontmatter parsing — 7/7 markdownFrontmatter and 9/9 workflowPromptReader tests pass."
  blocked_checks:
    - "AC4: workflowRegistry.test.ts (25 DB-instantiation tests) — pre-existing env block, not a TASK-652 regression"
  level: ground_truth
  severity: medium
  created_at: "2026-05-19T20:14:47.585Z"
  updated_at: "2026-05-19T20:14:47.585Z"
  override: "Known better-sqlite3 NODE_MODULE_VERSION mismatch (ABI 136 vs 127) — user-owned infra fix via pnpm electron:rebuild. Out of scope for TASK-663/664 (orchestrator/tRPC). Affected tests remain SKIPPED as in prior sprints."
  override_at: "2026-05-19T21:50:54.661Z"

- task: TASK-577
  type: overridden
  bucket: actions
  dedup_key: main_workspace_better_sqlite3_abi_mismatch
  plan_ref: .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-577-plan.md
  action: "Run `pnpm electron:rebuild` in .soloflow/worktrees/TASK-577 (or the merged main checkout) to rebuild better-sqlite3 against the active Node ABI. Until then, `pnpm --filter main test` fails with NODE_MODULE_VERSION 136 vs required 127 — pre-existing env drift, identical failure on parent commit ae78e34^, not caused by TASK-577's 5-line env-object edit. After rebuild, re-run `pnpm --filter main test` to confirm AC4 (exit 0). See FIND-SPRINT-014-16."
  blocked_checks:
    - "AC4: pnpm --filter main test exit 0"
  level: ground_truth
  severity: medium
  created_at: "2026-05-17T23:07:54.516Z"
  updated_at: "2026-05-17T23:07:54.516Z"
  override: "TASK-577 is already archived as done; deferred check (AC4: pnpm --filter main test exit 0) is environmental (better-sqlite3 NODE_MODULE_VERSION drift from Electron upgrade, not caused by TASK-577). Operator should run pnpm electron:rebuild when convenient; not blocking this sprint."
  override_at: "2026-05-18T03:27:35.909Z"

- task: TASK-578
  type: overridden
  bucket: actions
  action: "Re-run /soloflow:sprint with TASK-578 after SPRINT-014 (containing TASK-562) merges to main. TASK-578's prerequisite check evaluates shipped main state, so it cannot ride alongside TASK-562 in the same sprint."
  blocked_checks:
    - "\"prerequisite: Confirms TASK-562 has shipped on the producer side"
    - "so the consumer-side rename in AboutDialog will line up with the actual IPC response shape.\""
  level: ground_truth
  severity: high
  override: "SPRINT-014 with TASK-562 has shipped on main (merge 99058f4); the precondition that gated TASK-578's prerequisite check is now satisfied. Override is operational — TASK-578 will be re-verified when it next runs."
  override_at: "2026-05-18T03:27:33.077Z"

- task: TASK-555
  type: overridden
  bucket: actions
  action: "xcrun notarytool store-credentials AC_PASSWORD --apple-id <email> --team-id <team> --password <app-specific-password>; set APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD env vars."
  blocked_checks:
    - "prerequisite: Notarization requires Apple ID + team ID + app-specific password. Without these, electron-builder notarize step fails."
  level: ground_truth
  severity: high
  override: Notarization credentials are on the apple-signing-notarization-setup epic track (TASK-567/584/585); this sprint targets crystal-cuts-and-rebrand and does not exercise notarization.
  override_at: "2026-05-17T20:02:07.590Z"

- task: TASK-593
  type: overridden
  bucket: actions
  dedup_key: streamparser_fixtures_missing
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-593-plan.md
  action: "AC-6 for TASK-593 also fails on schemas.test.ts and typedEventNarrowing.test.ts because main/src/services/streamParser/__fixtures__/ contains only README.md (no JSON wire-format fixtures). This is TASK-594 scope (regenerate fixtures against Claude Agent SDK wire format). After TASK-594 lands, re-run `pnpm --filter main exec vitest run src/services/streamParser/__tests__/` and confirm the 19 ENOENT failures across schemas.test.ts and typedEventNarrowing.test.ts flip from FAIL to PASS. Pre-existed at parent commit bfce232 — not introduced by TASK-593."
  blocked_checks:
    - "AC-6 — streamParser/__tests__/schemas.test.ts and typedEventNarrowing.test.ts fail with ENOENT on __fixtures__/*.json"
  level: ground_truth
  severity: medium
  created_at: "2026-05-15T00:03:08.674Z"
  updated_at: "2026-05-15T00:03:08.674Z"
  override: "Deferred ground-truth check blocked on TASK-594 (stream parser fixture authoring), which is unrelated to the workflow-runs-and-day3-gate epic. Will be resolved when TASK-594 lands."
  override_at: "2026-05-15T04:26:25.559Z"

- task: TASK-588
  type: overridden
  bucket: actions
  dedup_key: better_sqlite3_node_module_version_mismatch
  plan_ref: .soloflow/active/plans/claude-agent-sdk-migration/TASK-588-plan.md
  action: "Run `pnpm electron:rebuild` from the repo root to rebuild better-sqlite3 against the current Node ABI (NODE_MODULE_VERSION 127 vs prebuilt 137). After rebuild, re-run `cd main && pnpm test -- approvalRouter` — TASK-588 leaves the case count at 8 (same as pre-task baseline), and a clean rebuild should turn the 8 collected-but-erroring tests into 8 passing tests. This env defect is documented in CLAUDE.md and pre-dates TASK-588 (identical failure reproduces on main pre-commit)."
  blocked_checks:
    - "AC#7 — pnpm test -- approvalRouter exits 0 (currently exits non-zero because better-sqlite3 throws before any test body runs)"
    - "AC-6 — streamParser/__tests__/rawEventsSink.test.ts (8 tests) fails on better-sqlite3 NODE_MODULE_VERSION mismatch, unrelated to TASK-593"
    - "AC#5 — rawEventsSink.test.ts (8 tests) failing on better-sqlite3 prebuilt ABI mismatch (NODE_MODULE_VERSION 136 vs 127)"
  level: ground_truth
  severity: high
  created_at: "2026-05-14T22:48:33.048Z"
  updated_at: "2026-05-15T01:37:53.798Z"
  affected_tasks:
    - TASK-588
    - TASK-593
    - TASK-594
  override: "Deferred ground-truth check requires user to run `pnpm electron:rebuild` (better-sqlite3 NODE_MODULE_VERSION mismatch) — environmental setup outside sprint scope, not blocking the workflow-runs-and-day3-gate epic."
  override_at: "2026-05-15T04:26:22.959Z"
