---
id: TASK-565
sprint: SPRINT-014
epic: crystal-cuts-and-rebrand
status: done
summary: "Extracted buildCommitFooter helper (commitFooter.ts) eliminating 4 hardcoded footer literals across shellEscape, ipc/file (×2), worktreeManager. Byte-level test guards against silent rebrand drift."
executor_loops: 1
code_review_rounds: 0
visual_mobile: skipped_user_preference
visual_web: skipped_user_preference
---

# TASK-565 — Done

## Outcome

New `main/src/utils/commitFooter.ts` exports `buildCommitFooter(enableCyboflowFooter: boolean): string`. Replaced 4 inline duplicate blocks in `main/src/utils/shellEscape.ts`, `main/src/ipc/file.ts` (initial + retry branches), `main/src/services/worktreeManager.ts`. The footer literal `💎 Built using [Cyboflow](https://github.com/cyboflow/cyboflow)\n\nCo-Authored-By: Cyboflow <hello@cyboflow.com>` now lives in exactly one source location plus one test assertion. `commitManager.ts` was correctly left untouched (delegates through shellEscape's `buildGitCommitCommand`).

New `main/src/utils/commitFooter.test.ts` with 2 cases: enabled returns canonical footer (byte-level `.toBe(...)` assertion to catch silent rebrand drift), disabled returns empty string.

## Verification

- Sweep grep: footer literal appears exactly once in `main/src` source (in `commitFooter.ts`).
- Main typecheck: exit 0.
- `commitFooter.test.ts`: 2/2 passing.
- Verifier round 1: NEEDS_CHANGES (test assertions too loose). Round 2: APPROVED after `563ad67` added byte-level `.toBe(...)`.
- Code reviewer CLEAN (2 minor findings queued).

## Findings filed

- FIND-SPRINT-014-5: helper parameter `enableCyboflowFooter` doesn't match callers' `enableCrystalFooter` (auto-resolves when TASK-561 lands)
- FIND-SPRINT-014-6: optional local `buildMessageFromRequest` helper in ipc/file.ts not extracted (plan-tagged optional)

## Commits

- `5b1a456` feat(TASK-565): extract buildCommitFooter helper to eliminate 4 hardcoded footer strings
- `563ad67` test(TASK-565): assert exact byte-level footer string to catch silent rebrand drift
