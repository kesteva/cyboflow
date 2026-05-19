---
sprint: SPRINT-019
pending_count: 8
last_updated: "2026-05-19T03:47:51.363Z"
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

## FIND-SPRINT-019-6
- **source:** SPRINT-019 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md:152-170
- **description:** BUILD_LOG_TEMPLATE.md verification steps cover only better-sqlite3 and node-pty unpacking under app.asar.unpacked/, but do not verify that cyboflowMcpServer.js — the new asarUnpack entry TASK-584 added — actually ends up unpacked. Cross-task gap: TASK-567 wrote the template assuming the pre-TASK-584 asarUnpack list (which had broad wildcards), and TASK-584 narrowed asarUnpack to a single file without back-porting a verification step into the template. The next signed build using this template will not catch a regression in cyboflowMcpServer.js unpacking.
- **suggested_action:** Add a new section AC after the lipo checks: `## cyboflowMcpServer.js Unpacking (AC6)` with a `test -f dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js; echo $?` step expecting exit 0. Mirror the addition in builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md as a historical note that the check was not performed on 0.3.5 (so the regression-detection bar applies from the next build forward).
- **resolved_by:** 





Suspected tasks: TASK-567, TASK-584

## FIND-SPRINT-019-7
- **source:** SPRINT-019 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** main/src/orchestrator/mcpServer/scriptPath.ts:27-28
- **description:** scriptPath.ts JSDoc states the dev-mode emit path is `main/dist/orchestrator/mcpServer/`, but the actual tsc emit layout — as ARCHITECTURE.md now correctly documents — is `main/dist/main/src/orchestrator/mcpServer/` (because main/tsconfig.json includes `../shared/**/*`, which shifts outDir up by one level). TASK-584 added the correct path to ARCHITECTURE.md and package.json but did not update scriptPath.ts's stale JSDoc that contradicts the new authoritative documentation. Out of TASK-584 diff scope (file not touched), but a real cross-task gap.
- **suggested_action:** In scriptPath.ts JSDoc line ~28, replace `main/dist/orchestrator/mcpServer/` with `main/dist/main/src/orchestrator/mcpServer/` to match the actual emit layout and the new ARCHITECTURE.md asarUnpack contract subsection.
- **resolved_by:** 




Suspected tasks: TASK-584

## FIND-SPRINT-019-8
- **source:** SPRINT-019 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** docs/packaging/root-deps-policy.md:1
- **description:** The new docs/packaging/root-deps-policy.md (created by TASK-585) has zero inbound links — it is not referenced from CLAUDE.md, docs/ARCHITECTURE.md, docs/cyboflow_system_design.md, or any code comment. Future contributors editing main/package.json deps will not discover it. Contrast with TASK-584's sister concern: the asarUnpack contract was added as a subsection inside ARCHITECTURE.md (discoverable). Cross-task inconsistency: two packaging-policy docs added in the same sprint, one discoverable, one orphaned.
- **suggested_action:** Either (a) add a `### Workspace dependency policy` subsection to docs/ARCHITECTURE.md adjacent to the new `asarUnpack contract` subsection that links to docs/packaging/root-deps-policy.md, or (b) reference docs/packaging/root-deps-policy.md from CLAUDE.md's `## Reference Docs` list since packaging policy is a class of decision contributors must read before changing main/package.json.
- **resolved_by:** 



Suspected tasks: TASK-585, TASK-584

## FIND-SPRINT-019-9
- **source:** SPRINT-019 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md:99
- **description:** Filled-in 0.3.5 build evidence contains a real Apple ID email (`rkesteva@gmail.com`) in a notarytool command transcript, while the new templates and APPLE_DEVELOPER_SETUP.md use `<APPLE_ID>` placeholders consistently. The Team ID (Y7B83UUSAC) and signing identity are public information (visible on any distributed signed app), so those are not a leak; the email address is borderline PII (and inconsistent with the project's public git user `Krishna`). The template (BUILD_LOG_TEMPLATE.md) does not currently warn future builders to redact the email before committing — risking the same pattern in every future build record.
- **suggested_action:** Two-part fix: (1) In BUILD_LOG_TEMPLATE.md, change the notarytool command example to use `<APPLE_ID>` instead of an email placeholder, and add a one-line warning above the Notarization sections: `> Use <APPLE_ID> placeholder for the Apple ID in committed transcripts; the real email is not required for cross-reference.` (2) Optionally redact rkesteva@gmail.com → <APPLE_ID> in docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md:99. Skip (2) if the user prefers not to rewrite historical audit records.
- **resolved_by:** 


Suspected tasks: TASK-567

## FIND-SPRINT-019-10
- **source:** SPRINT-019 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/signing/builds/README.md:27-44
- **description:** docs/signing/builds/README.md `## How to Record a New Signed Build` (TASK-567) duplicates the `cp templates → fill in → commit` instructions that already exist in docs/signing/APPLE_DEVELOPER_SETUP.md `## Recording a Signed Build` (same task). README explicitly says `See APPLE_DEVELOPER_SETUP.md § Recording a Signed Build for the workflow` yet still contains the workflow inline. Minor cross-doc redundancy that risks drift over time (one updated, the other forgotten).

Suspected tasks: TASK-567
- **suggested_action:** Trim docs/signing/builds/README.md to a 2-3 line stub that points to APPLE_DEVELOPER_SETUP.md as the single source of truth for the workflow, keeping only the directory-convention table and the never-overwrite rule local to the README. Or invert: keep the procedure in builds/README.md (closer to the artifact directory) and link from APPLE_DEVELOPER_SETUP.md. Either way, one source of truth.
- **resolved_by:** 
