---
id: TASK-595
idea: IDEA-014
status: ready
created: "2026-05-14T00:00:00Z"
files_owned:
  - docs/sdk-migration-smoke-results.md
  - docs/screenshots/sdk-migration/.gitkeep
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/panels/claude/claudePanelManager.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/package.json
  - CLAUDE.md
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
  - .soloflow/active/ideas/IDEA-014.md
  - cyboflow-backend-debug.log
  - cyboflow-frontend-debug.log
acceptance_criteria:
  - criterion: "docs/sdk-migration-smoke-results.md exists and contains a checklist of all 9 EPIC success signals, each with PASS / FAIL / N/A status and concrete evidence (log excerpt, screenshot path, or command output)."
    verification: "\"test -f docs/sdk-migration-smoke-results.md && for n in 1 2 3 4 5 6 7 8 9; do grep -E \\\"^("
  - criterion: "Every line in the 9-point checklist resolves to PASS, or to FAIL/N-A with a linked follow-up task spec stub in the same document."
    verification: "grep -E '^- \\*\\*(Signal [0-9]|S[0-9])' docs/sdk-migration-smoke-results.md | grep -Eiv '(PASS|FAIL|N/A)' | wc -l | grep -q '^[[:space:]]*0$' ; for f in $(grep -oE 'FAIL' docs/sdk-migration-smoke-results.md); do grep -q 'Follow-up:' docs/sdk-migration-smoke-results.md; done"
  - criterion: Document records the PATH-isolation method used (either `mv $(which claude) /tmp/claude.bak` or a per-process `PATH=` filter) AND records that `pnpm dev` started cleanly under that isolation.
    verification: "grep -E '(PATH-isolation|PATH isolation|which claude|/tmp/claude.bak)' docs/sdk-migration-smoke-results.md && grep -E '(pnpm dev|dev launch).*(clean|success|no error)' docs/sdk-migration-smoke-results.md"
  - criterion: Document confirms `@anthropic-ai/claude-agent-sdk` is the substrate by quoting the `main/package.json` dependency line and a backend-log line proving SDK init ran in-process.
    verification: "grep -E '\"@anthropic-ai/claude-agent-sdk\"' docs/sdk-migration-smoke-results.md && grep -E '(SDK init|claude-agent-sdk|sdk query)' docs/sdk-migration-smoke-results.md"
  - criterion: "Document cites at least two screenshot file paths under `docs/screenshots/sdk-migration/` — one for the panel UI streaming a response, one for the review queue receiving an intercepted tool call."
    verification: "ls docs/screenshots/sdk-migration/ | grep -E '(panel|stream)' && ls docs/screenshots/sdk-migration/ | grep -E '(review|approval|intercept)' && grep -E 'docs/screenshots/sdk-migration/' docs/sdk-migration-smoke-results.md | wc -l | awk '$1 >= 2 {exit 0} {exit 1}'"
  - criterion: "Document confirms session resume worked: a panel was killed mid-conversation, restarted, and the next message continued via `options.resume`."
    verification: "grep -E '(resume|sessionId|session_id)' docs/sdk-migration-smoke-results.md && grep -E 'docs/screenshots/sdk-migration/.*resume' docs/sdk-migration-smoke-results.md"
  - criterion: "Smoke-test PRODUCTION CODE was NOT modified: `git log` shows only changes under `docs/` and `.soloflow/` for this task's commit range."
    verification: "git log --pretty=format: --name-only TASK-595..HEAD 2>/dev/null | sort -u | grep -vE '^(docs/|\\.soloflow/|$)' | wc -l | grep -q '^[[:space:]]*0$'"
prerequisites:
  - check: "grep -q '\"@anthropic-ai/claude-agent-sdk\"' main/package.json"
    fix: "Complete TASK-590 and TASK-587's `pnpm add @anthropic-ai/claude-agent-sdk` step in `main/`."
    description: "T9 cannot smoke-test the SDK substrate if T1's `pnpm add` step never landed."
    blocking: true
  - check: "test ! -f main/build-cyboflow-permission-bridge.js"
    fix: Complete TASK-591.
    description: "EPIC success-signal #5 requires `build-cyboflow-permission-bridge.js` be deleted."
    blocking: true
  - check: "test ! -f main/src/services/streamParser/lineBufferer.ts && test ! -f main/src/services/streamParser/jsonParser.ts && test ! -f main/src/services/streamParser/streamParser.ts && test ! -f main/src/services/streamParser/completionDetector.ts"
    fix: Complete TASK-592 and TASK-593.
    description: "EPIC success-signal #6 requires these four files be deleted."
    blocking: true
  - check: "command -v claude > /dev/null && which claude || true"
    fix: Informational only.
    description: "Smoke step 1 needs to either move or filter the `claude` binary out of PATH to satisfy success-signal #4."
    blocking: false
  - check: "test -n \"$ANTHROPIC_API_KEY\" || test -d \"$HOME/.config/claude\" || test -d \"$HOME/.claude\""
    fix: "Export ANTHROPIC_API_KEY or log in via the SDK's auth flow."
    description: The SDK requires authenticated credentials.
    blocking: true
depends_on:
  - TASK-591
  - TASK-594
estimated_complexity: medium
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "This task IS the test. No new unit / component / integration code is added; the results document is the artifact and the verifier consumes the document plus the cited screenshots and log excerpts. Every files_owned path is non-executable documentation. The directory-level sibling-test scan against docs/ and docs/screenshots/sdk-migration/ returns no matches. Modifying documentation cannot affect a test-id, accessibility label, exported behavior, or mock shape. Running pnpm test from step 13 is sufficient to confirm no regression in the broader suite."
---
# Integration smoke test: end-to-end SDK migration verification

## Objective

After tasks T1..T8 of EPIC `claude-agent-sdk-migration` land, run a manual + visual smoke test confirming the Claude panel works end-to-end against a live Claude account using `@anthropic-ai/claude-agent-sdk` as the substrate, with the `claude` CLI binary unreachable on `$PATH`. Document results in `docs/sdk-migration-smoke-results.md` as a checklist mapped 1:1 to the EPIC's nine success signals. This task produces verification evidence, not production code; any regression discovered becomes a follow-up task spec inside the results document.

## Implementation Steps

1. **Prerequisite verification (FAIL FAST).** Run each `prerequisites[].check` from the frontmatter. If any blocking check fails, stop and report which upstream task is incomplete.

2. **Create the results document scaffold.** Create `docs/sdk-migration-smoke-results.md` and `docs/screenshots/sdk-migration/.gitkeep`. Doc structure:
   - Title, metadata (date, git SHA, tester, Node/pnpm versions, OS).
   - Environment section with prerequisite-check output.
   - PATH-isolation section.
   - Nine `### Signal N: <title>` subsections with PASS/FAIL/N/A and evidence.

3. **PATH-isolate the `claude` CLI binary.** Choose one method, record it. Use Option B (process-tree PATH filter) by default:
   ```bash
   export FILTERED_PATH=$(echo "$PATH" | tr ':' '\n' | while read p; do test -x "$p/claude" || echo "$p"; done | paste -sd:)
   ```
   Verify with `PATH="$FILTERED_PATH" which claude` returning non-zero.

4. **Build the main process.** `pnpm build:main`. A non-zero exit is a hard FAIL.

5. **Launch the app under PATH isolation.**
   ```bash
   PATH="$FILTERED_PATH" pnpm dev > /tmp/pnpm-dev.out 2>&1 &
   DEV_PID=$!
   ```
   Wait ~30 seconds. Inspect `cyboflow-backend-debug.log` and `cyboflow-frontend-debug.log` for `claude: command not found` errors (hard FAIL Signal 4) and SDK init lines.

6. **Signal 1 — panel create + prompt + stream.** Create a new Claude panel. Send `"Print the literal string SMOKE-OK-1, then stop."`. Observe streaming tokens. Screenshot to `docs/screenshots/sdk-migration/panel-stream-1.png`. Capture 5-10 lines of `system/init` log evidence.

7. **Signal 2 — tool intercept → review queue → approve.** Send `"Read the file CLAUDE.md and summarize it in one sentence."`. Observe `PreToolUse` hook fires. Screenshot review queue → `docs/screenshots/sdk-migration/review-queue-intercept.png`. Approve, observe completion. Repeat with deny. Cite both screenshots and backend-log excerpts.

8. **Signal 3 — session resume across panel restart.** Send `"My favorite color is octarine — remember this."`. Wait for completion. Kill panel. Restart against same worktree. Send `"What is my favorite color?"`. Observe Claude referencing `octarine`. Screenshot → `docs/screenshots/sdk-migration/panel-resume.png`. Tail backend logs for `options.resume: <session_id>`.

9. **Signal 4 — `pnpm dev` works with `claude` removed from PATH.** Already proven by step 5 if successful. Cite PATH-isolation method and `which claude` exit=1.

10. **Signal 5 — MCP bridge is gone.**
    ```bash
    test ! -f main/build-cyboflow-permission-bridge.js && echo "bridge file: deleted"
    grep -rn 'build-cyboflow-permission-bridge' main/src/ 2>/dev/null | wc -l   # expect 0
    grep -rn 'mcp-permission-bridge\|cyboflow-permission-bridge\|mcpBridge' main/src/services/panels/claude/permissionManager.ts 2>/dev/null | wc -l   # expect 0
    ```

11. **Signal 6 — stream-json parser plumbing is gone.**
    ```bash
    for f in lineBufferer.ts jsonParser.ts streamParser.ts completionDetector.ts \
             __tests__/lineBufferer.test.ts __tests__/jsonParser.test.ts \
             __tests__/streamParser.test.ts __tests__/completionDetector.test.ts; do
      path="main/src/services/streamParser/$f"
      test ! -f "$path" && echo "deleted: $path" || echo "STILL PRESENT: $path"
    done
    ls main/src/services/streamParser/__fixtures__ 2>/dev/null && echo "FIXTURE DIR STILL PRESENT" || echo "fixture dir: gone"
    ```

12. **Signal 7 — `ApprovalRouter` is the only contract `permissionManager.ts` knows.**
    ```bash
    grep -nE 'import.*(claude-agent-sdk|@anthropic-ai|@modelcontextprotocol)' main/src/services/panels/claude/permissionManager.ts 2>/dev/null
    grep -rnE 'import.*(claude-agent-sdk|@anthropic-ai|@modelcontextprotocol)' frontend/src/components/review 2>/dev/null
    ```

13. **Signal 8 — typecheck + lint + test green.**
    ```bash
    pnpm typecheck 2>&1 | tail -40
    pnpm lint 2>&1 | tail -40
    pnpm test 2>&1 | tail -60
    ```
    All three must exit 0.

14. **Signal 9 — user-visible behavior parity.** Compare screenshots against pre-migration baseline. Document any visible regression as a FAIL with follow-up task stub.

15. **Restore the `claude` binary** if Option A was used.

16. **Shut down the dev process.** `kill $DEV_PID 2>/dev/null; wait $DEV_PID 2>/dev/null`.

17. **Compile the results document.** Every `### Signal N` has PASS/FAIL/N/A, evidence, and `Follow-up:` line for any FAIL/N-A.

18. **Commit.** `git add docs/sdk-migration-smoke-results.md docs/screenshots/sdk-migration/` then `git commit -m "test: SDK migration end-to-end smoke results"`.

## Acceptance Criteria

- `docs/sdk-migration-smoke-results.md` exists with PASS/FAIL/N/A evidence for each of the nine EPIC success signals.
- Every signal resolves to PASS, or to FAIL/N-A with a same-document `Follow-up:` stub.
- PATH-isolation method recorded; `pnpm dev` documented as starting cleanly under that isolation.
- Document quotes the `main/package.json` SDK dep AND a backend-log line proving SDK code paths executed.
- At least one screenshot for the panel-stream view and one for the review-queue intercept.
- Session-resume evidence includes a backend-log excerpt showing `options.resume` AND a screenshot.
- No production code modified in this task's commit range.

## Test Strategy

This task IS the test. No new code is added; the results document is the artifact. Running `pnpm test` from step 13 is sufficient to confirm no regression in the broader suite.

## Hardest Decision

**Choosing how to verify session resume (Signal 3) without overfitting the AC to one specific SDK API shape.** Chose log-grep approach over DB-introspection — robust to T5's exact API shape and survives minor SDK version bumps.

## Rejected Alternatives

- **Make Signal 3 conditional on a programmatic resume API rather than UI restart.** Rejected: EPIC says "kill the panel mid-conversation, restart, continue via `options.resume`."
- **Automate the smoke as a Playwright spec.** Rejected: EPIC tags this as "manual + visual" and automating real `query()` calls hits live Claude credits unpredictably.
- **Skip PATH isolation.** Rejected: EPIC success-signal #4 is non-negotiable.

## Lowest Confidence Area

**The exact log-line format the rewritten `claudeCodeManager.ts` will emit at SDK init.** T5 (TASK-590) decides this. The executor reads `claudeCodeManager.ts` first to discover the actual identifier, then greps for it. If T5 lands without ANY identifying log line at init, the executor should add `Follow-up: claudeCodeManager.ts should emit an "SDK init" log line for observability` as a follow-up rather than fail Signal 1.

A secondary uncertainty: whether `permissionManager.ts` survives T5 / T8 as a file. If not, the executor should grep the surviving consumer and document the consolidation in Signal 7's evidence block.
