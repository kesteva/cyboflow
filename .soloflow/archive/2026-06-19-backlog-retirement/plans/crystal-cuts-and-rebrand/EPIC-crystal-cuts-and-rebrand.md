---
epic: crystal-cuts-and-rebrand
created: 2026-05-11T00:00:00Z
status: active
originating_ideas: [IDEA-001]
---

# Crystal Cuts and Rebrand

## Objective

Strip the inherited Crystal substrate down to the surface Cyboflow actually uses, fix the inherited blockers that would compound on top of new code (live Bull import, AI worktree naming API hop), and rebrand identity so signing/notarization can be set up against the real `com.cyboflow.app` appId. This is the first epic in the roadmap — nothing depends on prior work, but every subsequent epic (Apple signing, schema migration, stream parser, ApprovalRouter) builds on a coherent post-cuts codebase.

## Scope

- In scope:
  - Delete the Codex/OpenAI backend (managers, IPC handlers, panels, transformers, types, openai dependency)
  - Delete the live `Bull` import and the Bull branch in `taskQueue.ts`; remove `bull` from `package.json`
  - Delete `WorktreeNameGenerator` and its API-hop call site in `taskQueue.ts`; replace with deterministic local naming
  - Delete Linux/Windows-conditional code paths in PTY, filesystem, shell, packaging, and CI
  - Hide (NOT delete) `rebase`/`squash`/`merge` UI entry points; mark the underlying `WorktreeManager` methods with `@cyboflow-hidden` comment blocks
  - Delete multi-panel-per-session UI surfaces (add-panel dropdown, panel creation menus); preserve the underlying `tool_panels` table schema and `panelManager` service untouched
  - Rebrand: `appId` `com.cyboflow.app`, data dir `~/.cyboflow`, sockets at `~/.cyboflow/sockets/`, `productName` Cyboflow, placeholder icon, README with pinned Crystal commit
- Out of scope:
  - Renaming the permission bridge to `cyboflow-permissions` (handled by IDEA-007 / `approval-router-and-permission-fix` epic)
  - Apple Developer enrollment, hardenedRuntime flip, notarytool wiring (handled by `apple-signing-notarization-setup` epic)
  - Removing the `tool_panels` database table or the `panelManager` service — only UI surfaces are deleted
  - Refactoring `worktreeManager.ts` rebase/squash/merge methods — code stays intact, only call sites and UI buttons are hidden

## Success Signal

After this epic lands, the repo:
- builds and starts on macOS with `pnpm electron-dev`
- has no Codex or OpenAI code paths reachable (no `codex` panel type, no `openai` package, no `codexPanel` IPC)
- has no `bull` import or dependency, and `taskQueue.ts` uses only `SimpleQueue`
- generates worktree names deterministically without an Anthropic API call at session creation
- has no `linux`/`win32` platform branches in main process source (excluding tests/scripts that may keep cross-platform stubs for now)
- shows no rebase/squash/merge buttons in the worktree session UI, no "Add Tool" panel-creation dropdown
- has `appId: com.cyboflow.app`, `productName: Cyboflow`, data dir `~/.cyboflow`, socket path `~/.cyboflow/sockets/`
- `git grep -i 'import.*bull'` returns zero matches in `main/src/`
- `git grep "WorktreeNameGenerator"` returns zero matches in `main/src/`
