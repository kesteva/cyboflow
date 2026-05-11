---
id: TASK-003
sprint: SPRINT-001
epic: crystal-cuts-and-rebrand
status: done
summary: "Deleted all Linux/Windows platform conditional branches in 13 owned files; removed GTK workaround; trimmed Linux/win build targets and electron-builder keys from package.json. macOS-only after this."
executor_loops: 0
code_review_rounds: 1
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-003 — Delete Linux/Windows-Conditional Code Paths

## Commits

- `9df2abf feat(TASK-003): delete all Linux/Windows platform conditional branches`
- `beccb21 fix(TASK-003): remove stale whichCommand variable reference in nodeFinder`
- `6eaf2af refactor(TASK-003): collapse dead process.platform negation in terminalPanelManager`

## Changes

Collapsed platform branching across 13 files: `main/src/index.ts`, `main/src/services/{sessionManager,terminalPanelManager,terminalSessionManager,runCommandManager}.ts`, `main/src/services/panels/{cli/AbstractCliManager,logPanel/logsManager}.ts`, `main/src/utils/{shellDetector,shellEscape,shellPath,nodeFinder,claudeCodeTest}.ts`, `main/src/ipc/app.ts`, `frontend/src/components/Settings.tsx`. Removed Linux GTK workaround, Linux/win build scripts (`build:linux`, `release:linux`, `canary:linux`, `build:win`, etc.), and `linux`/`win`/`nsis`/`deb`/`appImage` keys from `package.json` `build` section. GitHub Actions Linux workflows (`build.yml`, `release.yml`) were already deleted ad-hoc before sprint start.

## Verification

All 6 acceptance criteria passed. `pnpm typecheck` exit 0. macOS-typical Node paths (`/usr/local/bin`, `/opt/homebrew/bin`, nvm, volta, asdf) confirmed preserved in `nodeFinder.ts`. Shell escape uses POSIX single-quote idiom.

## Carryover findings

- FIND-SPRINT-001-8 (medium): `taskQueue.ts`, `claudeCodeManager.ts:385` still have `isLinux`/`os.platform()` branch predicates — outside files_owned for this task, queued for follow-up.
- FIND-SPRINT-001-9 (minor): bare `{...}` block-scopes from collapsed conditionals in `shellPath.ts:73-172`, `runCommandManager.ts:297-350`, `AbstractCliManager.ts:855-902`; stale "Linux-specific"/"Windows taskkill" comments in `AbstractCliManager.ts:531`, `logsManager.ts:227`, `sessionManager.ts:1370`; orphaned `get-platform` IPC handler in `main/src/ipc/app.ts:12` (no frontend caller remains).
