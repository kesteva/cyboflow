---
id: TASK-001
idea: IDEA-001
status: in-flight
created: "2026-05-11T00:00:00Z"
files_owned:
  - main/src/ipc/codexPanel.ts
  - main/src/ipc/baseAIPanelHandler.ts
  - main/src/ipc/index.ts
  - main/src/ipc/panels.ts
  - main/src/ipc/session.ts
  - main/src/services/panels/codex/codexManager.ts
  - main/src/services/panels/codex/codexManager.test.ts
  - main/src/services/panels/codex/codexPanelManager.ts
  - main/src/services/panels/codex/CODEX_CONFIG.md
  - main/src/services/panels/ai/AbstractAIPanelManager.ts
  - main/src/services/sessionManager.ts
  - main/src/services/configManager.ts
  - main/src/services/taskQueue.ts
  - main/src/database/database.ts
  - main/src/database/models.ts
  - main/src/events.ts
  - main/src/preload.ts
  - main/src/types/config.ts
  - main/src/types/session.ts
  - main/src/utils/nodeFinder.ts
  - main/src/utils/toolFormatter.ts
  - shared/types/aiPanelConfig.ts
  - shared/types/models.ts
  - shared/types/panels.ts
  - frontend/src/components/CreateSessionButton.tsx
  - frontend/src/components/CreateSessionDialog.tsx
  - frontend/src/components/dialog/CodexConfig.tsx
  - frontend/src/components/DraggableProjectTreeView.tsx
  - frontend/src/components/SessionView.tsx
  - frontend/src/components/panels/PanelContainer.tsx
  - frontend/src/components/panels/PanelTabBar.tsx
  - frontend/src/components/panels/ai/MessagesView.tsx
  - frontend/src/components/panels/ai/RichOutputView.tsx
  - frontend/src/components/panels/ai/transformers/MessageTransformer.ts
  - frontend/src/components/panels/ai/transformers/CodexMessageTransformer.ts
  - frontend/src/components/panels/claude/RichOutputWithSidebar.tsx
  - frontend/src/components/panels/cli/CliPanelFactory.tsx
  - frontend/src/components/panels/codex/CodexDebugStateView.tsx
  - frontend/src/components/panels/codex/CodexInputPanel.tsx
  - frontend/src/components/panels/codex/CodexInputPanelRefactored.tsx
  - frontend/src/components/panels/codex/CodexInputPanelStyled.tsx
  - frontend/src/components/panels/codex/CodexInputPanelWithHook.tsx
  - frontend/src/components/panels/codex/CodexPanel.tsx
  - frontend/src/components/panels/codex/CodexStatsView.tsx
  - frontend/src/hooks/useAIInputPanel.ts
  - frontend/src/hooks/useCodexPanel.ts
  - frontend/src/stores/sessionPreferencesStore.ts
  - frontend/src/types/config.ts
  - frontend/src/types/electron.d.ts
  - frontend/src/types/session.ts
  - frontend/src/utils/api.ts
  - package.json
files_readonly:
  - main/src/services/panels/cli/AbstractCliManager.ts
  - main/src/services/panels/claude/claudeCodeManager.ts
  - main/src/services/cliManagerFactory.ts
  - main/src/services/cliToolRegistry.ts
  - docs/cyboflow_system_design.md
  - .soloflow/active/research/ROADMAP-001-research-architecture.md
acceptance_criteria:
  - criterion: "Codex backend code is fully removed: no `codex/` directory, no `codexPanel.ts`, no `CodexMessageTransformer.ts`, no `useCodexPanel.ts`"
    verification: "Run `test ! -d main/src/services/panels/codex && test ! -d frontend/src/components/panels/codex && test ! -f main/src/ipc/codexPanel.ts && test ! -f frontend/src/hooks/useCodexPanel.ts` — all five conditions return exit 0"
  - criterion: No live source code references the `codex` tool type after deletion
    verification: "`grep -rn --include='*.ts' --include='*.tsx' -E '[\"'\\''](codex)[\"'\\'']' main/src/ frontend/src/ shared/` returns zero matches (excluding `.backup` files, tests already deleted, comments documenting the removal)"
  - criterion: "`openai` package is removed from `package.json` dependencies"
    verification: "`node -e \"const p=require('./package.json'); process.exit(p.dependencies.openai === undefined ? 0 : 1)\"` returns exit 0"
  - criterion: "`@anthropic-ai/sdk` is removed from `package.json` dependencies (only used by WorktreeNameGenerator — but if Codex deletion removes it first that's also acceptable; if not, TASK-002 will remove it)"
    verification: "(Informational — actual removal verified by TASK-002.) `grep -n '@anthropic-ai/sdk' package.json` may still match — not a failure for THIS task."
  - criterion: "ToolPanelType union no longer contains `'codex'`"
    verification: "`grep -n \"ToolPanelType = \" shared/types/panels.ts` shows the union without `'codex'`"
  - criterion: Session creation tool selector defaults to Claude only with no Codex option visible
    verification: "`grep -n 'codex:' frontend/src/components/CreateSessionDialog.tsx` returns zero matches"
  - criterion: Codex panel IPC handler is not registered
    verification: "`grep -n 'registerCodexPanelHandlers\\|codexPanel' main/src/ipc/index.ts` returns zero matches"
  - criterion: "App still builds: `pnpm run build:main && pnpm run build:frontend` exits 0"
    verification: "Run `pnpm run build:main` and `pnpm run build:frontend` from repo root; both must complete with exit 0"
  - criterion: "App still typechecks: `pnpm typecheck` exits 0"
    verification: Run `pnpm typecheck` from repo root; exit code 0
depends_on: []
estimated_complexity: high
epic: crystal-cuts-and-rebrand
test_strategy:
  needed: false
  justification: This is a pure deletion task. The codebase has no tests for the deleted Codex paths (search confirmed `codexManager.test.ts` is the only Codex test file and it gets deleted with the rest). Existing Claude-path tests remain valid; the typecheck and build steps in acceptance criteria serve as the integration gate. Writing new tests would test removed code.
---
# Delete Codex/OpenAI Backend

## Objective

Crystal supported two AI agent backends (Claude Code and OpenAI Codex) via parallel manager classes, IPC handlers, UI components, and database fields. Cyboflow's product story is exclusively Claude Code's stream-json output and `--permission-prompt-tool` mechanism — the Codex paths are roughly 3,000 lines of misleading code that imply multi-provider support Cyboflow does not have. Delete the entire Codex surface (managers, IPC handlers, panels, frontend components, transformers, types, the `openai` npm dependency, and tool-type union members). Leave the `tool_type` column in `sessions` table intact for the schema-cleanup task (out of scope here); replace its three-value union with two values (`'claude' | 'none'`) at the TypeScript layer.

## Implementation Steps

1. **Run the completeness-gate sweep BEFORE editing**:
   