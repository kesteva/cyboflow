---
sprint: SPRINT-019
pending_count: 3
last_updated: "2026-05-19T03:37:33.932Z"
---
# Findings Queue

## FIND-SPRINT-019-3
- **source:** TASK-567 (code-reviewer)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** .soloflow/human-review-queue.md:34
- **description:** Pre-existing inconsistency surfaced during TASK-567 review (out of diff scope, so not blocking): the queued TASK-056 testing item says "Follow the 13-step procedure already scaffolded into docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md", but the doc contains 10 numbered steps (Step 1–Step 10), not 13. The "13-step" wording was introduced in commit d5e0d08 (chore(TASK-056): human-needed) before TASK-567 ran. TASK-567 correctly updated the path inside this entry but did not (and should not have, per its scope) touched the step-count text.
- **suggested_action:** When TASK-056 is closed out via /soloflow:review-queue, replace "13-step procedure" with "10-step procedure" in the queue entry's `action` field. Alternatively, drop the step count from the prose entirely since the doc itself is the source of truth.
- **resolved_by:** 

## FIND-SPRINT-019-1
- **type:** scope_deviation
- **source:** TASK-567 (executor)
- **severity:** low
- **status:** resolved
- **resolved_by:** verifier — AC-prescribed: AC #9 explicitly requires updating all in-repo references to the old top-level paths to the new builds/0.3.5/ paths. The executor also added .soloflow/human-review-queue.md to files_owned in this same task, so the edit is in-scope on both grounds.
- **location:** .soloflow/human-review-queue.md:33
- **description:** required to meet AC #9 (no stale references to old top-level paths): human-review-queue.md doc_ref still pointed at docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md; updated to docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md

## FIND-SPRINT-019-2
- **type:** scope_deviation
- **source:** TASK-567 (executor)
- **severity:** low
- **status:** resolved
- **resolved_by:** verifier — AC-prescribed: AC #9 explicitly requires updating all in-repo references to the old top-level paths to the new builds/0.3.5/ paths. The executor also added the EPIC plan to files_owned in this same task, so the edit is in-scope on both grounds.
- **location:** .soloflow/active/plans/apple-signing-notarization-setup/EPIC-apple-signing-notarization-setup.md:35
- **description:** required to meet AC #9 (no stale references to old top-level paths): EPIC Success Signal section referenced docs/signing/FIRST_SIGNED_BUILD_LOG.md and docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md; updated to builds/0.3.5/ paths

## FIND-SPRINT-019-4
- **type:** improvement
- **source:** TASK-584 (executor)
- **severity:** medium
- **status:** open
- **location:** package.json:104-107
- **description:** TASK-584 plan referenced cyboflowPermissionBridge.js and cyboflowPermissionBridgeStandalone.js as files that need asarUnpack, but these files do not exist in the codebase — the SDK-based rewrite (claudeCodeManager.ts) replaced the subprocess bridge approach. The actual subprocess that needs asarUnpack is cyboflowMcpServer.js at main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js. The plan AC checks for bridge files cannot pass. Executor corrected asarUnpack to the real path and documented it.
- **suggested_action:** Update TASK-584 acceptance criteria to check for cyboflowMcpServer.js path instead of the non-existent bridge files. Consider removing the scriptPath.ts ASAR-extraction fallback in a follow-up task once the asarUnpack fix is verified in a real packaged build.

## FIND-SPRINT-019-5
- **source:** TASK-585 (executor)
- **type:** cleanup
- **severity:** medium
- **status:** open
- **location:** main/package.json:25
- **description:** electron-store@^11.0.0 is declared in main/package.json but has zero importers in main/src/**. Grep confirmed: no import or require of electron-store anywhere in main/src TypeScript files. It appears to be a Crystal-era leftover. Should be removed from main/package.json in a follow-up task; root package.json intentionally omits it. Documented in docs/packaging/root-deps-policy.md.
- **suggested_action:** Remove electron-store from main/package.json dependencies in a dedicated cleanup task. Verify no other file references it (already confirmed empty for main/src/*.ts).
- **resolved_by:** 
