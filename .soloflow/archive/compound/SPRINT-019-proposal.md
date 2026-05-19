---
sprints: [SPRINT-019]
span_label: SPRINT-019
created: 2026-05-18T00:00:00.000Z
counters_start:
  ideas: 0
summary:
  cleanups: 5
  backlog_tasks: 3
  claude_md: 0
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-019

SPRINT-019 delivered three apple-signing-notarization-setup tasks (TASK-567, TASK-584, TASK-585):
a docs/signing/ versioned-evidence restructure, an asarUnpack path correction for cyboflowMcpServer.js,
and a dead-dep audit yielding docs/packaging/root-deps-policy.md. All three tasks completed with
`executor_loops: 0` and `code_review_rounds: 0`. No stuck reports. Eight open findings remain
(FIND-SPRINT-019-1 and -2 were already resolved by the verifier).

## A. Clean-up items (execute now)

### A1. Fix stale "13-step" wording in human-review-queue.md TASK-056 entry
- **Summary:** The TASK-056 Gatekeeper testing queue entry says "13-step procedure" but the referenced doc contains exactly 10 numbered steps.
- **Source-Sprint:** SPRINT-019
- **Rationale:** The step count is wrong and will confuse whoever performs the clean-account Gatekeeper test for the 0.3.5 DMG. The fix is a one-word change to a single prose field.
- **Blast radius:** `.soloflow/human-review-queue.md` only, trivial risk.
- **Source:** FIND-SPRINT-019-3 (TASK-567 code-reviewer); the pre-existing wording originates from commit d5e0d08 (chore(TASK-056): human-needed) before TASK-567 ran. TASK-567 correctly updated the path inside the same entry (AC #9) but left the step-count wording untouched as out of scope.
- **Proposed change:**
  ```diff
  # .soloflow/human-review-queue.md — TASK-056 action field
  -  action: "Clean-account Gatekeeper acceptance test for Cyboflow-0.3.5-macOS-universal.dmg …
  -   Follow the 13-step procedure already scaffolded into docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md …"
  +  action: "Clean-account Gatekeeper acceptance test for Cyboflow-0.3.5-macOS-universal.dmg …
  +   Follow the 10-step procedure already scaffolded into docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md …"
  ```
  (The phrase "13-step" appears on line 63 of human-review-queue.md; replace with "10-step".)

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `.soloflow/human-review-queue.md:63` contains "13-step procedure" while `docs/signing/builds/0.3.5/GATEKEEPER_ACCEPTANCE_TEST.md` has exactly 10 numbered step headings (`Step 1`–`Step 10`); the README at `docs/signing/builds/README.md:58` even cites "10-step procedure results" — a single-word fix in one prose field with zero blast radius.

---

### A2. Fix stale JSDoc in scriptPath.ts (wrong dev-mode emit path)
- **Summary:** The JSDoc comment in scriptPath.ts states the dev-mode compiled output is at `main/dist/orchestrator/mcpServer/` but the actual tsc emit path is `main/dist/main/src/orchestrator/mcpServer/`.
- **Source-Sprint:** SPRINT-019
- **Rationale:** TASK-584 added the correct path to both `package.json` `build.asarUnpack` and the new `docs/ARCHITECTURE.md § asarUnpack contract` subsection, but did not update scriptPath.ts's JSDoc (the file was not in TASK-584's diff scope). The stale comment now directly contradicts the authoritative ARCHITECTURE.md documentation, creating a trap for any developer who reads the source comment first.
- **Blast radius:** `main/src/orchestrator/mcpServer/scriptPath.ts` comment only (line ~28), zero functional change, trivial risk.
- **Source:** FIND-SPRINT-019-7 (SPRINT-019 sprint-code-reviewer); TASK-584 done report confirms the correct path in ARCHITECTURE.md at lines 182-196.
- **Proposed change:**
  ```diff
  # main/src/orchestrator/mcpServer/scriptPath.ts  (~line 28)
  - *   into main/dist/orchestrator/mcpServer/.
  + *   into main/dist/main/src/orchestrator/mcpServer/.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `main/src/orchestrator/mcpServer/scriptPath.ts:28` literally reads "into main/dist/orchestrator/mcpServer/." which contradicts the authoritative `docs/ARCHITECTURE.md:192` ("The tsc emit layout for the main process is `main/dist/main/src/**`") and the corrected `package.json` asarUnpack path — a one-line JSDoc fix in the same file the contract describes, zero functional risk.

---

### A3. Add cyboflowMcpServer.js unpack verification step to BUILD_LOG_TEMPLATE.md
- **Summary:** The build log template's verification section checks better-sqlite3 and node-pty unpacking but has no step for cyboflowMcpServer.js, the file that TASK-584 made the sole asarUnpack entry.
- **Source-Sprint:** SPRINT-019
- **Rationale:** TASK-567 authored the template before TASK-584 narrowed asarUnpack to a single concrete path. Without an explicit template step, the next signed build will not catch a regression where cyboflowMcpServer.js fails to unpack. The gap is purely in the template — the fix is adding one shell command block to a markdown file.
- **Blast radius:** `docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` only (append a new AC section after the lipo checks), trivial risk.
- **Source:** FIND-SPRINT-019-6 (SPRINT-019 sprint-code-reviewer); cross-task gap between TASK-567 (template author) and TASK-584 (asarUnpack narrower).
- **Proposed change:**

  Append after the existing lipo section (currently ending around line 170 of the template):

  ```diff
  +---
  +
  +## cyboflowMcpServer.js Unpacking (AC6)
  +
  +```
  +$ test -f dist-electron/mac-universal/Cyboflow.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js && echo "PRESENT" || echo "MISSING"
  +<TODO: paste verbatim output — expected: "PRESENT">
  +```
  +
  +File confirmed present under `app.asar.unpacked/`.
  ```

  No change needed to `docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md` — the 0.3.5 build predates this check; add a brief historical note only if the team wants an explicit audit marker.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` ends at the node-pty lipo check (line ~170) with no cyboflowMcpServer.js verification, even though `package.json` now lists that file as the sole concrete asarUnpack entry — appending one shell snippet to the template directly closes the regression-detection gap with no other touch points.

---

### A4. Link docs/packaging/root-deps-policy.md from ARCHITECTURE.md
- **Summary:** The new packaging policy doc created by TASK-585 has no inbound links and will not be discovered by contributors editing main/package.json dependencies.
- **Source-Sprint:** SPRINT-019
- **Rationale:** TASK-584's asarUnpack contract was added as a subsection inside ARCHITECTURE.md and is immediately discoverable. TASK-585's root-deps-policy.md was created as a standalone file with zero references — a contributor editing `main/package.json` deps will never see it. Adding a one-line `See also` pointer in ARCHITECTURE.md (adjacent to the asarUnpack contract) closes the discoverability gap at zero cost.
- **Blast radius:** `docs/ARCHITECTURE.md` only (one line appended to the asarUnpack contract subsection), trivial risk.
- **Source:** FIND-SPRINT-019-8 (SPRINT-019 sprint-code-reviewer); TASK-585 done report confirms the doc was created at `docs/packaging/root-deps-policy.md` and is currently unlinked.
- **Proposed change:**
  ```diff
  # docs/ARCHITECTURE.md — end of the "asarUnpack contract" subsection (~line 196)
     path — avoid broad wildcards to minimise the unpacked-tree size.
  +
  +  See also `docs/packaging/root-deps-policy.md` for the workspace dependency
  +  policy (which deps belong in `main/package.json` vs. root `package.json`,
  +  and the list of confirmed dead dependencies pending removal).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Repo-wide grep for `root-deps-policy` returns no hits outside `.soloflow/` plan/finding artifacts and the file itself — the policy doc is genuinely orphaned, and adding a `See also` line to the existing `### asarUnpack contract` subsection in `docs/ARCHITECTURE.md` (already the discoverability anchor for packaging) is the smallest possible fix.

---

### A5. Add Apple ID redaction warning to BUILD_LOG_TEMPLATE.md notarization section
- **Summary:** The 0.3.5 build log contains a real Apple ID email in a committed notarytool transcript; the template currently provides no guidance to redact it in future records.
- **Source-Sprint:** SPRINT-019
- **Rationale:** `docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md:99` contains `--apple-id <APPLE_ID>` verbatim. All other signing docs use `<APPLE_ID>` placeholders. The template's notarytool command example should use the placeholder and add a one-line warning so future build records don't repeat the pattern. The historical 0.3.5 record is an append-only audit record — redacting it is the user's call and is noted as optional.
- **Blast radius:** `docs/signing/builds/_template/BUILD_LOG_TEMPLATE.md` (add one warning line above the notarization section placeholder, change any literal email in the example command to `<APPLE_ID>`). Optional: `docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md` line 99 (`<APPLE_ID>` → `<APPLE_ID>`). Both changes are markdown-only, trivial risk.
- **Source:** FIND-SPRINT-019-9 (SPRINT-019 sprint-code-reviewer); evidence at `docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md:99`.
- **Proposed change:**

  In `BUILD_LOG_TEMPLATE.md`, above the Notarization section's `xcrun notarytool` command placeholder:
  ```diff
  +> Use `<APPLE_ID>` for the Apple ID in committed transcripts. The real email
  +> is not required for cross-reference — the submission ID and Team ID are
  +> sufficient audit anchors.
  ```
  Ensure any example `notarytool` command in the template uses `<APPLE_ID>` not a literal address.

  Optional (historical record, user decides):
  ```diff
  # docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md:99
  -xcrun notarytool log 0c820130-8bfc-4d58-b825-76f8abf94e40 --apple-id <APPLE_ID> --team-id Y7B83UUSAC
  +xcrun notarytool log 0c820130-8bfc-4d58-b825-76f8abf94e40 --apple-id <APPLE_ID> --team-id Y7B83UUSAC
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Confirmed `docs/signing/builds/0.3.5/FIRST_SIGNED_BUILD_LOG.md:99` contains `--apple-id <APPLE_ID>` verbatim while the rest of the signing docs use `<APPLE_ID>` placeholders — the template's existing `<APPLE_ID>` usage at line 83 needs an explicit prose warning to make the convention sticky for future builders; note that the same email already appears in `docs/signing/APPLE_DEVELOPER_SETUP.md:14,22` so this is mitigation, not a hard PII boundary.
- **Counterfactual:** If the user explicitly intends to keep the Apple ID public in audit records (consistent with `APPLE_DEVELOPER_SETUP.md`), drop the historical-redact half and keep only the template warning.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Remove dead electron-store dependency from main/package.json
- **Summary:** electron-store is declared in main/package.json but has zero importers in main/src; it is a Crystal-era leftover that should be removed.
- **Source-Sprint:** SPRINT-019
- **Source:** FIND-SPRINT-019-5 (TASK-585 executor); TASK-585 done report confirms the finding and explains why deletion was deferred to a follow-up task (behavior-class change requiring deliberate verification). `docs/packaging/root-deps-policy.md` documents it under "Dead dependencies."
- **Problem:** `main/package.json:25` declares `electron-store@^11.0.0`. A full grep of `main/src/**/*.ts` finds zero `import … from 'electron-store'` or `require('electron-store')` calls (confirmed by TASK-585 executor). The dep appears to be a Crystal-era leftover from when window-state persistence was handled differently. Leaving it in place wastes bundle size and risks `pnpm install` pulling a package that is never used.
- **Proposed direction:** Create a cleanup task that: (1) removes `electron-store` from `main/package.json` dependencies; (2) runs `pnpm install` to confirm no peer-dep warnings; (3) runs `pnpm typecheck` and `pnpm lint` (both must exit 0); (4) runs `pnpm --filter main test` (after `pnpm electron:rebuild` if the ABI mismatch is still present); (5) on success, updates `docs/packaging/root-deps-policy.md` to move `electron-store` from the "Dead dependencies" list to a removed-deps note. The task needs no packaged-build verification since the dep has zero importers and its removal path is unreachable.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Confirmed `grep -rn "from 'electron-store'\|require('electron-store')"` across `main/src`, `frontend/src`, and `shared` returns zero hits while `main/package.json:25` still declares `electron-store@^11.0.0` — TASK-585 already documented this in `docs/packaging/root-deps-policy.md`, and the proposed direction is a small targeted removal with proportional verification (typecheck/lint/test) rather than a refactor.

---

### B2. Update TASK-584 acceptance criteria to reflect cyboflowMcpServer.js (plan contains stale bridge-file references)
- **Summary:** TASK-584's original plan referenced two non-existent bridge files (cyboflowPermissionBridge.js / cyboflowPermissionBridgeStandalone.js) in its acceptance criteria; the executor adapted at runtime but the plan AC text was never updated.
- **Source-Sprint:** SPRINT-019
- **Source:** FIND-SPRINT-019-4 (TASK-584 executor); TASK-584 done report "Plan Adaptation" section.
- **Problem:** `.soloflow/active/plans/apple-signing-notarization-setup/TASK-584-plan.md` contains acceptance criteria that check for `cyboflowPermissionBridge.js` and `cyboflowPermissionBridgeStandalone.js` — files that no longer exist (removed during the Claude Agent SDK migration in an earlier sprint). The executor correctly identified the real target (`cyboflowMcpServer.js`), fixed `package.json`, and logged FIND-SPRINT-019-4, but the plan AC text still references the stale bridge files. If the plan is ever re-opened (e.g., for packaged-build smoke verification of AC#2 and AC#3 — currently deferred per TASK-584 done report), a verifier checking the plan will fail AC checks against non-existent files. Additionally, the plan's suggestion to remove the `scriptPath.ts` ASAR-extraction fallback once asarUnpack is verified is a distinct follow-up concern worth capturing.
- **Proposed direction:** Create a task that: (1) updates TASK-584-plan.md AC text to reference `cyboflowMcpServer.js` at path `main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js` throughout; (2) resolves the deferred packaged-build ACs (AC#2 and AC#3) by running `SKIP_SIGNING=1 pnpm run build:mac:arm64` after fixing the pre-existing `frontend/vite.config.ts` TS error (introduced by TASK-402), then confirming the file appears under `app.asar.unpacked/`; (3) optionally evaluates whether the ASAR-extraction fallback in `scriptPath.ts` (lines 43-58) should be removed now that `asarUnpack` is correctly configured — remove only if the packaged build smoke confirms the fallback never fires. The vite.config.ts fix is a prerequisite and may warrant its own task first.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** high
- **Reasoning:** TASK-584 is already archived (`.soloflow/archive/done/apple-signing-notarization-setup/TASK-584-done.md`, `status: done`) and its plan only survives at a worktree path (`.soloflow/worktrees/TASK-554/...`), and the deferred packaged-build smoke that is the only substantive part of this proposal is already queued at `.soloflow/human-review-queue.md:178-182` with the same prereqs and verification steps — implementing this task would duplicate existing tracked work to "fix" a plan no future verifier will reopen.
- **Counterfactual:** If the user wants a `scriptPath.ts` fallback-removal task as a distinct follow-up after the smoke confirms unpack works, that is a real future task — but it should be raised after the smoke, not bundled with stale-AC clean-up on an archived plan.

---

### B3. Resolve cross-doc duplication — builds/README.md vs APPLE_DEVELOPER_SETUP.md workflow instructions
- **Summary:** docs/signing/builds/README.md and docs/signing/APPLE_DEVELOPER_SETUP.md both contain the same step-by-step "copy templates, fill in, commit" workflow, creating a drift risk when one is updated and the other is not.
- **Source-Sprint:** SPRINT-019
- **Source:** FIND-SPRINT-019-10 (SPRINT-019 sprint-code-reviewer); both files were created or updated by TASK-567. FIND-SPRINT-019-10 notes that builds/README.md already cites APPLE_DEVELOPER_SETUP.md as the workflow source but still duplicates the instructions inline.
- **Problem:** `docs/signing/builds/README.md:26-47` contains a four-step "How to Record a New Signed Build" workflow (mkdir, cp templates, fill in placeholders, git add + commit). `docs/signing/APPLE_DEVELOPER_SETUP.md` has a matching "Recording a Signed Build" section covering the same ground. The README even points to APPLE_DEVELOPER_SETUP.md as the source of truth, yet still embeds the workflow. If one section is extended (e.g., to add the new cyboflowMcpServer.js unpack check from A3), the other must be found and updated in sync — a burden that grows with each build iteration.
- **Proposed direction:** Pick one canonical home and reduce the other to a pointer. The cleaner option is to keep the full workflow in `APPLE_DEVELOPER_SETUP.md` (already designated the canonical reference by CLAUDE.md's Reference Docs list) and trim `builds/README.md § How to Record a New Signed Build` to 2-3 lines referencing APPLE_DEVELOPER_SETUP.md — keeping only the directory-convention table, the required-files table, and the never-overwrite rule as local context. The task should update both files, verify no other file links to the trimmed section headers, and confirm the resulting README still stands alone as a quick-reference for the `builds/` directory's structure rules.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** DONT_IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The duplication is real (`docs/signing/builds/README.md:26-47` vs `docs/signing/APPLE_DEVELOPER_SETUP.md:427-461`) but the duplicated content is abstract `cp → fill → commit` workflow steps with no AC-detail churn, severity is theoretical-drift only, and `docs/signing/builds/README.md:47` already back-points to APPLE_DEVELOPER_SETUP.md as the source of truth — adding a stub-rewrite task for a one-sprint observation with no recurrence costs more attention than letting the redundancy sit.
- **Counterfactual:** If a future sprint records the workflow drifting (e.g. one doc updated, the other forgotten and a verifier follows the stale copy), this becomes an IMPLEMENT next time the issue surfaces.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

_No items._

No novel CLAUDE.md or CODE-PATTERNS.md gaps were identified from SPRINT-019's work. TASK-584 already captured the asarUnpack contract in `docs/ARCHITECTURE.md § asarUnpack contract` (the correct target for a packaging convention). All other open findings resolve to bounded edits (A-bucket) or scoped tasks (B-bucket).

---

## Reconciled Findings (informational)

_None._ FIND-SPRINT-019-1 and FIND-SPRINT-019-2 had `status: resolved` in the findings file and were correctly skipped. No done report claims resolution for any finding that the findings file still marks `status: open`.
