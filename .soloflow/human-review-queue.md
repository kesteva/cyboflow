---
pending_count: 19
buckets:
  decisions: 1
  actions: 3
  testing: 11
  deferred_visual: 4
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

## Actions

- task: TASK-554
  type: human_needed
  plan_ref: .soloflow/active/plans/first-run-onboarding-and-self-host-acceptance/TASK-554-plan.md
  verdict_notes: Manual 8-hour self-host acceptance run. Executor scaffolded the empty log on the TASK-554 worktree branch (cherry-pick or recreate it).
  action: "Perform a full working-day self-host session using Cyboflow exclusively for SoloFlow workflows. Fill in .soloflow/active/acceptance/SELF-HOST-LOG.md per the plan: log every run, log every Crystal/CLI fallback before working around it, complete the Risk-Check Findings section after Cmd+Q (zombie PTY count, .db-wal size, raw_events row count + EXPLAIN), triage each fallback (fix-same-day vs defer-to-ROADMAP-002), set the final Verdict line."
  severity: high
  level: goal_backward
  bucket: actions

- task: SPRINT-015
  type: config_gap
  bucket: actions
  dedup_key: visual_web_electron_unreachable
  plan_ref: .soloflow/active/sprints/SPRINT-015/sprint.json
  action: "verification.visual_web is true and playwright_target.kind is 'electron', but the Playwright MCP tools cannot launch an Electron app — they drive a Chromium browser only. Navigating to http://localhost:4521 fails per CLAUDE.md (renderer depends on preload-injected electronTRPC and cannot bootstrap standalone). To unblock visual verification: either (a) set verification.visual_web=false for this repo, (b) add a launch script that exposes the Electron renderer over CDP for Playwright to attach to, or (c) run the existing tests/*.spec.ts suite manually via `pnpm test` after `pnpm dev`."
  blocked_checks:
    - Pass 1 visual_web — TASK-630 cascading IPCResponse type-narrowing across 22 UI component files cannot be exercised end-to-end by the sprint verifier under the current tooling
  level: sprint
  severity: low
  created_at: "2026-05-18T00:00:00.000Z"

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
  level: visual
  severity: medium
  created_at: "2026-05-15T06:37:20.926Z"
  updated_at: "2026-05-17T00:56:05.145Z"
  affected_tasks:
    - TASK-354
    - TASK-404
    - TASK-455

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

## Deferred Visual

- sprint: SPRINT-007
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  action: "Live Electron end-of-sprint smoke. Prereq: run `pnpm electron:rebuild` (resolves better-sqlite3 NODE_MODULE_VERSION 137 vs 136 mismatch that crashed Electron during the SPRINT-007 verifier run). Then `pnpm dev`, create a session, run a prompt, open the Claude panel, and confirm `cyboflow-frontend-debug.log` contains no TypeError matching /Cannot read properties of undefined .*'some'/ and the panel renders messages. This is the load-bearing cross-task confirmation for SPRINT-007 (TASK-568 + TASK-572 jointly resolve FIND-SPRINT-005-9). Overlaps the existing per-task entries for TASK-568 and TASK-572 — running this one flow satisfies both."
  blocked_checks:
    - "End-of-sprint cross-task verification: opening the Claude panel after a Claude run does not throw .some-of-undefined (FIND-SPRINT-005-9 closure)"
  level: requirements
  severity: high

- sprint: SPRINT-010
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  dedup_key: visual_web_electron_renderer_needs_full_electron
  action: "End-of-sprint visual smoke for the review-queue-ui epic (TASK-401..TASK-407). The Vite renderer at http://localhost:4521 cannot bootstrap standalone — it requires Electron's preload-injected `electronTRPC` global (frontend/src/utils/trpcClient.ts uses `ipcLink` from `trpc-electron/renderer`). Run `pnpm dev` to launch Electron, then drive the six flows: (1) ReviewQueueView empty state, (2) PendingApprovalCard render with a realistic approval payload, (3) Blocking vs Pending section partitioning and the group variant, (4) j/k navigation focus ring (TASK-404), (5) y/n approve/reject keyboard, (6) approveRestOfRun group-card action (TASK-406). Confirm `cyboflow-frontend-debug.log` shows no errors and the dock badge reflects pending count (TASK-407). Alternative: grant Warp Screen Recording, flip `verification.visual_macos=true`, and re-run via Peekaboo MCP."
  blocked_checks:
    - "End-of-sprint cross-task visual verification of review-queue-ui flows (ReviewQueueView, PendingApprovalCard, group variant, j/k/y/n keyboard, approveRestOfRun, dock-badge sync)"
  level: visual
  severity: medium
  created_at: "2026-05-15T18:30:00.000Z"
  updated_at: "2026-05-15T18:30:00.000Z"

- sprint: SPRINT-013
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  dedup_key: visual_web_electron_renderer_needs_full_electron_sprint013
  action: "End-of-sprint visual smoke for the stuck-detection + onboarding + MCP-health-indicator sprint (TASK-501..504, TASK-551..553). The Vite renderer at http://localhost:4521 cannot bootstrap standalone — it requires Electron's preload-injected `electronTRPC` global (see CLAUDE.md, frontend/src/utils/trpcClient.ts uses `ipcLink` from `trpc-electron/renderer`). Run `pnpm dev` to launch Electron, then drive the seven flows: (1) StuckBadge surfaces on a PendingApprovalCard when a stuck event fires (TASK-501+502). (2) Cancel-and-restart button on a stuck card triggers the cancelAndRestart mutation and the card transitions to a new run within the per-run p-queue (TASK-502). (3) useStuckNotifications system notification fires once per session for the first stuck event (TASK-503). (4) 'Why stuck' button on a stuck card opens StuckInspectorModal with the four sections (transcript tail / approvals timeline / store snapshot / Cancel-and-restart CTA) rendered from getStuckInspection (TASK-504). (5) OnboardingCard renders for first-time users in ReviewQueueView, shows j/k/y/n hint, dismisses on 'Got it' AND on first y/n keypress, then never re-appears after preference write (TASK-551). (6) Creating a new project auto-writes `.cyboflow/worktrees/` to that project's .gitignore (TASK-552 — verifiable via filesystem, but UI confirmation that project creation succeeds without error is part of the same flow). (7) MCP server health dot in the StatusBar at the app shell footer cycles green/yellow/red with the live OrchestratorHealth status, tooltip surfaces lastError (TASK-553). Confirm `cyboflow-frontend-debug.log` shows no errors after each flow. Alternative: grant Warp Screen Recording, flip `verification.visual_macos=true`, and re-run via Peekaboo MCP."
  blocked_checks:
    - "End-of-sprint cross-task visual verification of stuck-detection flows (StuckBadge surface, cancel-and-restart button, useStuckNotifications fire, StuckInspectorModal 4 sections)"
    - "End-of-sprint cross-task visual verification of onboarding flow (OnboardingCard mount, 'Got it' dismiss path, y/n keypress dismiss path, never-re-appear preference contract)"
    - "End-of-sprint cross-task visual verification of MCP health indicator in StatusBar (green/yellow/red transitions, lastError tooltip)"
    - "Project creation gitignore-write smoke (project:create succeeds and `.cyboflow/worktrees/` appears in the project's .gitignore)"
  level: visual
  severity: medium
  created_at: "2026-05-17T17:35:00.000Z"
  updated_at: "2026-05-17T17:35:00.000Z"
  affected_tasks:
    - TASK-501
    - TASK-502
    - TASK-503
    - TASK-504
    - TASK-551
    - TASK-552
    - TASK-553

- sprint: SPRINT-014
  type: deferred_visual
  bucket: deferred_visual
  source: shadow-sprint-verifier
  dedup_key: visual_web_electron_renderer_needs_full_electron_sprint014
  action: "End-of-sprint visual smoke for the crystal-cuts-and-rebrand sprint (TASK-560/561/562/565/566/576/577/579). The Vite renderer at http://localhost:4521 cannot bootstrap standalone — it requires Electron's preload-injected `electronTRPC` global (CLAUDE.md; frontend/src/utils/trpcClient.ts uses `ipcLink` from `trpc-electron/renderer`). Verifier env has no Playwright/Electron binary on PATH and no live `pnpm dev` to attach to. Run `pnpm dev` to launch Electron, then drive four flows: (1) About dialog: open AboutDialog and confirm the 'Data Directory' row renders the path (tests the TASK-562 IPC-rename cross-task contract — producer in main/src/ipc/updater.ts emits `cyboflowDirectory`, consumer in frontend/src/components/AboutDialog.tsx reads `cyboflowDirectory`). (2) Settings modal: open Settings, confirm header reads 'Cyboflow Settings', 'Cyboflow Attribution' section is visible, the 'Include Cyboflow footer in commits' checkbox toggles + persists (tests TASK-561 + TASK-565 — settings write should round-trip the `enableCyboflowFooter` key and saved commits should carry the buildCommitFooter() output). (3) Update dialog (when an update is available, or via the 'Check for updates' button): confirm prose says 'A new version of Cyboflow is available.' and 'You are running the latest version of Cyboflow!' (TASK-560). (4) Create a session, run any prompt that produces a commit, then `git log -1 --pretty=%B` on the worktree and confirm the commit body ends with the canonical Cyboflow footer from buildCommitFooter (TASK-565 byte-level contract). Confirm `cyboflow-frontend-debug.log` shows no errors after each flow. Alternative: grant Warp Screen Recording, flip `verification.visual_macos=true`, and re-run via Peekaboo MCP."
  blocked_checks:
    - End-of-sprint cross-task visual verification of AboutDialog cyboflowDirectory IPC rename (TASK-562 producer × consumer)
    - End-of-sprint cross-task visual verification of Settings modal cyboflow rebrand + enableCyboflowFooter round-trip (TASK-560 × TASK-561)
    - End-of-sprint cross-task visual verification of UpdateDialog prose rebrand (TASK-560)
    - End-of-sprint cross-task visual verification of buildCommitFooter byte-level output on a real commit (TASK-565)
  level: visual
  severity: medium
  created_at: "2026-05-17T13:02:37.000Z"
  updated_at: "2026-05-17T13:02:37.000Z"
  affected_tasks:
    - TASK-560
    - TASK-561
    - TASK-562
    - TASK-565
    - TASK-566
    - TASK-576
    - TASK-577
    - TASK-579

## Overridden

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
