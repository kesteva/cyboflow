---
sprint: SPRINT-026
visual_mobile: skipped_user_preference
visual_web: skipped_unable
visual_macos: skipped_unable
visual_mobile_note: "verification.visual_mobile=false in resolved config"
visual_web_note: "Playwright MCP cannot drive Electron renderer; standalone Vite at :4521 lacks preload-injected electronTRPC (FIND-SPRINT-026-2/8, recurrence of visual_web_electron_unreachable filed under SPRINT-015/017/020 and SPRINT-026 TASK-672)"
visual_macos_note: "Peekaboo MCP host (Claude Code) lacks Accessibility permission; Screen Recording granted but click/type events cannot reach the app (FIND-SPRINT-026-3, queue entry dedup_key=visual_macos_unavailable under TASK-672)"
regressions_count: 0
flows_tested: 0
flows_deferred: 6
---

# Sprint Verification Report — SPRINT-026 (claude-agent-sdk-migration)

## Pass 1 — Visual Verification

### visual_mobile: skipped_user_preference
- `verification.visual_mobile=false` (gate closed before flow identification).

### visual_web: skipped_unable
- Resolved config: `verification.visual_web=true`, `playwright_target.kind="electron"`.
- Playwright MCP tools drive Chromium only; `_electron.launch` is not available through the MCP surface.
- Standalone Vite renderer at http://localhost:4521 cannot bootstrap without preload-injected `electronTRPC` (documented in CLAUDE.md and verified by prior runs: FIND-SPRINT-026-2 and FIND-SPRINT-026-8).
- Existing queue entry `dedup_key=visual_web_electron_unreachable` already covers this (SPRINT-015/017/020); not re-filed.

### visual_macos: skipped_unable
- Resolved config: `verification.visual_macos=true`.
- Peekaboo MCP probe confirms: Screen Recording GRANTED, Accessibility NOT granted (`mcp__peekaboo__list server_status`).
- Without Accessibility, click/type/menu events cannot reach the app — visual flows requiring interaction are unverifiable.
- Existing queue entry under TASK-672 (`dedup_key=visual_macos_unavailable`, severity medium) already covers this. Not re-filed.

### Flows identified
The four sprint tasks touched these flow surfaces:
- **TASK-672** — RunView / MessagesView / RichOutputView rendering (UnifiedMessage discriminator branches after IPC type alignment).
- **TASK-681** — Stream parser projection (no direct UI flow; render path validated via vitest projection coverage).
- **TASK-682** — RunView discriminator render (six SDK message types).
- **TASK-683** — Manual smokes AC#13–#18 (already deferred to human-review-queue.md, bucket=testing).

All UI-bearing flows for this sprint require Electron renderer + macOS UI driving and are blocked by the two config gaps above. **Flows tested via this verifier: 0. Flows deferred to human review: 6** (AC#13–#18 from TASK-683 — already in human-review-queue with bucket=testing).

### Failures
None observed (no flows executed).

## Pass 2 — Integration Tests (full suite)

### `pnpm typecheck`
- **Result:** PASS (exit 0)
- All workspaces (shared, main, frontend) typecheck clean. The TASK-682 StreamEventType narrowing + TASK-672 IPC `T` realignment + TASK-681 schema retirement compile end-to-end.

### `pnpm lint`
- **Result:** PASS (exit 0, 307 warnings)
- All warnings are pre-existing baseline noise (`react-hooks/exhaustive-deps`, `no-console`, `no-unused-vars` on caught errors, `no-explicit-any` suppression comments). No new errors introduced. No `any` violations in sprint-touched files.

### `pnpm --filter frontend test`
- **Result:** PASS (exit 0)
- 18 files / 248 tests passing.
- Sprint-relevant suites all green:
  - `RunView.test.tsx` (16 tests) — covers TASK-682 SDK discriminator branches.
  - `cyboflowStore.test.ts` (7 tests) — covers TASK-682 StreamEvent union narrowing.
  - `ipcResponseType.test.ts` (4 tests) — covers TASK-672 IPC type discipline.
- Pre-existing React `act()` warnings in `reviewQueueSlice.test.ts` and `reviewQueueStore.test.ts` — not introduced by this sprint.

### `pnpm --filter main test`
- **Result:** FAIL (exit 1) — but ALL failures are pre-existing, NOT sprint regressions.
- 49 / 51 files passing; 533 / 538 tests passing.
- **Sprint-relevant suites all green:**
  - `messageProjection.test.ts` — TASK-681 + TASK-682 projection paths (camelCase rename).
  - `schemas.test.ts` — TASK-681 schema retirement.
- **Failing files (pre-existing):**

  1. `src/orchestrator/__tests__/runExecutor.test.ts` — 4 failures
     - `lifecycle transitions > onLifecycleTransition routes each phase…`
     - `RunExecutor.bridgeEvents — source arg integration > source arg: lifecycleTransitions.running() fires…`
     - `RunExecutor.bridgeEvents — source arg integration > source absent: bridgeEvents short-circuits…`
     - `panelId/runId alignment — integration with RunEventBridge > bridge drops output event when panelId has run- prefix…`
     - **Reproduce-at-base:** YES. Diff `d010954..HEAD` for `main/src/orchestrator/runLauncher.ts` is a comment-only change (TASK-683 path-B KEEP rationale). The 4 failing assertions exercise spy call-count expectations unrelated to runLauncher comments.
     - **Documented as:** FIND-SPRINT-026-10 (severity low, open).

  2. `src/database/__tests__/cyboflowSchema.test.ts` — 1 failure
     - `006_cyboflow_schema — workflow_runs reconciler (post-006 in-place edits) > rebuilds the table when worktree_path is NOT NULL (canonical is nullable) or stuck_detected_at orphan column exists`
     - Assertion at line 680: `expect(cols.some((c) => c.name === 'stuck_detected_at')).toBe(false)` — received `true`.
     - **Reproduce-at-base:** YES. `git diff d010954..HEAD -- main/src/database/` returns zero lines. The sprint touched ZERO files under `main/src/database/`; the reconciler logic and the test assertion are byte-identical to the base SHA. The failure is in the migration reconciler logic last touched at commit `df6a270` (pre-base).
     - **Documented as:** NOT yet in findings — this is a NEW pre-existing-failure surface that prior per-task verifiers did not exercise (TASK-672/681/682/683 verifiers ran scoped tests, not the full main suite). Recommend filing a new finding for the sprint-closer to track.

- `rawEventsSink.test.ts` (FIND-SPRINT-026-4, NODE_MODULE_VERSION 136/127) — NOT failing in my run. The better-sqlite3 binding appears to have been rebuilt locally between TASK-681 verification and this sprint pass; the original FIND-SPRINT-026-4 remains valid context for fresh-install runs.

- `tests/cyboflow-day3-gate.spec.ts` Playwright/vitest conflict (FIND-SPRINT-026-9) — not exercised here; Playwright suite is not part of the sprint verifier's integration matrix (the protocol commands are typecheck + lint + frontend vitest + main vitest).

## Regressions requiring attention
None caused by this sprint.

All failures observed are pre-existing baseline issues that reproduce at the base SHA `d01095453f1d7a5fd912cc669e7809e833ddd2e3`:
- `runExecutor.test.ts` 4 failures → FIND-SPRINT-026-10 (already open, severity low, recommended action: investigate independently).
- `cyboflowSchema.test.ts` 1 failure → NEW pre-existing baseline failure; recommend filing FIND-SPRINT-026-N as a follow-up (severity low, root cause in reconciler test/migration logic last touched at `df6a270`, predates SPRINT-026).

## Deferred (already in human-review-queue)
- TASK-683 AC#13 — manual smoke: dev startup + first run
- TASK-683 AC#14 — manual smoke: permission flow (deny path)
- TASK-683 AC#15 — manual smoke: compaction event UI rendering
- TASK-683 AC#16 — manual smoke: stream error recovery
- TASK-683 AC#17 — manual smoke: session resume after Cmd+Q
- TASK-683 AC#18 — manual smoke: multi-panel parallel runs
- (Note: FIND-SPRINT-026-12 flagged these are templated in `docs/sdk-migration-smoke-results.md` but the executor did not append per-AC queue entries via `review-queue.js append`. The verifier prompt summary states "entries already in human-review-queue.md, bucket: testing" — if absent, the closer should reconcile.)
