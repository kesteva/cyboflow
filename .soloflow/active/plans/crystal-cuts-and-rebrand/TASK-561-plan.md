---
id: TASK-561
idea: SPRINT-002-compound
status: in-flight
created: "2026-05-12T00:00:00Z"
files_owned:
  - main/src/types/config.ts
  - frontend/src/types/config.ts
  - frontend/src/components/Settings.tsx
  - main/src/services/configManager.ts
  - main/src/utils/shellEscape.ts
  - main/src/ipc/file.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/commitManager.ts
files_readonly:
  - frontend/src/utils/migrateLocalStorageKey.ts
  - .soloflow/archive/done/crystal-cuts-and-rebrand/TASK-558-done.md
acceptance_criteria:
  - criterion: Zero references to `enableCrystalFooter` or `disableCrystalFooter` remain in main/src or frontend/src
    verification: "grep -rn --include='*.ts' --include='*.tsx' -E 'enableCrystalFooter|disableCrystalFooter' main/src/ frontend/src/ returns zero lines"
  - criterion: "Both AppConfig interfaces (main and frontend) declare `enableCyboflowFooter?: boolean`"
    verification: "grep -n 'enableCyboflowFooter\\?: boolean' main/src/types/config.ts frontend/src/types/config.ts returns exactly 2 matches (one per file)"
  - criterion: UpdateConfigRequest interface in main/src/types/config.ts uses the new field name on the disable path
    verification: "grep -n 'disableCyboflowFooter\\?: boolean' main/src/types/config.ts returns 1 match AND grep -n 'disableCrystalFooter' main/src/types/config.ts returns 0 matches"
  - criterion: "ConfigManager performs a one-time migration: on initialize, if loaded config has `enableCrystalFooter` and not `enableCyboflowFooter`, the value is copied to `enableCyboflowFooter`, the legacy key is deleted, and the config is re-saved"
    verification: "grep -n 'enableCyboflowFooter' main/src/services/configManager.ts returns at least 1 match AND grep -nE 'delete .*enableCrystalFooter' main/src/services/configManager.ts returns at least 1 match"
  - criterion: All four call sites that read the footer flag use the new field name
    verification: "grep -rn 'enableCyboflowFooter' main/src/utils/shellEscape.ts main/src/ipc/file.ts main/src/services/worktreeManager.ts main/src/services/commitManager.ts returns at least 6 matches AND grep -rn 'enableCrystalFooter' main/src/utils/shellEscape.ts main/src/ipc/file.ts main/src/services/worktreeManager.ts main/src/services/commitManager.ts returns 0 matches"
  - criterion: Settings.tsx renames its local state hook from `enableCrystalFooter`/`setEnableCrystalFooter` to `enableCyboflowFooter`/`setEnableCyboflowFooter` and submits the new field
    verification: "grep -n 'enableCyboflowFooter\\|setEnableCyboflowFooter' frontend/src/components/Settings.tsx returns at least 4 matches AND grep -n 'enableCrystalFooter\\|setEnableCrystalFooter' frontend/src/components/Settings.tsx returns 0 matches"
  - criterion: Main and frontend typecheck pass
    verification: pnpm typecheck exits with status 0
  - criterion: "Existing ConfigManager unit tests (if any) pass; manual smoke: with a config.json containing `\"enableCrystalFooter\": false`, the next initialize migrates to `\"enableCyboflowFooter\": false` and deletes the legacy key"
    verification: pnpm --filter main test exits with status 0 AND a new vitest case in main/src/services/configManager.test.ts (created by this task) asserts the migration round-trip
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "ConfigManager.initialize() gains new migration logic with three branches (legacy-only / new-only / both). Each branch must be exercised, especially the legacy→new copy + delete + save path, because a silent regression here would either lose the user's footer preference or leave a permanent legacy key in the file."
  targets:
    - behavior: "When config.json has enableCrystalFooter=false (legacy) and no enableCyboflowFooter, initialize copies value to enableCyboflowFooter, deletes legacy key, and re-saves"
      test_file: main/src/services/configManager.test.ts
      type: unit
    - behavior: "When config.json has both keys, enableCyboflowFooter wins and enableCrystalFooter is deleted on save"
      test_file: main/src/services/configManager.test.ts
      type: unit
    - behavior: "When config.json has neither key, no migration writes occur and enableCyboflowFooter remains undefined (default-true via `!== false` check)"
      test_file: main/src/services/configManager.test.ts
      type: unit
---
# Rename enableCrystalFooter → enableCyboflowFooter across schema, persistence, and call sites

## Objective

The boolean config field `enableCrystalFooter` (deferred by TASK-558 because it requires a JSON config migration to avoid wiping existing users' preferences) controls whether the Cyboflow attribution footer is appended to commit messages. It survives in 13 sites across both workspaces and as a key in `~/.cyboflow/config.json`. This task renames the field to `enableCyboflowFooter` everywhere AND adds a one-time migration in `ConfigManager.initialize()` that reads the legacy key, copies the value forward, deletes the legacy key, and persists — exactly mirroring TASK-558's `migrateLocalStorageKey` pattern but at the JSON-file layer (the persisted config is `~/.cyboflow/config.json`, NOT SQLite — confirmed by reading `main/src/services/configManager.ts:14-17,103-106`).

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns).** Run:
   ```
   grep -rn --include='*.ts' --include='*.tsx' -E 'enableCrystalFooter|disableCrystalFooter' main/src/ frontend/src/
   ```
   At task start this lists every site to rewrite; at task end it must return zero lines.

2. **Update `main/src/types/config.ts`:**
   - L52-53: rename comment `// Crystal commit footer setting` → `// Cyboflow commit footer setting` and field `enableCrystalFooter?: boolean;` → `enableCyboflowFooter?: boolean;`.
   - L101: rename `disableCrystalFooter?: boolean;` (UpdateConfigRequest interface) → `disableCyboflowFooter?: boolean;`.

3. **Update `frontend/src/types/config.ts`:**
   - L39-40: rename comment and field identically to step 2 (`enableCrystalFooter` → `enableCyboflowFooter`).

4. **Add the migration to `main/src/services/configManager.ts`.** In `initialize()` (currently line 60), after the merge block (line 96) and before `} catch (error) {` (line 97), insert a migration block:
   ```typescript
   // One-time migration: enableCrystalFooter → enableCyboflowFooter (see TASK-561).
   // We mutate `loadedConfig` so the existing merge above has already set
   // `this.config.enableCyboflowFooter` if both keys were present; here we just
   // ensure the legacy key never persists back to disk.
   const legacy = (loadedConfig as Record<string, unknown>).enableCrystalFooter;
   if (typeof legacy === 'boolean') {
     // Only fill the new key if it's not already set (new wins on conflict).
     if (this.config.enableCyboflowFooter === undefined) {
       this.config.enableCyboflowFooter = legacy;
     }
     // Remove the legacy key from in-memory config and force a save.
     delete (this.config as Record<string, unknown>).enableCrystalFooter;
     await this.saveConfig();
   }
   ```
   Note: because the merge at L69-95 spreads `loadedConfig` into `this.config`, the legacy key currently arrives in `this.config` if it was present on disk. The `delete` above strips it from in-memory state; the `saveConfig()` re-writes the JSON file without it. The new vitest test (step 11) exercises all three branches.

5. **Rename in `main/src/utils/shellEscape.ts`:**
   - L22 JSDoc: `@param enableCrystalFooter` → `@param enableCyboflowFooter`.
   - L25 function signature: `buildGitCommitCommand(message: string, enableCrystalFooter: boolean = true)` → `buildGitCommitCommand(message: string, enableCyboflowFooter: boolean = true)`.
   - L27 ternary: `enableCrystalFooter ? …` → `enableCyboflowFooter ? …`.

6. **Rename in `main/src/ipc/file.ts`:**
   - L238: `const enableCrystalFooter = config?.enableCrystalFooter !== false;` → `const enableCyboflowFooter = config?.enableCyboflowFooter !== false;`.
   - L241: `enableCrystalFooter ? …` → `enableCyboflowFooter ? …`.
   - L277: same as L238 (retry branch).
   - L279: same as L241 (retry branch).

7. **Rename in `main/src/services/worktreeManager.ts`:**
   - L621-622: same local-var rename.
   - L625: ternary rename.

8. **Rename in `main/src/services/commitManager.ts`:**
   - L102: local-var rename.
   - L105: pass new arg name to `buildGitCommitCommand(...)`.
   - L211: local-var rename.
   - L212: pass new arg name.

9. **Rename in `frontend/src/components/Settings.tsx`:**
   - L43: `const [enableCrystalFooter, setEnableCrystalFooter] = useState(true);` → `const [enableCyboflowFooter, setEnableCyboflowFooter] = useState(true);`.
   - L79: `setEnableCrystalFooter(data.enableCrystalFooter !== false);` → `setEnableCyboflowFooter(data.enableCyboflowFooter !== false);`.
   - L140: `enableCrystalFooter,` → `enableCyboflowFooter,` (in the API.config.update call).
   - L352: checkbox `checked={enableCrystalFooter}` → `checked={enableCyboflowFooter}`.
   - L353: `onChange={(e) => setEnableCrystalFooter(e.target.checked)}` → `onChange={(e) => setEnableCyboflowFooter(e.target.checked)}`.

10. **Re-run sweep grep from step 1.** Expected: zero matches.

11. **Create `main/src/services/configManager.test.ts`** (new file — does not exist; explicit creation). Use the existing vitest infra in `main/package.json`. Mock `fs/promises`, `os.homedir`, and the electron `app` module per the pattern in `main/src/utils/crystalDirectory.test.ts`. Three cases:
    - Case A: pre-populate a config.json on the mock FS with `{"enableCrystalFooter": false, ...}`. After `new ConfigManager().initialize()`, assert `config.enableCyboflowFooter === false`, `('enableCrystalFooter' in config) === false`, and `saveConfig` was called (the file on the mock FS no longer contains `enableCrystalFooter`).
    - Case B: pre-populate with both keys `{"enableCrystalFooter": true, "enableCyboflowFooter": false, ...}`. After initialize, assert `config.enableCyboflowFooter === false` (new wins), legacy key gone.
    - Case C: pre-populate with neither key. After initialize, assert `config.enableCyboflowFooter === undefined` and no extra save was triggered by the migration block (you can spy on `saveConfig`).

12. **Run `pnpm typecheck` and `pnpm --filter main test`.** Both must exit 0.

## Acceptance Criteria

See frontmatter. The compound rule: the sweep grep from step 1 returns zero matches AND the new vitest test exercises all three migration branches.

## Test Strategy

See frontmatter `test_strategy.targets`. Three vitest cases in a new `main/src/services/configManager.test.ts` covering legacy-only / both-keys / neither-key migration branches. Crystal-side: lib already in main devDeps (`vitest: ^2.1.8`). Mock pattern is identical to the existing `crystalDirectory.test.ts` (mock electron's `app`, use `vi.mock('fs/promises')`).

## Hardest Decision

Whether to gate the rename behind a multi-release deprecation cycle (write both keys, read new-preferred-with-legacy-fallback, drop legacy in a future major). **Decision: no, one-shot migration.** Rationale: this is a boolean preference with no API/protocol surface — no third-party reads `~/.cyboflow/config.json`. The migration runs at every ConfigManager.initialize() (i.e., every app start); after the first launch post-upgrade, the legacy key is gone. Multi-release deprecation adds zero safety here while leaving two competing keys in the schema. The migration is idempotent (no-op on a clean config). TASK-558 took the same approach for the localStorage keys without issue.

## Rejected Alternatives

- **Move the migration into a separate `migrateConfigKey` helper symmetric to `migrateLocalStorageKey`.** Rejected for now — the configManager migration is a single inline block; there's exactly one config key being renamed across the lifetime of the codebase that we're aware of. Premature extraction. Would reconsider if a second config key rename appears in the next two sprints.
- **Keep `enableCrystalFooter` as a permanent alias that aliases to `enableCyboflowFooter`.** Rejected: the field is internal — there are no users typing it directly. A permanent alias just doubles the schema surface forever.
- **Defer until a generic "config schema versioning" migration system exists.** Rejected: building a schema migration framework is a separate, larger task; B2 is small and pays its own way. The inline block is delete-only when we eventually add versioning.

## Lowest Confidence Area

The migration's interaction with the existing nested-merge logic (configManager.ts L69-95). Because `loadedConfig` is spread onto `this.config`, the legacy key transiently appears on `this.config` before the migration block strips it. If any other code reads `this.config.enableCrystalFooter` between the spread and the migration (e.g., an event listener fired during merge), the value seen is the legacy field. The current code has no such read, but the safest order would be: (a) read legacy off `loadedConfig` first, (b) construct `this.config` without ever spreading the legacy key, (c) save. The implementation in step 4 takes the simpler post-strip approach because the sequencing is synchronous within `initialize()` — no listeners run mid-merge. Worth verifying during code review.
