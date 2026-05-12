---
id: TASK-565
idea: SPRINT-002-compound
status: ready
created: 2026-05-12T00:00:00Z
files_owned:
  - main/src/utils/commitFooter.ts
  - main/src/utils/shellEscape.ts
  - main/src/ipc/file.ts
  - main/src/services/worktreeManager.ts
files_readonly:
  - main/src/services/commitManager.ts
  - main/src/types/config.ts
  - .soloflow/active/plans/crystal-cuts-and-rebrand/TASK-561-plan.md
acceptance_criteria:
  - criterion: "New helper module main/src/utils/commitFooter.ts exists and exports a buildCommitFooter function"
    verification: "test -f main/src/utils/commitFooter.ts && grep -nE 'export function buildCommitFooter' main/src/utils/commitFooter.ts returns exactly 1 match"
  - criterion: "The helper function takes a boolean parameter named `enableCyboflowFooter` (matches the renamed config field from TASK-561)"
    verification: "grep -nE 'function buildCommitFooter\\(enableCyboflowFooter: boolean' main/src/utils/commitFooter.ts returns at least 1 match"
  - criterion: "The literal commit-footer string `💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)` appears EXACTLY ONCE in the entire main/src tree (only in commitFooter.ts)"
    verification: "grep -rn --include='*.ts' '💎 Built using \\[Cyboflow\\]' main/src/ returns exactly 1 match (in main/src/utils/commitFooter.ts)"
  - criterion: "The 4 prior duplicated footer blocks are removed from shellEscape.ts, ipc/file.ts (×2 — initial commit + retry branches), and worktreeManager.ts"
    verification: "grep -rn --include='*.ts' -E '💎 Built using.*Co-Authored-By: Cyboflow' main/src/utils/shellEscape.ts main/src/ipc/file.ts main/src/services/worktreeManager.ts returns 0 matches"
  - criterion: "shellEscape.ts buildGitCommitCommand calls buildCommitFooter to construct the full message"
    verification: "grep -n 'buildCommitFooter' main/src/utils/shellEscape.ts returns at least 1 match"
  - criterion: "ipc/file.ts uses buildCommitFooter in both the initial and retry branches; main commit-message construction is extracted to a shared local helper buildCommitMessage if both branches build the message identically"
    verification: "grep -n 'buildCommitFooter' main/src/ipc/file.ts returns at least 2 matches (one per branch) OR if a local buildCommitMessage helper is introduced, grep -nE 'buildCommitMessage|buildCommitFooter' main/src/ipc/file.ts returns at least 3 matches (1 helper def + 2 callers)"
  - criterion: "worktreeManager.ts uses buildCommitFooter to construct the squashed-commit message"
    verification: "grep -n 'buildCommitFooter' main/src/services/worktreeManager.ts returns at least 1 match"
  - criterion: "Main typecheck and main vitest both pass"
    verification: "pnpm --filter main typecheck exits 0 AND pnpm --filter main test exits 0"
depends_on: [TASK-561]
estimated_complexity: low
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: true
  justification: "buildCommitFooter is a small pure function but lives on the path of every commit Cyboflow creates. A silent regression (wrong attribution URL, missing newline, swallowed `enableCyboflowFooter=false` case) would silently rebrand or duplicate footers on every user commit. Two cases give us full branch coverage."
  targets:
    - behavior: "buildCommitFooter(true) returns the canonical Cyboflow footer string with the exact format used by existing commits"
      test_file: main/src/utils/commitFooter.test.ts
      type: unit
    - behavior: "buildCommitFooter(false) returns an empty string (or whatever the contract says — see Implementation Step 2)"
      test_file: main/src/utils/commitFooter.test.ts
      type: unit
---

# Extract buildCommitFooter helper to eliminate 4 hardcoded Cyboflow footer string literals

## Objective

The Cyboflow commit-message footer (`💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)\n\nCo-Authored-By: Cyboflow <hello@cyboflow.com>`) is hardcoded in 4 places: `main/src/utils/shellEscape.ts:27-30`, `main/src/ipc/file.ts:241-245` and `:279-283` (two near-identical branches of the same commit handler), and `main/src/services/worktreeManager.ts:625-627`. The same `config?.enableCyboflowFooter !== false` (after TASK-561) ternary is duplicated alongside each. TASK-558 paid the lockstep-edit tax once when flipping the Crystal→Cyboflow string; the next rename will pay it again unless we extract a helper. This task introduces `main/src/utils/commitFooter.ts` exposing `buildCommitFooter(enableCyboflowFooter: boolean): string` and replaces all four duplicate blocks with calls.

## Implementation Steps

1. **Sweep gate (run as step 1 every time the executor returns).** Run:
   ```
   grep -rn --include='*.ts' '💎 Built using \[Cyboflow\]' main/src/
   ```
   At task start this returns 4 matches (shellEscape.ts, ipc/file.ts ×2, worktreeManager.ts). At task end it must return exactly 1 match — in `main/src/utils/commitFooter.ts`.

2. **Create `main/src/utils/commitFooter.ts`** (new file):
   ```typescript
   /**
    * Returns the Cyboflow commit-message footer when enabled, or an empty
    * string when disabled. Callers concatenate the result onto the user's
    * commit message; the canonical pattern is:
    *
    *   const footer = buildCommitFooter(enableCyboflowFooter);
    *   const fullMessage = footer ? `${message}\n\n${footer}` : message;
    *
    * Centralizing the literal here means future rebrand/attribution edits
    * touch exactly one site instead of four.
    */
   export function buildCommitFooter(enableCyboflowFooter: boolean): string {
     if (!enableCyboflowFooter) return '';
     return `💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)

   Co-Authored-By: Cyboflow <hello@cyboflow.com>`;
   }
   ```
   Contract: returns the footer body only (no leading blank-line separator). Callers add the `\n\n` between the user message and the footer to preserve the existing wire format. Returning empty-string-on-disabled keeps the calling code symmetrical (no `if/else` branches around the helper call).

3. **Rewrite `main/src/utils/shellEscape.ts` lines 19-35** — replace the inline footer with a helper call:
   ```typescript
   import { buildCommitFooter } from './commitFooter';

   /**
    * Build a safe git commit command with proper escaping
    * @param message The commit message
    * @param enableCyboflowFooter If true (default), add the Cyboflow footer
    */
   export function buildGitCommitCommand(message: string, enableCyboflowFooter: boolean = true): string {
     const footer = buildCommitFooter(enableCyboflowFooter);
     const fullMessage = footer ? `${message}\n\n${footer}` : message;
     const escapedMessage = escapeShellArg(fullMessage);
     return `git commit -m ${escapedMessage}`;
   }
   ```
   Net diff: -7 lines inline → +3 lines (import + helper call + concatenation).

4. **Rewrite `main/src/ipc/file.ts` lines 232-318** — both the initial-commit branch and the retry-branch construct the message identically. Extract a local helper inside the file scope to dedupe, then use it in both places:
   - Add at the top of the file (or just inside the IPC handler): `import { buildCommitFooter } from '../utils/commitFooter';`
   - **Optional local helper** (recommended): inside the handler function, factor out:
     ```typescript
     const buildMessageFromRequest = (msg: string, enabled: boolean): string => {
       const footer = buildCommitFooter(enabled);
       return footer ? `${msg}\n\n${footer}` : msg;
     };
     ```
   - **Initial branch (L237-245)** becomes:
     ```typescript
     const config = configManager.getConfig();
     const enableCyboflowFooter = config?.enableCyboflowFooter !== false;
     const commitMessage = buildMessageFromRequest(request.message, enableCyboflowFooter);
     ```
   - **Retry branch (L274-283)** becomes the symmetric same three lines using `request.message` (the retry uses the same source message).
   - Both branches still write to a tmpfile (`cyboflow-commit-…txt`) via `fs.writeFile` and invoke `git commit -F`; that part is unchanged.

5. **Rewrite `main/src/services/worktreeManager.ts` lines 614-636** — replace the inline footer construction:
   - Add `import { buildCommitFooter } from '../utils/commitFooter';` at the top of the file (alongside other utils imports).
   - L620-629 becomes:
     ```typescript
     const config = this.configManager?.getConfig();
     const enableCyboflowFooter = config?.enableCyboflowFooter !== false;
     const footer = buildCommitFooter(enableCyboflowFooter);
     const fullMessage = footer ? `${commitMessage}\n\n${footer}` : commitMessage;
     const escapedMessage = fullMessage.replace(/"/g, '\\"');
     command = `git commit -m "${escapedMessage}"`;
     ```
   - Net diff: -7 inline-footer lines, +3 helper-call lines.

6. **`main/src/services/commitManager.ts` is read-only for this task.** Both call sites (L102-105 and L211-212) already route through `buildGitCommitCommand` from `shellEscape.ts`. Once step 3 updates that helper to call `buildCommitFooter` internally, both commitManager sites pick up the change for free. **Verification:** after step 3 lands, `grep -n '💎 Built using' main/src/services/commitManager.ts` returns 0 matches (the file never had the inline footer — it always delegated). No edits to commitManager.ts.

7. **Create `main/src/utils/commitFooter.test.ts`** (new file):
   ```typescript
   import { describe, it, expect } from 'vitest';
   import { buildCommitFooter } from './commitFooter';

   describe('buildCommitFooter', () => {
     it('returns the canonical Cyboflow footer when enabled', () => {
       const footer = buildCommitFooter(true);
       expect(footer).toContain('💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)');
       expect(footer).toContain('Co-Authored-By: Cyboflow <hello@cyboflow.com>');
       // exact byte-level match to prevent silent format drift
       expect(footer).toBe(
         '💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)\n\nCo-Authored-By: Cyboflow <hello@cyboflow.com>'
       );
     });

     it('returns empty string when disabled', () => {
       expect(buildCommitFooter(false)).toBe('');
     });
   });
   ```

8. **Re-run sweep grep from step 1.** Expected: exactly 1 match in `main/src/utils/commitFooter.ts`. Zero matches in any other file.

9. **Run `pnpm --filter main typecheck` and `pnpm --filter main test`.** Both must exit 0.

## Acceptance Criteria

See frontmatter. Compound rule: the footer literal exists in exactly one source file, and all four prior duplicate blocks are gone.

## Test Strategy

See frontmatter `test_strategy.targets`. Two unit cases in `main/src/utils/commitFooter.test.ts`. The byte-level exact-match assertion in the enabled-case prevents silent rebrand drift (e.g., someone "fixing" the URL or changing the gem emoji and not noticing it diverges from existing git history).

## Hardest Decision

Whether to also extract a `buildCommitMessage(request, config)` helper to dedupe the ~30-line near-identical retry branch in `ipc/file.ts:268-308`. **Decision: partial — extract a *local* helper inside the IPC handler scope, not a separate module.** The two branches share the message-building logic (3 lines) but diverge in pre-commit error handling, tmpfile cleanup, and post-commit git-status refresh — extracting the full branch into a separate module would force a large parameterization (passing in error-handling callbacks, git-status manager refs, etc.) for marginal duplication savings. The local arrow function `buildMessageFromRequest` in step 4 captures the truly-shared logic (3 lines) without bleeding into the divergent error paths.

## Rejected Alternatives

- **Inline the helper as `buildCommitFooter` directly inside `shellEscape.ts` (no new file).** Rejected: `shellEscape.ts` is about shell-arg escaping; the commit footer is unrelated. A dedicated file keeps each module's responsibility focused.
- **Make `buildCommitFooter` return the full message including the user's input.** Rejected: would require passing both `message` and `enableCyboflowFooter`, making the helper less reusable and less testable. The current contract (returns footer body only, caller concatenates) is more orthogonal.
- **Extract a `buildCommitMessageFromConfig(message, configManager)` that internally reads the config flag.** Rejected: hides the config dependency from the call site, making test stubbing harder. Explicit boolean param is more transparent.

## Lowest Confidence Area

The `ipc/file.ts` refactor (step 4). The initial-commit branch and retry-branch diverge subtly after the message construction — initial branch's `fs.writeFile` uses `cyboflow-commit-${Date.now()}.txt`; retry branch uses `cyboflow-commit-retry-${Date.now()}.txt`. The shared local helper extracts only the message-string construction; the tmpfile creation, git-commit invocation, and cleanup paths remain duplicated by design (they have small but real differences). A more ambitious refactor would extract a `commitWithRetry` helper, but that's a separate-PR-sized change and outside this task's scope. If the executor finds the divergence too small to justify keeping both branches, they may consolidate further — but the AC only requires the footer-literal dedup, not the broader retry-path dedup.
