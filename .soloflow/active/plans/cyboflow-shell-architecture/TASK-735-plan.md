---
id: TASK-735
idea: SPRINT-034-compounder
status: in-flight
created: "2026-05-23T22:30:00Z"
files_owned:
  - frontend/src/components/PromptHistory.tsx
  - frontend/src/components/PromptHistoryModal.tsx
  - frontend/src/types/electron.d.ts
files_readonly:
  - frontend/src/components/cyboflow/CyboflowRoot.tsx
  - frontend/src/components/cyboflow/RunView.tsx
  - frontend/src/App.tsx
acceptance_criteria:
  - criterion: No file under frontend/src/ dispatches a navigateToPrompt CustomEvent.
    verification: "grep -rnE \"dispatchEvent\\(\\s*new\\s+CustomEvent\\(['\\\"]navigateToPrompt\" frontend/src/ returns 0 matches"
  - criterion: Standalone frontend/src/components/PromptHistory.tsx is deleted (the file is unreferenced after TASK-691; the modal variant in PromptHistoryModal.tsx is preserved).
    verification: "test ! -f frontend/src/components/PromptHistory.tsx"
  - criterion: frontend/src/components/PromptHistoryModal.tsx no longer contains the dead dispatch block but retains its session-switch + onClose behavior.
    verification: "grep -nE 'navigateToPrompt' frontend/src/components/PromptHistoryModal.tsx returns 0 matches; modal still exports a default React component"
  - criterion: "frontend/src/types/electron.d.ts:205 stale reference to PromptHistory is updated or removed."
    verification: "grep -nE 'PromptHistory' frontend/src/types/electron.d.ts returns 0 matches"
  - criterion: pnpm typecheck and pnpm lint pass.
    verification: pnpm typecheck exits 0; pnpm lint exits 0
  - criterion: pnpm --filter frontend test passes (no test depends on the deleted dispatch).
    verification: pnpm --filter frontend test exits 0
depends_on: []
estimated_complexity: low
epic: cyboflow-shell-architecture
test_strategy:
  needed: false
  justification: Removal of a dead CustomEvent dispatch with zero listeners (verified via grep). Modal session-switch + onClose paths are preserved unchanged; no new behavior. PromptHistory.tsx deletion is grep-verified to have zero importers. Typecheck-green + lint-green + the frontend suite passing is the correctness contract.
prerequisites: []
---
# Remove dead navigateToPrompt CustomEvent dispatch and delete orphan PromptHistory.tsx

## Objective

`frontend/src/components/PromptHistory.tsx:82` and `frontend/src/components/PromptHistoryModal.tsx:96` each call `window.dispatchEvent(new CustomEvent('navigateToPrompt', { detail: {...} }))`. After TASK-691 deleted `SessionView` (the only `addEventListener('navigateToPrompt')` site), the dispatch fires into the void on every Recent-Prompts click — a silent UX break.

Additionally, the standalone `frontend/src/components/PromptHistory.tsx` (152 LOC) has zero importers across `frontend/src/` (only `PromptHistoryModal.tsx` is mounted; the standalone variant was a Crystal-era surface). `frontend/src/types/electron.d.ts:205` carries a stale comment referencing the deleted file.

**Sub-decision before execution:** is prompt-history navigation a v1 feature in the CyboflowRoot shell?
- **Default = NO** (delete the dispatch; the modal still closes via the existing `onClose()` call after session-switch). If the project later decides to surface prompt-history navigation, a future task can wire a listener in `CyboflowRoot` or a `RunView` placement.
- If YES, the dispatch stays and a listener must be added — but that work belongs in its own scoped task with verification that the routing actually targets the right run/panel.

This task takes the default-NO path.

Resolves FIND-SPRINT-034-13.

## Implementation Steps

1. **Pre-flight grep:**
   ```bash
   grep -rnE "addEventListener\(\s*['\"]navigateToPrompt" frontend/src/ main/src/
   grep -rnE "from\s+['\"][^'\"]*PromptHistory(?!Modal)" frontend/src/
   ```
   First command must return 0 matches (confirms no listener exists today). Second command must return 0 matches outside `PromptHistoryModal.tsx` itself (confirms no other importer of standalone `PromptHistory.tsx`).

2. **In `frontend/src/components/PromptHistoryModal.tsx`**, remove the `window.dispatchEvent(new CustomEvent('navigateToPrompt', ...))` block at line ~96. Keep the surrounding session-switch logic (`API.sessions.setActive`) and the `onClose()` call. The modal continues to switch to the prompt's session and close — that is the still-useful 80% of the affordance.

3. **Delete `frontend/src/components/PromptHistory.tsx`** with `git rm`. Confirmed orphan via the grep at step 1.

4. **Update `frontend/src/types/electron.d.ts`** at line ~205 — remove the `PromptHistory` reference. If the comment becomes empty, drop the comment line entirely; if it still describes something useful, just strike the stale name.

5. **Run `pnpm typecheck`.** Must exit 0.

6. **Run `pnpm lint`.** Must exit 0.

7. **Run `pnpm --filter frontend test`.** Must exit 0.

8. **Atomic commit:** `feat(TASK-735): remove dead navigateToPrompt dispatch and delete orphan PromptHistory.tsx`.

## Acceptance Criteria

See frontmatter.

## Test Strategy

No new tests. Behavior change is removal of a no-op dispatch and deletion of an unreferenced file. The modal's session-switch + close path remains and is exercised by any future PromptHistoryModal interaction.

## Hardest Decision

**Whether to delete the standalone PromptHistory.tsx OR keep it as a `@cyboflow-hidden`-preserved surface.** Rejected the preservation: `@cyboflow-hidden` is for intentionally-unreachable-but-future-restorable code with a known restore path; standalone PromptHistory was a Crystal-era affordance with no documented future role and zero importers. Cleaner to delete; future work can re-introduce a renamed v2 variant if needed.

## Lowest Confidence Area

**Whether the session-switch behavior alone (without the navigation-to-specific-prompt) is sufficient UX.** This is the v1 trade-off — user clicks a prompt in history, the modal switches to that session and closes, but the prompt itself isn't scrolled into view. Acceptable for v1; if user feedback later flags it as a regression, a future task can add the listener+routing in CyboflowRoot.
