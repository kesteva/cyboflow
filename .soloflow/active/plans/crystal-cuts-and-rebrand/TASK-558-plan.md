---
id: TASK-558
idea: IDEA-001
status: in-flight
created: "2026-05-11T00:00:00Z"
source_compound: SPRINT-001-proposal.md
files_owned:
  - main/src/utils/logger.ts
  - main/src/index.ts
  - main/src/utils/shellEscape.ts
  - main/src/ipc/file.ts
  - main/src/services/worktreeManager.ts
  - main/src/services/analyticsManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - frontend/src/App.tsx
  - frontend/src/components/panels/editor/FileEditor.tsx
  - frontend/src/components/panels/claude/RichOutputWithSidebar.tsx
  - frontend/src/utils/console.ts
  - frontend/src/components/Sidebar.tsx
  - frontend/src/components/Welcome.tsx
  - frontend/src/components/AnalyticsConsentDialog.tsx
  - frontend/src/components/panels/SetupTasksPanel.tsx
  - frontend/src/assets/cyboflow-logo.svg
  - CLAUDE.md
files_readonly:
  - .soloflow/active/compound/SPRINT-001-proposal.md
  - .soloflow/active/findings/SPRINT-001-findings.md
  - .soloflow/archive/done/crystal-cuts-and-rebrand/TASK-006-done.md
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-006-plan.md
  - .soloflow/active/plans/approval-router-and-permission-fix/TASK-301-plan.md
  - main/src/utils/crystalDirectory.ts
  - frontend/src/assets/crystal-logo.svg
acceptance_criteria:
  - criterion: "Log filenames in `main/src/utils/logger.ts` use `cyboflow-` prefix, not `crystal-`"
    verification: "`grep -nE 'crystal-' main/src/utils/logger.ts` returns zero matches AND `grep -nE 'cyboflow-' main/src/utils/logger.ts` returns at least 3 matches (line ~73, ~86, ~106)"
  - criterion: Debug log filenames in `main/src/index.ts` use `cyboflow-` prefix
    verification: "`grep -nE \"cyboflow-(frontend|backend)-debug\\.log\" main/src/index.ts | wc -l` returns at least 8 AND `grep -nE \"crystal-(frontend|backend)-debug\\.log\" main/src/index.ts` returns zero matches"
  - criterion: Git commit footer trailer no longer references Crystal as the author
    verification: "`grep -rnE 'Co-Authored-By: Crystal' main/src` returns zero matches AND `grep -rnE 'Co-Authored-By: Cyboflow' main/src` returns at least 3 matches"
  - criterion: Temp commit filenames in `main/src/ipc/file.ts` use `cyboflow-commit-` prefix
    verification: "`grep -n 'crystal-commit' main/src/ipc/file.ts` returns zero matches AND `grep -n 'cyboflow-commit' main/src/ipc/file.ts` returns at least 2 matches"
  - criterion: "localStorage keys in frontend are migrated to `cyboflow-*` with a backward-read fallback for the old `crystal-*` key"
    verification: "`grep -rnE \"localStorage\\.(getItem|setItem|removeItem)\\(['\\\"`]crystal[._-]\" frontend/src` returns zero matches in non-fallback contexts (the migration helper in `frontend/src/utils/console.ts` and `frontend/src/App.tsx` may read the old key once for migration — verified by code review). `grep -rnE \"cyboflow[._-](sidebar-width|file-tree-width|sidebar-collapsed|verboseLogging)\" frontend/src` returns at least 4 matches."
  - criterion: PostHog distinctId prefix in `analyticsManager.ts` is `cyboflow_`
    verification: "`grep -n 'cyboflow_\\${uuid}' main/src/services/analyticsManager.ts` returns 1 match AND `grep -n 'crystal_\\${uuid}' main/src/services/analyticsManager.ts` returns zero matches"
  - criterion: "User-facing error string in `claudeCodeManager.ts:340` reads `Cyboflow Settings` not `Crystal Settings`"
    verification: "`grep -n 'Cyboflow Settings' main/src/services/panels/claude/claudeCodeManager.ts` returns 1 match AND `grep -n 'Crystal Settings' main/src/services/panels/claude/claudeCodeManager.ts` returns zero matches"
  - criterion: "`crystal-base-mcp-` filename in `claudeCodeManager.ts:889` is renamed to `cyboflow-base-mcp-`"
    verification: "`grep -n 'cyboflow-base-mcp-' main/src/services/panels/claude/claudeCodeManager.ts` returns 1 match AND `grep -n 'crystal-base-mcp-' main/src/services/panels/claude/claudeCodeManager.ts` returns zero matches"
  - criterion: Run-script filename string `./crystal-run.sh` in `SetupTasksPanel.tsx` is renamed to `./cyboflow-run.sh`
    verification: "`grep -n 'cyboflow-run.sh' frontend/src/components/panels/SetupTasksPanel.tsx` returns at least 3 matches AND `grep -n 'crystal-run.sh' frontend/src/components/panels/SetupTasksPanel.tsx` returns zero matches"
  - criterion: "Logo asset is imported from `cyboflow-logo.svg` (file exists) in `Sidebar.tsx`, `Welcome.tsx`, `AnalyticsConsentDialog.tsx`"
    verification: "`test -f frontend/src/assets/cyboflow-logo.svg` exits 0 AND `grep -rnE \"from ['\\\"]\\.\\.?/assets/crystal-logo\\.svg['\\\"]\" frontend/src` returns zero matches AND `grep -rnE \"cyboflow-logo\\.svg\" frontend/src/components` returns at least 3 matches"
  - criterion: "Welcome.tsx body copy at lines 85 and 99 reads `Cyboflow`, not `Crystal`"
    verification: "`grep -nE '>Crystal( |<)|Crystal runs Claude Code|Crystal will create' frontend/src/components/Welcome.tsx` returns zero matches"
  - criterion: "AnalyticsConsentDialog.tsx body copy at line 94 reads `Cyboflow`, not `Crystal`"
    verification: "`grep -n 'helps us make Crystal' frontend/src/components/AnalyticsConsentDialog.tsx` returns zero matches AND `grep -n 'helps us make Cyboflow' frontend/src/components/AnalyticsConsentDialog.tsx` returns 1 match"
  - criterion: "`--crystal-dir` CLI flag is preserved as a backward-compat alias with a deprecation log line; `--cyboflow-dir` is the canonical name"
    verification: "`grep -nE '\\-\\-cyboflow-dir' main/src/index.ts` returns at least 2 matches AND `grep -nE 'deprecated.*crystal-dir|crystal-dir.*deprecated' main/src/index.ts` returns at least 1 match (deprecation notice present)"
  - criterion: "CLAUDE.md debug-log filename guidance is updated to reference `cyboflow-*-debug.log`"
    verification: "`grep -nE 'crystal-(frontend|backend)-debug' CLAUDE.md` returns zero matches AND `grep -nE 'cyboflow-(frontend|backend)-debug' CLAUDE.md` returns at least 3 matches"
  - criterion: "Completeness gate: a recursive grep across the writable source tree for `crystal[._-]` (excluding owned-by-other-task surfaces) returns only intentionally-deferred matches"
    verification: "`grep -rnE 'crystal[._-]' main/src frontend/src --include='*.ts' --include='*.tsx' --include='*.js'` returns ONLY matches in the deferred allowlist: `crystal-permissions` / `crystal-mcp-` / `crystalDirectory` / `getCrystalDirectory` / `getCrystalSubdirectory` / `customCrystalDir` / `setCrystalDirectory` / `enableCrystalFooter` (config field name). Any other match is a sweep miss."
  - criterion: "Build, typecheck, and lint all pass"
    verification: "`pnpm run build:main && pnpm run build:frontend && pnpm typecheck && pnpm lint` all exit 0"
depends_on: []
estimated_complexity: medium
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "The localStorage key migration is behavior-affecting for existing users — switching the key without a fallback orphans the user's saved sidebar width / collapsed state / verbose-logging preference. The PostHog distinctId change is also user-impacting (analytics continuity). The string rename per se needs no test, but the migration helper that reads the old `crystal-*` key on first access and writes the new `cyboflow-*` key MUST be covered."
  targets:
    - behavior: "console.ts isVerboseEnabled() reads `cyboflow.verboseLogging` first, falls back to `crystal.verboseLogging`, and migrates the value to the new key on first read"
      test_file: frontend/src/utils/console.test.ts
      type: unit
    - behavior: "When `cyboflow.verboseLogging` is unset and `crystal.verboseLogging=true` is in localStorage, isVerboseEnabled() returns true and writes `cyboflow.verboseLogging=true`"
      test_file: frontend/src/utils/console.test.ts
      type: unit
---
# Finish Crystal-String Sweep (Identity-Layer Followup)

## Objective

TASK-006 rebranded the identity-critical surfaces (appId, productName, data dir, env var, AboutDialog, README) and SPRINT-001's A8 fixed three `<h1>` headings (Sidebar, Welcome, AnalyticsConsentDialog) plus their `alt` attributes. This task closes the remaining Crystal-string cluster TASK-006 explicitly deferred: user-persisted state keys (localStorage), externally visible commit metadata (Co-Authored-By trailer), on-disk filename artifacts (log files, MCP configs, commit tmp files), user-facing error strings, and the leftover Crystal-branded logo asset. The work is mechanical but cross-cuts main + frontend, requires a migration shim for the localStorage keys (so users don't lose preferences after the upgrade), and must declare a coherent policy for the `--crystal-dir` CLI flag (backward-compat alias vs hard rename). The completeness gate is a recursive grep with a small, named allowlist for symbols that are out-of-scope (owned by IDEA-007 or kept-as-internal-identifier).

## Implementation Steps

1. **Sweep pre-flight (completeness gate, step 1).** Run the authoritative sweep grep and capture its output for reference. The executor will re-run this as the final step to verify only allowlisted matches remain:
   ```bash
   grep -rnE 'crystal[._-]' main/src frontend/src --include='*.ts' --include='*.tsx' --include='*.js'
   ```
   Expected matches after this task: ONLY identifiers in the deferred allowlist documented in the AC (`crystal-permissions`, `crystal-mcp-`, `getCrystalDirectory`, `getCrystalSubdirectory`, `setCrystalDirectory`, `customCrystalDir`, `enableCrystalFooter`, `crystalDirectory` filename).

2. **Rename log filenames in `main/src/utils/logger.ts`.** Replace `crystal-` with `cyboflow-` at three sites:
   - Line 73: `` `crystal-${date}.log` `` → `` `cyboflow-${date}.log` ``
   - Line 86: `` `crystal-${timestamp}.log` `` → `` `cyboflow-${timestamp}.log` ``
   - Line 106: `file.startsWith('crystal-')` → `file.startsWith('cyboflow-')`
   Note that pre-existing on-disk `crystal-*.log` files in `~/.cyboflow/logs/` will no longer be enumerated by `cleanupOldLogs` after this change. This is acceptable — they're abandoned debug artifacts; the user can delete them manually. The `MAX_LOG_FILES` cap still applies to the new `cyboflow-*` files.

3. **Rename debug log filenames in `main/src/index.ts`** at all eight sites (lines 93, 94, 227, 261, 323, 379, 426, 467, 640): `crystal-frontend-debug.log` → `cyboflow-frontend-debug.log`, `crystal-backend-debug.log` → `cyboflow-backend-debug.log`. Use a single grep+sed-style sweep then verify with `grep -nE 'crystal-(frontend|backend)-debug' main/src/index.ts` returning zero matches.

4. **Rebrand commit author trailer.** Three files write the `Co-Authored-By: Crystal <crystal@stravu.com>` trailer:
   - `main/src/utils/shellEscape.ts:29-31`: the `buildGitCommitCommand` helper. Update the heredoc string to `💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)` and `Co-Authored-By: Cyboflow <hello@cyboflow.com>`. (URL is best-effort — the README pin established the cyboflow repo address; if it's not authoritative, leave the URL pointed at the project's `homepage` field or omit the URL line entirely.)
   - `main/src/ipc/file.ts:241-245` and `:279-283`: the two inline commit-message templates. Same replacement.
   - `main/src/services/worktreeManager.ts:625-629`: the squash-and-rebase commit template. Same replacement.
   Keep the existing `enableCrystalFooter` config field NAME unchanged (renaming the field requires a config migration; out of scope). The behavior the field gates simply changes from "add a Crystal trailer" to "add a Cyboflow trailer".

5. **Rename temp commit filenames in `main/src/ipc/file.ts`.** Lines 248 and 286: `crystal-commit-${Date.now()}.txt` → `cyboflow-commit-${Date.now()}.txt` and `crystal-commit-retry-${Date.now()}.txt` → `cyboflow-commit-retry-${Date.now()}.txt`.

6. **PostHog distinctId prefix in `main/src/services/analyticsManager.ts:39`.** Change `` `crystal_${uuid}` `` → `` `cyboflow_${uuid}` ``. Decision on identity continuity: accept a fresh distinctId on first run after upgrade. `ConfigManager.getAnalyticsDistinctId()` already reads the persisted ID — users who already have a `crystal_*` distinctId stored in their config will keep using it (the early-return at line 33-34 returns the existing ID before the new prefix is constructed). Only NEW installs get the `cyboflow_` prefix. This is the correct behavior: telemetry continuity for existing users, clean identity for new ones. No migration code needed.

7. **User-facing error string in `main/src/services/panels/claude/claudeCodeManager.ts:340`.** `'- Or set a custom Claude executable path in Crystal Settings'` → `'- Or set a custom Claude executable path in Cyboflow Settings'`.

8. **MCP base-config filename in `claudeCodeManager.ts:889`.** `` `crystal-base-mcp-${sessionId}.json` `` → `` `cyboflow-base-mcp-${sessionId}.json` ``.

   **File-conflict note.** `claudeCodeManager.ts` is ALSO declared as `files_owned` by TASK-301 (in the `approval-router-and-permission-fix` epic, status `ready`), which renames `crystal-permissions` strings and `crystal-mcp-` filename (lines 148, 732, 805-806). The lines this task touches (340 and 889) do NOT overlap with TASK-301's edits. Whichever task lands second will see a clean rebase since the edits are at different lines. If a real merge conflict appears, defer to TASK-301's version and re-apply lines 340 and 889 by hand.

9. **localStorage key migration — frontend/src/utils/console.ts.** The current code reads `localStorage.getItem('crystal.verboseLogging')` at line 10. Refactor `isVerboseEnabled()` to:
   ```typescript
   const isVerboseEnabled = () => {
     try {
       const newKey = localStorage.getItem('cyboflow.verboseLogging');
       if (newKey !== null) return newKey === 'true';
       // Migration: read legacy key once, write new key, remove legacy
       const legacy = localStorage.getItem('crystal.verboseLogging');
       if (legacy !== null) {
         localStorage.setItem('cyboflow.verboseLogging', legacy);
         localStorage.removeItem('crystal.verboseLogging');
         return legacy === 'true';
       }
       return false;
     } catch {
       return false;
     }
   };
   ```

10. **localStorage key migration — `frontend/src/App.tsx:61`.** Change `storageKey: 'crystal-sidebar-width'` → `storageKey: 'cyboflow-sidebar-width'`. If the project's resizable-width hook does NOT have a built-in migration mechanism, also add a one-shot migration block near the top of the `App` component (or in a `useEffect` that runs once) that reads the legacy `crystal-sidebar-width` localStorage entry, writes its value to `cyboflow-sidebar-width` if the new key is absent, then removes the legacy entry. Read the hook source to determine whether it already supports migration before adding redundant code.

11. **localStorage key migration — `frontend/src/components/panels/editor/FileEditor.tsx:608`.** Same pattern as step 10: `storageKey: 'crystal-file-tree-width'` → `storageKey: 'cyboflow-file-tree-width'` with the same one-shot migration helper if the underlying hook doesn't migrate automatically.

12. **localStorage key migration — `frontend/src/components/panels/claude/RichOutputWithSidebar.tsx:38`.** `` `crystal-sidebar-collapsed-${id}` `` → `` `cyboflow-sidebar-collapsed-${id}` ``. Since the key is per-`id`, the migration helper should run inline at component mount (a `useEffect` that reads the legacy `crystal-sidebar-collapsed-${id}` key, writes the value to the new key, removes legacy).

13. **Run-script filename in `frontend/src/components/panels/SetupTasksPanel.tsx`.** Three sites:
    - Line 81: `run_script: './crystal-run.sh'` → `run_script: './cyboflow-run.sh'`
    - Line 90: log message string `Successfully set run script to ./crystal-run.sh` → `Successfully set run script to ./cyboflow-run.sh`
    - Line 459: `initialPrompt="Create a new file crystal-run.sh ..."` → `initialPrompt="Create a new file cyboflow-run.sh ..."`

14. **Logo asset rename.** Decision: replace, not delete the legacy file (out of scope). Steps:
    - Copy `frontend/src/assets/crystal-logo.svg` to `frontend/src/assets/cyboflow-logo.svg` (this is the "create new file" step — `cyboflow-logo.svg` is a new path in `files_owned`). The contents can stay identical to the existing crystal-logo.svg for now — exact Cyboflow branding design is out of scope; this task just needs the import path to be Cyboflow-branded.
    - Update the three import sites:
      - `frontend/src/components/Sidebar.tsx:6`: `import crystalLogo from '../assets/crystal-logo.svg'` → `import cyboflowLogo from '../assets/cyboflow-logo.svg'`, and rename the JSX reference at line 109 to `cyboflowLogo`.
      - `frontend/src/components/Welcome.tsx:3` (and line 50 JSX reference): same rename.
      - `frontend/src/components/AnalyticsConsentDialog.tsx:3` (and line 80 JSX reference): same rename.
    - Leave `frontend/src/assets/crystal-logo.svg` on disk (not in `files_owned` for deletion) — orphaned but harmless. A follow-up house-cleaning task can sweep unused assets after the rebrand has settled.

15. **Welcome.tsx body copy.** Two lines:
    - Line 85: `Crystal runs Claude Code with` → `Cyboflow runs Claude Code with`
    - Line 99: `Crystal will create it and initialize git` → `Cyboflow will create it and initialize git`

16. **AnalyticsConsentDialog.tsx body copy.** Line 94: `Your data helps us make Crystal better.` → `Your data helps us make Cyboflow better.`

17. **`--crystal-dir` CLI flag in `main/src/index.ts:113-122`.** Decision: keep `--crystal-dir` as a backward-compat alias, add `--cyboflow-dir` as canonical, emit a deprecation log when the old flag is used.
    ```typescript
    // Support --cyboflow-dir=/path, --cyboflow-dir /path (canonical) and --crystal-dir (deprecated alias)
    if (arg.startsWith('--cyboflow-dir=') || arg.startsWith('--crystal-dir=')) {
      const flagName = arg.startsWith('--cyboflow-dir=') ? '--cyboflow-dir=' : '--crystal-dir=';
      const dir = arg.substring(flagName.length);
      setCrystalDirectory(dir);
      console.log(`[Main] Using custom Cyboflow directory: ${dir}`);
      if (flagName === '--crystal-dir=') {
        console.warn('[Main] --crystal-dir is deprecated; use --cyboflow-dir');
      }
    } else if ((arg === '--cyboflow-dir' || arg === '--crystal-dir') && i + 1 < args.length) {
      const dir = args[i + 1];
      setCrystalDirectory(dir);
      console.log(`[Main] Using custom Cyboflow directory: ${dir}`);
      if (arg === '--crystal-dir') {
        console.warn('[Main] --crystal-dir is deprecated; use --cyboflow-dir');
      }
      i++;
    }
    ```

18. **CLAUDE.md update.** The "Frontend Console Debugging" section at lines 488-497 references `crystal-frontend-debug.log` and `crystal-backend-debug.log` four times. Replace each occurrence with `cyboflow-frontend-debug.log` / `cyboflow-backend-debug.log`.

19. **Completeness gate (step 1 re-run).** Re-execute the sweep grep from step 1 and confirm only allowlisted matches remain:
    ```bash
    grep -rnE 'crystal[._-]' main/src frontend/src --include='*.ts' --include='*.tsx' --include='*.js' \
      | grep -vE 'crystal-permissions|crystal-mcp-|getCrystalDirectory|getCrystalSubdirectory|setCrystalDirectory|customCrystalDir|enableCrystalFooter|crystalDirectory\.ts'
    ```
    Expected: zero output. Any non-empty output is a sweep miss; STOP and resolve before reporting COMPLETED.

20. **Build / typecheck / lint gate.** From repo root: `pnpm run build:main && pnpm run build:frontend && pnpm typecheck && pnpm lint`. All must exit 0.

## Acceptance Criteria

(See frontmatter. Every grep gate must pass; the completeness gate at step 19 is the load-bearing one.)

## Test Strategy

Add `frontend/src/utils/console.test.ts` covering the localStorage migration helper:
- **Test 1**: When `cyboflow.verboseLogging=true` exists, `isVerboseEnabled()` returns `true` without touching the legacy key.
- **Test 2**: When `cyboflow.verboseLogging` is unset and `crystal.verboseLogging=true` exists, `isVerboseEnabled()` returns `true`, writes `cyboflow.verboseLogging=true` to localStorage, and removes the legacy entry.
- **Test 3**: When both keys are unset, `isVerboseEnabled()` returns `false` without writes.
- **Test 4**: When localStorage throws (private-browsing simulation via mocked getItem rejection), returns `false` gracefully.

Use Vitest with `vi.stubGlobal('localStorage', { ... })` to fake localStorage in jsdom. No mocking of React internals needed — the helper is a pure function. The sidebar-width / file-tree-width / sidebar-collapsed migrations may or may not warrant tests depending on whether the migration lives inline in the component or in a shared helper; if the migration is inline and trivially identical to the console.ts pattern, the console.ts tests are sufficient regression cover. If a shared `migrateLocalStorageKey(legacyKey, newKey)` helper emerges in step 9-12, test it directly and skip the inline tests.

## Hardest Decision

The `--crystal-dir` CLI flag. Three options were considered: (a) hard-rename to `--cyboflow-dir` and break any user scripts that invoke Cyboflow with the old flag, (b) keep `--crystal-dir` as a silent permanent alias, (c) accept BOTH flags, emit a deprecation warning on `--crystal-dir`, and document a removal milestone. Chose (c). The flag is a developer/power-user surface (no GUI affordance), so the user base is small and tolerant of deprecation noise, but a hard break still bothers the same users most (they have scripts/launchers using the flag). The deprecation warning gives them a one-release migration window. The flag itself stays in the source until a future "remove deprecated CLI flags" cleanup task.

## Rejected Alternatives

- **Hard-rename `--crystal-dir`.** Rejected for the reason above. Would reconsider only if the flag is verifiably unused (e.g. zero grep hits in user scripts surveyed via release notes ask).
- **Delete `crystal-logo.svg` instead of leaving it orphaned.** Rejected for this task. Deletion is a separate concern (asset cleanup) and risks invalidating any external doc/README screenshot reference. Defer to a future "unused-assets sweep" task.
- **Migrate the PostHog distinctId with a mapping table.** Rejected. Telemetry continuity for the small Crystal-era user base is not worth the complexity of a mapping table in `~/.cyboflow/config.json` and the analytics dashboard merge work. Existing users keep their already-persisted distinctId (no behavior change for them); new users get the `cyboflow_` prefix. Would reconsider if analytics shows a meaningful pre-existing cohort whose retention metric matters.
- **Skip the localStorage migration shim.** Rejected. Without it, every user who upgrades loses their saved sidebar width, file-tree width, sidebar collapsed state, and verbose-logging preference. The shim is 10 lines per call site (or one shared helper) — cheap insurance.
- **Rename `enableCrystalFooter` config field.** Rejected. Renaming a config field requires `ConfigManager` migration code to read the old key and persist under the new key, plus an update to the Settings UI binding. Sweep tasks should not pull in config schema changes; defer to a dedicated config-rename task.

## Lowest Confidence Area

The localStorage migration's correctness across all four key sites (sidebar width, file-tree width, sidebar collapsed per-id, verboseLogging). Three of the four sites use a `useResizable`-style hook with a `storageKey` prop; the hook may already implement built-in migration via a `legacyKey` option or similar, in which case the inline migration code in steps 10-11 is redundant. The executor MUST read the resizable hook source before adding inline migration — if the hook supports it natively, prefer the built-in. If the executor adds inline migration AND the hook also migrates, the result is harmless but ugly; the tests in `console.test.ts` won't catch this redundancy. Second risk: the `cyboflow-logo.svg` file is created with identical contents to `crystal-logo.svg`. Visually this is fine, but a downstream brand-asset task may overwrite it. If branding has a Cyboflow logo already approved, swap the file contents here instead of copying.
