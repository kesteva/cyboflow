---
id: TASK-561
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Renamed enableCrystalFooter → enableCyboflowFooter (and disable*) across schema + 4 read sites + Settings.tsx + one-time JSON config migration in ConfigManager.initialize()."
executor_loops: 0
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-561 — Done

## Outcome

Renamed `enableCrystalFooter` → `enableCyboflowFooter` (and `disableCrystalFooter` → `disableCyboflowFooter`) across both AppConfig interfaces, 4 read sites (shellEscape/file/worktreeManager/commitManager), and Settings.tsx state + checkbox binding. Added one-time JSON config migration in `ConfigManager.initialize()` that reads the legacy key, copies the value forward only if the new key is unset (new wins on conflict), deletes the legacy key, and persists via `saveConfig()`. New `main/src/services/configManager.test.ts` covers all 3 migration branches (legacy-only, both-keys, neither-key).

Also proactively swept `Crystal footer` prose comments in the same files (closing FIND-SPRINT-014-10 from TASK-576's blocker list).

## Verification

- Sweep grep: zero `enableCrystalFooter`/`disableCrystalFooter` outside the migration block and its tests.
- Both AppConfigs declare `enableCyboflowFooter?: boolean`.
- Main + frontend typecheck: exit 0; lint: 0 errors.
- 3 migration tests pass.
- Verifier APPROVED round 1.
- Code reviewer CLEAN (2 minor notes — comment wording, test cleanup).

## Findings

- Resolved: FIND-SPRINT-014-5 (naming cliff with TASK-565)
- Resolved: FIND-SPRINT-014-10 (TASK-576 coordination — prose swept here)
- New: FIND-SPRINT-014-15 (pre-existing UpdateConfigRequest schema mismatch in Settings.tsx — out of scope; not introduced by this task)

## Commits

- `5a3da78` feat(TASK-561): rename enableCrystalFooter → enableCyboflowFooter across schema and call sites
- `37c50c7` test(TASK-561): add configManager migration unit tests for enableCyboflowFooter
