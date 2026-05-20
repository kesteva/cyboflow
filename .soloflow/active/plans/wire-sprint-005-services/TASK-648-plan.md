---
id: TASK-648
idea: SPRINT-007-compound
status: in-flight
created: "2026-05-14T00:00:00Z"
files_owned:
  - main/src/ipc/session.ts
  - main/src/preload.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
files_readonly:
  - main/src/ipc/__tests__/sessionJsonMessages.test.ts
  - frontend/src/components/panels/ai/RichOutputView.tsx
  - frontend/src/components/panels/ai/MessagesView.tsx
  - .soloflow/active/compound/SPRINT-007-proposal.md
  - .soloflow/active/findings/SPRINT-007-findings.md
acceptance_criteria:
  - criterion: "The `sessions:get-json-messages` IPC handler is removed from session.ts"
    verification: "grep -nE \"ipcMain\\.handle\\(['\\\"]sessions:get-json-messages\" main/src/ipc/session.ts returns 0 matches"
  - criterion: All recursive references to the legacy channel name are gone from the codebase (excluding .soloflow history)
    verification: "grep -rn 'sessions:get-json-messages' main/src frontend/src returns 0 matches"
  - criterion: The preload binding for sessions.getJsonMessages is removed
    verification: "grep -nE \"sessions:get-json-messages|sessions\\.getJsonMessages\" main/src/preload.ts returns 0 matches"
  - criterion: "The frontend api binding (api.ts:87-90) is removed"
    verification: "grep -nE 'sessions\\.getJsonMessages|async getJsonMessages\\(sessionId' frontend/src/utils/api.ts returns 0 matches"
  - criterion: The TypeScript declaration for sessions.getJsonMessages is removed from electron.d.ts
    verification: "grep -nE 'sessions[^}]*getJsonMessages' frontend/src/types/electron.d.ts returns 0 matches"
  - criterion: "The panel-keyed handler at panels:get-json-messages and its preload/api bindings/types remain intact (no collateral damage)"
    verification: "grep -nE \"panels:get-json-messages\" main/src/ipc/session.ts main/src/preload.ts returns at least 2 matches AND grep -nE 'panels\\.getJsonMessages' frontend/src/utils/api.ts frontend/src/types/electron.d.ts returns at least 2 matches"
  - criterion: pnpm --filter main typecheck exits 0
    verification: pnpm --filter main typecheck
  - criterion: pnpm --filter frontend typecheck exits 0
    verification: pnpm --filter frontend typecheck
  - criterion: pnpm lint exits 0
    verification: pnpm lint
  - criterion: "Existing sessionJsonMessages.test.ts (covers panels:get-json-messages) still passes"
    verification: pnpm --filter main test -- sessionJsonMessages exits 0
depends_on: []
estimated_complexity: low
epic: wire-sprint-005-services
test_strategy:
  needed: false
  justification: "Pure deletion of an unreachable code path. The legacy handler has zero renderer callers — confirmed by `grep -rn 'API.sessions.getJsonMessages\\|API.session.getJsonMessages\\|electronAPI.sessions.getJsonMessages' frontend/src main/src` returning only the api.ts wrapper itself (which is being deleted in this task) and no component consumer. The only active code path that calls getJsonMessages is `panels.getJsonMessages` (RichOutputView.tsx:189, MessagesView.tsx:48), which is unaffected by this task. Sibling-test scan: `main/src/ipc/__tests__/sessionJsonMessages.test.ts` exists but per its docstring 'tests the panels:get-json-messages handler' — confirmed by re-reading lines 1-5 of that file. Adding tests for a handler we're deleting would be wasted effort; the existing test for the parallel panel-keyed handler stays green as a regression guard for the surviving path."
---
# Delete the divergent sessions:get-json-messages handler

## Objective

TASK-568 wired `projectStoredOutputs()` (which calls `MessageProjection` + `TypedEventNarrowing` to populate `.segments`) into `panels:get-json-messages` at `main/src/ipc/session.ts:937-961`. The parallel `sessions:get-json-messages` handler at `session.ts:1250-1329` was not migrated — it still does the legacy raw stream-json spread (`{...jsonData, timestamp}` at lines 1316-1319) which is exactly the payload shape that triggered the FIND-SPRINT-005-9 renderer crash (`TypeError: Cannot read properties of undefined (reading 'some')`). The session-keyed handler has zero renderer callers (verified by grep — only the `api.ts:87-90` wrapper references the preload binding, and no component calls that wrapper). It is a dormant footgun: if any future caller is added, the `.some`-of-undefined crash returns immediately. This task deletes the handler, the preload binding, the frontend api wrapper, and the TypeScript declaration in one atomic commit — eliminating the divergence at the API surface rather than trying to keep two parallel paths in sync.

## Implementation Steps

1. **Pre-flight grep — confirm no renderer caller exists** (re-run before editing to catch any race between proposal time and execution time):
   ```bash
   grep -rn 'sessions\.getJsonMessages\|electronAPI\.sessions\.getJsonMessages\|API\.session\.getJsonMessages\|API\.sessions\.getJsonMessages' frontend/src main/src
   ```
   Expected matches (and ONLY these):
   - `frontend/src/utils/api.ts:89` — the wrapper itself (deletion target)
   If grep returns any additional match, **stop** and switch to migration mode (option a per FIND-SPRINT-007-11): rewrite the handler to call `projectStoredOutputs()` on the panel branch. Add a note to the executor report explaining the pivot. The current plan assumes the zero-caller case.

2. **Delete the IPC handler in `main/src/ipc/session.ts:1250-1329`.** Remove the entire `ipcMain.handle('sessions:get-json-messages', ...)` block including its docstring/comment context. The `isGitOperation` helper inside the handler (lines 1271-1281) is closed-over by the handler and not used elsewhere — it goes with the deletion. Double-check via:
   ```bash
   grep -n 'isGitOperation' main/src
   ```
   Expected: zero matches outside the deleted block before commit.

3. **Delete the preload binding at `main/src/preload.ts:209`** — remove the single line:
   ```ts
   getJsonMessages: (sessionId: string): Promise<IPCResponse> => ipcRenderer.invoke('sessions:get-json-messages', sessionId),
   ```
   Keep the surrounding `sessions: { ... }` block well-formed (no trailing comma issue — verify the diff renders clean).

4. **Delete the frontend wrapper at `frontend/src/utils/api.ts:87-90`** — remove the entire 4-line `async getJsonMessages(sessionId: string)` method block. Verify the surrounding object literal still parses (the line above is `}` of `getOutput`, the line below is the `async getStatistics` method).

5. **Delete the TypeScript declaration at `frontend/src/types/electron.d.ts:64`** — remove the single line:
   ```ts
   getJsonMessages: (sessionId: string) => Promise<IPCResponse>;
   ```
   inside the `sessions: { ... }` block. The panel-keyed declaration at line 288 (`panels.getJsonMessages`) is unrelated and stays.

6. **Run the verification gates** (paste exact commands; all must exit 0 before reporting COMPLETED):
   ```bash
   pnpm --filter main typecheck
   pnpm --filter frontend typecheck
   pnpm lint
   pnpm --filter main test -- sessionJsonMessages
   grep -rn 'sessions:get-json-messages' main/src frontend/src
   ```
   The grep gate at the end must return 0 matches (excluding `.soloflow/` history). The vitest run validates that the surviving panel-keyed test is unaffected by the deletion.

## Acceptance Criteria

See frontmatter. Compound rule: the legacy `sessions:get-json-messages` handler and every binding pointing at it are gone; the panel-keyed `panels:get-json-messages` path is untouched and its test stays green.

## Test Strategy

No new tests. The deletion is pure dead-code removal — there is no behavior to assert beyond "the channel name no longer exists." The existing `sessionJsonMessages.test.ts` exercises the parallel `panels:get-json-messages` handler (its docstring at line 3 confirms this) and stays as the regression guard for the surviving path. Sibling-test scan: `main/src/ipc/__tests__/` contains only `sessionJsonMessages.test.ts`, which covers the panel-keyed handler (verified by `grep -n 'panels:get-json-messages\|sessions:get-json-messages' main/src/ipc/__tests__/sessionJsonMessages.test.ts` — only the panel name appears). No test mocks or asserts the legacy channel, so deletion does not require test updates.

## Hardest Decision

**Delete vs migrate.** FIND-SPRINT-007-11 listed both options. Decision: delete. The session-keyed handler has zero callers (grep-verified at proposal time and again in Implementation Step 1), so migrating it just maintains a dormant duplicate. The cost of migration is non-trivial because the legacy handler ALSO does the git-operation stdout/stderr filtering inline (lines 1269-1281, 1304-1312) which the panel handler does NOT do — so a faithful migration would either (a) add git-operation handling to `projectStoredOutputs` (cross-cutting change, large blast radius), (b) duplicate that branch in the new handler body (re-creates the divergence we are trying to eliminate), or (c) just drop git-operation handling (a behavioural regression for any future caller). All three are worse than deletion. If a future feature needs session-keyed JSON messages, it should be built fresh against `projectStoredOutputs`, not by resurrecting this handler.

## Rejected Alternatives

- **Migrate to call `projectStoredOutputs()` (option a from FIND-SPRINT-007-11).** Rejected because the handler has zero callers and the git-operation branch would create a new divergence. See "Hardest Decision."
- **Mark the handler `@cyboflow-hidden` instead of deleting it.** Rejected: `@cyboflow-hidden` is for code paths preserved for future re-enablement (per CLAUDE.md:15-17). This handler is not preserved-for-future — it's pre-cyboflow Crystal scaffolding that diverged from the canonical path. The annotation would suggest "we plan to bring this back," which is wrong.
- **Leave the handler in place since it's not causing active harm.** Rejected: FIND-SPRINT-005-9 cost a full sprint to diagnose because the renderer crash reproducer was non-obvious. Leaving a known-bad payload shape one IPC call away from a regression is precisely the "dormant footgun" class the compounder is designed to surface. The cost of deletion is ~30 lines across 4 files; the cost of a future regression is another full debug cycle.

## Lowest Confidence Area

Whether `frontend/src/types/electron.d.ts:64` is the only TypeScript declaration site. The file has two `getJsonMessages` declarations (line 64 for `sessions`, line 288 for `panels`). The plan deletes only the `sessions` one. If the declaration is duplicated elsewhere (e.g. via a `declare module` augmentation in a `.d.ts` file I haven't read), the typecheck will pass but the type surface will retain a phantom binding. Mitigation: the AC `grep -nE 'sessions[^}]*getJsonMessages' frontend/src/types/electron.d.ts returns 0 matches` is a tight verification — if the declaration is elsewhere, this check will pass while the type surface still leaks. Add a broader grep as a sanity check (informational, not an AC): `grep -rn 'getJsonMessages' frontend/src/types` should return only the panel-keyed line after the edit.
