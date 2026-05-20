---
sprint: SPRINT-026
pending_count: 2
last_updated: "2026-05-20T19:00:00Z"
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
