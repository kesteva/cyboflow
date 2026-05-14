---
pending_count: 5
buckets:
  decisions: 0
  actions: 0
  testing: 5
  deferred_visual: 0
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

## Deferred Visual

_No items._
