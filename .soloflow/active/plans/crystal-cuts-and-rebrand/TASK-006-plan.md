---
id: TASK-006
idea: IDEA-001
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - package.json
  - main/src/utils/crystalDirectory.ts
  - main/src/index.ts
  - main/src/services/configManager.ts
  - main/src/services/database.ts
  - main/src/services/permissionIpcServer.ts
  - main/src/services/mcpPermissionBridge.ts
  - main/build-mcp-bridge.js
  - main/src/utils/logger.ts
  - main/src/ipc/session.ts
  - main/src/ipc/updater.ts
  - frontend/src/components/AboutDialog.tsx
  - main/src/services/panels/claude/claudeCodeManager.ts
  - README.md
  - main/assets/icon.icns
  - main/assets/icon.png
  - AGENTS.md
files_readonly:
  - CLAUDE.md
  - docs/cyboflow_system_design.md
  - docs/ARCHITECTURE.md
  - .soloflow/active/research/ROADMAP-001-research-ecosystem.md
  - .soloflow/active/research/ROADMAP-001-research-risks.md
  - .soloflow/active/ideas/IDEA-007.md
acceptance_criteria:
  - criterion: "`package.json` has `appId: com.cyboflow.app` and `productName: Cyboflow`"
    verification: "`node -e \"const p=require('./package.json'); process.exit(p.build.appId==='com.cyboflow.app' && p.build.productName==='Cyboflow' ? 0 : 1)\"` returns exit 0"
  - criterion: "`package.json` `name` field is `cyboflow`"
    verification: "`node -e \"const p=require('./package.json'); process.exit(p.name==='cyboflow' ? 0 : 1)\"` returns exit 0"
  - criterion: The data directory utility resolves to `~/.cyboflow` (not `~/.crystal`) when no override is set
    verification: "`grep -n \"\\.cyboflow\\|'\\.cyboflow'\" main/src/utils/crystalDirectory.ts` returns at least 2 matches (the home-dir join expression and the CYBOFLOW_DIR env-var lookup)"
  - criterion: The `CRYSTAL_DIR` env var is renamed to `CYBOFLOW_DIR` in the data-directory utility
    verification: "`grep -n 'CYBOFLOW_DIR' main/src/utils/crystalDirectory.ts` returns at least 1 match AND `grep -n 'CRYSTAL_DIR' main/src/utils/crystalDirectory.ts` returns zero matches"
  - criterion: Socket path produced by `PermissionIpcServer` includes `~/.cyboflow/sockets/`
    verification: "After this task, `getCrystalSubdirectory('sockets')` (in `permissionIpcServer.ts:19`) resolves to `~/.cyboflow/sockets/`. Verified by reading `crystalDirectory.ts` and confirming the default home-dir join is `.cyboflow`."
  - criterion: README has been rewritten to describe Cyboflow and pins the current Crystal HEAD commit hash
    verification: "`grep -nE 'Cyboflow|Pinned Crystal commit' README.md` returns at least 2 matches; `grep -n 'Nimbalyst' README.md` returns zero matches (or only inside a 'Forked from' attribution sentence)"
  - criterion: "App icon files exist at `main/assets/icon.icns`, `main/assets/icon.png` (placeholder is acceptable; the file just needs to exist and differ from the inherited Crystal logo — content verification is out of scope)"
    verification: "`test -f main/assets/icon.icns && test -f main/assets/icon.png` returns exit 0"
  - criterion: "Build and typecheck succeed: `pnpm run build:main && pnpm run build:frontend && pnpm typecheck` exit 0"
    verification: Run all three commands from repo root; each exits 0
  - criterion: "`getCrystalDirectory()` function name itself remains exported but the FILE contents now write to `.cyboflow`. (Renaming the function name across the entire codebase is out of scope; subsequent epics may rename `getCrystalDirectory` → `getCyboflowDirectory` once the rebrand has settled.)"
    verification: "`grep -n 'export function getCrystalDirectory' main/src/utils/crystalDirectory.ts` returns at least 1 match (function name unchanged, body changed)"
depends_on:
  - TASK-001
  - TASK-002
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "The data directory change is behavior-affecting: users with an existing `~/.crystal` directory will, after this update, write new data to `~/.cyboflow`. Existing dev databases will be orphaned. While we cannot easily unit-test this in CI (it requires filesystem isolation), a single integration test that asserts `getCrystalDirectory()` returns a path ending in `.cyboflow` is cheap insurance against accidental regression."
  targets:
    - behavior: "getCrystalDirectory() returns a path ending in '.cyboflow' when no env override or custom dir is set"
      test_file: main/src/utils/crystalDirectory.test.ts
      type: unit
---
# Rebrand to Cyboflow Identity

## Objective

Crystal's identity (appId `com.stravu.crystal`, productName `Crystal`, data dir `~/.crystal`, socket dir `~/.crystal/sockets/`, README pointing at Nimbalyst) is hardcoded throughout the codebase. Cyboflow needs a clean identity for two reasons: (1) Apple Developer code signing must target the real appId — fixing it later breaks signed identity continuity; (2) the data directory and socket path must not collide with an existing Crystal install on the user's machine.

This task changes:
- **Application identity**: `appId` → `com.cyboflow.app`, `productName` → `Cyboflow`, `name` → `cyboflow` (npm package name)
- **Data directory**: `~/.crystal` → `~/.cyboflow` (and `~/.crystal_dev` → `~/.cyboflow_dev` for dev-mode isolation)
- **Env var**: `CRYSTAL_DIR` → `CYBOFLOW_DIR`
- **Socket path**: `~/.cyboflow/sockets/` (implicit from the data directory change — `PermissionIpcServer` constructs the path via `getCrystalSubdirectory('sockets')`)
- **App icon**: placeholder Cyboflow icon (PNG + ICNS) — exact design out of scope; just must not be the inherited Crystal logo
- **README**: replace the Nimbalyst-deprecation notice with a Cyboflow description and pin the current Crystal HEAD commit hash (`7a5ee42` per the git log) per the design doc §9 directive

This task does NOT rename:
- `getCrystalDirectory()` function (rename is large and noisy; defer to a separate cleanup task)
- `getCrystalSubdirectory()` function
- `crystalDirectory` parameter names in `AboutDialog.tsx` (rename to `dataDirectory` is allowed but optional — out of scope unless the test gate forces it)
- `crystal-permissions` MCP server name (owned by IDEA-007 / `approval-router-and-permission-fix` epic)
- `crystal-mcp-<sessionId>.json` config filename (owned by IDEA-007 — same reason)

Note the dependency on TASK-001 and TASK-002: both modify `package.json`. Running this task after both ensures only ONE git history entry touches `package.json` from a clean state, reducing merge conflicts within the epic.

## Implementation Steps

1. **Pre-flight grep** to confirm the rebrand surface:
   