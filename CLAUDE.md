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

Code that is intentionally unreachable in cyboflow v1 is marked with `@cyboflow-hidden` — either Crystal-baseline code preserved for future re-enablement OR a forward-looking placeholder awaiting a later integration task. Do NOT delete such code; do NOT add the marker to actively-called code. See `docs/CODE-PATTERNS.md` for the annotation template and canonical examples in both categories.

## Preserved Extension Points

`AbstractCliManager` (`main/src/services/panels/cli/AbstractCliManager.ts`) is an intentional extension surface per `docs/cyboflow_system_design.md:64` — do NOT collapse it into its single concrete subclass (`ClaudeCodeManager`). It is designed to host additional CLI tool integrations in future sprints. Contrast with `AbstractAIPanelManager` / `BaseAIPanelHandler`, which ARE collapse candidates (Crystal-era Claude+Codex scaffolding).

## Common Commands

```bash
pnpm dev               # Electron dev (Vite renderer + Electron main)
pnpm build:main        # Compile main process (run at least once before `pnpm dev`)
pnpm typecheck         # Type-check all workspaces
pnpm lint              # Lint all workspaces
pnpm test              # Playwright E2E
pnpm electron:rebuild  # Fix better-sqlite3 NODE_MODULE_VERSION errors after Node/Electron upgrades
```

Platform packaging (`pnpm build:mac:arm64`, `pnpm build:linux`, etc.) — see `package.json` `scripts`.

Workspace `"test"` scripts that participate in a root multi-tier chain (e.g. `pnpm run test:unit`) MUST be one-shot — use `"vitest run"`, never bare `"vitest"`. Bare `vitest` defaults to watch mode in a TTY and hangs the chain locally (CI escapes only because stdout is not a TTY). Put watch mode on a separate `"test:watch"` key.

Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at `http://localhost:4521` cannot bootstrap standalone — it depends on `preload`-injected `electronTRPC` and will error without the main process. For headless validation when capture is unavailable, read `cyboflow-frontend-debug.log` (see below).

## Frontend/Backend Debug Logs (dev mode)

In `pnpm dev`, the app writes `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` to the project root. Both are truncated on each dev launch, so they reflect only the most recent user session. Read these (preferably from a sub-agent) instead of asking the user to paste console output. Production builds do not write these files.

## TypeScript Rules

The `any` type is forbidden. ESLint rule `@typescript-eslint/no-explicit-any` is set to `error` and CI enforces it. Use `unknown` (with type guards) or narrow generics instead.

**IPC response types:** `IPCResponse<T>` callers must pass an explicit `T` — never rely on the default. The wrapper in `frontend/src/types/electron.d.ts` / `frontend/src/utils/api.ts` defaults `T = unknown`, which forces narrowing of `result.data` and catches field renames. Audit untyped sites: `grep -rnE "IPCResponse[^<A-Za-z]" frontend/src`.

Never declare a local `interface IPCResponse<T>` or inline `{ success; data?; error? }` shape in frontend code — import from `frontend/src/utils/api.ts`. Audit: `grep -rn "interface IPCResponse" frontend/src` should return zero hits outside `utils/api.ts` and `types/electron.d.ts`. `main/src/preload.ts` currently keeps its own `IPCResponse` declaration plus many bare `Promise<IPCResponse>` sites — include `grep -n "Promise<IPCResponse>" main/src/preload.ts` in any audit pass until `shared/types/ipc.ts` lands.

## localStorage Key Migrations

Use `frontend/src/utils/migrateLocalStorageKey.ts` for any localStorage key rename — never write ad-hoc `getItem`/`setItem` rename logic. See `docs/CODE-PATTERNS.md` for the mount-only call contract and the `console.ts` anti-pattern.
