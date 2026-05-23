---
sprint: SPRINT-034
pending_count: 4
last_updated: "2026-05-23T20:30:00.000Z"
---
# Findings Queue

TASK-555 gated: failing blocking prereq (notarytool credentials missing).

## FIND-SPRINT-034-2
- **source:** TASK-620 (verifier)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** shared/types/mcpHealth.ts:36
- **description:** `HEALTH_STARTING` is exported as a plain `McpServerHealth` const (not `Readonly<McpServerHealth>` or `Object.freeze`'d). Both call sites (`main/src/ipc/cyboflow.ts:211` and `main/src/orchestrator/trpc/routers/health.ts:46`) `return HEALTH_STARTING` directly — every caller receives the same object reference. A future consumer that mutates the response would corrupt the shared singleton globally, with no compile-time warning. Today both consumers are read-only, so this is latent; flagging now so the next contact gives it a `Readonly<McpServerHealth>` annotation or `Object.freeze`.
- **suggested_action:** Either annotate as `export const HEALTH_STARTING: Readonly<McpServerHealth> = Object.freeze({ status: 'starting', restartAttempts: 0 });` or wrap each call site to return a shallow clone (`return { ...HEALTH_STARTING };`). The frozen-readonly approach is preferred (cheaper, type-checked).
- **resolved_by:** 

## FIND-SPRINT-034-1
- **source:** TASK-617 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** main/src/orchestrator/mcpServer/__tests__/mcpQueryHandler.test.ts:19
- **description:** Header docstring still says "use an in-memory better-sqlite3 instance initialised with the imported GATE_SCHEMA fixture", but TASK-617 replaced that import with an inline `MINIMAL_SCHEMA` const (see line 38). The docstring now misdescribes the fixture and references an import that is no longer present. Future readers grepping for `GATE_SCHEMA` will hit this stale comment plus the line-31 "Mirrors the relevant subset of REGISTRY_SCHEMA + GATE_SCHEMA" comment (which is still accurate-as-prose, but the line-19 sentence is not).
- **suggested_action:** Update line 19 to "All tests use an in-memory better-sqlite3 instance initialised with the inline `MINIMAL_SCHEMA` const declared below (no real migration runner — tests are hermetic)."
- **resolved_by:** 

## FIND-SPRINT-034-3
- **type:** claude-md
- **severity:** low
- **source:** TASK-655 (verifier)
- **description:** Peekaboo MCP reported both Screen Recording + Accessibility grants present, but live `image` capture against the running Cyboflow Electron window failed with "Failed to start stream due to audio/video capture failure" (both background and auto focus modes). This suggests the per-binary Screen Recording grant for the Electron host that runs `pnpm dev` (path: node_modules/.pnpm/electron@37.6.0/node_modules/electron/dist/Electron.app) may be missing or stale, even though the Peekaboo binary itself is granted. docs/VISUAL-VERIFICATION-SETUP.md should call out that BOTH the Peekaboo CLI AND the dev-mode Electron app need an explicit Screen Recording grant before the verifier can capture renderer output; otherwise probe-passes-but-capture-fails silently degrades visual_macos to skipped_unable.
- **suggested_action:** Add a troubleshooting note to docs/VISUAL-VERIFICATION-SETUP.md: if Peekaboo reports grants present but capture still errors with "audio/video capture failure", check System Settings → Privacy & Security → Screen Recording for the Electron.app under node_modules and toggle it on (then restart pnpm dev). Include the exact Electron path so users can find it quickly.

## FIND-SPRINT-034-4
- **source:** TASK-655 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/utils/toolFormatter.ts:505-516, main/src/utils/toolFormatter.ts:647-658
- **description:** After TASK-655, the orphaned-tool-result branch passes `extractToolResultText(result.content)` (always returns `string`) into `filterBase64Data` (returns primitives unchanged), so `filteredContent` is now provably a `string`. The downstream `else if (filteredContent !== null && filteredContent !== undefined) { ... JSON.stringify(...) }` and trailing `else { contentStr = ''; }` branches are unreachable dead code, and `filterBase64Data` itself is a no-op on this path. Secondary behavioral note: orphan `tool_result` blocks whose content is an array of image blocks (`{type: 'image', source: {type: 'base64', data: ...}}`) now render as empty string instead of the previous JSON-stringified `{... "data": "[Base64 data filtered]" ...}` — because `extractToolResultText` drops every block without a `text` field. Acceptable per the plan's "Lowest Confidence Area" note; flagging so future support tickets about missing orphan-image-result rendering link back here.
- **suggested_action:** Collapse the orphan branch to `const contentStr = makePathsRelative(extractToolResultText(result.content));` (frontend) / `... (extractToolResultText(result.content), gitRepoPath);` (main), deleting `filterBase64Data` from this call chain and the unreachable conditional arms. If support reveals real users hitting orphan-image-result rendering, add an image-block branch to `extractToolResultText` (e.g. render `[Image: <size>KB]` placeholder).
- **resolved_by:**
