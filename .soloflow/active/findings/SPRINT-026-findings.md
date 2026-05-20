---
sprint: SPRINT-026
pending_count: 5
last_updated: "2026-05-20T19:23:00.000Z"
---
# Findings Queue

SPRINT-026 started with missing infra: docker, playwright, peekaboo; tests deferred.

## FIND-SPRINT-026-1
- **type:** scope_deviation
- **source:** TASK-672 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/components/panels/ai/parseJsonMessage.ts:9
- **description:** required to meet AC: acceptance criteria requires grep FIND-SPRINT-024-4 in frontend/src returns 0 matches, but parseJsonMessage.ts has a stale comment referencing FIND-SPRINT-024-4. File claimed to remove the now-resolved reference.
- **resolved_by:** verifier — AC-prescribed: AC #7 requires `grep -rn 'FIND-SPRINT-024-4' frontend/src` to return 0 matches; the comment in parseJsonMessage.ts contained that token, so updating it is mandated by the AC even though the file is not in files_owned.

## FIND-SPRINT-026-2
- **type:** claude-md
- **source:** TASK-672 (verifier)
- **severity:** low
- **status:** open
- **description:** Electron app visual verification gap: cyboflow is Electron and the renderer at :4521 cannot bootstrap standalone (preload-injected electronTRPC), but the project lacks documentation / setup for verifier subagents to drive the Electron app via Playwright _electron.launch. Either visual_web=true should imply Electron-aware launching (and docs/VISUAL-VERIFICATION-SETUP.md should specify it), OR config should distinguish web-renderer-standalone vs Electron-renderer to avoid silently degraded visual checks each task. Affects every UI-touching task in this codebase.

## FIND-SPRINT-026-3
- **type:** claude-md
- **source:** TASK-672 (verifier)
- **severity:** medium
- **status:** open
- **description:** Peekaboo MCP host (Claude Code) lacks Accessibility permission on this Mac, blocking visual_macos verification even though Screen Recording is granted. docs/VISUAL-VERIFICATION-SETUP.md should call out the two-permission requirement (Screen Recording + Accessibility) explicitly with the System Settings path, since Accessibility is the more commonly missed grant.

## FIND-SPRINT-026-4
- **source:** TASK-681 (executor)
- **type:** bug
- **severity:** medium
- **status:** open
- **location:** main/src/services/streamParser/__tests__/rawEventsSink.test.ts
- **description:** rawEventsSink.test.ts fails with NODE_MODULE_VERSION mismatch (better-sqlite3 compiled for NODE_MODULE_VERSION 136, current Node requires 127). Pre-existing infrastructure failure unrelated to TASK-681 changes. All 8 tests in this file fail. Blocked by mismatched native module binding — run pnpm electron:rebuild to fix.
- **suggested_action:** Run `pnpm electron:rebuild` to recompile better-sqlite3 against the current Node version.
- **resolved_by:** 

## FIND-SPRINT-026-5
- **source:** TASK-681 (code-reviewer)
- **type:** anti-pattern
- **severity:** low
- **status:** resolved
- **location:** main/src/services/streamParser/messageProjection.ts:138-141
- **description:** The new compact_boundary projection writes `compact_trigger` and `pre_tokens` as snake_case keys on UnifiedMessage.metadata, but every other field on that metadata object is camelCase (`systemSubtype`, `sessionInfo`, `agent`, `model`, `duration`, `tokens`, `cost`). The convention in shared/types/unifiedMessage.ts metadata is camelCase post-projection (snake_case is reserved for the wire layer in claudeStream.ts). Without rename, TASK-682's renderer will mix conventions when reading `message.metadata.systemSubtype === 'context_compacted'` alongside `message.metadata.compact_trigger`. Cheapest fix is in TASK-682's renderer wiring task: rename to `compactTrigger` / `preTokens` on the projection side before any renderer consumer reads them.
- **suggested_action:** In TASK-682, rename `compact_trigger` → `compactTrigger` and `pre_tokens` → `preTokens` in messageProjection.ts:138-141 (and the matching assertions in messageProjection.test.ts:221-222) before wiring the renderer consumer. Wire layer (claudeStream.ts SystemCompactBoundaryEvent.compact_metadata) keeps snake_case — only the post-projection metadata gets normalized.
- **resolved_by:** TASK-682

## FIND-SPRINT-026-6
- **type:** scope_deviation
- **source:** TASK-682 (executor)
- **severity:** low
- **status:** open
- **location:** main/src/services/streamParser/messageProjection.ts:139-140
- **description:** required to meet AC: FIND-SPRINT-026-5 cross-task naming alignment — renaming compact_trigger → compactTrigger and pre_tokens → preTokens in messageProjection.ts and matching test assertions in messageProjection.test.ts. The SystemEventRow renderer consumer reads from the wire shape directly (SystemCompactBoundaryEvent from claudeStream.ts), not from the projected UnifiedMessage.metadata, so no renderer-side coupling yet — but the rename is applied proactively per FIND-SPRINT-026-5 recommendation to keep all post-projection metadata camelCase.

## FIND-SPRINT-026-7
- **type:** scope_deviation
- **source:** TASK-682 (executor)
- **severity:** low
- **status:** resolved
- **location:** frontend/src/stores/__tests__/cyboflowStore.test.ts:134
- **description:** required to meet AC: StreamEventType union narrowing in cyboflowApi.ts causes the test object literal at line 128-133 to fail TS typecheck — TS widens the `type` property from literal string to `string`, making it incompatible with `StreamEventType`. Minimal fix is to cast `type: (value) as StreamEventType` or annotate the test object. The store test is in files_readonly but must be touched to maintain typecheck pass per AC #5.
- **resolved_by:** verifier — AC-prescribed: AC#5 (`pnpm typecheck` exit 0) cannot pass without this edit. Verifier reverted the single-line annotation and confirmed `pnpm typecheck` fails with `error TS2345: Type 'string' is not assignable to type 'StreamEventType'` at line 134. AC#5 and AC#6 are internally inconsistent as written — AC#5 wins because typecheck is the load-bearing safety net. Executor's fix is exactly one character of insert (`: StreamEvent` on a test-fixture object literal; the `StreamEvent` import was already in the file). Zero behavior change.

## FIND-SPRINT-026-8
- **type:** claude-md
- **source:** TASK-682 (verifier)
- **severity:** low
- **status:** open
- **description:** Recurring visual_web Electron-renderer gap (also FIND-SPRINT-026-2): standalone Vite at :4521 returns HTTP 200 but JS throws 'Could not find electronTRPC global'; renderer DOM snapshot is empty. Confirms TASK-682 RunView discriminator branch rendering cannot be verified through Playwright MCP without an Electron-aware driver. Same root cause as queue dedup_key visual_web_electron_unreachable (SPRINT-015/017/020). docs/VISUAL-VERIFICATION-SETUP.md should either require visual_web=false for Electron-only projects OR document an _electron.launch attach pattern.
