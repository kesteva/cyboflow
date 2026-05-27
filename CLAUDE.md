# cyboflow

cyboflow is an Electron desktop app for running multiple AI coding assistants in parallel against the same project, isolated via git worktrees. It is a fork of [Crystal](https://github.com/stravu/crystal) (`stravu/crystal@0.3.5`) currently being narrowed and rebuilt — see `docs/cyboflow_system_design.md` for the target scope and `docs/ARCHITECTURE.md` for the current component layout.

## Reference Docs

Load these before doing non-trivial work; they own the details so this file can stay short:

- `docs/ARCHITECTURE.md` — live component breakdown, dependency stack, data model, IPC contract.
- `docs/CODE-PATTERNS.md` — canonical patterns (task queue, shared utilities, `@cyboflow-hidden` template).
- `docs/cyboflow_system_design.md` — product spec, scope decisions, extension points.
- `docs/crystal-legacy/` — historical Crystal docs preserved for reference (CLI tool integration guides, troubleshooting).
- `docs/signing/APPLE_DEVELOPER_SETUP.md` — Apple signing env-var contract and provisioning steps. Load before any build, packaging, or release task.
- `docs/VISUAL-VERIFICATION-SETUP.md` — Electron visual-verification contract (visual_web non-functional; visual_macos via Peekaboo; two macOS permissions).

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
pnpm test:e2e          # Playwright E2E (requires display + Electron preload — NOT a code-change AC gate; see below)
pnpm test:unit         # Unit chain — main + frontend vitest, schema parity, build scripts (use this as the verifier AC gate)
pnpm electron:rebuild  # Fix better-sqlite3 NODE_MODULE_VERSION errors after Node/Electron upgrades
pnpm rebuild better-sqlite3   # Targeted reverse fix: `pnpm dev` postinstall rebuilds for Electron ABI (NMV 136); run this before `pnpm --filter main test` to restore host Node ABI (NMV 127)
```

Platform packaging (`pnpm build:mac:arm64`, `pnpm build:linux`, etc.) — see `package.json` `scripts`.

Workspace `"test"` scripts that participate in a root multi-tier chain (e.g. `pnpm run test:unit`) MUST be one-shot — use `"vitest run"`, never bare `"vitest"`. Bare `vitest` defaults to watch mode in a TTY and hangs the chain locally (CI escapes only because stdout is not a TTY). Put watch mode on a separate `"test:watch"` key.

`pnpm test:e2e` runs Playwright against `http://localhost:4521`, which cannot bootstrap without the Electron `preload`-injected `electronTRPC` (same root cause as the `visual_web` non-functionality below). Specs that wait on `[data-testid="settings-button"]` hang and the suite fails consistently in headless verifier environments. Verifiers MUST use `pnpm test:unit` (or per-workspace `pnpm --filter main test` + `pnpm --filter frontend test`) as the code-change AC gate; treat `pnpm test:e2e` failures as environmental until the Playwright config is reworked to use `_electron.launch()`.

Visual verification of any frontend UI change requires `pnpm dev` (full Electron). The Vite renderer at `http://localhost:4521` cannot bootstrap standalone — it depends on `preload`-injected `electronTRPC` and will error without the main process. For headless validation when capture is unavailable, read `cyboflow-frontend-debug.log` (see below).

The `visual_web` / Playwright MCP path is NON-FUNCTIONAL here (renderer cannot bootstrap without Electron `preload`). Use `visual_macos` via Peekaboo MCP with `pnpm dev` running. Both Screen Recording AND Accessibility grants must be held by the **MCP host process binary** (not only Cyboflow.app or Warp) — if `mcp__peekaboo__image` reports declined TCCs while `server_status` shows grants present, run the TCC.db host-process diagnostic in `docs/VISUAL-VERIFICATION-SETUP.md` (recurring failure across SPRINT-031..SPRINT-039).

## Frontend/Backend Debug Logs (dev mode)

In `pnpm dev`, the app writes `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` to the project root. Both are truncated on each dev launch, so they reflect only the most recent user session. Read these (preferably from a sub-agent) instead of asking the user to paste console output. Production builds do not write these files.

## TypeScript Rules

The `any` type is forbidden. ESLint rule `@typescript-eslint/no-explicit-any` is set to `error` and CI enforces it. Use `unknown` (with type guards) or narrow generics instead.

**IPC response types:** `IPCResponse<T>` callers must pass an explicit `T` — never rely on the default. The wrapper in `frontend/src/types/electron.d.ts` / `frontend/src/utils/api.ts` defaults `T = unknown`, which forces narrowing of `result.data` and catches field renames. Audit untyped sites: `grep -rnE "IPCResponse[^<A-Za-z]" frontend/src`.

Never declare a local `interface IPCResponse<T>` or inline `{ success; data?; error? }` shape in frontend code — import from `frontend/src/utils/api.ts`. Audit: `grep -rn "interface IPCResponse" frontend/src` should return zero hits outside `utils/api.ts` and `types/electron.d.ts`. `main/src/preload.ts` currently keeps its own `IPCResponse` declaration plus many bare `Promise<IPCResponse>` sites — include `grep -n "Promise<IPCResponse>" main/src/preload.ts` in any audit pass until `shared/types/ipc.ts` lands.

**IPC handler ↔ declared `T` parity:** the `T` in `IPCResponse<T>` declared in `frontend/src/types/electron.d.ts` and `frontend/src/utils/api.ts` MUST match the shape the matching `main/src/ipc/*` handler actually returns at runtime — not a legacy or aspirational type. A mismatched `T` forces `as unknown as X` double-casts in every consumer and hides handler shape changes from TypeScript (FIND-SPRINT-024-4: `getJsonMessages` declared `ClaudeJsonMessage[]` while the handler returned `UnifiedMessage[]`, causing TASK-637 to silently drop all output). When changing an IPC handler's return shape, grep the channel name across `frontend/src/types/electron.d.ts`, `frontend/src/utils/api.ts`, and the handler file in the same pass.

**IPC request-shape parity (mirror of the above on the request side):** request interfaces sent frontend → main (e.g. `CreateSessionRequest`, currently dual-declared in `main/src/types/session.ts` and `frontend/src/types/session.ts`) MUST be kept in sync. A field the server reads but the client can never send silently falls back to defaults — the request-direction twin of FIND-SPRINT-024-4 (FIND-SPRINT-037-5: `branchName` added to main only; `quickSession` dead on both sides). On any IPC touch, grep the request interface name across both `*/src/types/` and verify field parity. Prefer promoting to `shared/types/ipc.ts` over maintaining a dual declaration.

**Optional `logger?` on observability classes must be passed, not omitted.** Constructors that accept `logger?: Pick<ILogger, ...>` (e.g. `TypedEventNarrowing`, `RawEventsSink`, `MessageProjection`) gate every diagnostic on `this.logger?.…` — omitting the argument silently turns the whole class into a no-op for observability. This is the same silent-drop pattern as FIND-SPRINT-024-4 and FIND-SPRINT-033-6. Pass a logger from the enclosing scope; if the surrounding type uses a different logger surface (e.g. orchestrator `LoggerLike` has no `verbose`), adapt at the call site (e.g. `{ verbose: (m) => logger.debug(m) }`). Audit on touch (production code only — tests intentionally exercise the no-logger path): `grep -rn "new TypedEventNarrowing()" main/src --exclude-dir=__tests__` must return 0 matches.

**tRPC subscription `onData` payload type must come from `AppRouter` inference — never a local mirror or `(evt: unknown)` + runtime shape guard.** Write `onData: (event) => …` and let the tRPC client infer the payload from the router. A locally-declared interface (e.g. a `WorkflowStepTransitionEvent` copy in the renderer) or an `unknown`-typed arg with a hand-rolled `'runId' in evt` guard defeats inference and silently accepts stale shapes after the router output changes — same silent-drift class as the `IPCResponse<T>` parity rule above. Caught in TASK-768 / commit `f6240a6`. Audit: `grep -rnE "onData: \(evt: unknown\)|onData: \(event:" frontend/src` — each production hit is a candidate for inference (test files intentionally fake the shape and are exempt).

## localStorage Key Migrations

Use `frontend/src/utils/migrateLocalStorageKey.ts` for any localStorage key rename — never write ad-hoc `getItem`/`setItem` rename logic. See `docs/CODE-PATTERNS.md` for the mount-only call contract and the `console.ts` anti-pattern.
