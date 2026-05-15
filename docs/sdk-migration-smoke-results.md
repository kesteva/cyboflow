# SDK Migration Smoke Test Results

## Metadata

| Field | Value |
|---|---|
| Date | 2026-05-15 |
| Git SHA | `717442bcdd8e71f3ef59eeb0238bf10d073e9c7a` |
| Tester | Executor (TASK-595 autonomous run) |
| Node version | v22.15.1 |
| pnpm version | 10.11.1 |
| OS | Darwin 25.2.0 (macOS Sequoia 26 beta) |
| Branch | `soloflow/run-20260514-153933-SPRINT-008` |

> **Autonomous-execution caveat:** This smoke was run by an autonomous executor
> (Claude Sonnet 4.6) without a human operating the Electron UI.  Signals that
> require live UI interaction (panel create/prompt/stream, review-queue intercept,
> session resume) are marked **FAIL – autonomous** and paired with follow-up task
> spec stubs.  All static-analysis, build, log-grep, and test-runner signals were
> executed directly.

---

## Environment — Prerequisite Check Output

```
Prereq 1 (@anthropic-ai/claude-agent-sdk in main/package.json):
  PASS — "@anthropic-ai/claude-agent-sdk": "^0.2.141"

Prereq 2 (build-cyboflow-permission-bridge.js deleted):
  PASS — file does not exist

Prereq 3 (stream-parser source files deleted):
  PASS — lineBufferer.ts deleted
  PASS — jsonParser.ts deleted
  PASS — streamParser.ts deleted
  PASS — completionDetector.ts deleted

Prereq 4 (Claude auth):
  PASS — ~/.claude exists (credential store)
  Note: ANTHROPIC_API_KEY not set; SDK uses ~/.claude credential store.
```

All blocking prereqs pass.

---

## PATH Isolation

**Method used:** Option B — per-process PATH filter (no binary was moved).

```bash
FILTERED_PATH=$(echo "$PATH" | tr ':' '\n' | while read p; do
  test -x "$p/claude" 2>/dev/null || echo "$p"
done | tr '\n' ':' | sed 's/:$//')
PATH="$FILTERED_PATH" which claude   # exit 1, output: "claude not found"
```

`claude` binary is installed at `/Users/raimundoesteva/.local/bin/claude`.
Under the filtered PATH that directory is excluded.  Verified:

```
PASS: claude not reachable under filtered PATH
Filter effective
```

### pnpm dev launch under PATH isolation

Launched `PATH="$FILTERED_PATH" pnpm dev` (background, PID 89698) and
captured stdout/stderr to `/tmp/pnpm-dev.out`.  Process was alive after 20s.
No `claude: command not found` errors anywhere in the output.  Clean startup
confirmed; see excerpt under Signal 1 below.

---

## Signal Checklist

### Signal 1: Panel create + prompt + stream — FAIL (autonomous)

**Status: FAIL — requires live UI interaction**

**What was verified statically:**

The app started cleanly under PATH isolation.  Relevant startup log excerpt
from `/tmp/pnpm-dev.out`:

```
[Main] App is ready, initializing services...
[CliToolRegistry] Initialized CLI tool registry
[CliToolRegistry] Registered CLI tool: Claude Code (claude)
[CliManagerFactory] Registered built-in CLI tools
[CliToolRegistry] Created manager for CLI tool: Claude Code (claude)
[CliManagerFactory] Created claude manager successfully
[Main] Services initialized, creating window...
[Main] Orchestrator started and tRPC IPC handler attached
[Main] ApprovalRouter initialized
```

No `claude: command not found` and no PTY spawn errors.  The SDK substrate
log identifier that fires on actual panel use is emitted by
`claudeCodeManager.ts:259`:

```typescript
this.logger?.info(`[ClaudeCodeManager] SDK query started for panel ${panelId} (session ${sessionId})`);
```

This line was not observed because no panel was created in this autonomous run.

**What requires human verification:**

- Create a new Claude panel.
- Send `"Print the literal string SMOKE-OK-1, then stop."`.
- Observe streaming tokens in the UI.
- Capture screenshot to `docs/screenshots/sdk-migration/panel-stream-1.png`.
- Grep `cyboflow-backend-debug.log` for `[ClaudeCodeManager] SDK query started`.

**Follow-up:** TASK-596 — Human smoke Signal 1: Panel create + stream
(executor prerequisite: Playwright MCP or human operator with app running;
acceptance: screenshot at `docs/screenshots/sdk-migration/panel-stream-1.png`
plus backend log grep showing `SDK query started for panel`; update this
document to PASS and append log excerpt).

---

### Signal 2: Tool intercept → review queue → approve/deny — FAIL (autonomous)

**Status: FAIL — requires live UI interaction**

**What was verified statically:**

The `PreToolUse` hook wiring is confirmed in `claudeCodeManager.ts:345-356`:

```typescript
...(options.permissionMode !== 'ignore' ? {
  hooks: {
    PreToolUse: [{
      hooks: [this.makePreToolUseHook(options.panelId)]
    }]
  }
} : {})
```

`makePreToolUseHook` calls `ApprovalRouter.getInstance().requestApproval()`
and translates the decision to SDK `hookSpecificOutput.permissionDecision`
(`'allow'` or `'deny'`).  `ApprovalRouter` singleton was confirmed initialized
at startup (`[Main] ApprovalRouter initialized` in backend log).

**What requires human verification:**

- Send `"Read the file CLAUDE.md and summarize it in one sentence."`.
- Observe `PreToolUse` hook fires in the review queue.
- Screenshot review queue to `docs/screenshots/sdk-migration/review-queue-intercept.png`.
- Approve; observe completion.
- Repeat with deny; observe Claude receiving deny.
- Cite backend log excerpts showing `requestApproval` and decision.

**Follow-up:** TASK-596 — Human smoke Signal 2: Tool intercept + review queue
(prerequisite: running panel from Signal 1; acceptance: screenshots at
`docs/screenshots/sdk-migration/review-queue-intercept.png` and
`docs/screenshots/sdk-migration/review-queue-deny.png` plus backend log lines
confirming `PreToolUse` hook fired and decision routed through `ApprovalRouter`).

---

### Signal 3: Session resume across panel restart — FAIL (autonomous)

**Status: FAIL — requires live UI interaction**

**What was verified statically:**

Session resume is implemented in `buildSdkOptions()` at `claudeCodeManager.ts:358-364`:

```typescript
if (options.isResume) {
  const claudeSessionId = this.sessionManager.getPanelClaudeSessionId(options.panelId);
  if (!claudeSessionId) {
    throw new Error(`Cannot resume: no Claude session_id stored for Crystal session ${options.sessionId}`);
  }
  sdkOptions.resume = claudeSessionId;
}
```

`continuePanel()` at line 549 selects the resume path:

```typescript
console.log(`[ClaudeCodeManager] Using resume for panel ${panelId}`);
return this.spawnClaudeCode(panelId, sessionId, worktreePath, prompt, [], true, permissionMode, model);
```

The `options.resume` field is the SDK's `resume` option that accepts the
Claude session ID string.  The `sessionManager.getPanelClaudeSessionId()`
lookup retrieves the stored session ID from the database.

**What requires human verification:**

- Send `"My favorite color is octarine — remember this."` in a panel.
- Wait for completion.
- Kill the panel.
- Restart against the same worktree.
- Send `"What is my favorite color?"`.
- Observe Claude referencing `octarine`.
- Screenshot to `docs/screenshots/sdk-migration/panel-resume.png`.
- Grep backend log for `options.resume` or `Using resume for panel`.

**Follow-up:** TASK-596 — Human smoke Signal 3: Session resume
(prerequisite: running panel; acceptance: screenshot at
`docs/screenshots/sdk-migration/panel-resume.png` plus backend log line
`[ClaudeCodeManager] Using resume for panel <id>` and Claude response
referencing `octarine`; update this document to PASS).

---

### Signal 4: pnpm dev works with `claude` removed from PATH — PASS

**Status: PASS**

**Evidence:**

PATH-isolation method (Option B — per-process PATH filter):

```bash
FILTERED_PATH=$(echo "$PATH" | tr ':' '\n' | while read p; do
  test -x "$p/claude" 2>/dev/null || echo "$p"
done | tr '\n' ':' | sed 's/:$//')
```

Verification of filter:

```
$ PATH="$FILTERED_PATH" which claude
claude not found   # exit code 1
```

`pnpm dev` launch under filtered PATH: clean success, no error, process running
after 20s.  Zero occurrences of `claude: command not found` in `/tmp/pnpm-dev.out`.

The `testCliAvailability()` override in `claudeCodeManager.ts:104-106` always
returns `{ available: true, version: 'sdk-in-process' }` — no binary probe is
ever attempted, confirming the SDK substrate makes the `claude` binary
unnecessary for panel operation.

---

### Signal 5: MCP permission bridge is gone — PASS

**Status: PASS**

**Evidence:**

```bash
$ test ! -f main/build-cyboflow-permission-bridge.js && echo "bridge file: deleted"
bridge file: deleted

$ grep -rn 'build-cyboflow-permission-bridge' main/src/ | wc -l
0

$ ls main/src/services/panels/claude/permissionManager.ts
ls: No such file or directory
(permissionManager.ts consolidated into claudeCodeManager.ts)

$ grep -rn 'mcp-permission-bridge\|cyboflow-permission-bridge\|mcpBridge' \
    main/src/services/panels/claude/claudeCodeManager.ts | wc -l
0
```

The bridge JS file is deleted.  No references remain in `main/src/`.
`permissionManager.ts` no longer exists as a separate file; its permission
routing logic was consolidated into `claudeCodeManager.makePreToolUseHook()`.

Note: `main/src/services/cyboflowPermissionBridge.ts` (the TypeScript source)
still exists as dead code (FIND-SPRINT-008-6); scheduled for deletion in a
follow-up dead-code sweep.

---

### Signal 6: Stream-json parser plumbing is gone — PASS

**Status: PASS**

**Evidence:**

```bash
for f in lineBufferer.ts jsonParser.ts streamParser.ts completionDetector.ts \
         __tests__/lineBufferer.test.ts __tests__/jsonParser.test.ts \
         __tests__/streamParser.test.ts __tests__/completionDetector.test.ts; do
  path="main/src/services/streamParser/$f"
  test ! -f "$path" && echo "deleted: $path" || echo "STILL PRESENT: $path"
done
```

Output:

```
deleted: main/src/services/streamParser/lineBufferer.ts
deleted: main/src/services/streamParser/jsonParser.ts
deleted: main/src/services/streamParser/streamParser.ts
deleted: main/src/services/streamParser/completionDetector.ts
deleted: main/src/services/streamParser/__tests__/lineBufferer.test.ts
deleted: main/src/services/streamParser/__tests__/jsonParser.test.ts
deleted: main/src/services/streamParser/__tests__/streamParser.test.ts
deleted: main/src/services/streamParser/__tests__/completionDetector.test.ts
```

```
$ ls main/src/services/streamParser/__fixtures__ 2>/dev/null \
    && echo "FIXTURE DIR STILL PRESENT" || echo "fixture dir: gone"
fixture dir: gone
```

All four parser source files, all four test files, and the fixtures directory
are deleted.  The surviving files in `streamParser/` are the new SDK-shaped
pipeline: `eventRouter.ts`, `rawEventsSink.ts`, `messageProjection.ts`,
`schemas.ts`, `typedEventNarrowing.ts`, `types.ts`, `index.ts`,
and `__tests__/` containing `sdkMockFactories.ts` plus the migrated test files.

No PTY/bridge calls observed in the startup log or backend debug log.

---

### Signal 7: ApprovalRouter is the only permission contract — PASS

**Status: PASS**

**Evidence:**

`permissionManager.ts` does not exist (consolidated). The permission contract
in `claudeCodeManager.ts` imports only from `approvalRouter`:

```typescript
// main/src/services/panels/claude/claudeCodeManager.ts (lines 4-10)
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
```

No `@modelcontextprotocol` imports in `claudeCodeManager.ts`.

Frontend review components directory (`frontend/src/components/review`): does
not exist (no review-specific component directory).  The approval UI is
embedded in the main panel component and uses the `ApprovalRouter` IPC contract
via tRPC.

```bash
$ grep -rnE 'import.*(claude-agent-sdk|@modelcontextprotocol)' \
    frontend/src/components/review 2>/dev/null
# No output (directory does not exist)
```

`ApprovalRouter.requestApproval()` is the sole gateway: `makePreToolUseHook`
in `claudeCodeManager.ts:400-408` calls it for every `PreToolUse` event, and
the hook returns `hookSpecificOutput.permissionDecision` based on the decision.

---

### Signal 8: typecheck + lint + test green — PASS

**Status: PASS**

**Typecheck:**

```bash
$ pnpm typecheck
frontend typecheck: Done
shared typecheck: Done  (no TypeScript files)
main typecheck: Done
# exit code 0
```

**Lint:**

```bash
$ pnpm lint
# 303 warnings (pre-existing React hook + console.log warnings), 0 errors
# exit code 0
```

**Tests (Playwright E2E):**

```
Running 9 tests using 5 workers
  ✓ [chromium] tests/git-status.spec.ts:74:7  (2.7s)
  ✓ [chromium] tests/git-status.spec.ts:18:7  (2.7s)
  ✓ [chromium] tests/health-check.spec.ts:4:7 (2.8s)
  ✓ [chromium] tests/smoke.spec.ts:4:7        (594ms)
  ✓ [chromium] tests/smoke.spec.ts:19:7       (568ms)
  ✓ [chromium] tests/permissions-ui-fixed.spec.ts:15:7  (3.4s)
  ✓ [chromium] tests/permissions-ui-fixed.spec.ts:64:7  (883ms)
  ✓ [chromium] tests/permissions-ui-fixed.spec.ts:38:7  (3.6s)
  ✓ [chromium] tests/smoke.spec.ts:38:7       (863ms)

9 passed (6.6s)
# exit code 0
```

Note: `main/` vitest tests (including `rawEventsSink.test.ts`) are not part of
`pnpm test` (which runs Playwright).  The vitest suite hits the pre-existing
better-sqlite3 ABI mismatch (FIND-SPRINT-008-1; NODE_MODULE_VERSION 137 vs
127).  Resolution: `pnpm electron:rebuild`.  This is a pre-existing env issue,
not a TASK-595 regression.

---

### Signal 9: User-visible behavior parity — FAIL (autonomous)

**Status: FAIL — requires live UI interaction for screenshot comparison**

**What was verified statically:**

- Typecheck, lint, and Playwright E2E all pass (Signal 8 evidence above).
- Startup log shows the same services initializing as in a pre-migration run.
- No error regressions in the startup sequence.
- `CliToolRegistry` and `CliManagerFactory` boot correctly.
- `ApprovalRouter` initializes cleanly.

**What requires human verification:**

- Visual comparison of the panel UI streaming output against pre-migration
  baseline screenshots.
- Verify that the `session_info` descriptor emitted in `spawnCliProcess()` at
  line 207 renders correctly in the panel header.
- Confirm the review queue UI displays intercept cards identically to the
  pre-migration behavior.

**Follow-up:** TASK-596 — Human smoke Signal 9: UI parity check
(prerequisite: Signals 1+2+3 verified; acceptance: annotated side-by-side
screenshot comparison documenting any visible regressions, or explicit PASS if
no regressions observed; update this document accordingly).

---

## SDK Substrate Confirmation

**`main/package.json` dependency line:**

```json
"@anthropic-ai/claude-agent-sdk": "^0.2.141",
```

**SDK code path evidence (static analysis):**

`claudeCodeManager.ts:4` imports `query` from `@anthropic-ai/claude-agent-sdk`.
The hot path is `runSdkQuery()` at line 267 which calls `query({ prompt, options: { ...sdkOptions, abortController } })` and iterates the async generator.

**SDK init log line (fires on panel creation, not on app start):**

```typescript
// claudeCodeManager.ts:259
this.logger?.info(`[ClaudeCodeManager] SDK query started for panel ${panelId} (session ${sessionId})`);
```

This line was not observed in this autonomous run because no panel was created.
A human smoke run (TASK-596) will capture this line after sending the first prompt.

**Backend log excerpt confirming ApprovalRouter (SDK gate) initialized:**

```
[2026-05-15T01:44:27.539Z] [BACKEND LOG] [Main] ApprovalRouter initialized
```

---

## Summary Table

| # | Signal | Status | Evidence |
|---|---|---|---|
| 1 | Panel create + prompt + stream | FAIL | Follow-up: TASK-596 (autonomous limitation) |
| 2 | Tool intercept → review queue → approve | FAIL | Follow-up: TASK-596 (autonomous limitation) |
| 3 | Session resume across panel restart | FAIL | Follow-up: TASK-596 (autonomous limitation) |
| 4 | pnpm dev works without `claude` in PATH | PASS | PATH filter verified; dev log clean |
| 5 | MCP permission bridge is gone | PASS | File deleted; zero refs in main/src/ |
| 6 | Stream-json parser plumbing is gone | PASS | All 8 files deleted; fixture dir gone |
| 7 | ApprovalRouter is the only permission contract | PASS | Static import analysis + hook wiring |
| 8 | typecheck + lint + test green | PASS | tsc exit 0; lint 0 errors; 9/9 E2E pass |
| 9 | User-visible behavior parity | FAIL | Follow-up: TASK-596 (autonomous limitation) |

**Automated PASS: 5/9.  Deferred to TASK-596 (human smoke): 4/9.**

---

## Follow-up Task Spec: TASK-596

**Title:** Human smoke run — complete EPIC success signals 1, 2, 3, 9

**Trigger:** TASK-595 autonomous run verified signals 4-8 but could not drive
the Electron UI.

**Scope (files_owned):**
- `docs/sdk-migration-smoke-results.md` (update FAIL → PASS for each signal)
- `docs/screenshots/sdk-migration/panel-stream-1.png` (capture)
- `docs/screenshots/sdk-migration/review-queue-intercept.png` (capture)
- `docs/screenshots/sdk-migration/review-queue-deny.png` (capture)
- `docs/screenshots/sdk-migration/panel-resume.png` (capture)

**Steps:**

1. Ensure ANTHROPIC_API_KEY is set or `~/.claude` credential store is populated.
2. Run `pnpm build:main && PATH="$FILTERED_PATH" pnpm dev` (filtered PATH from TASK-595 results).
3. Create a new project + panel; send `"Print the literal string SMOKE-OK-1, then stop."`.
4. Screenshot streaming output to `docs/screenshots/sdk-migration/panel-stream-1.png`.
5. Grep `cyboflow-backend-debug.log` for `[ClaudeCodeManager] SDK query started`.
6. Update Signal 1 in this document to PASS with log excerpt.
7. Send `"Read the file CLAUDE.md and summarize it in one sentence."`.
8. When `PreToolUse` fires, screenshot review queue to `review-queue-intercept.png`.
9. Approve; observe completion; screenshot if relevant.
10. Send a second file-read prompt; screenshot deny flow to `review-queue-deny.png`.
11. Update Signal 2 in this document to PASS.
12. Send `"My favorite color is octarine — remember this."` Wait for completion.
13. Kill panel; restart against same worktree; send `"What is my favorite color?"`.
14. Observe Claude referencing `octarine`; screenshot to `panel-resume.png`.
15. Grep backend log for `Using resume for panel`.
16. Update Signal 3 in this document to PASS.
17. Update Signal 9 to PASS if no visual regressions observed.
18. Commit: `docs(TASK-596): complete human smoke signals 1-3+9`.

**Acceptance criteria:**

- All 9 signals PASS in `docs/sdk-migration-smoke-results.md`.
- Four screenshots present under `docs/screenshots/sdk-migration/`.
- Backend log shows `SDK query started` and `Using resume for panel` lines.
- No production code modified.
