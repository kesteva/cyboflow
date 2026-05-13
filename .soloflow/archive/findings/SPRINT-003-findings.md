---
sprint: SPRINT-003
pending_count: 8
last_updated: "2026-05-13T01:14:12.451Z"
---
# Findings Queue

## FIND-SPRINT-003-1
- **type:** scope_deviation
- **source:** TASK-055 (executor)
- **severity:** low
- **status:** open
- **location:** package.json:114
- **description:** configure-build.js mutated package.json notarize field from placeholder object { teamId: "${APPLE_TEAM_ID}" } to boolean true as part of the signed build. This is by design — configure-build.js always sets this field before electron-builder runs. Committing the resulting state as it correctly reflects the signed posture and prevents a confusing diff in the repo.

## FIND-SPRINT-003-2
- **source:** TASK-055 (verifier)
- **type:** cleanup
- **severity:** low
- **status:** open
- **location:** frontend/src/components/panels/ai/MessagesView.tsx:50
- **description:** Pre-existing lint error `'response' is never reassigned. Use 'const' instead` (`prefer-const`). The variable is declared `let` at line 50 but only assigned once on the next line. This causes `pnpm lint` to exit non-zero (1 error among 305 warnings). The file pre-dates TASK-055 work — last touched in commit `2d184f2` (TASK-001 Codex/OpenAI removal) — so this is not a TASK-055 regression. Surfacing it because the project-wide lint gate is currently red.
- **suggested_action:** Change `let response: { success: boolean; data?: JSONMessage[] };` followed by immediate assignment into a single `const response = await API.panels.getJsonMessages(panelId);` declaration. Verify the rest of the function does not reassign `response` (it does not).
- **resolved_by:** 

## FIND-SPRINT-003-3
- **source:** SPRINT-003 (sprint-code-reviewer)
- **type:** bug
- **severity:** high
- **status:** resolved
- **location:** docs/signing/FIRST_SIGNED_BUILD_LOG.md:119
- **description:** DMG SHA256 mismatch between sprint docs — FIRST_SIGNED_BUILD_LOG.md:119 records DMG sha256 as `cdf62a509f69d9984ec43c1a884fa83effd3f91608b197367b390e675e09ee8e`, but GATEKEEPER_ACCEPTANCE_TEST.md lists the same artifact (same path, same notarytool submission ID c5950a84-b245-4322-a866-f332b6a4bef8) with `6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494` (lines 20, 50, 100). Ground-truth `shasum -a 256` against the on-disk DMG returns `6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494` — the gatekeeper-test value is correct, the build-log value is wrong. The build-log value is almost certainly the pre-staple sha256 that notarytool computed on the bytes Apple received; stapling rewrites the DMG and changes its hash, which is the file users actually download. A clean-account tester following the procedure will compute the post-staple hash and treat any reference to the pre-staple hash as a sign of artifact tampering.
- **suggested_action:** In FIRST_SIGNED_BUILD_LOG.md update the DMG SHA256 row at line 119 to `6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494` (the post-staple, on-disk hash). Add a one-line note distinguishing the notarytool-reported sha256 (pre-staple, in Apple submission record) from the user-facing distribution sha256 (post-staple). Keep GATEKEEPER_ACCEPTANCE_TEST.md as the source of truth for the distribution hash — both docs must agree.
- **resolved_by:** a4c31f4 fix(TASK-055): record post-staple DMG SHA256 in build log






Suspected tasks: TASK-055, TASK-056

## FIND-SPRINT-003-4
- **source:** SPRINT-003 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** docs/signing/FIRST_SIGNED_BUILD_LOG.md, docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md
- **description:** Per-build snapshot docs lack a documented lifecycle, so future signed builds will not know whether to overwrite, append, or create new files. Both docs are hard-coded to version 0.3.5, the May 12 build timestamps, and one specific notarytool submission. There is no template, no `/docs/signing/builds/<version>/` directory pattern, and no instruction in `docs/signing/APPLE_DEVELOPER_SETUP.md` telling the next signer where to put 0.3.6 build evidence. Two failure modes: (a) the next signer overwrites these in place, destroying the audit trail of the first signed build; (b) the next signer creates `FIRST_SIGNED_BUILD_LOG_v2.md` and the directory grows ad-hoc copies. Compounder should decide: keep these as per-version snapshots under a `builds/<version>/` subdir, or promote the stable parts (procedure, expected outputs) into APPLE_DEVELOPER_SETUP.md and let per-build files be regenerated.
- **suggested_action:** Either (1) move both files to `docs/signing/builds/0.3.5/` and add a short "How to record a signed build" section to `docs/signing/APPLE_DEVELOPER_SETUP.md` pointing future signers at a template, or (2) promote the procedural sections (codesign verification, spctl assessment, stapler validate, lipo checks, the 10-step Gatekeeper test) into stable runbooks inside APPLE_DEVELOPER_SETUP.md and convert FIRST_SIGNED_BUILD_LOG.md / GATEKEEPER_ACCEPTANCE_TEST.md into per-version data sheets that only record (version, sha256, submission IDs, test result).
- **resolved_by:** 





Suspected tasks: TASK-055, TASK-056

## FIND-SPRINT-003-5
- **source:** SPRINT-003 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md:149, docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md:178
- **description:** AC3 data-directory check still accepts the legacy `~/.crystal/crystal.db` path as a pass condition (`test -s ~/.cyboflow/cyboflow.db || test -s ~/.crystal/crystal.db; echo $?`). The Cyboflow rebrand is otherwise complete per CLAUDE.md (`appId: com.cyboflow.app`, product name Cyboflow, FIRST_SIGNED_BUILD_LOG.md note 5 says "rebrand is complete"), so a fresh signed build on a clean account that writes to `~/.crystal/` is a regression that this acceptance test would silently mark PASS. The OR allows the test to pass when the actual rebrand has reverted.
- **suggested_action:** In GATEKEEPER_ACCEPTANCE_TEST.md Step 10 (line 149) and the CLI Verification Outputs block (line 178), tighten the check to `test -s ~/.cyboflow/cyboflow.db; echo $?` and add a note: "AC3 fails if any `~/.crystal/` artifacts appear on the clean account — the rebrand should be complete." If there is a transitional reason to still accept `~/.crystal/`, document the deprecation deadline inline.
- **resolved_by:** 




Suspected tasks: TASK-056

## FIND-SPRINT-003-6
- **source:** SPRINT-003 (sprint-code-reviewer)
- **type:** improvement
- **severity:** medium
- **status:** open
- **location:** package.json:114, scripts/configure-build.js
- **description:** `package.json` `build.mac.notarize` is now committed as `true` rather than `{ teamId: "${APPLE_TEAM_ID}" }`. Per FIND-SPRINT-003-1 this is by design (configure-build.js always rewrites the field before invoking electron-builder). Combined with the FIRST_SIGNED_BUILD_LOG.md "Notes for Future Builds" note 4 explaining that env vars are what actually matter, this means the committed value is now load-bearing in a way that is not obvious from reading `package.json` alone. Risk: a contributor running `pnpm electron-builder` directly (without going through `pnpm run build:mac:universal` -> configure-build.js) will get behaviour determined by the placeholder string, not the env vars they expect. There is no inline comment in `package.json` warning that this field is rewritten at build time.
- **suggested_action:** Add an entry to `docs/signing/APPLE_DEVELOPER_SETUP.md` (or CODE-PATTERNS.md) under a "configure-build.js contract" section noting (a) which package.json fields configure-build.js rewrites (`build.mac.notarize`, anything else), (b) what the committed values mean in each posture (signed vs unsigned), and (c) the canonical entry point (`pnpm run build:mac:*`) that always runs configure-build.js first. Optionally add a one-line `"_comment_notarize": "rewritten by scripts/configure-build.js — do not edit by hand"` sibling key in package.json.
- **resolved_by:** 



Suspected tasks: TASK-055

## FIND-SPRINT-003-7
- **source:** SPRINT-003 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/signing/FIRST_SIGNED_BUILD_LOG.md:99
- **description:** Build log includes a redacted-but-templated invocation `xcrun notarytool log 0c820130-... --apple-id ... --team-id Y7B83UUSAC` where the Apple ID is replaced with `...` but the team ID is left in-place. The team ID is already disclosed throughout the doc (line 16, line 50, line 119 implicitly via cert), so this is not a leak per se, but the asymmetry suggests an incomplete redaction pass. APPLE_DEVELOPER_SETUP.md line 14 already exposes the Apple ID as `rkesteva@gmail.com`, so the redaction in the build log is inconsistent with the rest of the signing-doc surface. Either redact uniformly or expose uniformly.
- **suggested_action:** Pick a policy and apply it across `docs/signing/`: either (a) all signing identifiers are public in-repo (Apple ID, team ID, cert SHA1, submission IDs), since the cert itself and team ID are already discoverable from any signed binary the project ships; or (b) Apple ID is redacted in all files (including APPLE_DEVELOPER_SETUP.md line 14). Document the choice once in APPLE_DEVELOPER_SETUP.md.
- **resolved_by:** 


Suspected tasks: TASK-055

## FIND-SPRINT-003-8
- **source:** SPRINT-003 (sprint-code-reviewer)
- **type:** improvement
- **severity:** low
- **status:** open
- **location:** docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md:211
- **description:** GATEKEEPER_ACCEPTANCE_TEST.md "How to Update This Document" step 6 instructs the tester to `Re-invoke /soloflow:sprint TASK-056 (or /soloflow:review-queue) to trigger final verification`. TASK-056 has already settled as `human_needed` this sprint, so the queued action lives in `human-review-queue.md` under the `testing` bucket — `/soloflow:sprint TASK-056` is not the correct re-entry point. This is a minor doc-vs-state drift that will confuse the user when they finish the manual test.

Suspected tasks: TASK-056
- **suggested_action:** Change step 6 to: "Resolve the queued `manual_acceptance_test` action via `/soloflow:review-queue` (it will pull this completed doc into the testing bucket)." Drop the `/soloflow:sprint TASK-056` reference.
- **resolved_by:** 
