---
id: TASK-301
idea_id: IDEA-007
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/services/mcpPermissionBridge.ts
  - main/src/services/permissionIpcServer.ts
  - main/src/services/mcpPermissionServer.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/cliManagerFactory.ts
  - main/src/index.ts
  - main/build-mcp-bridge.js
  - package.json
files_readonly:
  - main/src/utils/crystalDirectory.ts
  - main/src/services/permissionManager.ts
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
  - .soloflow/active/ideas/IDEA-007.md
acceptance_criteria:
  - criterion: The MCP bridge source file is renamed from mcpPermissionBridge.ts to cyboflowPermissionBridge.ts and the legacy file no longer exists
    verification: "test ! -e main/src/services/mcpPermissionBridge.ts && test -f main/src/services/cyboflowPermissionBridge.ts"
  - criterion: The MCP permission IPC server file is renamed from permissionIpcServer.ts to cyboflowPermissionIpcServer.ts
    verification: "test ! -e main/src/services/permissionIpcServer.ts && test -f main/src/services/cyboflowPermissionIpcServer.ts"
  - criterion: The standalone bridge builder is renamed from build-mcp-bridge.js to build-cyboflow-permission-bridge.js and outputs cyboflowPermissionBridgeStandalone.js
    verification: "test ! -e main/build-mcp-bridge.js && test -f main/build-cyboflow-permission-bridge.js && grep -q 'cyboflowPermissionBridgeStandalone.js' main/build-cyboflow-permission-bridge.js"
  - criterion: "Socket path uses ~/.cyboflow/sockets/cyboflow-permissions-<pid>.sock"
    verification: "grep -n 'cyboflow-permissions-' main/src/services/cyboflowPermissionIpcServer.ts && grep -nE 'getCyboflowSubdirectory\\(.sockets.\\)|join\\(.*\\.cyboflow.*sockets' main/src/services/cyboflowPermissionIpcServer.ts"
  - criterion: "MCP server identifies itself as 'cyboflow-permissions' (not 'crystal-permissions')"
    verification: "grep -n \"'cyboflow-permissions'\" main/src/services/cyboflowPermissionBridge.ts main/src/services/mcpPermissionServer.ts main/build-cyboflow-permission-bridge.js && ! grep -rn 'crystal-permissions' main/src/ main/build-cyboflow-permission-bridge.js package.json"
  - criterion: Claude is spawned with --permission-prompt-tool mcp__cyboflow-permissions__approve_permission (not crystal-permissions)
    verification: "grep -n 'mcp__cyboflow-permissions__approve_permission' main/src/services/panels/claude/claudeCodeManager.ts && ! grep -n 'mcp__crystal-permissions__' main/src/services/panels/claude/claudeCodeManager.ts"
  - criterion: "The .mcp.json injected for Claude registers the server under the key 'cyboflow-permissions'"
    verification: "grep -n '\"cyboflow-permissions\"' main/src/services/panels/claude/claudeCodeManager.ts && ! grep -n '\"crystal-permissions\"' main/src/services/panels/claude/claudeCodeManager.ts"
  - criterion: "package.json asarUnpack lists the new bridge filenames and no longer references mcpPermissionBridge*"
    verification: "grep -n 'cyboflowPermissionBridge' package.json && ! grep -n 'mcpPermissionBridge' package.json"
  - criterion: main/src/index.ts and main/src/services/cliManagerFactory.ts import the renamed module and reference the new socket env
    verification: "grep -n 'cyboflowPermissionIpcServer' main/src/index.ts && ! grep -n 'permissionIpcServer' main/src/index.ts"
  - criterion: Sweep grep finds zero residual identifiers in main/ source (excluding the .backup file and docs/.soloflow)
    verification: "! grep -rn --include='*.ts' --include='*.js' --include='*.json' -E 'crystal-permissions|mcpPermissionBridge|crystal-mcp-' main/src/ main/build-cyboflow-permission-bridge.js package.json"
  - criterion: TypeScript compilation of the main process succeeds with the renamed modules
    verification: "pnpm run build:main exits with status 0"
depends_on: []
estimated_complexity: medium
epic: approval-router-and-permission-fix
test_strategy:
  needed: false
  justification: "Pure rename / string-literal sweep. The build:main typecheck plus the AC grep sweep is the verification; no behavioral change to test. End-to-end coverage of the bridge flow is added in TASK-302's tests."
---
# Rename mcpPermissionBridge to cyboflowPermissionBridge (Identity Sweep)

## Objective

Adopt the Crystal permission-bridge pattern with Cyboflow identity. Rename every Crystal-named artifact on the permission path — file names, class names, socket directory, MCP server name, MCP tool flag — so the rest of the epic builds on a Cyboflow surface, and so the design doc's incorrect `MCP_PERMISSION_SOCKET` claim is replaced by the actual argv-based convention (socket path passed as `process.argv[3]` to the bridge subprocess; the env var `MCP_SOCKET_PATH` Crystal sets in the spawned environment is removed because the bridge never reads it).

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns to verify).** Run:
   ```
   grep -rn --include='*.ts' --include='*.js' --include='*.json' -E 'crystal-permissions|mcpPermissionBridge|crystal-mcp-|MCP_SOCKET_PATH' main/src/ main/build-cyboflow-permission-bridge.js package.json 2>/dev/null || true
   ```
   At task start this prints the matches you must rewrite; at task end it must return zero lines.

2. **Rename `main/src/services/mcpPermissionBridge.ts` → `main/src/services/cyboflowPermissionBridge.ts`.** Inside the file:
   - Update the usage error message at line ~24 from `mcpPermissionBridge.js` to `cyboflowPermissionBridge.js`.
   - Change the MCP `Server` `name` field from `'crystal-permissions'` to `'cyboflow-permissions'` (line ~94). The tool name `approve_permission` stays — only the server name changes (Claude's `--permission-prompt-tool` value is built as `mcp__<server-name>__<tool-name>`).
   - The bridge already takes `sessionId = process.argv[2]` and `ipcPath = process.argv[3]` — do not touch this convention.

3. **Rename `main/src/services/permissionIpcServer.ts` → `main/src/services/cyboflowPermissionIpcServer.ts`.** Inside:
   - Rename `class PermissionIpcServer` → `class CyboflowPermissionIpcServer`.
   - Replace `getCrystalSubdirectory('sockets')` with `getCyboflowSubdirectory('sockets')` from `../utils/crystalDirectory` (rule: do NOT rename `crystalDirectory.ts` in this task — it is owned by the broader `crystal-cuts-and-rebrand` epic and is currently out of scope; instead add a thin re-export `export const getCyboflowSubdirectory = getCrystalSubdirectory;` at the bottom of `crystalDirectory.ts` ONLY IF the symbol does not already exist after that epic has shipped. If the symbol already exists, import it directly.).
   - Replace the socket filename template `crystal-permissions-${process.pid}.sock` with `cyboflow-permissions-${process.pid}.sock` (line ~35).
   - Keep the import of `PermissionManager` from `./permissionManager` for now — TASK-302 swaps this to `ApprovalRouter`.

4. **Update `main/src/services/mcpPermissionServer.ts`** (the in-process MCP server variant that is currently dormant): change the `Server` `name` from `'crystal-permissions'` to `'cyboflow-permissions'` (line 18). Keep the file path and class name — this file is rewritten in a later epic but we cannot leave a Crystal-branded `name` in the binary.

5. **Update `main/src/services/panels/claude/claudeCodeManager.ts`:**
   - Line 11 import path: keep `PermissionManager` for now; this is TASK-302's swap target.
   - Line 147: replace `'mcp__crystal-permissions__approve_permission'` (both occurrences in the same `args.push`) with `'mcp__cyboflow-permissions__approve_permission'`.
   - Line 252: delete the `MCP_SOCKET_PATH: this.permissionIpcPath || '',` env entry entirely. The bridge subprocess receives the socket path via `argv[3]` (line 777) and never reads this env var. Document with a one-line comment: `// Socket path is passed via argv[3] to the bridge, not env vars (see cyboflowPermissionBridge.ts argv parsing).`
   - Lines 675–676: rename `mcpPermissionBridgeStandalone.js` → `cyboflowPermissionBridgeStandalone.js` and `mcpPermissionBridge.js` → `cyboflowPermissionBridge.js`.
   - Line 711: rename the temp script filename `mcpPermissionBridge-${sessionId}.js` → `cyboflowPermissionBridge-${sessionId}.js`.
   - Line 732: rename the MCP config filename `crystal-mcp-${sessionId}.json` → `cyboflow-mcp-${sessionId}.json`.
   - Line 806: replace the `.mcp.json` server key `"crystal-permissions"` with `"cyboflow-permissions"`.

6. **Update `main/src/services/cliManagerFactory.ts` line 212:** remove `'MCP_SOCKET_PATH'` from the `optionalEnvVars` array (Cyboflow no longer reads this env var anywhere). Leave `'MCP_DEBUG'` and `'ANTHROPIC_API_KEY'`.

7. **Update `main/src/index.ts`:**
   - Line 24: `import { CyboflowPermissionIpcServer } from './services/cyboflowPermissionIpcServer';`
   - Line 82: `let permissionIpcServer: CyboflowPermissionIpcServer | null;` (you may also rename the variable to `cyboflowPermissionIpcServer` for clarity but the type rename is mandatory).
   - Lines 730, 735, 736, 742, 980, 982: instantiate / call methods on the renamed class.

8. **Rename `main/build-mcp-bridge.js` → `main/build-cyboflow-permission-bridge.js`.** Inside:
   - Update the inline error message at line 22 (`mcpPermissionBridge.js` → `cyboflowPermissionBridge.js`).
   - Line 141: rename the inline MCP server `name` field from `'crystal-permissions'` to `'cyboflow-permissions'`.
   - Line 264: change output filename `dist/main/src/services/mcpPermissionBridgeStandalone.js` → `dist/main/src/services/cyboflowPermissionBridgeStandalone.js`.

9. **Update `package.json`:**
   - Update the `scripts.build:main` (or wherever `build-mcp-bridge.js` is invoked — search the `scripts` block) to call `node main/build-cyboflow-permission-bridge.js` instead.
   - In `build.asarUnpack` (lines 110–111): replace both `mcpPermissionBridge.js` entries with `cyboflowPermissionBridge.js` and `cyboflowPermissionBridgeStandalone.js`.

10. **Re-run the sweep grep from step 1.** Confirm zero matches in `main/src/`, `main/build-cyboflow-permission-bridge.js`, and `package.json`. The `.backup` files under `main/src/services/panels/claude/` are intentionally excluded (they will be deleted in `crystal-cuts-and-rebrand`).

11. **Run `pnpm run build:main`** and confirm exit 0. TypeScript compilation will catch any missed reference (e.g., an import path that still points at the old filename).

## Acceptance Criteria

See frontmatter. Each criterion is a `grep`/`test` check. The compound rule is: the sweep grep in step 1 must return zero lines and `pnpm run build:main` must succeed.

## Test Strategy

No new tests. The verification surface is the deterministic grep sweep plus a clean main-process typecheck/build. Behavioral coverage of the permission flow comes in TASK-302 (ApprovalRouter unit tests) and TASK-303/304 (timeout and clear-pending tests), all of which exercise the renamed surface end-to-end.

## Hardest Decision

Whether to rename `getCrystalSubdirectory` / `crystalDirectory.ts` as part of this task. **Decision: no.** That utility is the data-directory abstraction owned by the `crystal-cuts-and-rebrand` epic, which also flips `~/.crystal` → `~/.cyboflow`. Touching it here would either (a) duplicate that epic's diff scope, or (b) create a half-renamed state where `getCrystalSubdirectory('sockets')` returns `~/.cyboflow/sockets/`, which is confusing. Instead, TASK-301 calls the existing function and trusts the other epic to flip the data dir; we only own the socket *filename* and the bridge identity.

## Rejected Alternatives

- **Keep the Crystal filenames but rebrand only the MCP server name.** Rejected: the system design doc and the IDEA both explicitly say "rename mcpPermissionBridge → cyboflowPermissionBridge." Leaving the file name Crystal-branded creates ongoing cognitive load every time someone greps the surface.
- **Bundle the rename into TASK-302 (ApprovalRouter).** Rejected: TASK-302 already touches non-trivial logic (transaction co-write, EventEmitter wiring, status guard); mixing a 200-line rename diff in would muddy the review. Pure renames want to be their own commits.
- **Use `npx jscodeshift` or a codemod tool.** Rejected: ~30 occurrences across 8 files is well within the scope of a grep-driven sweep. A codemod is overkill and adds a dependency.

## Lowest Confidence Area

The `MCP_SOCKET_PATH` env-var removal (step 5, bullet 3). The architecture research clearly stated the bridge reads `argv[3]`, not the env var — but other code paths (e.g., custom MCP servers a user has configured in their `~/.claude.json`) might read `MCP_SOCKET_PATH` and silently break if removed. Mitigation: a grep across `main/src/` for `MCP_SOCKET_PATH` shows only the producer in `cliManagerFactory.ts` and `claudeCodeManager.ts` — no consumer reads it. But this is the most likely place a regression hides if a user has unusual local MCP config.
