---
pending_count: 8
buckets:
  decisions: 0
  actions: 0
  testing: 7
  deferred_visual: 1
items: []
---
# Human Review Queue

## Decisions

_No items._

## Actions

_No items._

## Testing

- task: TASK-056
  type: manual_acceptance_test
  bucket: testing
  plan_ref: .soloflow/active/plans/apple-signing-notarization-setup/TASK-056-plan.md
  doc_ref: docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md
  action: "Clean-account Gatekeeper acceptance test for Cyboflow-0.3.5-macOS-universal.dmg (SHA256 6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494). Follow the 13-step procedure already scaffolded into docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md (create clean macOS user account or VM; copy DMG via /Users/Shared/; verify quarantine flag; mount/drag to /Applications; run spctl --assess on test account; double-click verify no Gatekeeper modal; create session inside app; check ps for PTY child; check Console.app for codesign errors; verify ~/.cyboflow/cyboflow.db or ~/.crystal/crystal.db written; fill placeholders; commit; re-run /soloflow:review-queue --testing-only to re-verify)."
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

## Overridden

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
