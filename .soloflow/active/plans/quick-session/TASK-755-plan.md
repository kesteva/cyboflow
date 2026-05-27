---
id: TASK-755
idea: SPRINT-038-compound-B2
status: in-flight
created: "2026-05-25T00:00:00Z"
files_owned:
  - main/src/types/session.ts
  - frontend/src/types/session.ts
files_readonly:
  - main/src/ipc/session.ts
  - main/src/services/sessionManager.ts
  - main/src/services/taskQueue.ts
  - main/src/preload.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/stores/sessionStore.ts
  - .soloflow/active/findings/SPRINT-038-findings.md
  - CLAUDE.md
acceptance_criteria:
  - criterion: "`CreateSessionRequest` in `main/src/types/session.ts` no longer declares `model?: string`."
    verification: "grep -nE 'model\\?:' main/src/types/session.ts returns no hit inside the `interface CreateSessionRequest` block (the nested `claudeConfig.model` must remain — verify the only deleted line is the top-level `model?: string;`)."
  - criterion: "`CreateSessionRequest` in `frontend/src/types/session.ts` no longer declares `isMainRepo?: boolean`."
    verification: "Inside `interface CreateSessionRequest` (frontend/src/types/session.ts:126-145) `grep -n 'isMainRepo' frontend/src/types/session.ts` shows only the unrelated `Session.isMainRepo` declaration (not inside `CreateSessionRequest`)."
  - criterion: No production code in main/src or frontend/src reads `request.model` or `request.isMainRepo` on a `CreateSessionRequest`-typed value.
    verification: "grep -rnE 'request\\.(model|isMainRepo)\\b' main/src frontend/src returns zero hits. Also `grep -rnE 'const\\s*\\{[^}]*\\b(model|isMainRepo)\\b' main/src frontend/src` returns zero hits involving the request type (destructuring guard)."
  - criterion: Sync-warning comment blocks on both files reference this audit pass (include FIND-SPRINT-038-3 alongside the existing FIND-SPRINT-037-5 reference).
    verification: "grep -n 'FIND-SPRINT-038-3' main/src/types/session.ts frontend/src/types/session.ts shows one match in each file."
  - criterion: Type-check passes across all workspaces.
    verification: pnpm typecheck exits 0.
  - criterion: Main and frontend test suites pass.
    verification: pnpm --filter main test exits 0; pnpm --filter frontend test exits 0.
  - criterion: Lint stays clean (no new errors).
    verification: pnpm lint exits 0.
depends_on: []
estimated_complexity: low
epic: quick-session
test_strategy:
  needed: false
  justification: "Pure type-surface change. Both deleted fields have already been audited as dead (the AC #3 grep is the regression guard, and the executor re-runs it as step 1 of Implementation Steps). The matching parity-fix predecessor TASK-753 also declared `test_strategy.needed: false` for the same reason and shipped without issue. No sibling tests exist in `main/src/types/__tests__/` or `frontend/src/types/__tests__/` for `session.ts`. The cross-workspace `pnpm typecheck` is the actual contract test."
prerequisites:
  - check: "grep -rnE 'request\\.(model|isMainRepo)\\b' main/src frontend/src"
    fix: "If matches appear (other than tests intentionally exercising the type), STOP. A production consumer has appeared since the SPRINT-038 audit; reclassify the field as alive and switch task from delete-on-both to add-to-twin."
    description: Sanity check that both fields are still dead before pruning
    blocking: true
---
# Prune dead `isMainRepo` (frontend) and `model` (main) from `CreateSessionRequest`

## Objective

Close the two remaining pre-existing IPC request-shape parity gaps in `CreateSessionRequest` documented in FIND-SPRINT-038-3:

1. `frontend/src/types/session.ts:133` declares `isMainRepo?: boolean` — never read by any main-side handler.
2. `main/src/types/session.ts:68` declares `model?: string` — never read by any handler (the live model field is the nested `claudeConfig.model`, declared on both sides).

Both fields are dead per audit (`grep -rnE 'request\.(model|isMainRepo)\b' main/src frontend/src` returns zero hits). This task is a straight delete-both-with-verification, mirroring TASK-753 (which pruned `quickSession` from main and added `branchName` to frontend). After this task lands, the two `CreateSessionRequest` declarations have aligned field sets — the precondition for the still-deferred promotion to `shared/types/ipc.ts`.

## Implementation Steps

1. **Re-run the dead-field audit (completeness gate).** Run all of:
   ```
   grep -rnE 'request\.(model|isMainRepo)\b' main/src frontend/src
   grep -rnE 'const\s*\{[^}]*\b(model|isMainRepo)\b' main/src frontend/src
   grep -rn 'isMainRepo' main/src/ipc/ main/src/services/sessionManager.ts main/src/services/taskQueue.ts
   ```
   Expected: the first two greps return zero hits. The third returns only positional-parameter sites in `sessionManager.ts` and the `dbSession.is_main_repo` mapper — NONE of which read a `CreateSessionRequest.isMainRepo` field. If any read shows up that the SPRINT-038 audit missed, STOP — the field is alive on one side and the task scope changes from delete to add-twin.
2. **Edit `main/src/types/session.ts`.** Inside `interface CreateSessionRequest`, delete the top-level `model?: string;` declaration. Keep the nested `claudeConfig.model` intact (the live model surface). Update the sync-warning comment block to append a second reference line — e.g. `// See also FIND-SPRINT-038-3 (pruned dead top-level model?: string).`.
3. **Edit `frontend/src/types/session.ts`.** Inside `interface CreateSessionRequest`, delete the `isMainRepo?: boolean;` declaration. Crucially DO NOT touch the `Session.isMainRepo` declaration — it has production consumers and is unrelated. Update the sync-warning comment block with the symmetric FIND-SPRINT-038-3 reference.
4. **Run typecheck.** `pnpm typecheck`. Must exit 0. If anything fails, a consumer reads one of the deleted fields — revert and reclassify.
5. **Run tests.** `pnpm --filter main test` then `pnpm --filter frontend test`. Both exit 0.
6. **Run lint.** `pnpm lint`. Must exit 0.
7. **Re-run the completeness grep one final time** and confirm zero hits before reporting COMPLETED.

## Acceptance Criteria

See frontmatter.

## Hardest Decision

Whether to promote `CreateSessionRequest` to `shared/types/ipc.ts` in the same task. Decided AGAINST: the promotion is one design step beyond the parity fix. After this task the two declarations have identical field sets, which is the precondition the promotion was waiting on — but the promotion itself is a separate task with its own design surface.

## Rejected Alternatives

1. **Add the missing field to the twin instead of deleting.** Rejected — audit confirms zero readers on either side; nothing to preserve.
2. **Delete only one field.** Rejected — both are the same pattern (silent-drop dead field) and both block the future promotion. Splitting into two tasks is mechanical overhead with no isolation benefit.
3. **Restore `model?: string` for hypothetical external callers.** Rejected — the IPC channel is private to the Electron renderer; there are no external callers. The nested `claudeConfig.model` is the live channel.

## Lowest Confidence Area

Step 1's audit. A greedy regex (`request\.(model|isMainRepo)\b`) can miss two destructuring patterns:
- `const { model, isMainRepo } = request;`
- A spread `taskQueue.createSession({ ...request })` that flows the field into a code path that later reads `.model`.

The executor must run the destructuring + spread greps in step 1 before deletion. The risk is low (TASK-753 just edited these files) but not zero.
