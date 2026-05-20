---
id: TASK-683
idea: IDEA-014
status: in-flight
created: "2026-05-20T00:00:00Z"
files_owned:
  - main/src/orchestrator/runLauncher.ts
  - main/src/orchestrator/__tests__/runLauncher.test.ts
  - docs/sdk-migration-smoke-results.md
  - main/package.json
  - main/src/services/permissionManager.ts
  - main/src/services/streamParser/eventRouter.ts
  - main/src/services/streamParser/messageProjection.ts
  - main/src/services/streamParser/rawEventsSink.ts
  - main/src/services/streamParser/typedEventNarrowing.ts
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/orchestrator/runExecutor.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/orchestrator/preToolUseHookHelper.ts
  - main/src/orchestrator/runEventBridge.ts
  - main/src/orchestrator/permissionModeMapper.ts
  - main/src/index.ts
  - frontend/src/utils/cyboflowApi.ts
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/stores/cyboflowStore.ts
  - shared/types/claudeStream.ts
  - shared/types/approval.ts
  - main/src/services/streamParser/index.ts
  - main/src/services/streamParser/schemas.ts
  - tests/cyboflow-stream-publisher.spec.ts
  - tests/cyboflow-day3-gate.spec.ts
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
acceptance_criteria:
  - criterion: "`@anthropic-ai/claude-agent-sdk` is declared as a direct dependency in `main/package.json` at version ≥ 0.2.x."
    verification: "grep -nE '\"@anthropic-ai/claude-agent-sdk\":\\s*\"\\^0\\.[2-9]' main/package.json returns exactly one line."
  - criterion: The legacy MCP permission bridge build script `main/build-cyboflow-permission-bridge.js` is absent from the repo.
    verification: "test ! -e main/build-cyboflow-permission-bridge.js (exit 0). Equivalent: ls main/build-cyboflow-permission-bridge.js 2>/dev/null prints nothing."
  - criterion: All four stream-json parser source files are absent under main/src/services/streamParser/.
    verification: "Each of the following commands exits 0 — test ! -e main/src/services/streamParser/lineBufferer.ts; test ! -e main/src/services/streamParser/jsonParser.ts; test ! -e main/src/services/streamParser/streamParser.ts; test ! -e main/src/services/streamParser/completionDetector.ts."
  - criterion: "The stream-json `__fixtures__/*.json` corpus directory is absent under `main/src/services/streamParser/`."
    verification: "test ! -d main/src/services/streamParser/__fixtures__ (exit 0)."
  - criterion: The four surviving streamParser modules remain in main/src/services/streamParser/.
    verification: Each of the following commands exits 0 — test -f main/src/services/streamParser/eventRouter.ts; test -f main/src/services/streamParser/messageProjection.ts; test -f main/src/services/streamParser/rawEventsSink.ts; test -f main/src/services/streamParser/typedEventNarrowing.ts.
  - criterion: "`permissionManager.ts` has zero imports of MCP-bridge code and no SDK/MCP-specific types leak into permissionManager or review-queue UI."
    verification: "grep -rnE 'cyboflowPermissionBridge|build-cyboflow-permission-bridge|McpBridge' main/src/services/permissionManager.ts frontend/src/components/cyboflow returns 0 matches."
  - criterion: The stale `epic 7+` wiring-proof comment in `main/src/orchestrator/runLauncher.ts` is gone OR replaced with a comment that accurately describes the current SDK-wired state (RunExecutor is wired; SDK events flow via the runEventBridge).
    verification: "grep -nE 'epic 7\\+' main/src/orchestrator/runLauncher.ts returns 0 matches."
  - criterion: "The decision on the synthetic `run_started` 'wiring proof' event is recorded: either the synthetic publish call at runLauncher.ts:145-149 is removed (replaced exclusively by real SDK events from runEventBridge), OR a comment at that site explicitly justifies why it stays as a UI-bootstrap aid. The decision is documented in the verification report (docs/sdk-migration-smoke-results.md, new dated section)."
    verification: "Two-part: (a) grep -nE \"type: 'run_started'\" main/src/orchestrator/runLauncher.ts returns 0 hits, OR a comment within 5 lines of that emission begins with 'KEEP:' explaining the rationale. (b) grep -n 'Synthetic run_started decision' docs/sdk-migration-smoke-results.md returns ≥ 1 hit."
  - criterion: "`pnpm typecheck` exits 0 from the repo root."
    verification: Run `pnpm typecheck` and confirm exit code 0.
  - criterion: "`pnpm lint` exits 0 from the repo root."
    verification: Run `pnpm lint` and confirm exit code 0.
  - criterion: "`pnpm test:unit` exits 0 from the repo root."
    verification: "Run `pnpm test:unit` and confirm exit code 0 (covers main + frontend vitest + schema verify + test:build)."
  - criterion: "`pnpm test` (Playwright smoke + spec suite) exits 0 from the repo root."
    verification: Run `pnpm test` and confirm exit code 0.
  - criterion: "Manual smoke 1 — `pnpm dev` launches the Electron app and a new Claude panel can be created, prompted, and streams responses end-to-end (including partial-message events visible in the panel)."
    verification: "Visual: tester records the panel id, the prompt text, and the count of streamed events in the verification report. Programmatic: `cyboflow-backend-debug.log` shows `ClaudeCodeManager` SDK query started log + ≥ 1 `stream_event` or assistant event for that panel."
  - criterion: "Manual smoke 2 — A tool call is intercepted by the SDK `PreToolUse` hook, routed through `ApprovalRouter` into the review queue, and is approvable/deniable from the UI without code changes to the review-queue UI."
    verification: "Visual: tester triggers a tool call (e.g. prompt 'list files in this folder'), confirms the review-queue UI shows the request, approves it, and the tool completes. Programmatic: `cyboflow-backend-debug.log` contains a `routePreToolUseThroughApprovalRouter` invocation and an `ApprovalRouter.requestApproval`-derived row in `approvals`."
  - criterion: "Manual smoke 3 — Session resume across a panel restart works: kill the panel mid-conversation, restart, the next message continues the prior session via `options.resume`."
    verification: "Visual: tester sends a prompt, kills the panel, reopens it, sends a follow-up that references the prior turn. Programmatic: query `sessions.claude_session_id` for the panel; the second invocation passes `resume: <session_id>` to query() (visible in `cyboflow-backend-debug.log` as 'resuming with sessionId=<id>')."
  - criterion: Manual smoke 4 — `pnpm dev` works with `claude` removed from `$PATH`. No CLI binary dependency.
    verification: "Tester filters `claude` out of PATH using the per-process filter recorded in docs/sdk-migration-smoke-results.md ('PATH Isolation' section, Option B), confirms `which claude` returns exit 1, then launches `pnpm dev` and repeats smoke 1. App launches; panel prompt-and-stream works."
  - criterion: "Manual smoke 5 — Workflow runs emit REAL SDK stream events (not just the synthetic `run_started` wiring-proof event). Starting a workflow from the cyboflow tab produces ≥ 2 distinct event types in the RunView event log (e.g. `system`, `assistant`, `result`, `stream_event`)."
    verification: "Visual: tester starts a workflow run from the cyboflow UI, observes the RunView event log; report records the list of unique `type` values seen. Must include at least one of: `system`, `assistant`, `user`, `result`, `stream_event`. Programmatic: query SELECT DISTINCT type FROM raw_events WHERE run_id = '<id>' returns ≥ 2 SDK-shaped types."
  - criterion: "Manual smoke 6 — The review queue UI, panel UI, and run lifecycle behave identically to pre-migration from a user's perspective (no regressions visible in normal use)."
    verification: "Tester walks through: create panel → prompt → tool approval → resume → workflow run start → workflow run complete. Records any UX deltas (none expected) in the verification report."
  - criterion: "The sibling test at main/src/orchestrator/__tests__/runLauncher.test.ts remains green. If the synthetic `run_started` emission is removed (per AC 8 path A), the test is updated to assert the new contract (no synthetic event published) instead of being deleted, OR the test is moved into a `describe.skip` with a comment naming this task. If the emission is kept (path B), the test is unchanged."
    verification: "Run `pnpm --filter main test -- --run main/src/orchestrator/__tests__/runLauncher.test.ts` and confirm exit code 0. Inspect diff of main/src/orchestrator/__tests__/runLauncher.test.ts against HEAD~1 — if AC 8 path A taken, diff shows the assertion updated, not removed-then-test-deleted."
  - criterion: "A dated verification report section is appended to `docs/sdk-migration-smoke-results.md` capturing: today's date, the tester's name, the git SHA, the prerequisite-check output, PATH-isolation result, the 6 manual smoke outcomes, the synthetic-event decision (KEEP/REMOVE + rationale), and the typecheck/lint/test command outputs (or 'all exit 0')."
    verification: "grep -nE '^## Verification — 2026-05' docs/sdk-migration-smoke-results.md returns ≥ 1 hit. Section contains subheadings for each smoke + the synthetic-event decision."
depends_on:
  - TASK-681
  - TASK-682
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: true
  justification: "The sibling test `main/src/orchestrator/__tests__/runLauncher.test.ts` (line 508-594) asserts on the literal `run_started` event. If AC 8 resolves to 'remove the synthetic event' (path A), this test MUST be updated to assert the new contract (no synthetic publish) rather than silently deleted. If AC 8 resolves to 'keep the synthetic event' (path B), the existing test is unchanged but must still be re-run as a smoke. Either way, this test is in `files_owned`. No new test files are created — this task is verification-driven, not feature-driven. The 6 manual smokes are deliberately not Playwright-automated: they require live UI interaction (panel create + prompt streaming, review-queue intercept with click-through, session resume across kill/restart, PATH manipulation) that exceed the cost/benefit of writing new E2E flows for a one-time verification gate."
  targets:
    - behavior: "RunLauncher.launch's publisher contract matches whichever path AC 8 selects (synthetic run_started kept OR removed)."
      test_file: main/src/orchestrator/__tests__/runLauncher.test.ts
      type: unit
prerequisites:
  - check: "test -d ~/.claude || test -n \"$ANTHROPIC_API_KEY\""
    fix: "Run `claude` once interactively to populate ~/.claude credential store, OR export ANTHROPIC_API_KEY in your shell."
    description: The SDK uses the same credential store as `claude -p`. Manual smokes 1-3 and 5 will fail with an auth error otherwise.
    blocking: true
  - check: "grep -q '\"@anthropic-ai/claude-agent-sdk\"' main/package.json"
    fix: pnpm --filter main add @anthropic-ai/claude-agent-sdk@^0.2.141
    description: The SDK must be declared as a direct dependency in the main workspace — verified by AC 1 but probed here so the executor can fail fast if the dep was accidentally removed during TASK-681 cleanup.
    blocking: true
  - check: "test -f main/dist/index.js || test -f main/dist/main/src/index.js"
    fix: "pnpm build:main"
    description: "`pnpm dev` requires the main process to be compiled at least once. Without it the Vite renderer comes up but Electron cannot bootstrap."
    blocking: false
  - check: "command -v pnpm >/dev/null 2>&1"
    fix: "Install pnpm: `npm install -g pnpm@10.11.1` (matches the version recorded in docs/sdk-migration-smoke-results.md)."
    description: All verification commands route through pnpm scripts.
    blocking: true
---
# Integration smoke and visual verify — SDK substrate end-to-end

## Objective

Execute the final acceptance gate for the `claude-agent-sdk-migration` epic. Walk the 9 success-signal criteria from `EPIC-claude-agent-sdk-migration.md` (lines 87-97), translating each into a machine-checkable or human-checkable verification step. The task is verification-driven: it does NOT write new production code, but it MAY patch hygiene issues discovered in-flight (specifically: stale comments and the synthetic `run_started` decision). Output is a dated verification-report section appended to `docs/sdk-migration-smoke-results.md` plus minor in-line patches to `main/src/orchestrator/runLauncher.ts` (and its sibling test, if the synthetic-event decision warrants it). This task PRESUMES TASK-681 (parser stub retirement) and TASK-682 (`unknown`-tag retirement) are complete and merged into the same branch — execute it last among the three.

## Implementation Steps

1. **Prerequisite probe (manual).** Run the four `prerequisites[]` checks from the frontmatter in your shell. If any blocking prereq fails, stop and resolve before proceeding.

2. **Inventory the deletion gates (success signal 6).** Run from repo root:
   ```bash
   for f in lineBufferer.ts jsonParser.ts streamParser.ts completionDetector.ts; do
     test -e "main/src/services/streamParser/$f" && echo "STILL PRESENT: $f" || echo "deleted: $f"
   done
   test -d main/src/services/streamParser/__fixtures__ && echo "STILL PRESENT: __fixtures__/" || echo "deleted: __fixtures__/"
   test -e main/build-cyboflow-permission-bridge.js && echo "STILL PRESENT: bridge build script" || echo "deleted: bridge build script"
   ```
   All five lines should print `deleted:`. If any prints `STILL PRESENT:`, halt — the prior epic work is incomplete and TASK-683 cannot proceed.

3. **Inventory the survival gates (success signal 6 cont'd).** Run:
   ```bash
   for f in eventRouter.ts messageProjection.ts rawEventsSink.ts typedEventNarrowing.ts; do
     test -f "main/src/services/streamParser/$f" && echo "present: $f" || echo "MISSING: $f"
   done
   ```
   All four must print `present:`.

4. **Inventory the permissionManager isolation (success signal 5+7).** Run:
   ```bash
   grep -rnE 'cyboflowPermissionBridge|build-cyboflow-permission-bridge|McpBridge' main/src/services/permissionManager.ts frontend/src/components/cyboflow
   ```
   Expected: 0 matches.

5. **Inventory the stale wiring-proof comment.** Run:
   ```bash
   grep -nE 'epic 7\+' main/src/orchestrator/runLauncher.ts
   ```
   Currently this matches line 144. Edit `main/src/orchestrator/runLauncher.ts` lines 142-144: replace the three-line `Wiring proof: ... epic 7+` comment with one of:
   - **If keeping the synthetic event (path B):** a comment `// KEEP: synthetic run_started emission. The renderer subscribes to cyboflow:stream:<runId> as soon as startRun resolves; without this synthetic publish there is a 50-500ms window where the panel shows 'Waiting for events…' before the first real SDK event arrives. RunExecutor is now wired (see main/src/index.ts:580-589) and real SDK events follow; this remains as a UI-bootstrap aid.`
   - **If removing the synthetic event (path A):** delete the comment AND the `this.publisher?.publish(runId, { type: 'run_started', ... })` block (lines 145-149) entirely. Pick path A only if a quick manual test (step 11 below) confirms there is no visible UI gap.

6. **Decide the synthetic-event question.** Default to path B (KEEP) unless step 11's UI smoke shows the synthetic event is provably redundant. The decision is irreversible-within-this-task — record it in the verification report.

7. **Update the sibling test `main/src/orchestrator/__tests__/runLauncher.test.ts`.**
   - If path B: no change required. Re-run the test to confirm it still passes against the new comment.
   - If path A: rewrite the test at lines 508-594. Instead of asserting `firstCall[1].type === 'run_started'`, assert `publishSpy` is NOT called by `launch()` directly (it will still be called later by RunExecutor via the bridge, but that path is not exercised by this unit test). Update the test description from `'calls publisher.publish with run_started event after status update'` to `'does not synthetically publish run_started; real events flow via runEventBridge'`.

8. **Run static gates.** Execute, in order:
   ```bash
   pnpm typecheck    # success signal 8a
   pnpm lint         # success signal 8b
   pnpm test:unit    # main + frontend vitest, schema verify, build verify
   pnpm test         # Playwright spec suite
   ```
   Each must exit 0. Capture stderr if any non-zero exit — these become FAIL entries in the verification report.

9. **Launch the app.** Run `pnpm build:main` then `pnpm dev`. Confirm the Electron window opens. Read `cyboflow-backend-debug.log` and `cyboflow-frontend-debug.log` (project root, truncated each launch) for any startup error lines. Record the launch SHA and timestamp.

10. **Manual smoke 1 — panel create + prompt + stream (success signal 1).** Create a new Claude panel. Send the prompt: `Say hello and explain in one sentence what file I'm currently in.` (use any project file). Confirm streaming response appears in the panel. Read `cyboflow-backend-debug.log` — must contain `[ClaudeCodeManager] SDK query started` for the panel. Record the panel id and event count in the report.

11. **Decide the synthetic-event question (step 6 cont'd).** With `pnpm dev` running, open the cyboflow tab and start a workflow run. Observe the RunView event log. If there's a visible gap (>250ms) of "Waiting for events…" before the first event appears, KEEP the synthetic event (path B). If the first real SDK event lands fast enough that the synthetic is imperceptible, REMOVE it (path A). Record the decision.

12. **Manual smoke 2 — tool intercept + approval (success signal 2).** In the panel from step 10, send: `List the files in the current directory using the bash tool.` The review queue should show the bash tool-call. Click approve. Tool completes. Confirm `cyboflow-backend-debug.log` contains `routePreToolUseThroughApprovalRouter` and `ApprovalRouter.requestApproval`. Sanity-query: `sqlite3 <db-path> "SELECT id, run_id, status FROM approvals ORDER BY created_at DESC LIMIT 3"` (db path varies by config). Record the approval id and outcome.

13. **Manual smoke 3 — session resume (success signal 3).** In the panel: send `My favorite color is teal. Remember this.`. After response, close the panel (right-click → close). Reopen the panel for the same session. Send: `What's my favorite color?`. Response should reference teal. Confirm `cyboflow-backend-debug.log` contains `resuming with sessionId=` near the second prompt. Record both prompts and the model's answer in the report.

14. **Manual smoke 4 — PATH isolation (success signal 4).** In a fresh terminal:
    ```bash
    FILTERED_PATH=$(echo "$PATH" | tr ':' '\n' | while read p; do
      test -x "$p/claude" 2>/dev/null || echo "$p"
    done | tr '\n' ':' | sed 's/:$//')
    PATH="$FILTERED_PATH" which claude   # must exit 1
    PATH="$FILTERED_PATH" pnpm dev       # launch the app
    ```
    Repeat smoke 1 in this PATH-filtered context. Must succeed (the SDK is in-process; no `claude` binary needed). Record exit code of `which claude` and the smoke-1 outcome.

15. **Manual smoke 5 — workflow run emits real SDK events (Addition 1 verification).** From the cyboflow tab in the running app, click `Start run` on any workflow. Watch the RunView event log. Record the unique `type` values seen — there MUST be ≥ 2 SDK-shaped types beyond `run_started` (e.g. `system`, `assistant`, `result`, `stream_event`). If only `run_started` appears, RunExecutor is not wired correctly — file a separate finding and halt this task. Programmatic check:
    ```bash
    sqlite3 <db-path> "SELECT DISTINCT type FROM raw_events WHERE run_id = '<runId>'"
    ```
    Must return ≥ 2 distinct types.

16. **Manual smoke 6 — no UX regressions (success signal 9).** Walk the user flows end-to-end: create panel → prompt → tool approval → resume → workflow run start → workflow run complete. Note any UX deltas in the report (none expected). Capture screenshots if reasonable.

17. **Append the verification report.** Edit `docs/sdk-migration-smoke-results.md`. Append a new H2 section starting with `## Verification — 2026-05-20 (TASK-683)`. Include subsections:
    - **Metadata** (date, git SHA, tester, Node/pnpm/OS versions)
    - **Prerequisite checks** (outputs from step 1)
    - **Deletion / survival gates** (outputs from steps 2-4)
    - **Static gates** (typecheck/lint/test:unit/test results from step 8)
    - **Manual smokes 1-6** (one subsection each, with prompt, observation, and pass/fail)
    - **Synthetic `run_started` decision** (path A or B + rationale from step 11)
    - **Stale `epic 7+` comment patch** (before/after diff snippet)
    - **Overall verdict** (pass / fail with list of outstanding follow-ups)

18. **Re-run the unit-test sibling.** After editing the test (if path A), run:
    ```bash
    pnpm --filter main test -- --run runLauncher.test.ts
    ```
    Confirm exit 0.

19. **Final completion gate.** Re-run `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test`. All must exit 0. If any regressed during the in-flight edits to `runLauncher.ts` / its test, fix before reporting COMPLETED.

## Acceptance Criteria

See frontmatter — 20 criteria covering: dependency presence (AC1), deletions (AC2-4), survivors (AC5), permission-manager isolation (AC6), stale-comment patch (AC7), synthetic-event decision (AC8), static gates (AC9-12), manual smokes 1-6 (AC13-18), sibling-test integrity (AC19), and the verification report (AC20).

## Test Strategy

The single test target is `main/src/orchestrator/__tests__/runLauncher.test.ts` (line 508-594). The current assertion (`firstCall[1].type === 'run_started'`) is path-B-shaped — it survives unchanged if step 6 selects path B. If step 6 selects path A (synthetic event removed), the test must be rewritten to assert the new contract: `publishSpy` is NOT called by `launch()`, with a description that names this task and the rationale. Do not delete the test. Do not add new test files — the 6 manual smokes are deliberately verification-only.

## Hardest Decision

Whether to remove the synthetic `run_started` event (path A) or keep it as a UI-bootstrap aid (path B). The argument for removal: real SDK events flow now (TASK-681/682 + earlier `RunExecutor` wiring), so the synthetic event is a redundancy that fires a 'run started' notification before the run is fully wired — a small lie. The argument for keeping it: empirically the SDK's first event can lag 100-500ms behind `startRun` resolution, and the renderer shows `Waiting for events…` in that window. The synthetic event closes the gap without changing semantics elsewhere.

**Chosen approach:** default to KEEP (path B) and let the empirical smoke in step 11 override it. The KEEP comment is updated to reflect reality (RunExecutor IS wired now; the synthetic event is no longer 'temporary' but 'load-bearing UX'). This minimizes blast radius — the sibling test stays green, the renderer doesn't have to handle a fresh edge case, and the decision is explicit and documented rather than implicit.

## Rejected Alternatives

- **Delete the synthetic event unconditionally.** Rejected because empirical evidence for the UX gap is mixed; the conservative move is to keep, document, and revisit if first-event latency improves. Would reconsider if step 11 shows < 50ms gap consistently.
- **Promote the verification to a Playwright E2E suite.** Rejected because the 6 smokes require live UI interaction (panel kill/restart, PATH manipulation in the parent shell, multi-turn conversation flow). Writing E2E flows for a one-time epic-acceptance gate is not cost-justified; the value is the human-driven cross-check, not the automation.
- **Run all smokes inside a fresh ephemeral profile.** Rejected — would invalidate the session-resume smoke (no prior session to resume). The current cyboflow profile is the correct test surface.
- **Add a Maestro flow.** Rejected because cyboflow is an Electron desktop app with no `.maestro/` directory configured. Maestro targets mobile; Playwright is the configured E2E driver.

## Lowest Confidence Area

The synthetic-event decision step (step 11) depends on observable timing on the tester's machine, which is non-deterministic across hardware and OS load. The plan defaults to KEEP precisely because reasoning about UI latency under load is unreliable from a static codebase read — the executor's machine may show different behavior than the next user's. A possible follow-up (not in scope for this task): instrument the first-real-event latency programmatically and remove the synthetic event when p95 < 100ms. Surface this as a follow-up finding if step 11's observation is ambiguous.
