---
sprints: [SPRINT-001]
span_label: SPRINT-001
created: "2026-05-11T00:00:00.000Z"
counters_start:
  ideas: 0
summary:
  cleanups: 9
  backlog_tasks: 3
  claude_md: 2
  soloflow_improvements: 0
---

# Compound Proposal — SPRINT-001

SPRINT-001 landed six tasks that deleted ~9,700 lines of Crystal-era code (Codex/OpenAI backend, Bull queue, Linux/Windows platform branches, multi-panel UI surface) and rebranded the app identity to Cyboflow. The sprint produced 16 findings; one is `status: resolved` (FIND-SPRINT-001-6). The remaining 15 open findings are triaged below into three buckets. No stuck reports; no human-review-queue items.

---

## A. Clean-up items (execute now)

### A1. Trim stale Codex fields from `SessionInfoData` interface
- **Summary:** Remove five Codex-only fields from the `SessionInfoData` interface whose permissive index signature silently hides them from type errors.
- **Source-Sprint:** SPRINT-001
- **Rationale:** TASK-001 deleted all Codex code paths, but `SessionInfoData` in `frontend/src/components/panels/ai/transformers/MessageTransformer.ts` still declares `modelProvider`, `approvalPolicy`, `sandboxMode`, `resumeSessionId`, `isResume` — none of which `ClaudeMessageTransformer` ever populates. The `[key: string]: unknown` index signature suppresses any TypeScript error, meaning the interface now misrepresents actual runtime shape.
- **Blast radius:** One file (`MessageTransformer.ts`), one interface, 5 field deletions. Risk: trivial — `pnpm typecheck` will catch any accidental consumer.
- **Source:** FIND-SPRINT-001-2 (TASK-001 code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/components/panels/ai/transformers/MessageTransformer.ts
  interface SessionInfoData {
    initialPrompt?: string;
    claudeCommand?: string;
    worktreePath?: string;
    model?: string;
    permissionMode?: string;
    timestamp?: string;
  - modelProvider?: string;
  - approvalPolicy?: string;
  - sandboxMode?: string;
  - resumeSessionId?: string;
  - isResume?: boolean;
  - [key: string]: unknown;
  }
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across `frontend/src`, `main/src`, and `shared` shows the five Codex-only fields on `SessionInfoData` have zero consumers — the only other occurrences are inside an unrelated `InputOptions` interface in `AbstractInputPanel.tsx` and a distinct `resumeSessionId` field on `cliPanels.ts`, neither of which type-overlaps with `SessionInfoData` (used only by `MessageTransformer.ts` itself).

---

### A2. Add `@cyboflow-hidden` header to `CommitMessageDialog.tsx`
- **Summary:** Add a top-of-file `@cyboflow-hidden` comment to the unreachable `CommitMessageDialog` component for parity with the annotation pattern used in `worktreeManager.ts`.
- **Source-Sprint:** SPRINT-001
- **Rationale:** TASK-004 disconnected `<CommitMessageDialog />` from `SessionView.tsx` and added `@cyboflow-hidden` markers at the former import and render sites, and annotated the backend methods in `worktreeManager.ts:472`. The component file itself has no such annotation. A future agent grepping for active components will hit it without context.
- **Blast radius:** One file (`frontend/src/components/session/CommitMessageDialog.tsx`), comment insertion only. Risk: trivial.
- **Source:** FIND-SPRINT-001-3 (TASK-004 code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/components/session/CommitMessageDialog.tsx  (top of file, before any imports)
  + // @cyboflow-hidden: This dialog is unreachable in cyboflow v1. The rebase/squash UI
  + // entry points that triggered it were removed in TASK-004. Re-enable by re-adding
  + // <CommitMessageDialog /> JSX in SessionView.tsx and restoring the branchActions entries.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `SessionView.tsx:14` and `:510` already carry `@cyboflow-hidden` markers at the import and render sites, and `worktreeManager.ts:472` carries the method-group marker — the dialog file is the only artifact in the chain missing the header, matching the proposal's parity rationale exactly.

---

### A3. Add `@cyboflow-hidden` annotation to dead handler group in `useSessionView.ts`
- **Summary:** Annotate the four preserved-but-disconnected rebase/squash handlers in `useSessionView.ts` with a `@cyboflow-hidden` block comment matching the pattern in `worktreeManager.ts`.
- **Source-Sprint:** SPRINT-001
- **Rationale:** TASK-004 preserved `handleRebaseMainIntoWorktree`, `handleSquashAndRebaseToMain`, `performSquashWithCommitMessage`, `performSquashWithCommitMessageAndArchive` and their related state as per plan AC#4, but did not annotate them. The backend analogue at `worktreeManager.ts:472` got the annotation; the hook should match for consistency. Without it, future agents may try to decipher why these handlers exist but are never called.
- **Blast radius:** One file (`frontend/src/hooks/useSessionView.ts`), comment insertion around line 1329. Risk: trivial.
- **Source:** FIND-SPRINT-001-4 (TASK-004 code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/hooks/useSessionView.ts  ~line 1329
  + // @cyboflow-hidden: The four handlers below (handleRebaseMainIntoWorktree,
  + // handleSquashAndRebaseToMain, performSquashWithCommitMessage,
  + // performSquashWithCommitMessageAndArchive) and their related state are preserved
  + // per TASK-004 plan AC#4 but are not wired to any UI entry point in cyboflow v1.
  + // Re-enable by restoring branchActions entries in SessionView.tsx.
  const handleRebaseMainIntoWorktree = ...
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** `useSessionView.ts:1329` confirmed as the location of `handleRebaseMainIntoWorktree`, with no `@cyboflow-hidden` marker present — adding the comment block matches the established pattern at `worktreeManager.ts:472` and `SessionView.tsx:14` and prevents future agents from interpreting the disconnected handlers as live code.

---

### A4. Delete orphaned `AIPanelConfigFactory` class from `shared/types/aiPanelConfig.ts`
- **Summary:** Delete the 11-line `AIPanelConfigFactory` class (lines 47–57) from `shared/types/aiPanelConfig.ts` — it has zero consumers after TASK-001 removed the Codex sibling factories.
- **Source-Sprint:** SPRINT-001
- **Rationale:** The sprint-code-reviewer confirmed via grep that `AIPanelConfigFactory` and `createClaudeConfig` appear only at their declaration site. The four interfaces above it (`AIPanelConfig`, `StartPanelConfig`, `ContinuePanelConfig`, `AIPanelState`) are still actively used and must be kept.
- **Blast radius:** One file, 11 lines removed. Risk: trivial — `pnpm typecheck` will catch any missed consumer.
- **Source:** FIND-SPRINT-001-12 (sprint-code-reviewer)
- **Proposed change:**
  ```diff
  // shared/types/aiPanelConfig.ts  lines 47-57
  - export class AIPanelConfigFactory {
  -   static createClaudeConfig(...): StartPanelConfig { ... }
  - }
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Repo-wide grep for `AIPanelConfigFactory|createClaudeConfig` returns only the declaration at `shared/types/aiPanelConfig.ts:47` plus its compiled `main/dist/` mirror — zero source consumers — and the four interfaces above it remain in active use, so the 11-line deletion is exactly scoped.

---

### A5. Delete `openaiApiKey` from main process config types
- **Summary:** Remove the two `openaiApiKey?: string` field declarations in `main/src/types/config.ts` that have zero consumers after the Codex/OpenAI deletion in TASK-001.
- **Source-Sprint:** SPRINT-001
- **Rationale:** `AppConfig.openaiApiKey` (line 4) and `UpdateConfigRequest.openaiApiKey` (line 67) survive TASK-001 scope-limiting. The field is harmless at runtime (config manager spreads JSON) but the type surface falsely implies the app accepts and uses an OpenAI key.
- **Blast radius:** One file, 2 field deletions. Risk: trivial — `pnpm typecheck` confirms no consumers.
- **Source:** FIND-SPRINT-001-14 (sprint-code-reviewer)
- **Proposed change:**
  ```diff
  // main/src/types/config.ts line 4
  - openaiApiKey?: string;
  
  // main/src/types/config.ts line 67
  - openaiApiKey?: string;
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep across `main/src` and `frontend/src` returns only the two declaration lines at `main/src/types/config.ts:4` and `:67` — zero consumers anywhere in the repo, so the deletion is risk-free and `pnpm typecheck` is the only check needed.

---

### A6. Delete `.backup` files from the git-tracked source tree
- **Summary:** Remove two stale Crystal-era `.backup` files (`claudeCodeManager.ts.backup`, `ClaudePanel.tsx.backup`) from the git-tracked source tree and add `*.backup` to `.gitignore`.
- **Source-Sprint:** SPRINT-001
- **Rationale:** Both files predate SPRINT-001 (present in baseline commit `7a5ee42`) and are never imported. They inflate `git ls-files` results and grep noise, and keep deprecated Crystal-era code committed. TASK-006 extensively modified the live `claudeCodeManager.ts` sibling without addressing the backup, compounding the staleness. The sprint-code-reviewer estimated 60KB+ deletion with zero behavior change.
- **Blast radius:** Two file deletions + one line added to `.gitignore`. Risk: trivial (nothing imports `.backup` files — confirming grep returns zero hits is the only check needed).
- **Source:** FIND-SPRINT-001-16 (sprint-code-reviewer)
- **Proposed change:**
  ```
  git rm main/src/services/panels/claude/claudeCodeManager.ts.backup
  git rm frontend/src/components/panels/claude/ClaudePanel.tsx.backup
  echo "*.backup" >> .gitignore
  git add .gitignore
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Both `.backup` files confirmed present in the working tree (`claudeCodeManager.ts.backup` 60 KB, `ClaudePanel.tsx.backup` 5 KB) and grep for their filenames in `*.ts`/`*.tsx`/`*.json` returns zero hits, so the deletion has no behavior risk and the `*.backup` gitignore entry is a one-line preventative.

---

### A7. Rename `handlePanelCreate` in `ProjectView.tsx` to eliminate naming collision with `handlePanelCreated`
- **Summary:** Rename the `handlePanelCreate` callback in `ProjectView.tsx` to `ensureClaudePanel` (or equivalent) to eliminate the readability hazard with the `handlePanelCreated` IPC event listener in the same file.
- **Source-Sprint:** SPRINT-001
- **Rationale:** After TASK-005, `handlePanelCreate` in `ProjectView.tsx` is called exclusively as `handlePanelCreate('claude')` (two call sites: `handleGitPull` and `handleGitPush` fallback). The function's `(type: ToolPanelType)` signature promises generality it no longer has, and the name differs from the `panel:created` subscriber `handlePanelCreated` by one trailing `d` — a future maintainer reading the file will likely confuse the two. Narrowing the name and signature also allows the `ToolPanelType` import (line 9) to be dropped. Relates to FIND-SPRINT-001-15, which proposes the same rename as part of tightening the callback signature.
- **Blast radius:** One file (`ProjectView.tsx`), rename + signature narrowing + drop one import. Risk: low — contained to that file, TypeScript will surface any missed call site.
- **Source:** FIND-SPRINT-001-7 (TASK-005 code-reviewer), FIND-SPRINT-001-15 (sprint-code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/components/ProjectView.tsx
  - import { ToolPanelType } from '../../../shared/types/panels';  // line 9, drop if no other use
  
  - const handlePanelCreate = useCallback(async (type: ToolPanelType) => {
  + const ensureClaudePanel = useCallback(async () => {
      // body unchanged — only ever called with 'claude'
  -   await panelApi.createPanel({ sessionId: mainRepoSessionId, type });
  +   await panelApi.createPanel({ sessionId: mainRepoSessionId, type: 'claude' });
    }, [...]);
  
  // at call sites (~lines 182, 193):
  - handlePanelCreate('claude')
  + ensureClaudePanel()
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep confirms `ProjectView.tsx:158` declares `handlePanelCreate`, lines `:182` and `:193` are its only two call sites (both `handlePanelCreate('claude')` fallbacks), and `:263` declares the near-identical `handlePanelCreated` IPC subscriber — the collision is real and contained to one file, and narrowing the signature drops the `ToolPanelType` import at `:9`.

---

### A8. Fix three user-visible "Crystal" headings in Sidebar, Welcome, and AnalyticsConsentDialog
- **Summary:** Replace the literal "Crystal" text in three top-level UI headings and their associated `alt` attributes with "Cyboflow" to complete the user-visible rebrand.
- **Source-Sprint:** SPRINT-001
- **Rationale:** TASK-006 rebranded `appId`, `productName`, `AboutDialog`, and `README`, but three always-visible screens still display "Crystal": `Sidebar.tsx:110` (`<h1>Crystal</h1>`), `Welcome.tsx:52` (`<h1>Welcome to Crystal</h1>`), `AnalyticsConsentDialog.tsx:81` (`<h1>Help Improve Crystal</h1>`). These are the first text users see on every launch. The sprint-code-reviewer flagged this as distinct from the deferred logo-asset swap (FIND-SPRINT-001-11) — the headings can be fixed independently without resolving the `crystal-logo.svg` asset question.
- **Blast radius:** Three files, text substitutions only. Risk: trivial.
- **Source:** FIND-SPRINT-001-13 (sprint-code-reviewer)
- **Proposed change:**
  ```diff
  // frontend/src/components/Sidebar.tsx ~line 109-110
  - <img src={crystalLogo} alt="Crystal" ... />
  - <h1 ...>Crystal</h1>
  + <img src={crystalLogo} alt="Cyboflow" ... />
  + <h1 ...>Cyboflow</h1>
  
  // frontend/src/components/Welcome.tsx ~line 50-52
  - <img ... alt="Crystal" />
  - <h1>Welcome to Crystal</h1>
  + <img ... alt="Cyboflow" />
  + <h1>Welcome to Cyboflow</h1>
  
  // frontend/src/components/AnalyticsConsentDialog.tsx ~line 80-81
  - <img ... alt="Crystal" />
  - <h1>Help Improve Crystal</h1>
  + <img ... alt="Cyboflow" />
  + <h1>Help Improve Cyboflow</h1>
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** All three sites verified verbatim: `Sidebar.tsx:109-110` ships `alt="Crystal"` + `<h1>Crystal</h1>`, `Welcome.tsx:50-52` ships `alt="Crystal"` + `<h1>Welcome to Crystal</h1>`, `AnalyticsConsentDialog.tsx:80-81` ships `alt="Crystal"` + `<h1>Help Improve Crystal</h1>` — these are always-visible UI strings that complete the user-facing rebrand started by TASK-006 and are independent of the larger logo-asset question covered by B3.

---

### A9. Flatten orphaned bare block-scopes and remove stale platform comments left by TASK-003
- **Summary:** Flatten three bare `{ ... }` block-scopes left over from TASK-003's `if/else` collapse and rewrite four stale comments that still reference Linux/Windows; also remove or document the orphaned `get-platform` IPC handler.
- **Source-Sprint:** SPRINT-001
- **Rationale:** TASK-003 correctly deleted the Linux/Windows arms of platform conditionals, but the macOS arm's braces were left as bare block-scopes in `shellPath.ts:73-172`, `runCommandManager.ts:297-350`, and `AbstractCliManager.ts:855-902`. Separately, stale comments in `AbstractCliManager.ts:531`, `logsManager.ts:227-230`, and `sessionManager.ts:1370-1371` still describe Linux/Windows behavior that no longer exists. The `get-platform` IPC handler (`main/src/ipc/app.ts:12-14`) plus its preload binding (`preload.ts:181`) and frontend type (`electron.d.ts:37`) are dead — `grep` for `electronAPI.getPlatform` in `frontend/src` returns zero hits after `Settings.tsx` was cleaned in TASK-003.
- **Blast radius:** Six files; cosmetic deindent + comment rewrites + optional dead-code removal. Risk: low — no behavior change; `pnpm typecheck` verifies type declaration removal.
- **Source:** FIND-SPRINT-001-9 (TASK-003 code-reviewer)
- **Proposed change:**
  Prose description (exact line numbers are confirmed in findings):
  1. In `shellPath.ts`, `runCommandManager.ts`, `AbstractCliManager.ts` (three sites): remove the wrapping bare braces and dedent the body so the macOS code reads as the direct, unconditional path.
  2. In `AbstractCliManager.ts:531`: rewrite comment to remove "includes Linux-specific paths" reference.
  3. In `logsManager.ts:227-230` and `sessionManager.ts:1370-1371`: rewrite JSDoc to drop "taskkill on Windows" / "process tree (Windows)" descriptions.
  4. Delete `get-platform` handler from `main/src/ipc/app.ts:12-14`, its `getPlatform` preload binding (`preload.ts:181`), and its type declaration (`frontend/src/types/electron.d.ts:37`). Verify grep returns zero consumers before deleting.

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Verified `shellPath.ts:73` has a bare `{` block opening at the cited line, and `electronAPI.getPlatform` returns zero hits in `frontend/src` confirming `get-platform`/`getPlatform`/`electron.d.ts:37` are dead — bundle covers six files of cosmetic deindent plus a three-site dead-IPC removal, which is on the upper edge of clean-up scope but each step is independently low-risk and tightens grep noise for future readers.
- **Counterfactual:** If any of the six listed line ranges were already cleaned up since the finding was filed, the corresponding sub-step should be skipped at apply time; the executor should grep before each edit.

---

## B. Backlog tasks (refine into execution-ready plans)

### B1. Finish dependency cleanup: purge `bull`, `@types/bull`, `@anthropic-ai/sdk` from `main/package.json` and regenerate `pnpm-lock.yaml`
- **Summary:** Complete the package removal that TASK-002 started — delete three phantom deps from the workspace sub-package and regenerate the lockfile to eliminate ~50 MB of dead transitive installs from `node_modules` and reduce CI supply-chain exposure.
- **Source-Sprint:** SPRINT-001
- **Source:** FIND-SPRINT-001-5 (TASK-002 code-reviewer) and FIND-SPRINT-001-17 (sprint-code-reviewer)
- **Problem:** TASK-002 removed `bull`, `@types/bull`, and `@anthropic-ai/sdk` from the root `package.json` but did not touch `main/package.json` (the workspace sub-package), where all three are still declared (`bull@^4.16.3` line 24, `@types/bull@^4.10.0` line 35, `@anthropic-ai/sdk@^0.60.0` line 20). In a pnpm workspace the sub-package drives what actually gets installed for the main process — the root-only deletion was incomplete. Separately, `pnpm-lock.yaml` was never regenerated after TASK-001 (`openai` removed), TASK-002 (`bull`, `@anthropic-ai/sdk`), or TASK-006 (root `package.json` touched again), so the root importer block still declares `@anthropic-ai/sdk: specifier ^0.60.0`, `bull: specifier ^4.16.3`, and `openai: specifier ^5.1.1` as direct root dependencies. `pnpm install --frozen-lockfile` (used in CI) still installs all three packages and their transitive trees (~50+ MB). No code anywhere imports Bull or the Anthropic/OpenAI SDKs — confirmed by grep.
- **Proposed direction:** Create a single task that owns `main/package.json` and the lockfile. Steps: (1) delete `bull`, `@types/bull`, `@anthropic-ai/sdk` from `main/package.json` (lines 20, 24, 35); (2) run `pnpm install` from repo root to regenerate `pnpm-lock.yaml`; (3) verify with `grep -E "^  (bull|openai|@anthropic-ai/sdk):" pnpm-lock.yaml` returning zero hits; (4) run `pnpm run build:main && pnpm typecheck && pnpm lint` and confirm all pass; (5) commit `main/package.json` + `pnpm-lock.yaml` together. No code changes expected — this is purely a manifest + lockfile fix.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `main/package.json` still declares `@anthropic-ai/sdk` (line 20), `bull` (line 24), and `@types/bull` (line 35) while root `package.json` already has them removed — the workspace sub-package drives actual installs, so CI's `pnpm install --frozen-lockfile` keeps ~50 MB of phantom deps and the supply-chain surface they pull in; the proposed task is a small manifest+lockfile fix with zero code changes.

---

### B2. Collapse `AbstractAIPanelManager` into `ClaudePanelManager` and `BaseAIPanelHandler` into `ClaudePanelHandler`
- **Summary:** Eliminate two now-superfluous one-subclass abstractions (`AbstractAIPanelManager`, `BaseAIPanelHandler`) left over from the Crystal Claude+Codex split by inlining their logic into the single concrete subclass in each case.
- **Source-Sprint:** SPRINT-001
- **Source:** FIND-SPRINT-001-1 (TASK-001 code-reviewer)
- **Problem:** After TASK-001 deleted the Codex panel, `AbstractAIPanelManager` (`main/src/services/panels/ai/AbstractAIPanelManager.ts`) and `BaseAIPanelHandler` (`main/src/ipc/baseAIPanelHandler.ts`) each have exactly one concrete subclass: `ClaudePanelManager` and `ClaudePanelHandler` respectively. Unlike `AbstractCliManager` (explicitly preserved as a planned extension surface per `docs/cyboflow_system_design.md:64`), these AI-panel abstractions are not called out in the cyboflow architecture as future extension points. They are now pure indirection — every method call passes through an abstract class to reach one concrete class, with no polymorphism benefit. FIND-SPRINT-001-1 notes this should be evaluated after TASK-005 landed (which it now has), removing the multi-panel UI.
- **Proposed direction:** A refactor task that: (1) reads both abstract files and their subclasses to map the full inheritance surface; (2) moves all abstract method bodies and any state into `ClaudePanelManager` / `ClaudePanelHandler` respectively; (3) updates all import sites to point directly to the concrete classes; (4) deletes the two abstract files; (5) verifies `pnpm typecheck && pnpm run build:main` pass. The task should explicitly NOT touch `AbstractCliManager` — it is the documented extension surface and must be preserved. Acceptance criterion: `grep -r "AbstractAIPanelManager\|BaseAIPanelHandler" main/src` returns zero hits after the merge.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** Grep confirms exactly one concrete subclass each — `ClaudePanelManager extends AbstractAIPanelManager` (claudePanelManager.ts:14) and `ClaudePanelHandler extends BaseAIPanelHandler` (claudePanel.ts:11) — and `docs/cyboflow_system_design.md:64,118` explicitly preserves `AbstractCliManager` as an extension point but does not mention these two AI abstractions, making the collapse proportionate to the now-eliminated Crystal+Codex split.
- **Counterfactual:** If a future plan adds a second AI-panel subclass (e.g. a Gemini panel) before this task lands, the abstraction becomes load-bearing and the collapse should be cancelled.

---

### B3. Finish Crystal-string sweep: logs, localStorage keys, commit trailer, PostHog prefix, run-script defaults, logo asset
- **Summary:** Complete the Cyboflow rebrand by sweeping all remaining user-visible and analytics-visible "Crystal" strings that TASK-006 deferred or did not own — including log filenames, localStorage keys, git commit co-author trailer, PostHog distinctId prefix, `SetupTasksPanel` run-script default, and the `crystal-logo.svg` asset import.
- **Source-Sprint:** SPRINT-001
- **Source:** FIND-SPRINT-001-11 (TASK-006 code-reviewer) and FIND-SPRINT-001-13 (sprint-code-reviewer; the three `<h1>` headings can be batched here if A8 is not applied first, or this task can exclude them and treat A8 as prerequisite)
- **Problem:** TASK-006 completed the identity-layer rebrand (appId, productName, data dir, env var, AboutDialog, README) but explicitly deferred a cluster of Crystal strings outside its `files_owned`. The following surfaces are still Crystal-branded:
  - **Log filenames** (`main/src/utils/logger.ts:73,86,106`): `crystal-{date}.log`, `crystal-frontend-debug.log`, `crystal-backend-debug.log` — user-facing in `~/Library/Logs/` and in project root.
  - **Debug log filenames** (`main/src/index.ts:93-94,227,261,323,379,427,467`): same `crystal-*` names in debug output paths.
  - **Git commit co-author trailer** (`main/src/utils/shellEscape.ts:31`, `main/src/ipc/file.ts:245,248,283,286`, `main/src/services/worktreeManager.ts:629`): `Co-Authored-By: Crystal <crystal@stravu.com>` appears on every commit Cyboflow makes — externally visible in git history.
  - **localStorage keys** (`frontend/src/App.tsx:61`, `frontend/src/components/panels/editor/FileEditor.tsx:608`, and others): `crystal-sidebar-width`, `crystal.verboseLogging`, `crystal-file-tree-width`, `crystal-sidebar-collapsed-{id}` — persisted in users' browsers; renaming without a migration reads as preference loss.
  - **PostHog distinctId prefix** (`main/src/services/analyticsManager.ts:39`): `crystal_{uuid}` — bleeds Crystal-era identity into Cyboflow analytics. Renaming with a mapping table may be needed for telemetry continuity.
  - **`claudeCodeManager.ts:340`** user-facing error string: "Or set a custom Claude executable path in Crystal Settings" — wrong brand in an error message users will see.
  - **`SetupTasksPanel.tsx:81,90,459`**: hard-codes `./crystal-run.sh` as the run-script filename told to Claude.
  - **`crystal-logo.svg` asset** (`frontend/src/assets/`): still imported and rendered by `Sidebar.tsx`, `Welcome.tsx`, `AnalyticsConsentDialog.tsx` with `alt="Crystal"`.
  - **`--crystal-dir` CLI flag** (`main/src/index.ts:114-122`): kept as backward-compat alias while `CRYSTAL_DIR` env var was renamed without fallback — an inconsistent migration story that should be resolved (either document the asymmetry or rename the flag too).
  - **`crystal-base-mcp-{id}.json` filename** (`claudeCodeManager.ts:889`): MCP config file written to disk.
  - **`crystal_` analytics prefix and `"crystal"` in `analyticsManager.ts`** (multiple call sites).
  Note: FIND-SPRINT-001-13 (A8 above) covers the three `<h1>` text strings independently as a fast clean-up. This B3 task should either treat A8 as a prerequisite or include those files in `files_owned`.
- **Proposed direction:** Create a comprehensive follow-up task "Finish Crystal-string sweep" with `files_owned` covering all files listed above. The task plan should decide: (a) localStorage key migration strategy (read old key name on first access, write new key name, let old key expire); (b) PostHog ID continuity (whether a mapping is needed); (c) whether `--crystal-dir` CLI flag should be renamed to `--cyboflow-dir` or documented as a permanent backward-compat alias; (d) whether `crystal-logo.svg` is replaced with a Cyboflow asset or swapped for a text-only placeholder. The task should update `CLAUDE.md`'s debug-log filename guidance (`crystal-frontend-debug.log`, `crystal-backend-debug.log`) to reflect the renamed filenames after this change lands.
- **Scope:** medium

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep verifies every cited surface: `Co-Authored-By: Crystal` at `shellEscape.ts:31`, `file.ts:245/283`, `worktreeManager.ts:629` (externally visible in every commit), `crystal-sidebar-width` localStorage key at `App.tsx:61`, `crystal-logo.svg` import in three components, `--crystal-dir` CLI flag at `index.ts:113-118`, `./crystal-run.sh` defaults at `SetupTasksPanel.tsx:79-90,459`, and `crystal-base-mcp-${sessionId}.json` at `claudeCodeManager.ts:889` — all are user- or analytics-visible and the rebrand is genuinely half-done until they land.

---

### B4. Fix or delete `gitStatusManager.test.ts` — 19/23 tests fail against current implementation
- **Summary:** Rewrite or delete the `gitStatusManager.test.ts` suite, which has 19 of 23 tests failing due to the test file referencing private methods and internal state that no longer match the current `gitStatusManager` implementation.
- **Source-Sprint:** SPRINT-001
- **Source:** FIND-SPRINT-001-10 (TASK-006 executor)
- **Problem:** `main/src/services/__tests__/gitStatusManager.test.ts` has 19 of 23 tests failing with TypeErrors (`executeGitCommand is not a function`, `pollAllSessions does not exist`) and assertion errors (state always returns `conflict` instead of `clean`/`modified`/etc.). These failures pre-date SPRINT-001 — they exist in the Crystal baseline fork at commit `7a5ee42` — so no task in this sprint introduced them. The test file references private methods and internal state the current implementation no longer exposes. The failures are suppressed in CI coverage (they existed before the fork) but they constitute a false signal: the test suite appears to be exercising `gitStatusManager` when it is not.
- **Proposed direction:** A dedicated task that: (1) reads the current `gitStatusManager.ts` public API; (2) decides whether to rewrite the test file against the public interface or delete it (if the service is sufficiently gated by E2E Playwright tests, deletion is the lower-risk path); (3) if rewriting, covers the methods actually exported and verifiable without accessing private state; (4) verifies `pnpm test` runs clean after the change. The task plan should include a note about which Playwright test(s) cover the same behaviors, so the reviewer can assess coverage delta before approving deletion.
- **Scope:** small

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** medium
- **Reasoning:** The test file exists (`main/src/services/__tests__/gitStatusManager.test.ts`, 439 lines) and the finding's claim of pre-existing baseline failures is plausible given the file long-predates the fork; either rewriting against the public API or deleting outright is a proportionate small task and removes a false-signal in CI output.
- **Counterfactual:** If running `pnpm test` shows the suite passes after intervening fixes, the task is unnecessary — the executor should confirm the failure mode still reproduces before refactoring.

---

## C. CLAUDE.md / CODE-PATTERNS.md improvements (apply now)

### C1. Document the `@cyboflow-hidden` rule in CLAUDE.md
- **Summary:** Add a one-line `@cyboflow-hidden` rule to root CLAUDE.md so every agent knows to mark (not delete) preserved-but-disconnected code, with a pointer to the pattern template.
- **Source-Sprint:** SPRINT-001
- **Target file:** `CLAUDE.md`
- **Action:** insert-after "## Implementation Status: ✅ COMPLETE"
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  @@ ## Implementation Status: ✅ COMPLETE
  @@ ...existing content...
  +
  +## `@cyboflow-hidden` Convention
  +
  +Code that is intentionally unreachable in cyboflow v1 (but preserved from the Crystal baseline for future re-enablement) is marked with `@cyboflow-hidden`. Do NOT delete such code; do NOT add the marker to actively-called code. See `docs/CODE-PATTERNS.md` for the annotation template and canonical examples (`main/src/services/worktreeManager.ts:472`, `frontend/src/components/SessionView.tsx:14`).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep returns four active `@cyboflow-hidden` annotations across `main/src/services/worktreeManager.ts:472` and `frontend/src/components/SessionView.tsx:14/510` already, plus three more proposed in A2/A3 — the convention is live but undocumented in CLAUDE.md, and four findings in this sprint alone (FIND-2/3/4/11 and the multiple TASK done reports) flag preservation-vs-deletion as a recurring decision, easily clearing the "future agents will repeatedly need this" bar.

### C2. Add the `@cyboflow-hidden` annotation template to CODE-PATTERNS.md
- **Summary:** Add an annotation template (file-level and method-group-level) for `@cyboflow-hidden` to `docs/CODE-PATTERNS.md` so agents have a concrete pattern to copy.
- **Source-Sprint:** SPRINT-001
- **Target file:** `docs/CODE-PATTERNS.md`
- **Action:** append to "## Recurring Patterns"
- **Status:** ready
- **source_item:** C1
- **Diff:**
  ```diff
  @@ ## Recurring Patterns
  @@ ...existing entries...
  +
  +### `@cyboflow-hidden` annotation
  +
  +Mark preserved-but-disconnected code (kept for future re-enablement) at the top of the file (whole-component case) or immediately above the first function of the disconnected group (partial-file case). Always include a one-sentence re-enable hint pointing at the call site to restore.
  +
  +```
  +// @cyboflow-hidden: <what is unreachable> in cyboflow v1.
  +// Re-enable by <restoring specific call site or JSX usage>.
  +```
  +
  +- **Canonical examples:** `main/src/services/worktreeManager.ts:472` (method-group), `frontend/src/components/SessionView.tsx:14` (import-line)
  +- **Audit tool:** `grep -rn '@cyboflow-hidden' main/src frontend/src` lists all preserved-but-inactive surfaces.
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Verified `docs/CODE-PATTERNS.md` has a "## Recurring Patterns" section but no `@cyboflow-hidden` entry, while the pattern is already in active use at four call sites — pairs with C1 to make the convention discoverable and audit-able via the included grep one-liner.

### C3. Note `AbstractCliManager` is an extension point, not a collapse candidate
- **Summary:** Add a short note in root CLAUDE.md that `AbstractCliManager` is a load-bearing extension surface and must not be collapsed despite having one current subclass.
- **Source-Sprint:** SPRINT-001
- **Target file:** `CLAUDE.md`
- **Action:** insert-after "### Modular Architecture (Refactored)" section (within "## Critical Implementation Details")
- **Status:** ready
- **source_item:** C2
- **Diff:**
  ```diff
  @@ ## Critical Implementation Details
  @@ ### Modular Architecture (Refactored)
  @@ ...existing content...
  +
  +### Preserved Extension Points
  +
  +`AbstractCliManager` (`main/src/services/panels/cli/AbstractCliManager.ts`) is an intentional extension surface per `docs/cyboflow_system_design.md:64` — do NOT collapse it into its single concrete subclass (`ClaudeCodeManager`). It is designed to host additional CLI tool integrations in future sprints. Contrast with `AbstractAIPanelManager` / `BaseAIPanelHandler`, which ARE collapse candidates (Crystal-era Claude+Codex scaffolding).
  ```

### Skeptic Verdict
- **Verdict:** IMPLEMENT
- **Confidence:** high
- **Reasoning:** Grep of `docs/cyboflow_system_design.md` confirms two explicit "lift from Crystal" mentions of `AbstractCliManager` at lines 64 and 118 as planned extension infrastructure, and B2 in this very proposal targets the *other* one-subclass abstractions for collapse — without this note, a future agent applying B2's pattern is plausibly going to also attack `AbstractCliManager` on the same "single subclass" rationale and tear out a load-bearing extension point.

---

## Reconciled Findings (informational)

- FIND-SPRINT-001-6 — marked `status: resolved` in the findings file; confirmed resolved by TASK-005 (code-reviewer) per the done report at `.soloflow/archive/done/crystal-cuts-and-rebrand/TASK-005-done.md`. Skipped from triage.

## Suppressed — SoloFlow Defects

- FIND-SPRINT-001-6 (scope deviation: `files_readonly` vs acceptance criteria conflict) — the finding notes that future plans should not list a file as read-only when an acceptance criterion requires editing it, and that the plan template should validate `files_owned` covers every file named in acceptance criteria. This is a SoloFlow planner/plan-template defect, not a cyboflow project convention. Consider opening an issue or running `/soloflow:compound --tester` against this sprint in a SoloFlow-tester setup to surface it as a maintainer recommendation.
