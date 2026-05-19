---
id: TASK-567
idea: IDEA-002
status: in-flight
created: "2026-05-12T00:00:00Z"
files_owned:
  - docs/signing/APPLE_DEVELOPER_SETUP.md
  - docs/signing/FIRST_SIGNED_BUILD_LOG.md
  - docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md
  - docs/signing/builds/README.md
  - docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md
  - docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md
  - docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md
  - docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md
files_readonly:
  - .soloflow/active/plans/apple-signing-notarization-setup/EPIC-apple-signing-notarization-setup.md
  - .soloflow/active/plans/apple-signing-notarization-setup/TASK-055-plan.md
  - .soloflow/active/plans/apple-signing-notarization-setup/TASK-056-plan.md
  - .soloflow/active/findings/SPRINT-003-findings.md
  - .soloflow/active/compound/SPRINT-003-proposal.md
acceptance_criteria:
  - criterion: "`docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md` exists and is byte-identical to the pre-task `docs/signing/FIRST_SIGNED_BUILD_LOG.md` except that the (now-promoted) 'Notes for Future Builds' section has been removed"
    verification: "`test -f docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md` exits 0. `grep -c 'submission ID\\|notarytool\\|lipo\\|codesign' docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md` returns >= 4. `grep -c 'Notes for Future Builds' docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md` returns 0."
  - criterion: "`docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` exists and is byte-identical to the pre-task `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md`"
    verification: "`test -f docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` exits 0. `grep -c 'macOS\\|SHA256\\|spctl' docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` returns >= 3. `grep -c '6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494' docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` returns >= 1 (post-staple DMG SHA256 preserved)."
  - criterion: The top-level `docs/signing/FIRST_SIGNED_BUILD_LOG.md` and `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` have been removed (or replaced with one-line stub redirects to `builds/0.3.5/`)
    verification: "Run `ls docs/signing/FIRST_SIGNED_BUILD_LOG.md docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md 2>&1`. Either both files are absent (preferred), OR each file is <= 5 lines and contains the text 'moved to builds/0.3.5/' (stub option). The plan body chooses the 'delete' option; the stub option is only acceptable if executor finds an external reference that must not break."
  - criterion: "`docs/signing/builds/README.md` exists and documents the lifecycle: directory convention (`builds/<version>/`), copy-from-template instruction, and a list of required files per build"
    verification: "`test -f docs/signing/builds/README.md` exits 0. `grep -c 'builds/<version>' docs/signing/builds/README.md` >= 1. `grep -c 'BUILD_LOG_TEMPLATE\\|GATEKEEPER_TEST_TEMPLATE' docs/signing/builds/README.md` >= 2."
  - criterion: "`docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` exists with placeholder fields for every section present in the 0.3.5 build log (Build Summary, Pre-flight Smoke Tests, Build Process Timeline, configure-build.js Output, Notarization submissions, Rejection Iterations, codesign Verification, spctl Assessment, Stapler Validation, lipo for native binaries)"
    verification: "`test -f docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` exits 0. `grep -c 'Build Summary\\|Notarization\\|codesign\\|spctl\\|stapler\\|lipo' docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` returns >= 6. The template uses `<TODO: ...>` placeholders for every per-build field (no 0.3.5-specific values leak through)."
  - criterion: "`docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md` exists with the same 10-step procedure as the 0.3.5 doc but with every version-specific value (DMG filename, SHA256, submission ID, dates) replaced by `<TODO: ...>` placeholders"
    verification: "`test -f docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md` exits 0. `grep -c 'Step 1\\|Step 5\\|Step 10\\|spctl' docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md` returns >= 4. `grep -c '0\\.3\\.5\\|6eda21e9dd98d4aa8d8fc2fbe636a22d6b6f1e2045ed68d7bb1d640a5490e494\\|c5950a84-b245-4322-a866-f332b6a4bef8' docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md` returns 0 (no version-specific leakage)."
  - criterion: "`docs/signing/APPLE_DEVELOPER_SETUP.md` contains a new 'Known Build Pitfalls' section that incorporates the five 'Notes for Future Builds' items from the 0.3.5 build log (electron-builder background kill / notarytool timeout, separate DMG notarization, Apple notarization latency, configure-build.js notarize rewrite, appId confirmation)"
    verification: "`grep -c 'Known Build Pitfalls' docs/signing/APPLE_DEVELOPER_SETUP.md` returns >= 1. `grep -c 'notarytool\\|hdiutil\\|configure-build' docs/signing/APPLE_DEVELOPER_SETUP.md` returns >= 5 (covers the five pitfalls)."
  - criterion: "`docs/signing/APPLE_DEVELOPER_SETUP.md` contains a new 'Recording a Signed Build' section pointing the next signer at `docs/signing/builds/` and explaining the copy-template-fill workflow"
    verification: "`grep -c 'Recording a Signed Build' docs/signing/APPLE_DEVELOPER_SETUP.md` returns >= 1. `grep -c 'docs/signing/builds/' docs/signing/APPLE_DEVELOPER_SETUP.md` returns >= 1."
  - criterion: "No code or doc outside the moved files references the old top-level paths `docs/signing/FIRST_SIGNED_BUILD_LOG.md` or `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` in a way that would break (in-repo references are updated to the new `builds/0.3.5/` paths, except inside `.soloflow/archive/` which is historical and frozen)"
    verification: "Run `grep -rn 'docs/signing/FIRST_SIGNED_BUILD_LOG.md\\|docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md' --include='*.md' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.yml' --include='*.yaml' --exclude-dir='.soloflow/archive' --exclude-dir='node_modules' --exclude-dir='.claude' .` — every remaining match must be either inside `docs/signing/builds/` (correctly nested) or be the new redirect/pointer in `APPLE_DEVELOPER_SETUP.md` / `builds/README.md`. No raw top-level references remain in active (non-archive) docs."
  - criterion: "The active in-flight TASK-056 plan's references to the old paths still resolve (either by updating its `files_owned`/`files_readonly` to point at `builds/0.3.5/...`, or by leaving them and noting that TASK-056 is mid-execution against the legacy paths)"
    verification: "Read `.soloflow/active/plans/apple-signing-notarization-setup/TASK-056-plan.md` and confirm one of the following: (a) it has been updated in this task to reference `docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md`, OR (b) the plan body of THIS task explicitly defers TASK-056's path update to a follow-up and the original top-level files are left as stub redirects so TASK-056's verification still passes."
depends_on: []
estimated_complexity: low
epic: apple-signing-notarization-setup
test_strategy:
  needed: false
  justification: "Pure docs/markdown reorganization with no code paths exercised. The acceptance-criteria greps ARE the test cases. Sibling-test scan: no test files exist under `docs/signing/` — confirmed `ls docs/signing/` returns only the three `.md` files this plan owns. No JS/TS test files are co-located with these docs."
prerequisites:
  - check: "test -f docs/signing/FIRST_SIGNED_BUILD_LOG.md && test -f docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md && test -f docs/signing/APPLE_DEVELOPER_SETUP.md"
    fix: Source docs missing — restore from git (SPRINT-003 should have left these three files intact at the top level).
    description: "This task moves and rewrites the three existing signing docs; if any of them is already missing, the task cannot run."
    blocking: true
---
# Define a lifecycle and template for per-build signing snapshot docs

## Objective

This work item was surfaced by the compounder during SPRINT-003. Refine it into an execution-ready task plan.

Eliminate the two failure modes called out in FIND-SPRINT-003-4 — (a) silent overwrite of the 0.3.5 audit trail by the next signer, and (b) ad-hoc `_v2.md` proliferation — by establishing a `docs/signing/builds/<version>/` convention with explicit templates, moving the existing 0.3.5 build evidence under that convention, and updating `APPLE_DEVELOPER_SETUP.md` to (i) tell the next signer exactly where to put 0.3.6 build evidence and (ii) absorb the "Notes for Future Builds" runbook material currently buried inside the 0.3.5 build log.

The chosen direction is a **blend favoring Option 1 (versioned data-sheet model)**: the existing docs are too version-pinned (filenames, timestamps, submission IDs, SHA256, even step-5 of the test procedure embeds `Cyboflow-0.3.5-macOS-universal.dmg`) to be sensibly turned into stable runbooks via Option 2. Moving them under `builds/0.3.5/` and providing templates is the lower-risk, higher-clarity path. The Option-2 idea of promoting genuine *runbook* material survives as the "Known Build Pitfalls" + "Recording a Signed Build" sections appended to `APPLE_DEVELOPER_SETUP.md`.

## Implementation Steps

1. **Create the `docs/signing/builds/` directory tree.** Add `docs/signing/builds/`, `docs/signing/builds/0.3.5/`, and `docs/signing/builds/_template/`. Use `_template` (with leading underscore) to make it visually obvious that this directory is the template stash, not a real version.

2. **Move the 0.3.5 build log.** `git mv docs/signing/FIRST_SIGNED_BUILD_LOG.md docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md`. Then edit the moved file to remove the entire "Notes for Future Builds" section (lines 221–235 in the original), since that content is being promoted to `APPLE_DEVELOPER_SETUP.md`. Leave all other content byte-identical — every submission ID, SHA256, and timestamp is audit-trail evidence and must not be altered.

3. **Move the 0.3.5 Gatekeeper test record.** `git mv docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md`. Do not modify the body — the cross-reference at line 21 (`docs/signing/FIRST_SIGNED_BUILD_LOG.md`) is wrong relative to the new location; the correct relative reference from `docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` to the sibling moved log is `./FIRST_SIGNED_BUILD_LOG.md`. Apply that single-line fix as part of this step.

4. **Create `docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md`.** Base it on the structure of the (just-moved) 0.3.5 log but replace every value with a `<TODO: ...>` placeholder. Keep all section headings: Build Summary, Pre-flight Smoke Tests, Build Process Timeline, configure-build.js Output, Notarization — Submission 1, Notarization — Submission 2 (mark as "omit if not applicable"), Rejection Iterations, codesign Verification, spctl Assessment, Stapler Validation, lipo — better-sqlite3 Universal Binary, lipo — node-pty Universal Binary. Do NOT include a "Notes for Future Builds" section here — that material now lives in `APPLE_DEVELOPER_SETUP.md` and per-version logs should only record evidence specific to that build.

5. **Create `docs/signing/builds/_template/GATEKEEPER_TEST_TEMPLATE.md`.** Base it on the (just-moved) 0.3.5 Gatekeeper test doc. Replace every version-specific value (DMG filename, SHA256, notarytool submission ID, dates, build version) with `<TODO: ...>` placeholders. Update Step 2's `cp dist-electron/Cyboflow-0.3.5-macOS-universal.dmg ...` to `cp dist-electron/Cyboflow-<VERSION>-macOS-universal.dmg ...`. Preserve the 10-step procedure verbatim.

6. **Create `docs/signing/builds/README.md`** documenting the lifecycle. Required content:
   - One-paragraph statement of policy: per signed release, copy the two `_template/` files into a new `builds/<version>/` directory, fill in the placeholders, commit.
   - Directory convention: `builds/<version>/FIRST_SIGNED_BUILD_LOG.md` and `builds/<version>/GATEKEEPER_ACCEPTANCE_TEST.md`. Version string matches `package.json` → `version`.
   - "Never overwrite" rule: completed `builds/<version>/` directories are append-only audit records; a regression discovered after the fact gets recorded in a NEW directory (e.g. `builds/0.3.5-rebuild/`), not by editing the original.
   - Pointer to `APPLE_DEVELOPER_SETUP.md` § "Known Build Pitfalls" for runbook material.

7. **Delete the top-level legacy paths.** After steps 2 and 3 have moved both files via `git mv`, there is nothing left at `docs/signing/FIRST_SIGNED_BUILD_LOG.md` or `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` (which is the desired post-state per AC criterion #3, "delete" option). If `git mv` was used in steps 2 and 3, no extra action is needed here — confirm via `ls docs/signing/*.md` that only `APPLE_DEVELOPER_SETUP.md` remains at the top level of `docs/signing/`.

8. **Append a "Known Build Pitfalls" section to `docs/signing/APPLE_DEVELOPER_SETUP.md`.** Insert it after the "Troubleshooting" section (currently the last section, ending around line 406). Port the five items from the original 0.3.5 build log's "Notes for Future Builds":
   - **Pitfall 1: `electron-builder` background kill during notarytool wait.** Foreground the build or extend the terminal timeout; notarization may take ~1 hour on first submission. Recovery: poll `xcrun notarytool info`, manually staple the .app, manually create the DMG with `hdiutil create`, re-submit and staple the DMG.
   - **Pitfall 2: DMG notarization is a separate round-trip from app notarization.** If the build is interrupted after `.app` signing but before DMG creation, the DMG must be submitted separately (adds ~2 min).
   - **Pitfall 3: Apple notarization latency variance.** First submission for a new app identity can take ~95 min; subsequent submissions are typically 2–15 min. Do not assume a slow notarization means the submission has failed.
   - **Pitfall 4: `configure-build.js` rewrites `package.json` `build.mac.notarize` at build time.** The committed value (`true`) is overridden — `APPLE_*` env vars are what actually drive the credentials. A contributor invoking `pnpm electron-builder` directly (bypassing `pnpm run build:mac:*`) will get unexpected behavior. (This also overlaps with C1 from the SPRINT-003 compound proposal, which adds a richer `configure-build.js contract` subsection in the same doc — keep this pitfall concise and let the contract section be the canonical reference.)
   - **Pitfall 5: Stapling rewrites the DMG.** Always record the post-staple SHA256 (the file users download) in the Gatekeeper test record; the pre-staple SHA256 from the notarytool submission record is for cross-reference only and will NOT match the file on disk. (This codifies the lesson from FIND-SPRINT-003-3.)

9. **Append a "Recording a Signed Build" section to `docs/signing/APPLE_DEVELOPER_SETUP.md`.** Insert it directly before the new "Known Build Pitfalls" section so it is the first thing the next signer hits when searching the doc. Content:
   - Workflow: after `pnpm run build:mac:universal` produces a signed-and-notarized DMG, copy `docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` to `docs/signing/builds/<version>/FIRST_SIGNED_BUILD_LOG.md` and fill in the placeholders.
   - Same for `GATEKEEPER_TEST_TEMPLATE.md` → `docs/signing/builds/<version>/GATEKEEPER_ACCEPTANCE_TEST.md` after the clean-account test completes.
   - Pointer to `docs/signing/builds/README.md` for the full lifecycle policy.
   - One-line reminder: this directory is the audit trail for distribution — never overwrite a completed build's evidence.

10. **Update the active TASK-056 plan reference (option B from AC #10).** TASK-056 is in-flight and its `files_owned` lists `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` — that path no longer exists after this task. Update `.soloflow/active/plans/apple-signing-notarization-setup/TASK-056-plan.md`'s `files_owned` entry to `docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` and its `files_readonly` `docs/signing/FIRST_SIGNED_BUILD_LOG.md` to `docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md`. Do NOT modify the body of TASK-056 (its implementation steps still describe the right procedure; only the file path target changes). This is a frontmatter-only edit.

11. **Sweep for stale references.** Run:
    ```
    grep -rn 'docs/signing/FIRST_SIGNED_BUILD_LOG.md\|docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md' --include='*.md' --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.yml' --include='*.yaml' --exclude-dir='.soloflow/archive' --exclude-dir='node_modules' --exclude-dir='.claude' .
    ```
    For each match found, decide:
    - Inside `.soloflow/archive/` → leave alone (historical, frozen).
    - Inside `.soloflow/active/plans/apple-signing-notarization-setup/TASK-056-plan.md` → already handled by step 10.
    - Inside the new `docs/signing/builds/0.3.5/*.md` → leave alone (these are the moved files cross-referencing each other; step 3 already fixed the one such reference).
    - Anywhere else → update to the new `docs/signing/builds/0.3.5/...` path.

12. **Re-run the sweep grep as a completeness gate** before reporting COMPLETED. Confirm that every remaining match falls into one of the four "leave alone" categories from step 11.

## Acceptance Criteria

Each criterion listed in the frontmatter must be satisfied. In summary:
- 0.3.5 evidence preserved at the new location, byte-identical except the "Notes for Future Builds" section is removed from the build log (its content is now in `APPLE_DEVELOPER_SETUP.md`).
- Top-level legacy paths gone (no stubs).
- `builds/README.md` documents the lifecycle.
- Two generic templates exist with no version-specific values leaking through.
- `APPLE_DEVELOPER_SETUP.md` has both new sections: "Recording a Signed Build" (pointer/workflow) and "Known Build Pitfalls" (the five runbook items).
- No stale references to the old top-level paths remain outside `.soloflow/archive/`.
- The in-flight TASK-056 plan has been updated so its `files_owned`/`files_readonly` resolve.

## Test Strategy

No automated tests. This task is markdown-only and the acceptance-criteria greps ARE the verification. Sibling-test scan: `ls docs/signing/` shows only the three `.md` files this plan owns plus the new directories created here — no co-located test files exist or would be appropriate.

## Hardest Decision

Choosing between Option 1 (versioned data sheets) and Option 2 (stable runbooks). The compounder offered both as viable. The deciding factor: a quick re-read of the two existing docs showed they are **predominantly version-pinned evidence** (5 of the 6 main sections in the build log are submission IDs / timestamps / hashes; 8 of the 10 steps in the Gatekeeper test reference the specific DMG filename or its hash). Trying to convert them into stable runbooks would either (a) discard the audit evidence (unacceptable — the first signed build's record is meaningful to future contributors investigating Gatekeeper regressions), or (b) result in a doc that is half-stable-procedure and half-version-snapshot, which is exactly the unclear state that surfaced this finding in the first place. Option 1 produces clean separation: per-version directories are pure evidence; `APPLE_DEVELOPER_SETUP.md` is pure runbook.

The smaller-but-real second decision: whether to leave stub redirect files at the old top-level paths. Going with delete-not-stub because (1) the only known active in-repo reference is TASK-056's frontmatter, which is fixed inline, (2) `.soloflow/archive/` references are historical and tolerate broken links, (3) stubs add ongoing maintenance cost ("when do we delete them?"). The git history preserves the rename via `git mv` so external readers tracing a commit can still follow.

## Rejected Alternatives

- **Pure Option 2 (stable-runbook model with Build History tables).** Rejected because the existing docs are not predominantly procedural — they are evidence records with procedure embedded. Forcing them into a stable-runbook shape would require gutting the evidence sections and would lose the first-build audit trail. Would reconsider if a future signed-build doc emerged that was genuinely procedural (no per-version data); the templates this task creates make that easy to spot.

- **Leave the files in place and just add a "Build History" table at the top of each.** Rejected because it does not solve the original failure mode: the next signer still has no clear instruction on whether to overwrite, append rows, or create a new file. The directory convention is the unambiguous signal.

- **Move only the build log, leave the Gatekeeper test in place.** Rejected because the two docs are symmetric — both are per-build evidence — and treating them asymmetrically would itself be a documentation smell.

## Lowest Confidence Area

Step 10's update to the in-flight TASK-056 plan is the riskiest part of this task. TASK-056 is currently in the human-review queue (testing bucket); a path change to its frontmatter while it is queued might confuse the review-queue tooling if it indexes plans by their original `files_owned` paths. Mitigation: the change is frontmatter-only and the file's `id`, `status`, and body are untouched, so any indexer keyed on `id` will be fine. If the review-queue tooling is keyed on file paths inside `files_owned`, the executor should pause and surface a clarification before applying step 10. The fallback (option A from AC #10) is to instead leave stub redirect files at the old paths so TASK-056's existing references continue to resolve — but the plan above commits to option B (no stubs) for the cleanliness reasons cited in "Hardest Decision."
