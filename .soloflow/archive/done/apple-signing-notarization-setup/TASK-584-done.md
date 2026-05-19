---
id: TASK-584
sprint: SPRINT-019
epic: apple-signing-notarization-setup
status: done
summary: "Correct package.json asarUnpack entry to match real tsc emit path for cyboflowMcpServer.js; add asarUnpack contract doc to ARCHITECTURE.md."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: not_applicable
---

# TASK-584 — Done Report

## Summary

Fixed `package.json` `build.asarUnpack` to reference the real tsc emit path. Removed two stale entries (`main/dist/services/**/*.js` and `main/dist/orchestrator/mcpServer/**/*.js`, both wrong prefixes that matched zero files) and added a single concrete path: `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js`. Added a new `### asarUnpack contract` subsection to `docs/ARCHITECTURE.md` documenting the tsc emit layout convention and the runtime extraction fallback.

## Plan Adaptation

The plan referenced `cyboflowPermissionBridge.js` and `cyboflowPermissionBridgeStandalone.js` files. These source files **no longer exist** in the codebase — they were removed during the Claude Agent SDK migration. The real subprocess needing asarUnpack is `cyboflowMcpServer.js` (spawned externally per `main/src/orchestrator/mcpServer/scriptPath.ts:22-40`). Executor adapted the work to the current codebase and logged FIND-SPRINT-019-4 for the compounder to assess.

## Changes

- 2 commits on run branch:
  - `c75b91f` — fix(TASK-584): correct asarUnpack paths to match tsc emit layout
  - `8edb22c` — docs(TASK-584): add asarUnpack contract subsection to ARCHITECTURE.md

## Verification

- AC#1 (correct path): MET — `find main/dist -name 'cyboflowMcpServer*'` returns 4 artifacts at the expected path.
- AC#2 (post-unpack filesystem): DEFERRED — packaged build blocked by pre-existing `frontend/vite.config.ts:17` TypeScript error (introduced by TASK-402, not by this task).
- AC#3 (runtime smoke): DEFERRED — same packaged-build prerequisite.
- AC#4 (wildcards removed, ≤2 entries): MET — one concrete entry only.
- AC#5 (ARCHITECTURE.md asarUnpack section): MET — section present at `docs/ARCHITECTURE.md:182-196`.
- AC#6 (build:main + emit artifact): MET — `cyboflowMcpServer.js` exists at the expected path.
- AC#7 (typecheck + lint): PASS — `pnpm typecheck` exit 0, `pnpm lint` exit 0 (306 pre-existing warnings).

## Notes

- Code review: CLEAN.
- Test writer: NO_TESTS_NEEDED — asarUnpack is build-time only.
- Deferred packaged-build smoke queued to human-review-queue testing bucket (verifier appended). User needs to fix the pre-existing `frontend/vite.config.ts` TS error first, then run `SKIP_SIGNING=1 pnpm run build:mac:arm64` and inspect the unpacked layout.
- FIND-SPRINT-019-4 (plan-stale-assumption) remains open for compounder attention.
