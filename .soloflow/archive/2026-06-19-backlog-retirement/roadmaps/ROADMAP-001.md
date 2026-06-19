---
id: ROADMAP-001
status: materialized
created: 2026-05-11T00:00:00Z
materialized_at: 2026-05-11T20:06:13Z
materialized_as: plans
title: "Cyboflow MVP — Cross-Workflow Review Queue"
vision: "A macOS desktop app that concentrates Claude Code tool-use approvals from parallel SoloFlow workflows into a single keyboard-driven review queue."
idea_ids: [IDEA-001, IDEA-002, IDEA-003, IDEA-004, IDEA-005, IDEA-006, IDEA-007, IDEA-008, IDEA-009, IDEA-010, IDEA-011, IDEA-012]
task_ids: [TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-051, TASK-052, TASK-053, TASK-054, TASK-055, TASK-056, TASK-101, TASK-102, TASK-103, TASK-151, TASK-152, TASK-153, TASK-154, TASK-155, TASK-201, TASK-202, TASK-203, TASK-204, TASK-205, TASK-251, TASK-252, TASK-253, TASK-254, TASK-255, TASK-301, TASK-302, TASK-303, TASK-304, TASK-305, TASK-351, TASK-352, TASK-353, TASK-354, TASK-355, TASK-401, TASK-402, TASK-403, TASK-404, TASK-405, TASK-406, TASK-407, TASK-451, TASK-452, TASK-453, TASK-454, TASK-455, TASK-501, TASK-502, TASK-503, TASK-504, TASK-551, TASK-552, TASK-553, TASK-554, TASK-555, TASK-556]
phases:
  - name: "Phase 1 — Orchestrator Foundation"
    status: approved
    milestone: "End of week 1 (day 5): one workflow runs in a worktree, Claude's stream-json output drives typed events through main-process orchestrator into a custom UI, and the day-3 gate is met — two runs in different workflows are each pausable and approvable in any order."
    target_timeline: "days 1-5 (week 1)"
    epics:
      - slug: "crystal-cuts-and-rebrand"
        idea_id: IDEA-001
        objective: "Strip Crystal substrate down to the surface Cyboflow actually uses, fix the inherited blockers that would compound on top of new code, and rebrand identity so signing/notarization can be set up against the real appId."
        scope:
          - "Delete Codex/OpenAI backend (codexPanel, codexManager, codexPanelManager, codex IPC, frontend codex panel components)"
          - "Delete Bull import and Bull branch in taskQueue.ts; remove bull dependency from package.json"
          - "Delete WorktreeNameGenerator API hop in taskQueue.ts; replace with deterministic naming hook for cyboflow/<workflow>/<runId8>"
          - "Delete Linux/Windows-conditional paths in PTY, filesystem, and packaging code"
          - "Hide (do not delete) rebase/squash UI entry points in worktree views; mark hidden methods with @cyboflow-hidden comment"
          - "Delete multi-panel-per-session UI surfaces (panel creation menus, panel bar add-panel control); preserve underlying panel data model temporarily"
          - "Rebrand: appId com.cyboflow.app, data dir ~/.cyboflow, ~/.cyboflow/sockets/, app icon placeholder, product name, README pin to Crystal HEAD commit"
        success_signal: "Repo builds and starts on macOS with no Codex/Bull/Linux-Windows code paths reachable; no rebase/squash buttons visible; data dir is ~/.cyboflow; `git grep -i codex` and `git grep -i bull` return only documentation"
        estimated_complexity: medium
        depends_on: []

      - slug: "apple-signing-notarization-setup"
        idea_id: IDEA-002
        objective: "Set up code signing, hardened runtime entitlements, and notarytool-based notarization on day 1-2 so packaging is a known-good operation by Milestone 2 rather than a week-2 cliff. Apple Developer enrollment lag (24-48h) makes this non-deferrable."
        scope:
          - "Enroll in / verify Apple Developer Program membership; create Developer ID Application certificate"
          - "Flip hardenedRuntime: true and notarize: true in electron-builder config"
          - "Author build/entitlements.mac.plist with allow-jit, network.client, files.user-selected.read-write, allow-unsigned-executable-memory (for node-pty subprocess spawn)"
          - "Replace build/afterSign.js stub with a notarytool submit call using keychain-stored credentials (xcrun notarytool store-credentials AC_PASSWORD)"
          - "First end-to-end test: produce a signed universal DMG, verify with lipo -info on the bundled .node binaries, verify Gatekeeper accepts on a clean macOS install"
        success_signal: "A signed, notarized universal DMG opens on a fresh macOS user account without Gatekeeper warnings; lipo -info confirms both x64 and arm64 slices in better-sqlite3.node and node-pty.node"
        estimated_complexity: medium
        depends_on:
          - "crystal-cuts-and-rebrand"

      - slug: "typed-stream-event-schema"
        idea_id: IDEA-003
        objective: "Freeze the corrected ClaudeStreamEvent discriminated union as the parser-boundary contract — snake_case fields, 4 result subtypes, system/compact variant, no fictional ErrorEvent, stream_event (not StreamDeltaEvent). Everything downstream is mechanical once this contract is locked."
        scope:
          - "Write shared/types/claudeStream.ts with the corrected discriminated union: system/init, system/api_retry, system/compact, assistant, user, result (4 subtypes), stream_event, plus unknown catch-all"
          - "Zod schemas in main/src/services/streamParser/schemas.ts with .passthrough() and snake_case keys matching actual JSON"
          - "Handle inconsistent tool-result content encoding via z.union([z.string(), z.array(...)])"
          - "Unit tests fixture-driven against captured real stream-json output covering each variant including compact and all 4 result subtypes"
        success_signal: "Captured fixtures from real Claude runs parse without warnings; unknown variants surface as the catch-all without crashing; TypeScript exhaustive-check passes on the union"
        estimated_complexity: small
        depends_on: []

      - slug: "stream-parser-to-main"
        idea_id: IDEA-005
        objective: "Move Crystal's renderer-side ClaudeMessageTransformer to main/ as ClaudeStreamParser, wire the parsing pipeline (LineBufferer → JSONParser → ZodNarrowing → EventRouter), and implement the triple-gate completion detector. This is the day-1 discipline that unblocks orchestrator-side event consumption."
        scope:
          - "Create main/src/services/streamParser/ with LineBufferer, JSONParser (drops parse errors with WARN), TypedEventNarrowing, and EventRouter (per-runId fanout via EventEmitter)"
          - "Replace renderer ClaudeMessageTransformer consumption with subscriptions to the main-process event emitter"
          - "Implement triple-gate completion: (child exited) AND (stdout EOF) AND (parser queue drained), with 30s watchdog grace before forcing failed"
          - "Append every parsed event to raw_events table (table created in cyboflow-schema-migration epic)"
          - "Force --permission-prompt-tool=approve mode (no --dangerously-skip-permissions default for Cyboflow runs)"
        success_signal: "A real Claude run streams typed events into raw_events; reducers in main can iterate the typed union exhaustively; a run with a missing result event still completes via the watchdog within 30s of child exit"
        estimated_complexity: medium
        depends_on:
          - "typed-stream-event-schema"
          - "cyboflow-schema-migration"

      - slug: "cyboflow-schema-migration"
        idea_id: IDEA-004
        objective: "Add the 5 new tables (workflows, workflow_runs, raw_events, messages, approvals) as a single numbered migration with indexes from day 1 — the 100k+ raw_events rows projected over a 1-day self-host make indexes mandatory in the initial schema, not a retrofit."
        scope:
          - "Single migration 006_cyboflow_schema.sql with IF NOT EXISTS guards, no FKs to Crystal tables"
          - "Indexes: raw_events(run_id, id), raw_events(event_type, run_id), approvals(status, created_at), workflow_runs(status, created_at)"
          - "State machine columns on workflow_runs supporting queued | starting | running | awaiting_review | stuck | completed | failed | canceled"
          - "Hand-write a db.transaction() helper for atomic awaiting_review co-writes (workflow_runs UPDATE + approvals INSERT under BEGIN IMMEDIATE with status guard)"
          - "Verify Crystal's migration runner applies numeric-prefixed files after the inline 003-005 migrations"
        success_signal: "Fresh install creates all 5 tables with indexes; query plans on raw_events(run_id, id DESC LIMIT 100) use the index; state-transition helper rejects forbidden transitions (e.g., completed→running)"
        estimated_complexity: small
        depends_on:
          - "crystal-cuts-and-rebrand"

      - slug: "orchestrator-and-trpc-router"
        idea_id: IDEA-006
        objective: "Wrap orchestration concerns in a single Orchestrator class with no Electron imports inside, exposed only via a typed tRPC router using trpc-electron (mat-sz fork v0.1.2). This is the discipline that preserves the team-tier extraction path and gives the renderer typed RPC."
        scope:
          - "Install trpc-electron@0.1.2, @trpc/server@^11, @trpc/client@^11, superjson, p-queue"
          - "Pin @trpc/server to a version containing PR #6161 subscription-leak fix (verify changelog)"
          - "Create main/src/orchestrator/ with Orchestrator class, start()/stop() lifecycle, no electron imports"
          - "Define tRPC router skeleton: cyboflow.runs (list, start, cancel, get), cyboflow.approvals (listPending, approve, reject), cyboflow.workflows (list, get), cyboflow.events (onStreamEvent, onApprovalCreated)"
          - "tRPC context carries an auth principal { userId: 'local' } as a forward-compat placeholder"
          - "Server-side 60Hz throttle on the onStreamEvent subscription broadcast; full fidelity persists to raw_events"
          - "Per-run p-queue({concurrency: 1}) registry keyed by runId; document the no-recursive-enqueue rule"
        success_signal: "Renderer can subscribe via tRPC and receive typed stream events for an active run; orchestrator module passes a typecheck with no electron imports; per-run queue serializes two simultaneous mutations correctly"
        estimated_complexity: medium
        depends_on:
          - "stream-parser-to-main"

      - slug: "approval-router-and-permission-fix"
        idea_id: IDEA-007
        objective: "Replace Crystal's no-timeout PermissionManager with ApprovalRouter that holds the socket reply under per-run mutex, enforces a 60-minute timeout that replies deny on the socket (never silent expiration), and handles boot-time recovery of stale awaiting_review runs. This is the highest-severity inherited bug fix and the load-bearing primitive for the queue."
        scope:
          - "Rename mcpPermissionBridge to cyboflowPermissionBridge, socket path to ~/.cyboflow/sockets/, MCP server name mcp__cyboflow-permissions__approve_permission"
          - "Implement ApprovalRouter in main/src/orchestrator/approvalRouter.ts replacing PermissionManager; consult workflow policy (frontmatter-parsed permission_mode), under per-run p-queue: transaction-write approvals row + transition workflow_runs to awaiting_review"
          - "60-minute setTimeout per pending approval that sends deny on the socket and updates the row to status=expired"
          - "clearPendingForRun(runId) called on cancel/fail/app-close: each pending approval gets a deny socket reply before PTY kill"
          - "Boot-time recovery pass: any workflow_runs with status=awaiting_review transitions to status=failed with reason='app_restart'"
          - "Race protection: status guard on the awaiting_review→running UPDATE so a canceled run cannot be revived by a late approval"
        success_signal: "A run that has been awaiting review for >60min auto-denies on the socket and the PTY exits cleanly; closing the app while an approval is pending sends deny on the socket within 1s; rebooting the app with an awaiting_review row in DB transitions it to failed at boot"
        estimated_complexity: high
        depends_on:
          - "cyboflow-schema-migration"
          - "orchestrator-and-trpc-router"

      - slug: "workflow-runs-and-day3-gate"
        idea_id: IDEA-008
        objective: "Wire workflow selection → worktree creation → Claude spawn with deterministic naming → typed events into the new orchestrator, and prove the day-3 gate: two runs in different SoloFlow workflows can both pause on tool-use approvals and be approved in any order. This is the hard milestone that validates the fork-path bet."
        scope:
          - "Workflow registry seeded with the 5 SoloFlow workflows (soloflow, planner, sprint, compound, prune); parse frontmatter for permission_mode"
          - "Worktree creation uses deterministic cyboflow/<workflow>/<runId8> scheme; worktrees live under <repo>/.cyboflow/worktrees/ with auto-written .gitignore entry"
          - "Per-run .mcp.json written with cyboflow-permissions bridge, CYBOFLOW_RUN_ID and CYBOFLOW_ORCH_SOCKET env vars, --strict-mcp-config flag"
          - "Minimal frontend: workflow picker, run start button, single run view showing parsed event stream from tRPC subscription"
          - "Two-run day-3 gate test: start a sprint run and a prune run; both hit tool-use approvals; approve the prune one first via direct tRPC mutation; sprint resumes independently when its approval is decided"
        success_signal: "Day-3 gate met: two runs in different workflows each pause on the socket bridge, can be approved in any order via tRPC mutation, and each resumes Claude correctly. If this gate fails, the greenfield-reset option triggers."
        estimated_complexity: high
        depends_on:
          - "approval-router-and-permission-fix"

  - name: "Phase 2 — Review Queue and Self-Host"
    status: approved
    milestone: "End of week 2 (day 10): the cross-workflow review queue is the primary UI surface, the MCP outbound server gives Claude sessions read access to queue state, and the author can self-host Cyboflow for at least 1 full working day (50-100 approvals across 6-8 runs) without falling back to Crystal/CLI."
    target_timeline: "days 6-10 (week 2)"
    epics:
      - slug: "review-queue-ui"
        idea_id: IDEA-009
        objective: "Ship the workspace-scoped cross-workflow review queue as the primary UI surface — keyboard-first (j/k/y/n) triage, oldest-first sort, blocking pin for >3min waits, collapsed repeated-same-run approval cards. This is the differentiator the entire fork exists to deliver."
        scope:
          - "<ReviewQueueView /> as the primary left-rail / top-tab; always visible"
          - "<PendingApprovalCard /> showing workflow name, tool name, payload preview, Claude's preceding rationale text, age"
          - "Keyboard navigation: j/k to move selection, y/n to approve/reject, with focus visible"
          - "Sort oldest-pending first; visually pin items whose run has been awaiting_review > 3min with 'blocked Nm' badge"
          - "Collapse repeated approvals from the same run with the same tool+payload signature into a single card with × count and Approve-all-in-this-run / Reject-all-in-this-run"
          - "Per-run 'approve rest of this run' action (scoped, not global)"
          - "NO global approve-all in v1 (deliberate omission — accidental bulk-delete risk)"
          - "reviewQueueSlice Zustand store fed by tRPC onApprovalCreated subscription with full-state resync on mount"
          - "Dock badge bound to queue.length with reconnect-resync to prevent desync"
          - "React error boundary wrapping <ReviewQueueView /> with restart-app affordance"
        success_signal: "User clears a 15-item queue in <60 seconds using only the keyboard; dock badge count matches queue.length after a renderer reload; a sprint run generating 8 repeated npm-test approvals appears as a single collapsed card"
        estimated_complexity: high
        depends_on:
          - "workflow-runs-and-day3-gate"

      - slug: "cyboflow-mcp-server"
        idea_id: IDEA-010
        objective: "Ship the outbound CyboflowMcpServer as a stdio subprocess giving Claude sessions a minimal read-mostly view of queue state. Templated from Crystal's existing mcpPermissionBridge pattern. Resist write-state tools in v1 — the human-in-the-loop is the product."
        scope:
          - "main/src/orchestrator/mcpServer/cyboflowMcpServer.ts as a stdio MCP subprocess, registered in the per-run .mcp.json alongside cyboflow-permissions"
          - "Tools: cyboflow_list_pending_approvals (read), cyboflow_get_run (read), cyboflow_submit_checkpoint (limited write — checkpoint marker only)"
          - "Subprocess connects to orchestrator over the private Unix socket; CYBOFLOW_RUN_ID / CYBOFLOW_ORCH_SOCKET disambiguate sender"
          - "asarUnpack pattern for the MCP server script so it can spawn from a packaged DMG"
          - "Crash isolation: subprocess errors logged to dedicated channel, never leak to Claude's stdout/stderr"
          - "App-boot health check: if the MCP server fails to start, surface a clear error rather than silently disabling outbound tools"
        success_signal: "A running Claude session can invoke cyboflow_list_pending_approvals and see queue state including approvals from other parallel runs; killing the MCP subprocess does not corrupt approval flow; packaged DMG spawns the server correctly from asar.unpacked"
        estimated_complexity: medium
        depends_on:
          - "workflow-runs-and-day3-gate"

      - slug: "stuck-detection-and-observability"
        idea_id: IDEA-011
        objective: "Detect cross-run deadlock (run awaiting_review >5min where the reviewer is itself paused on another run's tool call) and surface it as a stuck flag the user can see and act on. Add the minimum observability that prevents silent failure during the 1-day self-host."
        scope:
          - "Periodic check (60s interval) scanning approvals where status=pending AND created_at < now() - 5min"
          - "Detect self-deadlock and cross-run deadlock patterns; transition workflow_runs to status=stuck with stuck_reason"
          - "UI: stuck runs surfaced with a distinct visual state on the queue card and in the run list; user can cancel-and-restart"
          - "Notification on first stuck detection per session (collapsed thereafter to prevent fatigue)"
          - "Minimal 'why is this run stuck?' inspector: latest 10 raw_events for that run plus the pending approval payload"
        success_signal: "Synthetic cross-run deadlock (two runs each awaiting the other's tool result) gets flagged as stuck within 6 minutes; user can cancel a stuck run cleanly and the deny replies fire on the socket"
        estimated_complexity: medium
        depends_on:
          - "review-queue-ui"

      - slug: "first-run-onboarding-and-self-host-acceptance"
        idea_id: IDEA-012
        objective: "Polish first-run UX, document the onboarding card explaining the review queue, run the 1-day self-host bar, log every fallback to Crystal/CLI as a fix-or-defer, and ship the signed DMG. This is the MVP-done gate."
        scope:
          - "First-run onboarding card: 'Cyboflow pauses Claude when it needs to take an action. Approve or reject in this queue. Keyboard: j/k navigate, y/n decide.'"
          - "Auto-write .cyboflow/worktrees/ entry to .gitignore on project add"
          - "MCP server startup health surfaced in app status bar (green/yellow/red dot)"
          - "Self-host run: full working day using Cyboflow for soloflow/planner/sprint/prune/compound runs on real repos; log every fallback to Crystal/CLI; fix any blockers same-day or defer with explicit ROADMAP-002 follow-up"
          - "Produce, sign, notarize the v1.0.0 DMG; verify it opens on a clean macOS user without Gatekeeper warnings"
          - "Tag the Crystal commit in README; document the post-fork license posture (pure MIT, do not merge from Nimbalyst)"
        success_signal: "MVP-done bar achieved: 1 full working day used Cyboflow exclusively, no fallback to Crystal or raw Claude CLI; final signed DMG installed and launched on a fresh macOS account from the GitHub release page"
        estimated_complexity: medium
        depends_on:
          - "review-queue-ui"
          - "cyboflow-mcp-server"
          - "stuck-detection-and-observability"
          - "apple-signing-notarization-setup"

research_refs:
  - ROADMAP-001-research-ecosystem.md
  - ROADMAP-001-research-user-needs.md
  - ROADMAP-001-research-architecture.md
  - ROADMAP-001-research-risks.md
---

# Cyboflow MVP — Cross-Workflow Review Queue

## Executive Summary

Cyboflow is a macOS desktop app forked from `stravu/crystal` at HEAD that orchestrates Claude Code as a multi-agent workflow runner with one product differentiator: a workspace-scoped cross-workflow review queue. The thesis is that the scarce resource is human attention, not agent time. This roadmap delivers a 12-epic, 2-phase plan over 10 full-time working days (~80 productive hours) ending with a 1-day self-host acceptance gate.

Phase 1 (days 1-5) gets the orchestrator running end-to-end: Crystal cuts and rebrand, day-1 Apple Developer enrollment, the typed `ClaudeStreamEvent` schema (corrected for the snake_case / 4-subtype / no-fictional-ErrorEvent issues research surfaced), the parser refactored from renderer to main, the orchestrator wrapped behind a tRPC router with no Electron imports, the schema migration with day-1 indexes, the `ApprovalRouter` replacement for Crystal's no-timeout `PermissionManager`, and the day-3 gate (two runs in different workflows pausable and approvable in any order). Phase 2 (days 6-10) ships the differentiator: the keyboard-first review queue UI with collapsed-repeated-approval cards, the outbound `CyboflowMcpServer`, cross-run deadlock detection, and the 1-day self-host acceptance run that produces the signed, notarized DMG.

The research surfaced concrete sequencing constraints that override generic ordering. The corrected stream schema must freeze before parser code is written; Crystal's `PermissionManager` no-timeout bug is non-deferrable from day 1; Apple Developer enrollment lag (24-48h) forces signing setup into days 1-2; Crystal noise (Bull import, `WorktreeNameGenerator` API hop, Codex backend, multi-panel UI surfaces) must be cut before new features land on top. The roadmap front-loads high-uncertainty work (parser refactor, ApprovalRouter, day-3 gate) and back-loads polish. The 2-week budget is tight but achievable given Crystal provides 6 of 8 primitives; the day-3 gate is the explicit pivot point if the per-panel substrate fights the queue differentiator.

## Phase Details

### Phase 1: Orchestrator Foundation

**Milestone:** End of week 1 (day 5): one workflow runs in a worktree, Claude's stream-json output drives typed events through main-process orchestrator into a custom UI, and the day-3 gate is met — two runs in different workflows are each pausable and approvable in any order.
**Timeline:** days 1-5

#### Crystal Cuts and Rebrand (`crystal-cuts-and-rebrand`)

**Objective:** Strip the Crystal substrate down to the surface Cyboflow uses, fix the inherited blockers that would compound on top of new code, and rebrand identity so signing can be set up against the real appId.
**Scope:** Delete Codex/OpenAI backend; delete Bull import and `bull` dep; delete `WorktreeNameGenerator` API hop; delete Linux/Windows paths; hide rebase/squash UI entry points (preserve code with `@cyboflow-hidden` marker); delete multi-panel-per-session UI surfaces; rebrand to `com.cyboflow.app` / `~/.cyboflow/`.
**Success signal:** Repo builds and starts on macOS with no Codex/Bull/Linux-Windows paths reachable; data dir is `~/.cyboflow`; `git grep` confirms cuts landed.
**Complexity:** medium
**Dependencies:** none
**Key decisions:** Apply the doc's decision rule literally — delete misleading code (Codex, Bull, Linux/Windows, AI naming, multi-panel); hide harmless out-of-scope code (rebase/squash). Risks research flagged `bull` is still actually imported in `taskQueue.ts` even though docs claim otherwise, and `WorktreeNameGenerator` is still wired into the task queue — both must land in this first epic before new features build on them.

#### Apple Signing and Notarization Setup (`apple-signing-notarization-setup`)

**Objective:** Set up code signing, hardened runtime entitlements, and notarytool-based notarization on day 1-2 so packaging is known-good by Milestone 2.
**Scope:** Apple Developer Program enrollment / verification; Developer ID Application cert; flip `hardenedRuntime: true` and `notarize: true`; author `build/entitlements.mac.plist`; replace `afterSign.js` with a `notarytool submit` call; produce a first signed universal DMG and verify with `lipo -info`.
**Success signal:** A signed, notarized universal DMG opens on a fresh macOS user without Gatekeeper warnings; `lipo -info` confirms both arch slices in `.node` binaries.
**Complexity:** medium
**Dependencies:** crystal-cuts-and-rebrand (for stable appId)
**Key decisions:** Risks research surfaced that the inherited `package.json` ships `hardenedRuntime: false` and `notarize: false` (Crystal's dev shortcut), and Apple Developer enrollment takes 24-48 hours. Pushing this to week 2 risks failing the MVP gate on a packaging technicality after the product is otherwise done. Done early, every subsequent build is signed.

#### Typed Stream Event Schema (`typed-stream-event-schema`)

**Objective:** Freeze the corrected `ClaudeStreamEvent` discriminated union as the parser-boundary contract. Architecture research found the design doc's union has 7 wrong-cased variants — must be corrected before any parser code is written.
**Scope:** `shared/types/claudeStream.ts` with `system/init`, `system/api_retry`, `system/compact`, `assistant`, `user`, `result` (4 subtypes), `stream_event`, plus an `unknown` catch-all. Zod schemas with `.passthrough()` and snake_case keys. Handle `tool_result.content` as `string | array`. Fixture tests against captured real output.
**Success signal:** Captured fixtures parse without warnings; unknown variants surface via the catch-all without crashing; TypeScript exhaustive check passes.
**Complexity:** small
**Dependencies:** none
**Key decisions:** Architecture research caught that the design doc has `camelCase` field names while actual JSON uses `snake_case`, the `result` event has 4 subtypes not 1, the `system/compact` variant exists but isn't in the design doc union, `StreamDeltaEvent` should be `stream_event`, and `ErrorEvent` is fictional. Fixing these in the contract before the parser is the cheapest moment to fix them.

#### Cyboflow Schema Migration (`cyboflow-schema-migration`)

**Objective:** Add the 5 new tables in a single numbered migration with day-1 indexes. The 100k+ `raw_events` rows projected over a 1-day self-host make indexes mandatory in the initial migration, not a retrofit.
**Scope:** `006_cyboflow_schema.sql` with `workflows`, `workflow_runs`, `raw_events`, `messages`, `approvals`; indexes on `raw_events(run_id, id)`, `raw_events(event_type, run_id)`, `approvals(status, created_at)`, `workflow_runs(status, created_at)`; state machine columns supporting the 8-state enum; transaction helper for atomic `awaiting_review` co-writes (UPDATE + INSERT under `BEGIN IMMEDIATE` with status guard).
**Success signal:** Fresh install creates all 5 tables with indexes; `EXPLAIN QUERY PLAN` confirms index usage; state-transition helper rejects forbidden transitions.
**Complexity:** small
**Dependencies:** crystal-cuts-and-rebrand (Crystal's migration runner must be untouched)
**Key decisions:** No FKs to Crystal's tables — the design doc says "coexist but not source of truth"; FK constraints would couple Cyboflow's lifecycle to Crystal's session lifecycle. Single migration file (not split) avoids partial-apply states. Indexes on day 1 because risks research projected ~115k `raw_events` rows for a 1-day self-host.

#### Stream Parser to Main (`stream-parser-to-main`)

**Objective:** Move the parser from renderer to main, wire the pipeline, and implement the triple-gate completion detector. This is the discipline that unblocks orchestrator-side event consumption.
**Scope:** `main/src/services/streamParser/` with `LineBufferer`, `JSONParser` (errors dropped with WARN), Zod narrowing, `EventRouter` (per-runId fanout via EventEmitter); renderer subscribes via tRPC; triple-gate completion `(child exited) AND (stdout EOF) AND (parser drained) + 30s watchdog`; raw events appended to `raw_events`; force `approve` mode for all Cyboflow-spawned Claude processes (no `--dangerously-skip-permissions` default).
**Success signal:** A real Claude run streams typed events into `raw_events`; orchestrator reducers iterate the typed union exhaustively; a run with a missing `result` event completes via the watchdog within 30s.
**Complexity:** medium
**Dependencies:** typed-stream-event-schema, cyboflow-schema-migration
**Key decisions:** Risks research confirmed issue #1920 is closed-not-planned — the watchdog is permanent, not a workaround. Architecture research found Crystal defaults to `--dangerously-skip-permissions` unless `effectiveMode === 'approve'` — this default must be inverted for Cyboflow runs.

#### Orchestrator and tRPC Router (`orchestrator-and-trpc-router`)

**Objective:** Wrap orchestration concerns in a single `Orchestrator` class with no Electron imports, exposed only via a typed tRPC router using `trpc-electron`. Discipline that preserves the team-tier extraction path.
**Scope:** Install `trpc-electron@0.1.2`, `@trpc/server@^11` (pinned to include PR #6161 subscription-leak fix), `superjson`, `p-queue`; `main/src/orchestrator/` with `start()`/`stop()`; tRPC router for `cyboflow.runs`, `cyboflow.approvals`, `cyboflow.workflows`, `cyboflow.events`; auth principal placeholder; 60Hz server-side throttle on `onStreamEvent`; per-run `p-queue({concurrency: 1})` registry with documented no-recursive-enqueue rule.
**Success signal:** Renderer subscribes via tRPC and receives typed stream events; orchestrator module typechecks with no Electron imports; per-run queue serializes two simultaneous mutations correctly.
**Complexity:** medium
**Dependencies:** stream-parser-to-main
**Key decisions:** Use `mat-sz/trpc-electron` (not `jsonnull/electron-trpc`) per ecosystem research — the original is unmaintained for v11. Pin `@trpc/server` to a version including PR #6161 to avoid the v11 subscription memory leak risks research flagged. Server-side throttle is mandatory because IPC has no built-in backpressure.

#### Approval Router and Permission Fix (`approval-router-and-permission-fix`)

**Objective:** Replace Crystal's no-timeout `PermissionManager` with `ApprovalRouter` — the single highest-severity inherited bug fix and the load-bearing primitive for the queue.
**Scope:** Rename `mcpPermissionBridge` → `cyboflowPermissionBridge`, socket path `~/.cyboflow/sockets/`, tool name `mcp__cyboflow-permissions__approve_permission`; `ApprovalRouter` in `main/src/orchestrator/approvalRouter.ts` replacing `PermissionManager` (parse workflow policy, write `approvals` row + transition `awaiting_review` atomically under per-run mutex); 60-minute timeout per pending approval that sends `deny` on the socket; `clearPendingForRun(runId)` on cancel/fail/app-close; boot-time recovery (stale `awaiting_review` → `failed` with reason `app_restart`); status-guard on `awaiting_review → running` UPDATE.
**Success signal:** A run awaiting review for >60min auto-denies on the socket and the PTY exits cleanly; closing the app with a pending approval sends deny within 1s; rebooting with an `awaiting_review` row transitions it to `failed`.
**Complexity:** high
**Dependencies:** cyboflow-schema-migration, orchestrator-and-trpc-router
**Key decisions:** Ecosystem and risks research both flagged `PermissionManager.requestPermission` has no timeout (`permissionManager.ts:73` is a bare Promise with no reject path) — this is non-negotiable for day 1. Architecture research clarified that `--permission-prompt-tool` takes an MCP tool name (not a socket path), and the socket path is passed to the bridge subprocess via `argv[3]` (not `MCP_PERMISSION_SOCKET` env var as the design doc claims). Adopt Crystal's working `argv` convention.

#### Workflow Runs and Day-3 Gate (`workflow-runs-and-day3-gate`)

**Objective:** Wire workflow selection → worktree → Claude spawn → typed events end-to-end; prove the day-3 gate. This is the explicit Phase 1 milestone the entire fork-vs-greenfield decision hinges on.
**Scope:** Workflow registry seeded with 5 SoloFlow workflows; frontmatter-parsed `permission_mode` per workflow; deterministic `cyboflow/<workflow>/<runId8>` naming; worktrees under `<repo>/.cyboflow/worktrees/`; per-run `.mcp.json` with `cyboflow-permissions`, `CYBOFLOW_RUN_ID`, `CYBOFLOW_ORCH_SOCKET`, `--strict-mcp-config`; minimal frontend (workflow picker, run start, single run view via tRPC subscription); two-run gate test.
**Success signal:** Two runs in different workflows pause on the socket bridge, can be approved in any order via tRPC mutation, and each resumes Claude correctly.
**Complexity:** high
**Dependencies:** approval-router-and-permission-fix
**Key decisions:** Use `--strict-mcp-config` (ecosystem research recommendation) to prevent user-installed global MCP servers from interfering with the permission tool. If the day-3 gate fails — if hitting it requires touching 20+ files in the per-panel architecture — the greenfield-reset option triggers per the brief's risk tolerance.

### Phase 2: Review Queue and Self-Host

**Milestone:** End of week 2 (day 10): the cross-workflow review queue is the primary UI surface, the MCP outbound server is live, and the author can self-host Cyboflow for at least 1 full working day without falling back to Crystal/CLI.
**Timeline:** days 6-10

#### Review Queue UI (`review-queue-ui`)

**Objective:** Ship the workspace-scoped cross-workflow review queue as the primary UI surface — the differentiator the entire fork exists to deliver.
**Scope:** `<ReviewQueueView />` always-visible left rail / top tab; `<PendingApprovalCard />` with workflow, tool, payload preview, Claude's rationale, age; keyboard nav (j/k/y/n); oldest-first sort; pinned-blocking for runs awaiting >3min with `blocked Nm` badge; collapsed repeated-approval cards (same run + same tool+payload signature) with per-run approve-all / reject-all; per-run "approve rest" action (scoped); no global approve-all; `reviewQueueSlice` Zustand store fed by tRPC subscription with full-state resync on mount; dock badge bound to `queue.length` with reconnect-resync; React error boundary around the queue view.
**Success signal:** User clears a 15-item queue in <60 seconds via keyboard only; dock badge matches `queue.length` after renderer reload; a sprint run generating 8 repeated `npm test` approvals appears as a single collapsed card.
**Complexity:** high
**Dependencies:** workflow-runs-and-day3-gate
**Key decisions:** User-needs research drove every UX choice. 93% approval rate means the queue is an attention-concentration interface (rote approval must be effortless), not a safety interface. Collapsed repeated approvals address the rajiv.com "14 identical prompts" failure mode. NO global approve-all in v1 — accidental prune bulk-delete during sprint approval clearing is the highest-harm failure mode. Per-run "approve rest" is the safer alternative. j/k/y/n keyboard model proven by Superhuman and claude-control. React error boundary fixes a risks-research finding that the inherited Crystal codebase has zero error boundaries.

#### Cyboflow MCP Server (`cyboflow-mcp-server`)

**Objective:** Ship the outbound `CyboflowMcpServer` as a stdio subprocess giving Claude sessions a minimal read-mostly view of queue state.
**Scope:** `main/src/orchestrator/mcpServer/cyboflowMcpServer.ts` as stdio MCP subprocess; tools `cyboflow_list_pending_approvals` (read), `cyboflow_get_run` (read), `cyboflow_submit_checkpoint` (limited write); connects to orchestrator over Unix socket using `CYBOFLOW_RUN_ID` / `CYBOFLOW_ORCH_SOCKET`; `asarUnpack` config for packaged DMG; crash isolation (errors don't leak to Claude stdout); app-boot health check.
**Success signal:** A running Claude session invokes `cyboflow_list_pending_approvals` and sees queue state including approvals from other parallel runs; killing the MCP subprocess doesn't corrupt approval flow; packaged DMG spawns the server from `asar.unpacked`.
**Complexity:** medium
**Dependencies:** workflow-runs-and-day3-gate
**Key decisions:** Template from Crystal's existing `mcpPermissionBridge` pattern — ecosystem research corrected the design doc's claim that "Crystal has no outbound MCP server today"; it does, and Cyboflow can lift the architecture. Resist write-state tools (e.g., "approve from inside Claude") per design doc §5.6 — the human-in-the-loop is the product.

#### Stuck Detection and Observability (`stuck-detection-and-observability`)

**Objective:** Detect cross-run deadlock and surface stuck runs as a recoverable state, plus the minimum observability that prevents silent failure during the 1-day self-host.
**Scope:** 60s periodic scan of `approvals` where status=pending AND created_at < now() - 5min; detect self-deadlock and cross-run deadlock; transition to `stuck` with `stuck_reason`; UI distinct visual state and cancel-and-restart action; notification on first-stuck-per-session (collapsed thereafter); minimal "why stuck?" inspector showing last 10 `raw_events` and pending approval payload.
**Success signal:** Synthetic cross-run deadlock flagged as stuck within 6 minutes; cancel-stuck-run sends socket deny replies cleanly.
**Complexity:** medium
**Dependencies:** review-queue-ui
**Key decisions:** Design doc §5.7 makes 5-min cross-run deadlock detection non-negotiable. Risks research flagged that "stuck" has no surfacing path defined; this epic closes that gap. Notification collapse follows the user-needs research finding that notification fatigue is itself a risk vector.

#### First-Run Onboarding and Self-Host Acceptance (`first-run-onboarding-and-self-host-acceptance`)

**Objective:** Polish first-run UX, run the 1-day self-host bar, ship the signed DMG. This is the MVP-done gate.
**Scope:** Onboarding card explaining the review queue; auto-write `.cyboflow/worktrees/` to `.gitignore`; MCP server health in status bar; full-day self-host with log of every Crystal/CLI fallback (fix same-day or defer to ROADMAP-002); produce + sign + notarize v1.0.0 DMG; verify clean-account install; tag Crystal commit in README; document license posture.
**Success signal:** 1 full working day used Cyboflow exclusively, no fallback; final signed DMG installs and launches on a fresh macOS account from the GitHub release.
**Complexity:** medium
**Dependencies:** review-queue-ui, cyboflow-mcp-server, stuck-detection-and-observability, apple-signing-notarization-setup
**Key decisions:** The 1-day self-host is the final acceptance epic (not a separate phase) per the brief's explicit guidance. Risks research flagged five failure surfaces only a long sustained run will expose: tRPC subscription leaks, WAL checkpoint stalls, zombie PTYs, dock badge desync, `p-queue` recursive self-deadlock. Same-day-fix-or-defer policy keeps the gate honest.

## Dependency Graph

```
Phase 1:
  crystal-cuts-and-rebrand ──┬─→ apple-signing-notarization-setup
                             ├─→ cyboflow-schema-migration ─┐
                             │                              │
  typed-stream-event-schema ─┴─→ stream-parser-to-main ─────┤
                                                            │
                                  orchestrator-and-trpc-router
                                                            │
                                  approval-router-and-permission-fix
                                                            │
                                  workflow-runs-and-day3-gate

Phase 2:
  workflow-runs-and-day3-gate ──┬─→ review-queue-ui ──┐
                                ├─→ cyboflow-mcp-server│
                                                       ├─→ stuck-detection-and-observability
                                                       │
                                  apple-signing-notarization-setup
                                                       │
                                  first-run-onboarding-and-self-host-acceptance
```

## Key Risks and Mitigations

| Risk | Severity | Mitigation | Phase Affected |
|------|----------|------------|----------------|
| Inherited `PermissionManager` has no timeout — app hangs indefinitely on pending approval if window closes | high | `ApprovalRouter` epic implements 60-min timeout with socket deny + `clearPendingForRun` + boot recovery | Phase 1 |
| Apple Developer enrollment lag (24-48h) blocks first signed build | high | `apple-signing-notarization-setup` starts day 1-2, not week 2 | Phase 1 → Phase 2 ship |
| `bull` still imported in `taskQueue.ts` despite docs claiming to delete; Redis transitive dep weight | medium | `crystal-cuts-and-rebrand` deletes import and dependency on day 1 | Phase 1 |
| Day-3 gate fails: per-panel architecture fights the queue, requires touching 20+ files | high | Explicit day-3 milestone (`workflow-runs-and-day3-gate`); greenfield reset is on the table if gate fails | Phase 1 |
| tRPC v11 subscription memory leak (~1MB/s/run, exposed in 1-day self-host) | high | Pin `@trpc/server` to version including PR #6161 fix; server-side 60Hz throttle | Phase 1 (install) / Phase 2 (validation) |
| Stream-json schema drift (Anthropic ships without SemVer); design doc has wrong casing + missing variants | medium | `typed-stream-event-schema` corrects union; Zod `.passthrough()` + unknown catch-all; never crash on unrecognized | Phase 1 |
| `result` event missing (closed not planned) | medium | Triple-gate completion `(child exited) AND (stdout EOF) AND (parser drained) + 30s watchdog` in `stream-parser-to-main` | Phase 1 |
| 100k+ `raw_events` rows in 1-day self-host; WAL checkpoint starvation | medium | Day-1 indexes on `(run_id, id)` and `(event_type, run_id)` in initial migration | Phase 1 |
| Universal-binary native module mismatch | medium | `@homebridge/node-pty-prebuilt-multiarch` ships fat binaries; `lipo -info` verification in signing epic | Phase 1 |
| Notification fatigue from 50-100 approvals/day | medium | Collapsed repeated-same-run cards; pinned-blocking only above 3min threshold; first-stuck-per-session notification | Phase 2 |
| Accidental approve-all across mixed prune-delete + sprint-test approvals | high | NO global approve-all in v1; per-run "approve rest" is scoped alternative | Phase 2 |
| React error boundaries absent in Crystal — a queue UI crash blocks all approvals | medium | Error boundary around `<ReviewQueueView />` in `review-queue-ui` epic | Phase 2 |
| `p-queue` recursive self-deadlock if approval handler triggers transition that re-enters queue | medium | Document the no-recursive-enqueue rule in `orchestrator-and-trpc-router` epic; status-changed events flow via EventEmitter, not via re-entering the per-run mutex | Phase 1 / Phase 2 |
| Crystal is deprecated — no upstream fixes after fork | low | Accepted; design doc §3 explicitly addresses this; pin Crystal commit in README | All phases |
| `SimpleQueue.close()` abandons in-flight jobs creating zombie PTYs on quit | medium | Documented for ROADMAP-002 fix path; partial mitigation via inherited Crystal zombie-process boot detection; surface during self-host acceptance epic | Phase 2 |

## Decisions Made

1. **Fork `stravu/crystal` at HEAD over greenfield** — Chosen over building from scratch.
   - Rationale: Crystal provides 6 of 8 required primitives in production-tested form (PTY, worktrees, DB, packaging, permission-bridge architecture, zombie detection). Greenfield estimated at 2× calendar time per design doc §3 with no architectural wins for the v1 differentiator.
   - Reversibility: Hard — day-3 gate exists specifically to detect if the fork is fighting the differentiator, in which case reset is on the table.

2. **Adopt `mat-sz/trpc-electron@0.1.2` over `jsonnull/electron-trpc`** — Chosen over the original package or building manual typed-IPC wrappers.
   - Rationale: Ecosystem research confirmed `jsonnull/electron-trpc` has no tRPC v11 support (PR #194 open since July 2025, unmerged) and is effectively unmaintained for v11. `trpc-electron` is the only v11-compatible option with release history.
   - Reversibility: Moderate — tRPC call sites are unchanged across libraries; swapping the IPC link is mechanical.

3. **Corrected `ClaudeStreamEvent` schema before parser code** — Chosen over implementing the design doc's union verbatim.
   - Rationale: Architecture research caught 7 errors in the design doc's union (camelCase vs snake_case, 4 result subtypes vs 1, missing `system/compact`, fictional `ErrorEvent`, `StreamDeltaEvent` vs `stream_event`). Fixing in the contract is cheapest; downstream code is mechanical.
   - Reversibility: Easy — schema is a single file change, propagated by TypeScript exhaustive checks.

4. **Apple Developer signing setup on days 1-2, not week 2** — Chosen over deferring to packaging time.
   - Rationale: Risks research surfaced 24-48h Apple enrollment lag and 5-30min notarization round-trip per iteration. A week-2 first attempt risks failing MVP gate on a packaging technicality.
   - Reversibility: N/A (lifecycle decision).

5. **Day-3 gate as explicit Phase 1 milestone** — Chosen over rolling into a single "end of week 1" check.
   - Rationale: Brief and design doc §7 both name this as the fork-path mitigation gate. Surfacing it inside the phase forces the right test on the right day; if the gate fails, greenfield reset triggers before week 2 sunk-cost takes over.
   - Reversibility: Hard — failing the gate means abandoning fork work and resetting.

6. **NO global approve-all in v1; per-run "approve rest" only** — Chosen over a queue-wide approve-all action.
   - Rationale: User-needs research identified accidental prune bulk-delete during mixed sprint+prune approval clearing as the highest-harm failure mode. Per-run scoping is safe because the user has context about what one run is doing.
   - Reversibility: Easy — re-add the global action in v1.1 with a confirmation step if user feedback demands it.

7. **Keep Crystal's `ipcMain.handle` IPC for inherited surface; tRPC for `cyboflow.*` only** — Chosen over a full IPC migration.
   - Rationale: Design doc §5.8 explicitly says "don't refactor what works." Migrating 1,872 lines of `session.ts` and 1,391 lines of `git.ts` to tRPC is out of scope for a 2-week MVP. Half-migrated state risk is mitigated by explicit `cyboflow.*` namespace.
   - Reversibility: Easy — Crystal IPC can be migrated incrementally post-MVP if team-tier extraction needs it.

8. **Single migration file for all 5 new tables (no FKs to Crystal tables)** — Chosen over per-table migrations or FK-referenced design.
   - Rationale: Architecture research found Crystal's migration system is hybrid (inline + numbered files) with gaps in numbering. Single file `006_cyboflow_schema.sql` with `IF NOT EXISTS` guards is reviewable and avoids partial-apply states. FK to `sessions` would couple Cyboflow's lifecycle to Crystal's session model and complicate eventual Crystal-table cleanup.
   - Reversibility: Moderate — adding FKs in v2 is a schema change; removing them in v2 would be harder.

9. **Force `approve` permission mode for all Cyboflow Claude runs (override Crystal's `--dangerously-skip-permissions` default)** — Chosen over respecting Crystal's existing default.
   - Rationale: Architecture research found `ClaudeCodeManager.buildCommandArgs()` defaults to `--dangerously-skip-permissions` if `effectiveMode !== 'approve'`. For Cyboflow's queue-centric thesis every run must use `approve` mode.
   - Reversibility: Easy — single flag change.

## Dropped Scope

Items intentionally excluded from this roadmap and the v1 MVP, drawn from design doc §8 and the brief's scope boundary:

- **Auto-update via `electron-updater`** — Distribution is direct DMG download from GitHub release for v1. Revisit in v1.1.
- **Codex / OpenAI integration** — Multi-provider support, if wanted, should be designed deliberately rather than inherited. v1 is Claude-only. The Codex backend is deleted, not hidden.
- **Linux or Windows builds** — macOS-only v1. Every cross-platform line is one to debug for a platform not running. Reconsider when team-tier ships and there's volume demand.
- **AI-driven worktree naming** — Replaced with deterministic `cyboflow/<workflow>/<runId8>`. AI naming added an API hop, failed offline, produced non-deterministic names. The deterministic scheme is sortable, greppable, namespaced (`git branch -D 'cyboflow/*'` scrubs cleanly).
- **Crystal's rebase/squash UI** — Hidden, not deleted. Plausible v2 features but irrelevant to v1's "concentrate human attention" thesis. Hiding preserves the code without burning the optionality.
- **Multi-panel-per-session UI surfaces** — Deleted from UI. Cyboflow's model is 1:1 (run = agent = worktree); the multi-panel UI would actively confuse the product story. Underlying data model preserved temporarily to avoid same-week refactor.
- **Cross-machine sync, cloud agents, custom DAG editor, workflow versioning** — All require backend infrastructure or a different product story. Reconsider with team-tier (v2).
- **Multi-user, authentication, SSO, team review queues** — Backend-tier features. v1 user is solo; no auth principal beyond `{ userId: 'local' }` placeholder (built into tRPC context for forward compatibility).
- **Edit-plan and request-changes flows** — Approve/Reject only in v1. Edit-plan adds a third action whose UX is non-trivial; cut for scope. Reconsider in v1.1.
- **Cost estimation from historical data** — Static estimates fine, or omitted entirely. Historical cost UI is a v2 polish layer.
- **Streaming partial JSON for tool inputs** — Parse on `content_block_stop` only. `--include-partial-messages` deltas are stored to `raw_events` but not reduced into partial approval cards.
- **Global approve-all in the queue** — Deliberately omitted in v1 as the highest-harm UX trap (user-needs research). Per-run "approve rest" is the safer alternative shipped instead.
- **Backend extraction to a Node service** — Preserved as architectural option via the orchestrator/UI split, the tRPC boundary, and the auth principal placeholder, but explicitly budgeted as ~1 week of v2 team-tier work. Not free.
- **Custom workflow authoring / agent customization** — v1 ships the 5 fixed SoloFlow workflows only. Custom workflows are a v2 product question.
