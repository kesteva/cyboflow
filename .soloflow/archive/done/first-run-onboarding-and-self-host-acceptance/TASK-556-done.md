---
id: TASK-556
sprint: SPRINT-013
epic: first-run-onboarding-and-self-host-acceptance
status: done
summary: "Replace Nimbalyst deprecation README with Cyboflow-native README; add docs/PROVENANCE.md. Pin full 40-char Crystal fork SHA, document MIT license posture, and codify the 'do not merge from Nimbalyst' rule with AGPL contamination rationale."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-556 — README + license/provenance housekeeping

Delivered:

- `README.md` — rewritten from scratch. Removed all Nimbalyst deprecation banner content. Added: one-paragraph Cyboflow intro mentioning cross-workflow review queue, Claude Code, macOS, SoloFlow workflows; Quick Start section with v1.0.0 DMG placeholder; Provenance section pinning Crystal fork commit `7a5ee427b0f3595db69e237eda1718c87215ad97`; MIT license declaration; "Do not merge from Nimbalyst" rule with AGPL contamination rationale; Development section pointing at CLAUDE.md + `.soloflow/`.
- `docs/PROVENANCE.md` (new) — upstream URL (`https://github.com/stravu/crystal`), fork commit SHA, fork date `2026-05-11`, do-not-merge rule, Crystal primitives inventory (6 inherited + 2 added), author attribution.

Verifier APPROVED via 6 grep-based AC verifications. Code-reviewer CLEAN with 4 minor non-blocking observations (license-posture hedging, optional year in attribution, maintainer email public on a public-facing provenance doc, an unverified `stravu/soloflow` URL that is hedged with "or a compatible workflow runner"). Plan's `test_strategy.needed: false` — no code tests required.
