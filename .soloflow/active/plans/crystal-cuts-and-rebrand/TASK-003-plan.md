---
id: TASK-003
idea: IDEA-001
status: approved
created: 2026-05-11T00:00:00Z
files_owned:
  - main/src/index.ts
  - main/src/services/sessionManager.ts
  - main/src/services/terminalPanelManager.ts
  - main/src/services/terminalSessionManager.ts
  - main/src/services/runCommandManager.ts
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/panels/logPanel/logsManager.ts
  - main/src/utils/shellDetector.ts
  - main/src/utils/shellEscape.ts
  - main/src/utils/shellPath.ts
  - main/src/utils/nodeFinder.ts
  - main/src/utils/claudeCodeTest.ts
  - main/src/ipc/app.ts
  - frontend/src/components/Settings.tsx
  - package.json
  - .github/workflows/build.yml
  - .github/workflows/release.yml
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/utils/crystalDirectory.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
acceptance_criteria:
  - criterion: "No `process.platform === 'linux'` or `process.platform === 'win32'` or `platform === 'linux'` or `platform === 'win32'` branches remain in `main/src/` source files owned by this task"
    verification: "`grep -rn --include='*.ts' -E \"process\\.platform\\s*===?\\s*['\\\"](linux|win32)['\\\"]|\\bplatform\\s*===?\\s*['\\\"](linux|win32)['\\\"]\" main/src/services/sessionManager.ts main/src/services/terminalPanelManager.ts main/src/services/terminalSessionManager.ts main/src/services/runCommandManager.ts main/src/services/panels/cli/AbstractCliManager.ts main/src/services/panels/logPanel/logsManager.ts main/src/utils/shellDetector.ts main/src/utils/shellEscape.ts main/src/utils/shellPath.ts main/src/utils/nodeFinder.ts main/src/utils/claudeCodeTest.ts main/src/ipc/app.ts main/src/index.ts` returns zero matches"
  - criterion: "The Linux GTK workaround at top of `main/src/index.ts` is removed"
    verification: "`grep -n 'gtk-version\\|gtk-' main/src/index.ts` returns zero matches"
  - criterion: "`package.json` no longer has Linux build targets (`build:linux`, `build:linux:ci`, `release:linux`, `canary:linux`, `build:win`, `build:win:x64`) in `scripts`"
    verification: "`node -e \"const p=require('./package.json'); const bad=['build:linux','build:linux:ci','release:linux','canary:linux','build:win','build:win:x64'].filter(k => p.scripts && p.scripts[k]); process.exit(bad.length===0?0:1)\"` returns exit 0"
  - criterion: "`package.json` no longer has `linux`, `win`, `nsis`, `deb`, `appImage` keys in `build`"
    verification: "`node -e \"const p=require('./package.json'); const bad=['linux','win','nsis','deb','appImage'].filter(k => p.build && p.build[k]); process.exit(bad.length===0?0:1)\"` returns exit 0"
  - criterion: "GitHub Actions Linux workflow steps are removed from `build.yml` and `release.yml`"
    verification: "`grep -nE 'build:linux|ubuntu-latest|build-linux' .github/workflows/build.yml .github/workflows/release.yml` returns zero matches"
  - criterion: "Build and typecheck succeed: `pnpm run build:main && pnpm typecheck` exit 0"
    verification: "Run both commands from repo root; both exit 0"
  - criterion: "macOS build still produces an output: `pnpm run build:mac:arm64` exits 0 (informational — full notarized build is owned by apple-signing-notarization-setup; here we only verify the build command succeeds with no platform-conditional regressions)"
    verification: "Optional — run `pnpm run build:mac:arm64` on a macOS host. Not blocking if Apple Developer cert is not yet enrolled (cert errors are OK; only platform-branch syntax errors are failures)."
depends_on: []
estimated_complexity: high
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: "Deletion of cross-platform branches. The Linux- and Windows-only code paths cannot be exercised on macOS, so they have no test coverage; the typecheck gate catches type errors from removed branches. CI's existing macOS smoke test (Playwright) continues to run and validates the remaining macOS code path. Writing new tests would test absence of removed branches."
---

# Delete Linux/Windows-Conditional Code Paths

## Objective

Crystal supported macOS, Linux, and Windows with conditional code throughout PTY management, shell detection, filesystem operations, packaging, and CI. Cyboflow v1 is macOS-only (§2 of design doc, §3 cut decision). Every line of `process.platform === 'linux'` or `'win32'` branching is one Claude Code agent has to read and possibly debug for a platform Cyboflow does not run. Delete all such branches; collapse to the macOS code path; remove Linux/Windows packaging targets and CI workflows.

Files like `worktreeManager.ts.backup`, `claudeCodeManager.ts.backup`, and `flatpak`/`.deb` build scripts are documentation-leaning leftover — delete the live `package.json` keys and CI workflow steps, but leave `.backup` files alone (they're already implicitly out-of-build).

## Implementation Steps

1. **Run the pre-flight grep** to enumerate the exact branches that must be deleted:
   