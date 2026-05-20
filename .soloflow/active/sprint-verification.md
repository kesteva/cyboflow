---
sprint: SPRINT-024
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
visual_web_note: "Electron renderer port 4521 not listening; existing Electron PID 22778 has 0 windows; orchestrator forbids spawning pnpm dev"
visual_macos_note: "Peekaboo MCP reachable but Electron app shows 0 windows; peekaboo CLI not installed for fallback"
regressions_count: 0
flows_tested: 0
flows_deferred: 3
---

## Sprint Verification Report

- **Sprint:** SPRINT-024
- **Base SHA:** 7b84b16d8853f451434b891780984518a42b5b73
- **Sprint-verification file:** .soloflow/active/sprint-verification.md

### Visual Verification

- **visual_mobile:** skipped_user_preference — config `verification.visual_mobile=false`
- **visual_web:** skipped_unable — Electron renderer at http://localhost:4521 not reachable. A zombie Electron process (PID 22778, ~11.5h elapsed, state SN) has 0 windows; frontend/backend debug logs stale from 17:38 (~3.5h old at verification start at 23:39). Orchestrator directive forbids spawning `pnpm dev`. The Vite renderer cannot bootstrap standalone (per CLAUDE.md: depends on preload-injected electronTRPC).
- **visual_macos:** skipped_unable — Peekaboo MCP reachable, but `mcp__peekaboo__list(app=Electron)` returns 0 windows. `peekaboo` CLI not installed (no fallback). Nothing to capture.
- **Flows tested:** 0
- **Flows deferred:** 3 (awaiting human action; queued in `human-review-queue.md` under `dedup_key: electron_renderer_unreachable`)
- **Failures:** none
- **Deferred:**
  - RichOutputView Claude SDK output rendering (TASK-637 + bb926cd fix) — awaiting human `pnpm dev` smoke
  - MessagesView session_info card population (FIND-SPRINT-024-5) — awaiting human `pnpm dev` smoke
  - panels:get-json-messages consumer path still works after sessions:get-json-messages deletion (TASK-648) — awaiting human `pnpm dev` smoke

### Integration Tests

Ran the canonical CI gate: `pnpm typecheck`, `pnpm lint`, and the full `pnpm run test:unit` chain (main vitest + frontend vitest + schema-parity script + schema-parity tests + build tests). Playwright E2E (`pnpm test`) NOT run — its `webServer` config requires `pnpm electron-dev`, which is blocked by the same orchestrator directive.

**Results:**

| Gate | Status | Detail |
|---|---|---|
| typecheck | PASS | 3 workspaces (main, frontend, shared), no errors |
| lint | PASS | 0 errors, 208 warnings (pre-existing baseline) |
| main vitest | FAIL (pre-existing) | 494/499 pass; 5 failures all pre-existing at base SHA (see below) |
| frontend vitest | PASS | 218/218 pass (includes new `parseJsonMessage.test.ts`) |
| schema-parity script | PASS | OK (silent exit 0) |
| schema-parity tests | PASS | 3/3 subtests pass |
| build tests | PASS | Both signing-posture cases pass |

**Main vitest failures — all 5 pre-existing at base SHA `7b84b16`:**

1. `src/database/__tests__/cyboflowSchema.test.ts > 006_cyboflow_schema — workflow_runs reconciler > rebuilds the table when worktree_path is NOT NULL (canonical is nullable) or stuck_detected_at orphan column exists` — `stuck_detected_at` orphan column not removed after rebuild. **Pre-existence proof:** `main/src/database/` tree is byte-identical between base SHA and HEAD (no commits during SPRINT-024 touch this path). The "fix" commit `d3142db` ("fix: stop reconciliation from dropping stuck_detected_at column") predates the base SHA.
2. `src/orchestrator/__tests__/runExecutor.test.ts > lifecycle transitions > onLifecycleTransition routes each phase to the right transition helper` — `running` spy called 2x instead of 1x.
3. `src/orchestrator/__tests__/runExecutor.test.ts > RunExecutor.bridgeEvents — source arg integration > source arg: lifecycleTransitions.running() fires when source emits output event` — `running` spy called 2x instead of 1x.
4. `src/orchestrator/__tests__/runExecutor.test.ts > RunExecutor.bridgeEvents — source arg integration > source absent: bridgeEvents short-circuits; running() is not called` — `running` spy called 1x instead of 0x.
5. `src/orchestrator/__tests__/runExecutor.test.ts > panelId/runId alignment — integration with RunEventBridge > bridge drops output event when panelId has run- prefix (old broken behaviour)` — `running` spy called 1x instead of 0x.

**Pre-existence proof for runExecutor.test.ts failures:**

- `main/src/orchestrator/runExecutor.ts` was NOT touched during SPRINT-024 (`git log 7b84b16..HEAD -- main/src/orchestrator/runExecutor.ts` returns nothing).
- The most recent change to `runExecutor.ts` was `715b6c9` ("fix: transition to running pre-spawn; silence Crystal validation for cyboflow runs") — in SPRINT-022, BEFORE base SHA. That commit's title strongly suggests it altered when `running` fires, which would cause exactly these assertion failures against the pre-existing test expectations.
- TASK-646 (commit `24c451a`) DID touch `runExecutor.test.ts`, but the diff is a pure logger fixture swap (`makeLogger()` → `makeSpyLogger()`). The failing assertions (`expect(running).toHaveBeenCalledOnce()`, `expect(running).not.toHaveBeenCalled()`) are on transition-helper spies, NOT logger spies, and those lines are unchanged. `makeSpyLogger` and the deleted local `makeLogger` are functionally equivalent (`vi.fn()` per level).

These failures are gaps in the pre-existing test suite or in stale test expectations vs. updated production semantics from SPRINT-022. They are **NOT** regressions introduced by SPRINT-024 and do not gate this sprint's merge.

### Regressions requiring attention

None. All test failures pre-exist at base SHA and originate from changes made before SPRINT-024 started. The sprint's 10 completed tasks (1 UI integration adapter + 9 backend/test refactors) do not introduce new failures in the test suite.

### Notes for sprint-closer / human reviewer

1. **Visual smoke remains unverified.** TASK-637 is the only UI-touching change in this sprint. Its UnifiedMessage restoration (commit `bb926cd`) was verified at the per-task level but the cross-sprint visual smoke (RichOutputView rendering + MessagesView session_info card + panels:get-json-messages consumer path after TASK-648's deletion) is queued for human verification. See `dedup_key: electron_renderer_unreachable` in `.soloflow/human-review-queue.md`.

2. **Pre-existing test failures should be addressed in a follow-up sprint.** Five tests are red at base SHA. The schema-test failure (`stuck_detected_at` orphan) and the four `running` lifecycle-transition assertion failures appear to describe stale test expectations against production code that legitimately changed in SPRINT-022 (commit `715b6c9`). A dedicated sprint should either fix the production code (if behavior is wrong) or update the test assertions (if production behavior is intentional).

3. **Frontend tests are clean** including the new `parseJsonMessage.test.ts` (5/5 pass) added by TASK-637 — the adapter unit-tests itself successfully even if its UI consumer path needs visual smoke.

4. **Lint baseline:** 208 warnings is the pre-existing baseline (matches prior sprint counts); 0 errors. No new lint regressions.
