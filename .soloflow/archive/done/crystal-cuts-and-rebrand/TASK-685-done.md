---
id: TASK-685
sprint: SPRINT-028
epic: crystal-cuts-and-rebrand
status: done
summary: "Removed app:update-discord-shown IPC handler, stripped discord_shown from DB layer (orphan column with IDEA-016 comment + idempotent DELETE of hide_discord seed), narrowed recordAppOpen/getLastAppOpen signatures."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
visual_macos: not_applicable
---

# TASK-685 — done

## Commit
- 2afbf2e feat(TASK-685): remove discord IPC handler and strip discord_shown from database layer

## Changes
- main/src/ipc/app.ts — deleted app:update-discord-shown handler; stripped discordShown from app:record-open signature
- main/src/database/database.ts — orphaned discord_shown column (IDEA-016 comment); removed hide_discord seed lines; added idempotent DELETE FROM user_preferences WHERE key='hide_discord' outside the if/else; narrowed recordAppOpen and getLastAppOpen signatures; deleted updateLastAppOpenDiscordShown
- main/src/index.ts — updated recordAppOpen call to 2 args

## Verifier
APPROVED_WITH_DEFERRED — AC1..AC10 MET; AC11 (visual launch) deferred to manual pnpm dev smoke. Goal-backward checks pass (preload + frontend clean of deleted symbols; DB orphan strategy safe for both fresh and existing DBs).

## Code review
CLEAN. Two out-of-diff findings queued (FIND-SPRINT-028-2: stale "Discord popup" comment + likely-dead track-welcome-dismissed handler; FIND-SPRINT-028-3: app:record-open/get-last-open IPC channels appear redundant — no frontend/preload surface).

## Tests
NO_TESTS_NEEDED — test_strategy.needed: false. 53/54 main test files pass; the single failure (claudeCodeManager.killProcess.test.ts) is pre-existing per verifier's HEAD~1 reproduction.
