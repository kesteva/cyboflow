---
sprint: SPRINT-001
findings_count:
  critical: 0
  important: 7
  minor: 9
---

# Sprint Code Review: SPRINT-001

## Scope
- Base: 7b56dc1d0d5f5930c533130a3af4c0d3ce218381
- Tasks reviewed: [TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006]
- Files changed: 93 (1,243 insertions, 9,719 deletions — net −8,476 LOC)
- Cross-task hotspots:
  - main/src/services/taskQueue.ts (TASK-002, TASK-003)
  - main/src/index.ts (TASK-002, TASK-003, TASK-006)
  - main/src/services/sessionManager.ts (TASK-001, TASK-003)
  - main/src/ipc/session.ts (TASK-001, TASK-002, TASK-006)
  - package.json (TASK-001, TASK-002, TASK-003, TASK-006)
  - main/src/services/panels/cli/AbstractCliManager.ts (TASK-003, TASK-001)
  - main/src/utils/nodeFinder.ts (TASK-001, TASK-003)
  - frontend/src/components/SessionView.tsx (TASK-004, TASK-005)
  - frontend/src/components/Help.tsx (TASK-004, TASK-006 implicitly via rebrand audit)
  - frontend/src/types/electron.d.ts (TASK-001, TASK-003)

## Findings queued

16 findings total in `.soloflow/active/findings/SPRINT-001-findings.md` (11 from per-task reviewers + 5 net-new cross-task findings appended by sprint-code-reviewer). Severity breakdown after this pass: critical=0, important=7 (medium), minor=9 (low).

### Important (medium severity)
- FIND-SPRINT-001-1 — AbstractAIPanelManager / BaseAIPanelHandler one-subclass abstraction (Codex deletion fallout)
- FIND-SPRINT-001-5 — main/package.json still declares bull / @types/bull / @anthropic-ai/sdk (phantom deps)
- FIND-SPRINT-001-8 — Linux/Windows branch residue in out-of-scope files (taskQueue.ts, claudeCodeManager.ts, analyticsManager.ts)
- FIND-SPRINT-001-10 — gitStatusManager.test.ts has 19/23 failing tests (pre-existing Crystal baseline rot)
- FIND-SPRINT-001-11 — Crystal-string sweep: logo asset, log filenames, commit trailer, localStorage keys, posthog distinctId, hardcoded run-script
- FIND-SPRINT-001-13 — User-visible `<h1>Crystal</h1>` / `Welcome to Crystal` text in Sidebar, Welcome, AnalyticsConsentDialog (new)
- FIND-SPRINT-001-17 — pnpm-lock.yaml root importer drift: still lists bull/openai/@anthropic-ai/sdk as direct deps after root package.json removed them (new)

### Minor (low severity)
- FIND-SPRINT-001-2 — SessionInfoData interface retains dead Codex-only fields
- FIND-SPRINT-001-3 — CommitMessageDialog.tsx lacks `@cyboflow-hidden` annotation
- FIND-SPRINT-001-4 — useSessionView.ts dead-but-exported rebase/squash handlers lack `@cyboflow-hidden` annotation
- FIND-SPRINT-001-6 — TASK-005 plan inconsistency (files_readonly vs AC) — resolved
- FIND-SPRINT-001-7 — ProjectView.tsx handlePanelCreate / handlePanelCreated naming collision
- FIND-SPRINT-001-9 — TASK-003 cosmetic residue (bare blocks, stale Linux/Windows comments, dead get-platform IPC)
- FIND-SPRINT-001-12 — AIPanelConfigFactory dead export in shared/types/aiPanelConfig.ts (new)
- FIND-SPRINT-001-14 — openaiApiKey?: string dead field in main/src/types/config.ts (new)
- FIND-SPRINT-001-15 — ProjectView.handlePanelCreate type signature wider than actual usage (only ever called with 'claude') (new)
- FIND-SPRINT-001-16 — Tracked .backup files in source tree (claudeCodeManager.ts.backup, ClaudePanel.tsx.backup) (new)

## Cross-task patterns observed

1. **Codex deletion (TASK-001) was thorough at the file level** but left small typed residue in non-owned files: `AIPanelConfigFactory.createClaudeConfig` class with zero callers (FIND-12), `openaiApiKey?` config field never read (FIND-14), and SessionInfoData transformer-interface fields (FIND-2). These all share the pattern of "config/type surface that referenced Codex without importing it".

2. **The `@cyboflow-hidden` marker convention is inconsistently applied** across the sprint. TASK-004 and TASK-005 both deferred dead UI behind this marker; TASK-004 added the annotation at one site (worktreeManager.ts) but missed the React component file and the four exported handlers in useSessionView.ts (FIND-3, FIND-4). Same convention, two tasks, inconsistent depth.

3. **Multi-step rebrand drift.** TASK-006 explicitly scoped a list of deferred `crystal-*` strings, but did not enumerate user-visible `<h1>` text content (FIND-13), the lockfile drift (FIND-17), or the openaiApiKey config-type leftover (FIND-14). Combined with FIND-11 (the originally documented sweep), this argues for one follow-up "crystal-string sweep finalization" task that owns all the surfaces in one shot rather than piecemeal.

4. **pnpm workspace dependency hygiene is split-brain.** Removing a package from the root `package.json` (TASK-002) without (a) regenerating `pnpm-lock.yaml` and (b) checking the workspace sub-package (`main/package.json`) leaves the dependency on disk. FIND-5 and FIND-17 are the same root cause applied to different parts of the manifest.
