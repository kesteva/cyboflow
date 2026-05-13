---
sprints: [SPRINT-003]
span_label: SPRINT-003
created: 2026-05-12T00:00:00Z
counters_start:
  ideas: 0
summary:
  cleanups: 4
  backlog_tasks: 1
  claude_md: 1
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-003

## A. Clean-up items (execute now)

### A1. Fix `prefer-const` lint error in MessagesView.tsx
- **Summary:** Change `let response` at `frontend/src/components/panels/ai/MessagesView.tsx:47` to a single `const` declaration to clear the project-wide `pnpm lint` gate (currently exits non-zero).
- **Source-Sprint:** SPRINT-003
- **Rationale:** `pnpm lint` exits with code 1 because of this single error among 305 warnings. The lint gate is red for every contributor until this is fixed. The fix is mechanical: `let response: { success: boolean; data?: JSONMessage[] };` on line 47 followed by an assignment on line 50 can be collapsed into one `const` declaration with the await inline.
- **Blast radius:** `frontend/src/components/panels/ai/MessagesView.tsx` only; risk trivial (verifier confirmed no downstream reassignment of `response` in the function).
- **Source:** FIND-SPRINT-003-2 (TASK-055 verifier, surfaced in TASK-055 done report line 21); pre-existing since commit `2d184f2` (TASK-001 Codex/OpenAI removal).
- **Proposed change:**
  ```diff
  // frontend/src/components/panels/ai/MessagesView.tsx  (around line 47)
  -       let response: { success: boolean; data?: JSONMessage[] };
  -
  -       // Get JSON messages from API
  -       response = await API.panels.getJsonMessages(panelId);
  +       // Get JSON messages from API
  +       const response = await API.panels.getJsonMessages(panelId);
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `pnpm lint` reproduces exactly one error at `frontend/src/components/panels/ai/MessagesView.tsx:50:9` ("`'response' is never reassigned. Use 'const' instead`") among 305 warnings, and reading lines 47–115 confirms `response` is only assigned once at line 50 with no reassignment downstream, so this is a one-line mechanical fix that unblocks the project-wide lint gate.

---

### A2. Fix incorrect re-entry point in GATEKEEPER_ACCEPTANCE_TEST.md step 6
- **Summary:** Change the "How to Update This Document" step 6 in `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` to reference `/soloflow:review-queue` only — the `TASK-056` sprint invocation listed there is no longer the correct re-entry point.
- **Source-Sprint:** SPRINT-003
- **Rationale:** TASK-056 settled as `human_needed` this sprint; the queued action lives in `human-review-queue.md` under the `testing` bucket. A user who follows the acceptance-test procedure and then tries to re-invoke `/soloflow:sprint TASK-056` will be confused. The correct re-entry is `/soloflow:review-queue`, which is already listed as the fallback in the original text.
- **Blast radius:** `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` line 211 only; risk trivial.
- **Source:** FIND-SPRINT-003-8 (sprint-code-reviewer); `human-review-queue.md` testing bucket entry for TASK-056.
- **Proposed change:**
  ```diff
  // docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md  line 211
  -6. Re-invoke `/soloflow:sprint TASK-056` (or `/soloflow:review-queue`) to trigger final verification.
  +6. Resolve the queued `manual_acceptance_test` action via `/soloflow:review-queue` (it will pull this completed doc into the testing bucket).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `.soloflow/human-review-queue.md` confirms TASK-056 lives in the testing bucket as a `manual_acceptance_test` action (line 22–30), so the `/soloflow:sprint TASK-056` reference at `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md:211` is genuinely stale; one-line doc tweak with zero blast radius.

---

### A3. Tighten AC3 data-directory check to Cyboflow-only path
- **Summary:** Remove the `|| test -s ~/.crystal/crystal.db` fallback from the AC3 data-directory check in `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` (lines 149 and 178) so a legacy-Crystal write is no longer accepted as a pass condition.
- **Source-Sprint:** SPRINT-003
- **Rationale:** The Cyboflow rebrand is confirmed complete (`appId: com.cyboflow.app`, FIRST_SIGNED_BUILD_LOG.md note 5). Keeping the `~/.crystal/` OR allows the test to silently pass if a regression reverts the data-directory path. Two occurrences: the runnable check block (line 149) and the CLI Verification Outputs template (line 178).
- **Blast radius:** `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` lines 149 and 178; risk trivial.
- **Source:** FIND-SPRINT-003-5 (sprint-code-reviewer); FIRST_SIGNED_BUILD_LOG.md note 5 ("rebrand is complete").
- **Proposed change:**
  ```diff
  // docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md  line 149
  -test -s ~/.cyboflow/cyboflow.db || test -s ~/.crystal/crystal.db; echo $?
  +test -s ~/.cyboflow/cyboflow.db; echo $?

  // docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md  line 178 (CLI Verification Outputs template)
  -  test -s ~/.cyboflow/cyboflow.db || test -s ~/.crystal/crystal.db; echo $?
  +  test -s ~/.cyboflow/cyboflow.db; echo $?
  ```
  Add a one-line note after the Step 10 expected-output block:

  > **Note:** AC3 fails if any `~/.crystal/` artifacts appear on a clean account — the rebrand is complete and the legacy path is not an acceptable substitute.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Both cited locations (`GATEKEEPER_ACCEPTANCE_TEST.md:149` and `:178`) contain the `|| test -s ~/.crystal/crystal.db` fallback verbatim, and `FIRST_SIGNED_BUILD_LOG.md:235` plus `package.json` (`appId: com.cyboflow.app`) confirm the rebrand is complete — keeping the OR would let a regression to the legacy path silently pass AC3.

---

### A4. Resolve asymmetric signing-identifier redaction in FIRST_SIGNED_BUILD_LOG.md
- **Summary:** Align the `docs/signing/FIRST_SIGNED_BUILD_LOG.md` notarytool log invocation at line 99 with the rest of the signing-doc surface: either expose the Apple ID consistently (matching `APPLE_DEVELOPER_SETUP.md:14`) or redact it in both files.
- **Source-Sprint:** SPRINT-003
- **Rationale:** `FIRST_SIGNED_BUILD_LOG.md:99` shows `--apple-id ...` (redacted) while `--team-id Y7B83UUSAC` is left in. Meanwhile `APPLE_DEVELOPER_SETUP.md:14` already exposes `<APPLE_ID>` inline. Team ID, cert SHA1, and submission IDs are already public throughout the signing docs. The asymmetric redaction is a cosmetic inconsistency but will puzzle any contributor auditing the docs — it looks like an incomplete privacy pass when the project has already decided the Apple ID is public. Recommended policy: expose uniformly (Apple ID, team ID, cert SHA1, submission IDs are all public in-repo; the only secret is `APPLE_APP_SPECIFIC_PASSWORD` which is never committed).
- **Blast radius:** `docs/signing/FIRST_SIGNED_BUILD_LOG.md` line 99 only; risk trivial.
- **Source:** FIND-SPRINT-003-7 (sprint-code-reviewer); `docs/signing/APPLE_DEVELOPER_SETUP.md:14` (Apple ID already public).
- **Proposed change:**
  ```diff
  // docs/signing/FIRST_SIGNED_BUILD_LOG.md  line 99
  -xcrun notarytool log 0c820130-8bfc-4d58-b825-76f8abf94e40 --apple-id ... --team-id Y7B83UUSAC
  +xcrun notarytool log 0c820130-8bfc-4d58-b825-76f8abf94e40 --apple-id <APPLE_ID> --team-id Y7B83UUSAC
  ```
  Optionally add one sentence to the `APPLE_DEVELOPER_SETUP.md` Identity section noting the policy: "All signing identifiers (Apple ID, Team ID, cert SHA1, notarytool submission IDs) are committed in plain text in `docs/signing/`. The only secret is `APPLE_APP_SPECIFIC_PASSWORD`, which is never committed."

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** `FIRST_SIGNED_BUILD_LOG.md:99` does have the asymmetric `--apple-id ... --team-id Y7B83UUSAC`, and `APPLE_DEVELOPER_SETUP.md:14` and `:22` already expose `<APPLE_ID>` in plain text, so the redaction is genuinely incomplete; trivial single-line fix with the optional policy sentence adding clarity for future contributors.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if the project decided to redact Apple ID everywhere instead — but APPLE_DEVELOPER_SETUP.md already commits to exposing it, so flipping that policy would be the larger change.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Define a lifecycle and template for per-build signing snapshot docs
- **Summary:** Decide whether `docs/signing/FIRST_SIGNED_BUILD_LOG.md` and `GATEKEEPER_ACCEPTANCE_TEST.md` are per-version data sheets (move to `docs/signing/builds/<version>/`) or stable runbooks (promote procedural sections into `APPLE_DEVELOPER_SETUP.md`), and document the choice so future build signers know exactly what to create.
- **Source-Sprint:** SPRINT-003
- **Source:** FIND-SPRINT-003-4 (sprint-code-reviewer); TASK-055 done report line 19 ("Notes for Future Builds section worth promoting into APPLE_DEVELOPER_SETUP.md as runbook material — queued for compounder").
- **Problem:** Both `docs/signing/FIRST_SIGNED_BUILD_LOG.md` and `docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md` are hard-coded to version 0.3.5 and the May 2026 build. There is no `builds/<version>/` directory pattern, no template for a new version's build evidence, and no instruction in `APPLE_DEVELOPER_SETUP.md` telling the next signer what to create (or overwrite). Two concrete failure modes: (a) the next signer overwrites both files in place, destroying the 0.3.5 audit trail; (b) the next signer creates ad-hoc `FIRST_SIGNED_BUILD_LOG_v2.md` copies with no shared structure. The TASK-055 done report also flags the "Notes for Future Builds" section as ready-to-promote runbook material — right now it is buried inside a version-specific log rather than in the canonical setup doc.
- **Proposed direction:** Two viable options (task-refiner should choose one and draft the plan):
  1. **Versioned data-sheet model:** Move both current files to `docs/signing/builds/0.3.5/`. Add a `docs/signing/builds/README.md` (or a section in `APPLE_DEVELOPER_SETUP.md`) with (a) a link to a `BUILD_LOG_TEMPLATE.md` stub listing the required fields, (b) a link to a `GATEKEEPER_TEST_TEMPLATE.md` stub, and (c) instructions: "For each signed release, copy both templates into `docs/signing/builds/<version>/`, fill in the fields, and commit." Promote the "Notes for Future Builds" content from `FIRST_SIGNED_BUILD_LOG.md:221–235` into `APPLE_DEVELOPER_SETUP.md` under a new "Known Build Pitfalls" section.
  2. **Stable-runbook model:** Keep both current files as living documents. Add a "Build History" table at the top of each (version | date | submission ID | SHA256 | result) so multiple builds accumulate as rows rather than files. The per-step instructions become reusable for any version. Clarify in `APPLE_DEVELOPER_SETUP.md` that these two files are the canonical runbooks. Still promote "Notes for Future Builds" into `APPLE_DEVELOPER_SETUP.md`.
  Either way, the task should conclude with `APPLE_DEVELOPER_SETUP.md` containing actionable guidance for the next signer and the Notes for Future Builds content removed from `FIRST_SIGNED_BUILD_LOG.md` and preserved in the setup doc.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** TASK-055 done report line 19 explicitly flags "Notes for Future Builds section worth promoting into APPLE_DEVELOPER_SETUP.md as runbook material — queued for compounder", and `FIRST_SIGNED_BUILD_LOG.md:221–235` confirms this is buried runbook content (electron-builder kill recovery, DMG-separate notarization, latency expectations) that the next signer needs but won't find without it; refinement-only scope keeps cost low while the lifecycle decision pre-empts a real fork at 0.3.6.
- **Counterfactual:** Would flip to DONT_IMPLEMENT if a second signed build were not anticipated in any reasonable timeframe, but cyboflow is actively versioned (`0.3.5` is in package.json with renewal already documented at 2027-02-01).

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the configure-build.js contract in APPLE_DEVELOPER_SETUP.md
- **Summary:** Add a "configure-build.js contract" section to `docs/signing/APPLE_DEVELOPER_SETUP.md` clarifying which `package.json` fields are rewritten at build time, what the committed values mean, and why `pnpm run build:mac:*` is the only safe entry point.
- **Source-Sprint:** SPRINT-003
- **Target file:** `docs/signing/APPLE_DEVELOPER_SETUP.md`
- **Action:** replace existing 3-line paragraph at lines 323–326 (which is partially redundant with the new section) and insert the new `### configure-build.js contract` subsection in its place, before the `> TASK-052…` blockquote (line 328).
- **Status:** ready
- **source_item:** C1
- **Rationale:** FIND-SPRINT-003-1 and FIND-SPRINT-003-6 both surface the same gap: `package.json:114` reads `"notarize": true` as the post-signed-run committed value, but the repo never documents that this field is overwritten by `scripts/configure-build.js` on every build. A contributor running `pnpm electron-builder` directly would get behaviour driven by the committed placeholder, not their env vars. The "Notes for Future Builds" note 4 in `FIRST_SIGNED_BUILD_LOG.md:233` carries the correct explanation but is buried in a per-version build log. Evidence: TASK-055 done report lines 18–21; `scripts/configure-build.js:47,52,56-57,61,63-64`.
- **Reviewer notes:** The original proposal appended the new section after the build-invocation block but left the existing 3-line paragraph at lines 323–326 in place, which duplicates half the new content. The refined diff replaces that paragraph so the contract section is the single source of truth. The "never invoke electron-builder directly" rule lives inside this contract section rather than in CLAUDE.md because the root `CLAUDE.md` already instructs agents to load this doc before any build/packaging/release task — promoting the rule to CLAUDE.md would duplicate that routing.
- **Diff:**
  ```diff
  // docs/signing/APPLE_DEVELOPER_SETUP.md  lines 323–326 (replace the existing
  // paragraph describing what configure-build.js sets) with the new subsection below.
  // The `> TASK-052 flips …` blockquote on lines 328–331 is left untouched.

  -`scripts/configure-build.js` (invoked by `build:mac:universal` before
  -`electron-builder`) reads these vars and sets `hardenedRuntime: true`,
  -`notarize: true`, and `entitlements: build/entitlements.mac.plist` in the
  -electron-builder configuration before the build runs.
  +### configure-build.js contract
  +
  +`scripts/configure-build.js` rewrites `package.json` **in place** before invoking
  +`electron-builder`, and is run automatically by every `pnpm run build:mac:*` script.
  +The fields it rewrites on every invocation:
  +
  +| Field                           | Signed (all 5 env vars set) | Unsigned        |
  +| ------------------------------- | --------------------------- | --------------- |
  +| `build.mac.notarize`            | `true`                      | `false`         |
  +| `build.mac.hardenedRuntime`     | `true`                      | `false`         |
  +| `build.mac.entitlements`        | `build/entitlements.mac.plist` | deleted       |
  +| `build.mac.entitlementsInherit` | `build/entitlements.mac.plist` | deleted       |
  +
  +The committed values in `package.json` (e.g. `"notarize": true` after a signed
  +run) are post-run artifacts, not defaults — the script overwrites them every
  +build based on the env vars present at that moment.
  +
  +**Never invoke `electron-builder` directly.** Always use `pnpm run build:mac:universal`
  +(or another `build:mac:*` / `release:mac` script). Skipping the npm script skips
  +`configure-build.js`, leaving the signed/unsigned posture determined by whatever
  +is committed in `package.json` rather than by the env vars in your shell.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `scripts/configure-build.js:47,52,56–57,61,63–64` rewrites the exact four fields the proposal lists, every `build:mac:*` script in `package.json:33–41` chains `node scripts/configure-build.js && electron-builder`, and `package.json:114` shows `"notarize": true` (the post-signed-run committed value) — the contract is real, undocumented in the canonical sub-doc, and the diff replaces an existing 3-line paragraph rather than adding net attention-budget cost.

---

## Reconciled Findings (informational)

- FIND-SPRINT-003-3 — status field in findings file reads `resolved`; confirmed resolved by commit `a4c31f4` (fix(TASK-055): record post-staple DMG SHA256 in build log) per TASK-055 done report (`/Users/raimundoesteva/Developer/cyboflow/.soloflow/archive/done/apple-signing-notarization-setup/TASK-055-done.md`, line 22). Skipped from triage.
