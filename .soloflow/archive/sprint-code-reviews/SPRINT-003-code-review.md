---
sprint: SPRINT-003
findings_count:
  critical: 1
  important: 3
  minor: 2
---

# Sprint Code Review: SPRINT-003

## Scope
- Base: bc732a07dc39406795a718ad88519c8fdc99b4c5
- Tasks reviewed: [TASK-055, TASK-056]
- Files changed: 2 (docs/signing/FIRST_SIGNED_BUILD_LOG.md, docs/signing/GATEKEEPER_ACCEPTANCE_TEST.md) + 1-line package.json (already accounted for in FIND-SPRINT-003-1)
- Cross-task hotspots: docs/signing/ (both tasks contributed; SHA256, submission ID, and DMG path cross-referenced)

## Findings queued
6 new findings appended to `.soloflow/active/findings/SPRINT-003-findings.md` for the next `/soloflow:compound` run. Severity breakdown: critical=1, important=3, minor=2.

### Critical
- FIND-SPRINT-003-3 — DMG SHA256 mismatch between FIRST_SIGNED_BUILD_LOG.md (cdf62a50...) and GATEKEEPER_ACCEPTANCE_TEST.md (6eda21e9...); ground-truth `shasum` against the on-disk DMG confirms 6eda21e9... — build log is wrong (likely captured the pre-staple notarytool sha256).

### Important
- FIND-SPRINT-003-4 — Per-build snapshot docs lack a documented lifecycle; future signed builds have no rule for overwrite vs. append vs. promote-to-runbook.
- FIND-SPRINT-003-5 — AC3 data-directory check still accepts legacy `~/.crystal/crystal.db` via OR, masking a regression in the rebrand the docs themselves declare complete.
- FIND-SPRINT-003-6 — `package.json` `build.mac.notarize: true` is rewritten by configure-build.js at build time; no inline marker or runbook entry warns contributors who invoke electron-builder directly.

### Minor
- FIND-SPRINT-003-7 — Inconsistent redaction policy across `docs/signing/`: Apple ID redacted in build log, exposed in APPLE_DEVELOPER_SETUP.md.
- FIND-SPRINT-003-8 — GATEKEEPER_ACCEPTANCE_TEST.md step 6 tells the tester to re-invoke `/soloflow:sprint TASK-056`, but the action is queued in human-review-queue under `testing`; correct re-entry point is `/soloflow:review-queue`.
