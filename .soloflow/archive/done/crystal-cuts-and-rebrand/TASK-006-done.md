---
id: TASK-006
sprint: SPRINT-001
epic: crystal-cuts-and-rebrand
status: done
summary: "Rebranded identity to Cyboflow: appId, productName, npm name, data dir ~/.cyboflow, env var CYBOFLOW_DIR, README rewrite, placeholder icons, AboutDialog UI text. Function names getCrystalDirectory/getCrystalSubdirectory preserved per plan."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-006 — Rebrand to Cyboflow Identity

## Commits

- `8f2e67b feat(TASK-006): rebrand package identity to cyboflow`
- `2ee4bb8 feat(TASK-006): remove Nimbalyst popup, update app title to Cyboflow`
- `99b250e feat(TASK-006): rebrand AboutDialog to Cyboflow`
- `6101f3f feat(TASK-006): update AGENTS.md to reference Cyboflow env var`
- `0ddf8ab feat(TASK-006): rewrite README for Cyboflow identity`
- `ff8654f feat(TASK-006): replace Crystal icons with Cyboflow placeholder icons`
- `e87576b feat(TASK-006): replace hardcoded .crystal paths in claudeCodeManager`
- `056f2bf test(TASK-006): add unit tests for getCrystalDirectory() .cyboflow behavior`

## Changes

- `package.json`: name → `cyboflow`, appId → `com.cyboflow.app`, productName → `Cyboflow`
- `crystalDirectory.ts`: default `.crystal` → `.cyboflow`, env var `CRYSTAL_DIR` → `CYBOFLOW_DIR`, dev isolation `.crystal_dev` → `.cyboflow_dev`. Function names preserved.
- `index.ts`: removed Nimbalyst migration popup, window title → `Cyboflow [worktree]`, log dir messages
- `AboutDialog.tsx`: visible UI text rebranded
- `README.md`: complete rewrite for Cyboflow, pins upstream Crystal commit `7a5ee42`
- `AGENTS.md`: `CYBOFLOW_DIR` example
- Icon placeholders: cyan PNG (512x512) and minimal ICNS
- `crystalDirectory.test.ts` (new): 5 unit tests, all pass

## Verification

All 9 acceptance criteria pass. Code-reviewer verdict: CLEAN. 5/5 new unit tests pass.

## Carryover findings

- FIND-SPRINT-001-10 (informational): pre-existing `gitStatusManager.test.ts` failures from Crystal baseline — not a regression.
- FIND-SPRINT-001-11 (minor cluster): stale `crystal-*` references outside `files_owned` — `crystal-logo.svg` imports in Sidebar/Welcome/AnalyticsConsentDialog, `crystal-{date}.log` logger filenames, `Co-Authored-By: Crystal <crystal@stravu.com>` trailer, `crystal_*` localStorage keys, PostHog distinctId, "Crystal Settings" string in `claudeCodeManager.ts:340`, `crystal-run.sh` filename in SetupTasksPanel. Plan explicitly defers these.
- Minor in-diff: test process.env hygiene (asymmetric cleanup); inconsistent migration story (`--crystal-dir` CLI flag retained but `CRYSTAL_DIR` env var dropped without fallback); icon placeholder may be too small for electron-builder strictness.
