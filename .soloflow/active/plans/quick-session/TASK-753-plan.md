---
id: TASK-753
idea: SPRINT-037-compound
status: ready
created: 2026-05-25T00:00:00Z
files_owned:
  - main/src/types/session.ts
  - frontend/src/types/session.ts
files_readonly:
  - main/src/ipc/session.ts
  - main/src/preload.ts
  - frontend/src/utils/api.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/stores/sessionStore.ts
  - .soloflow/active/findings/SPRINT-037-findings.md
  - .soloflow/archive/done/quick-session/TASK-744-done.md
acceptance_criteria:
  - criterion: "main/src/types/session.ts CreateSessionRequest no longer declares quickSession?: boolean"
    verification: "grep -n 'quickSession' main/src/types/session.ts returns 0 matches"
  - criterion: "frontend/src/types/session.ts CreateSessionRequest declares branchName?: string"
    verification: "grep -n 'branchName' frontend/src/types/session.ts returns at least one match inside the CreateSessionRequest interface block"
  - criterion: "main/src/types/session.ts CreateSessionRequest still declares branchName?: string"
    verification: "grep -n 'branchName' main/src/types/session.ts returns at least one match inside the CreateSessionRequest interface block"
  - criterion: "Both CreateSessionRequest declarations carry a sync-warning comment referencing shared/types/ipc.ts"
    verification: "grep -n 'shared/types/ipc' main/src/types/session.ts frontend/src/types/session.ts returns at least two matches"
  - criterion: "Production code does not read CreateSessionRequest.quickSession"
    verification: "grep -rn 'quickSession' --include='*.ts' --include='*.tsx' main/src frontend/src returns 0 matches for the field-name reference"
  - criterion: "pnpm typecheck && pnpm lint exit 0"
    verification: "pnpm typecheck && pnpm lint exit 0"
depends_on: []
estimated_complexity: low
epic: quick-session
test_strategy:
  needed: false
  justification: "Pure type-surface change. No runtime behavior changes. Verification is `pnpm typecheck` (catches any accidental consumer of `quickSession`) plus AC-level grep. main/src/types/ and frontend/src/types/ have no sibling tests (pure type declarations). Component tests in CyboflowRoot.test.tsx and WorkflowPicker.test.tsx do not import CreateSessionRequest and do not reference quickSession — both call sites send hard-coded payloads."
prerequisites:
  - check: "grep -rn 'quickSession' --include='*.ts' --include='*.tsx' main/src frontend/src | grep -vE 'quick-session|quickSessionId|quickSessions|quickSession-session'"
    fix: "If matches outside main/src/types/session.ts appear, audit — a production consumer may have been added since SPRINT-037; do NOT delete the field; escalate"
    description: "Sanity check that nothing in production reads CreateSessionRequest.quickSession before pruning the type"
    blocking: true
---

# Prune dead CreateSessionRequest.quickSession + add missing branchName to frontend type

## Objective

`CreateSessionRequest` is dual-declared in `main/src/types/session.ts` and `frontend/src/types/session.ts`. TASK-744 added `quickSession?: boolean` (dead from inception, zero production reads) and `branchName?: string` (consumed by `main/src/ipc/session.ts:338` but absent from the frontend declaration) to main only. Make the minimal correction per the skeptic counterfactual: delete the dead field, add `branchName` to the frontend, leave a sync-warning comment near both declarations referencing the future `shared/types/ipc.ts` consolidation target. Do NOT introduce `shared/types/ipc.ts` — explicitly out of scope.

## Implementation Steps

1. **Pre-flight grep gate.** Run `grep -rn 'quickSession' --include='*.ts' --include='*.tsx' main/src frontend/src`. Expected: exactly one match at `main/src/types/session.ts:75`. Other test-only string-literal variables (`quickSession-session-abc123`, `quickSessionId`) are unrelated. If a production consumer appears that reads the field, STOP — deletion is unsafe.

2. **Edit `main/src/types/session.ts`**: delete `quickSession?: boolean;` from `CreateSessionRequest`. Keep `branchName?: string;` (TASK-744 added it; ipc/session.ts consumes it). Add comment above the interface:
   ```ts
   // NOTE: keep this interface in sync with frontend/src/types/session.ts CreateSessionRequest
   // until shared/types/ipc.ts consolidates IPC request shapes. See FIND-SPRINT-037-5.
   ```

3. **Edit `frontend/src/types/session.ts`**: add `branchName?: string;` inside `CreateSessionRequest`, placed after `toolType?: 'claude' | 'none';` to mirror main's ordering. Add the symmetric comment above the interface.

4. **Re-run the grep gate** as completeness check; `pnpm typecheck && pnpm lint`.

## Acceptance Criteria
See frontmatter.

## Hardest Decision
Delete `quickSession` from main vs. add it to frontend for symmetry. Chose deletion: adding dead code to frontend would propagate the divergence surface; deletion shrinks it. Git history preserves the prior declaration for revival if requirements change.

## Rejected Alternatives
- **Promote to `shared/types/ipc.ts`.** Explicitly forbidden by the work-item constraint (skeptic counterfactual).
- **Keep `quickSession` as "reserved for future use."** Rejected — speculative fields without consumers create audit noise; delete-and-restore-when-needed is the maintainable pattern.
- **Also touch `frontend/src/stores/sessionStore.ts`'s narrower local `CreateSessionRequest`.** Rejected — separate scoped-down type, not the IPC payload shape covered by FIND-SPRINT-037-5.

## Lowest Confidence Area
Comment placement near the interface declaration is cosmetic; AC only asserts the string `shared/types/ipc` appears in the file.
