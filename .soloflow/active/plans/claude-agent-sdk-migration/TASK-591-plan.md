---
id: TASK-591
idea: IDEA-014
status: ready
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/build-cyboflow-permission-bridge.js
  - main/package.json
  - package.json
files_readonly:
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/cyboflowPermissionBridge.ts
  - main/src/services/cyboflowPermissionIpcServer.ts
  - main/src/services/permissionManager.ts
  - main/src/orchestrator/approvalRouter.ts
  - main/src/index.ts
  - .soloflow/active/plans/claude-agent-sdk-migration/EPIC-claude-agent-sdk-migration.md
acceptance_criteria:
  - criterion: main/build-cyboflow-permission-bridge.js no longer exists on disk.
    verification: "test ! -e main/build-cyboflow-permission-bridge.js"
  - criterion: "main/package.json no longer references the deleted bridge build script (no `bundle:mcp` script, no `build-cyboflow-permission-bridge` mention)."
    verification: "! grep -n 'build-cyboflow-permission-bridge' main/package.json && ! grep -n '\"bundle:mcp\"' main/package.json"
  - criterion: "main/package.json `build` script no longer chains `npm run bundle:mcp` (since the script itself has been removed)."
    verification: "grep -n '\"build\":' main/package.json | grep -v 'bundle:mcp'"
  - criterion: Root package.json `build.asarUnpack` array no longer lists `cyboflowPermissionBridge.js` or `cyboflowPermissionBridgeStandalone.js`.
    verification: "! grep -nE 'cyboflowPermissionBridge(Standalone)?\\.js' package.json"
  - criterion: Recursive grep for the deleted build-script filename across `main/` produces no source-code matches.
    verification: "test -z \"$(grep -rln 'build-cyboflow-permission-bridge' main/ --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json')\""
  - criterion: "Recursive grep for `cyboflowPermissionBridge` and `mcpPermissionBridge` symbols inside `main/` shows ONLY two intentionally-preserved files: `main/src/services/cyboflowPermissionBridge.ts` (TS source — out of scope) and `main/src/services/panels/claude/claudeCodeManager.ts` (only comment/docstring lines)."
    verification: "grep -rln --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' -E 'cyboflowPermissionBridge|mcpPermissionBridge' main/ | sort -u | diff - <(printf 'main/src/services/cyboflowPermissionBridge.ts\nmain/src/services/panels/claude/claudeCodeManager.ts\n' | sort -u)"
  - criterion: permissionManager.ts has zero imports from the deleted bridge artifact and zero references to its spawn pathway.
    verification: "! grep -nE 'cyboflowPermissionBridge|mcpPermissionBridge|build-cyboflow-permission-bridge' main/src/services/permissionManager.ts"
  - criterion: "`pnpm typecheck` succeeds with exit code 0."
    verification: pnpm typecheck
  - criterion: "`pnpm build:main` succeeds with exit code 0."
    verification: "pnpm build:main"
  - criterion: Lint is green for the workspaces touched.
    verification: pnpm lint
depends_on:
  - TASK-590
estimated_complexity: low
epic: claude-agent-sdk-migration
test_strategy:
  needed: false
  justification: "Pure deletion + build-config scrub. No code paths added; no behavior changes beyond removing an already-unreachable subprocess artifact. Coverage is provided by the typecheck + build smoke gates in acceptance criteria (and downstream by TASK-595's integration smoke). No sibling test files own the deleted bridge artifact — confirmed by globbing `main/__tests__/**`, `main/src/services/**/*.test.ts`, and `main/src/services/__tests__/**` for `*bridge*` or `*PermissionBridge*` and finding zero matches at refinement time. The only test surface that could indirectly fail is the orchestrator approval router suite, which exercises `CyboflowPermissionIpcServer` (the IPC server, NOT the bridge subprocess) and is unaffected because the IPC server survives this task intact."
---
# Delete MCP permission bridge build artifact

## Objective

Remove the now-dead MCP permission bridge build script (`main/build-cyboflow-permission-bridge.js`) and scrub every build-config reference to it and its compiled outputs. This is the final cleanup step in the EPIC's deletion list: TASK-590 already rewrote `claudeCodeManager.ts` to use the SDK's in-process `hooks.PreToolUse` callback instead of spawning the bridge subprocess, so the bridge script and the asar-unpack manifest entries that ship its compiled `.js` outputs into packaged builds are pure dead weight that must be removed before the EPIC's success signal #5 ("`build-cyboflow-permission-bridge.js` is deleted") can be marked true.

## Implementation Steps

1. **Pre-flight sweep grep (completeness gate).** Capture the baseline reference set:
   ```bash
   grep -rln --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' 'build-cyboflow-permission-bridge' main/ package.json
   grep -rln --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' -E 'cyboflowPermissionBridge(Standalone)?\.js' main/ package.json
   ```
   Expected baseline: `main/build-cyboflow-permission-bridge.js`, `main/package.json`, `package.json`. Plus TS-source self-references inside `main/src/services/cyboflowPermissionBridge.ts` (out of scope, see step 6).

2. **Delete the build script.** `rm main/build-cyboflow-permission-bridge.js`. This is a 275-line top-level file that emits a hand-rolled MCP server bundle into `dist/main/src/services/cyboflowPermissionBridgeStandalone.js`. With T4's claudeCodeManager rewrite landed, nothing spawns that output.

3. **Scrub `main/package.json`.** Apply two edits:
   - Remove the `"bundle:mcp": "node build-cyboflow-permission-bridge.js"` line entirely from the `scripts` object (currently line 10).
   - In the `"build"` script (currently line 9: `"rimraf dist && tsc && npm run copy:assets && npm run bundle:mcp"`), drop the trailing `&& npm run bundle:mcp`. New value: `"rimraf dist && tsc && npm run copy:assets"`.

   Keep `main/package.json` valid JSON after the deletions.

4. **Scrub root `package.json` asarUnpack.** In the `build.asarUnpack` array (currently lines 102-108), remove:
   ```
   "main/dist/services/cyboflowPermissionBridge.js",
   "main/dist/services/cyboflowPermissionBridgeStandalone.js",
   ```
   Keep the surrounding entries untouched. Validate the array remains a valid JSON list.

5. **Verify `permissionManager.ts` is bridge-free.** Run `grep -nE 'cyboflowPermissionBridge|mcpPermissionBridge|build-cyboflow-permission-bridge' main/src/services/permissionManager.ts`. If a match appears, STOP and surface it as a finding rather than patching.

6. **Inspect `claudeCodeManager.ts` for T4 escapes (read-only verification).** Run:
   ```bash
   grep -nE 'cyboflowPermissionBridge|mcpPermissionBridge|spawn.*bridge|path\\.join\\(__dirname, .cyboflowPermissionBridge' main/src/services/panels/claude/claudeCodeManager.ts
   ```
   Expected: ONLY comment/docstring lines (acceptable), NOT executable code. If executable bridge-spawn code survives, DO NOT patch here. File a finding (`finding_type: scope_deviation`, `severity: high`, location `main/src/services/panels/claude/claudeCodeManager.ts:<line>`, suggested_action "T4/TASK-590 left bridge-spawn code in claudeCodeManager.ts — re-open T4 or schedule a remediation task; out of scope for T5/TASK-591").

   IMPORTANT: `cyboflowPermissionBridge.ts` (the TypeScript source of the bridge subprocess) is NOT in this task's `files_owned` list and is NOT being deleted. Per the EPIC and task scope, only the JS build artifact and its packaging references are in scope. The TS file becomes dead code post-task (its only build-time output, `dist/main/src/services/cyboflowPermissionBridge.js`, will still be emitted by `tsc` until the file is removed by a follow-up task). Surface this as a `Lowest Confidence Area` item below — it is the residual loose thread this task knowingly leaves.

7. **Re-run the sweep grep as a completeness gate.** Repeat step 1's greps. Required post-state:
   - First grep returns **zero** matches.
   - Second grep returns at most matches inside `main/src/services/cyboflowPermissionBridge.ts`. Zero matches in `main/package.json` or root `package.json`.

8. **Run smoke gates.** Execute in order from the repo root:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm build:main
   ```
   All three must exit 0.

## Acceptance Criteria

1. `main/build-cyboflow-permission-bridge.js` does not exist on disk.
2. `main/package.json` has no `bundle:mcp` script and no occurrence of `build-cyboflow-permission-bridge`.
3. The `main/package.json` `build` script value no longer chains `&& npm run bundle:mcp`.
4. Root `package.json`'s `build.asarUnpack` array no longer lists `cyboflowPermissionBridge.js` or `cyboflowPermissionBridgeStandalone.js`.
5. Source-code grep for `build-cyboflow-permission-bridge` returns zero.
6. Bridge-symbol grep resolves to ONLY the two carved-out files.
7. `permissionManager.ts` contains zero references to the bridge.
8. `pnpm typecheck`, `pnpm lint`, and `pnpm build:main` exit 0.

## Test Strategy

No new tests. Pure deletion + build-config scrub; coverage is provided by typecheck + build smoke gates here, and by `TASK-595` integration smoke downstream.

## Hardest Decision

**Whether to also delete `main/src/services/cyboflowPermissionBridge.ts` in this task.** That TS file is the source the deleted build script bundled, and post-T4 it has zero callers. Leaving it means `tsc` will keep emitting a dead `dist/main/src/services/cyboflowPermissionBridge.js` from a 200-line dead-code file every build.

**Decision: leave it for a follow-up task.** Three reasons:
1. The task skeleton's `files_owned_hint` lists ONLY the JS build artifact.
2. The EPIC's success signal #5 names ONLY `build-cyboflow-permission-bridge.js` as the deletion target.
3. The task instructions explicitly say "If you find lingering bridge code in `claudeCodeManager.ts`, that's a T4 escape and should be filed as a finding, not patched here." The same principle applies to the TS source.

## Rejected Alternatives

**Alternative A — Delete `cyboflowPermissionBridge.ts` in this task too.** Rejected because it widens scope past the skeleton's `files_owned_hint`.

**Alternative B — Leave `bundle:mcp` in `main/package.json` and only rename it to be a no-op.** Rejected because dead scripts are noise.

**Alternative C — Leave root `package.json` `asarUnpack` references in place.** Rejected because `electron-builder` warns on missing files referenced in `asarUnpack`.

**Alternative D — Run `pnpm test` (Playwright E2E) as a gate.** Rejected because Playwright is the EPIC-level integration gate owned by `TASK-595`.

## Lowest Confidence Area

**Three residual unknowns:**

1. **The `cyboflowPermissionBridge.ts` TS file is left as dead code on disk.** Expected follow-up: schedule deletion in a future "dead code sweep" sprint after TASK-595 confirms SDK substrate is fully operational. Surface as a finding (`finding_type: dead_code`, `severity: low`).

2. **T4 escape detection in step 6.** If T4 has NOT fully removed bridge-spawn code, step 8's gates may fail. The plan's response — surface as a finding rather than patch — is correct. The verifier and human checkpoint must understand that a finding here is expected handling, not a TASK-591 defect.

3. **Whether root `package.json`'s `asarUnpack` glob `main/dist/services/**/*.js` re-includes the bridge outputs.** Benign for this task's ACs but means residual cleanup #1 doesn't fully eliminate the bridge from packaged builds. The next sprint's TS-source deletion will close this loop.
