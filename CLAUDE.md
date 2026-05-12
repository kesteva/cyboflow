# cyboflow

cyboflow is an Electron desktop app for running multiple AI coding assistants in parallel against the same project, isolated via git worktrees. It is a fork of [Crystal](https://github.com/stravu/crystal) (`stravu/crystal@0.3.5`) currently being narrowed and rebuilt — see `docs/cyboflow_system_design.md` for the target scope and `docs/ARCHITECTURE.md` for the current component layout.

## Reference Docs

Load these before doing non-trivial work; they own the details so this file can stay short:

- `docs/ARCHITECTURE.md` — live component breakdown, dependency stack, data model, IPC contract.
- `docs/CODE-PATTERNS.md` — canonical patterns (task queue, shared utilities, `@cyboflow-hidden` template).
- `docs/cyboflow_system_design.md` — product spec, scope decisions, extension points.
- `docs/crystal-legacy/` — historical Crystal docs preserved for reference (CLI tool integration guides, troubleshooting).
- `docs/signing/APPLE_DEVELOPER_SETUP.md` — Apple signing env-var contract and provisioning steps. Load before any build, packaging, or release task.

## `@cyboflow-hidden` Convention

Code that is intentionally unreachable in cyboflow v1 (but preserved from the Crystal baseline for future re-enablement) is marked with `@cyboflow-hidden`. Do NOT delete such code; do NOT add the marker to actively-called code. See `docs/CODE-PATTERNS.md` for the annotation template and canonical examples (`main/src/services/worktreeManager.ts:472`, `frontend/src/components/SessionView.tsx:14`).

## Preserved Extension Points

`AbstractCliManager` (`main/src/services/panels/cli/AbstractCliManager.ts`) is an intentional extension surface per `docs/cyboflow_system_design.md:64` — do NOT collapse it into its single concrete subclass (`ClaudeCodeManager`). It is designed to host additional CLI tool integrations in future sprints. Contrast with `AbstractAIPanelManager` / `BaseAIPanelHandler`, which ARE collapse candidates (Crystal-era Claude+Codex scaffolding).

## Common Commands

```bash
pnpm dev               # Electron dev (Vite renderer + Electron main)
pnpm build:main        # Compile main process (run at least once before `pnpm dev`)
pnpm typecheck         # Type-check all workspaces
pnpm lint              # Lint all workspaces
pnpm test              # Playwright E2E
```

Platform packaging (`pnpm build:mac:arm64`, `pnpm build:linux`, etc.) — see `package.json` `scripts`.

## Frontend/Backend Debug Logs (dev mode)

In `pnpm dev`, the app writes `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` to the project root. Both are truncated on each dev launch, so they reflect only the most recent user session. Read these (preferably from a sub-agent) instead of asking the user to paste console output. Production builds do not write these files.

## TypeScript Rules

The `any` type is forbidden. ESLint rule `@typescript-eslint/no-explicit-any` is set to `error` and CI enforces it. Use `unknown` (with type guards) or narrow generics instead.
