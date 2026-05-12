---
id: TASK-558
sprint: SPRINT-002
epic: crystal-cuts-and-rebrand
status: done
summary: "Finished Crystal→Cyboflow string sweep across the identity layer: log filenames, commit-trailer rebrand, PostHog distinctId prefix, localStorage key migration with shared helper, --crystal-dir CLI deprecation alias, body copy, and logo import sites. Added migrateLocalStorageKey helper + 4 vitest cases."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-558 — Done

Closed the remaining Crystal-string cluster TASK-006 deferred. Cross-cutting work across 17 owned files (main + frontend) plus a new shared helper, a real test suite, and a logo asset.

Round 1 (commit 263cd69): mechanical string sweep across all 17 files. Verifier APPROVED on functionality. Code-reviewer flagged two IMPROVEMENTS_NEEDED:
1. The new `console.test.ts` was tautological — it never imported `isVerboseEnabled`, just re-implemented the migration inline and asserted on the replica.
2. localStorage migration logic was duplicated across 4 sites with inconsistent error handling — `console.ts` had try/catch but the 3 component-level migrations did not, so a Safari private-browsing throw would crash on first render. App.tsx also ran the migration on every render.

Round 2 (commit ea14220): extracted `frontend/src/utils/migrateLocalStorageKey.ts` (single helper with try/catch). Refactored all 4 call sites to use it: console.ts (direct call), App.tsx + FileEditor.tsx (now mount-once `useEffect`), RichOutputWithSidebar.tsx (lazy `useState` initializer). Replaced tautological console.test.ts with `migrateLocalStorageKey.test.ts` — 4 real cases that import and call the helper. Round 2 verifier and code-reviewer both APPROVED CLEAN.

Highlights:
- Existing users keep their preferences after upgrade (4 localStorage keys: sidebar-width, file-tree-width, sidebar-collapsed-${id}, verboseLogging). Migration is one-shot and idempotent.
- PostHog identity continuity preserved — `ConfigManager.getAnalyticsDistinctId()` early-returns the persisted ID before the new `cyboflow_${uuid}` prefix is constructed; only NEW installs get the new prefix.
- `--crystal-dir` CLI flag retained as backward-compat alias with deprecation warning; `--cyboflow-dir` is canonical.
- `enableCrystalFooter` config field name preserved (renaming requires config migration, deferred).
- `crystal-logo.svg` left on disk (orphaned but harmless) for a future asset cleanup; `cyboflow-logo.svg` is identical contents at the new path.

All 16 acceptance_criteria pass including the load-bearing AC15 completeness gate. Pre-existing baseline lint error in `MessagesView.tsx:50` (from prior commit, out of scope) noted but not fixed.

Findings logged during this task:
- FIND-SPRINT-002-3: 3 commented-out Monaco theme strings (`'crystal-dark'`, `'crystal-light'`) in `MonacoDiffViewer.tsx` (file outside files_owned)
- FIND-SPRINT-002-4: bare-word `Crystal` copy sweep that the AC's `crystal[._-]` regex couldn't catch (Settings/Help/UpdateDialog/etc.)

Commits:
- 263cd69 feat(TASK-558): finish Crystal→Cyboflow string sweep across identity layer
- ea14220 refactor(TASK-558): extract migrateLocalStorageKey helper; fix per-render migration and missing error handling
