# cyboflow agent guide

Shared engineering guidance for **every** agent working in this repo, regardless of runtime.
`CLAUDE.md` (Claude) imports this file; `AGENTS.md` (Codex, OMP, pi, anything else) points here.
Those two files carry only runtime-specific notes — this guide is the canonical shared truth,
and nothing in them overrides it.

cyboflow is a self-contained Electron desktop app for running AI coding flows in parallel
against the same project, isolated via git worktrees. It ships five user-facing built-in
flows — **Launch**, **Planner**, **Sprint**, **Compound**, and **Ship** — whose prompt bodies
live in `main/src/orchestrator/workflows/*.md`. It is a fork of
[Crystal](https://github.com/stravu/crystal) (tag `0.3.5`), heavily narrowed and rebuilt;
`docs/ARCHITECTURE.md` describes what exists today.

**Precedence:** when you run as a cyboflow flow subagent, your step's instructions define what
YOU are responsible for and outrank the general advice here on scope. Concretely: this guide
names the repo's final gate, but if your step says to run only the tests covering your files
and never the full suite, obey the step.

## Two layers: running INSIDE cyboflow vs. working ON cyboflow

Agents in this repo usually run *inside* a cyboflow session while editing cyboflow's *source
code* (dogfooding). Keep the layers separate:

- **Default stance: you are working ON the codebase.** Words like "task", "idea", "run",
  "sprint", "finding" refer to product concepts (code, schema, features) unless the user
  clearly means their live backlog.
- **The `cyboflow_*` MCP tools operate the LIVE app instance hosting you** — they write real
  rows to the user's actual backlog/review-queue database; there is no test fixture behind
  them. Call them only when the user explicitly asks to touch the backlog. NEVER call them to
  test or debug entity-model / MCP / router code — use `pnpm test:unit` and the fake-SDK
  harness instead.
- Env vars like `CYBOFLOW_RUN_ID` just mean you are hosted by the app; they don't change how
  you treat the repo. If a request is genuinely ambiguous between layers ("create a task for
  X"), ask instead of guessing.

## Reference docs (load on demand)

Full index: `docs/README.md`. The load-bearing ones:

- `docs/ARCHITECTURE.md` — components, data model, IPC contract, dual-substrate seam + warm
  SDK sessions, build/test mechanics.
- `docs/CODE-PATTERNS.md` — canonical patterns: entity-write chokepoints, IPC type-parity
  rules, `@cyboflow-hidden`, localStorage key migrations, test conventions.
- `docs/cyboflow_system_design.md` — the MVP-era product spec and scope decisions
  (historical; where it disagrees with `docs/ARCHITECTURE.md`, the latter wins).
- `docs/RELEASE-RUNBOOK.md` + `docs/signing/APPLE_DEVELOPER_SETUP.md` — load before any
  build, packaging, or release task.
- `docs/UPDATES.md` — the R2 update channel, feed mechanics, and per-variant data-dir
  resolution (`~/.cyboflow*`).
- `docs/VISUAL-VERIFICATION-SETUP.md` — how to see/drive the UI (CDP attach on :9223 is the
  primary path; Peekaboo is the fallback, with TCC diagnostics).
- `docs/SHELL-LAYOUT.md` — the renderer shell: column geometry, navigation state, and which
  component owns each surface (cited from `App.tsx` / `navigationStore.ts`).
- `docs/PERFORMANCE.md` — the CPU/memory harness (`pnpm dev:perf`,
  `scripts/profile-electron.mjs`), baselines, and the measurement traps (main-process timer
  wakeups cost more than their callbacks; dev-mode renderer profiles are inflated by
  `jsxDEV`).
- `docs/BACKUP-RESTORE.md` — daily `sessions.db` snapshots, the `raw_events` shard archive,
  lineages, and the restore procedure. Read before touching a backup: a daily backup alone
  has an EMPTY `raw_events`.
- `docs/PROVENANCE.md` — fork lineage.
- `docs/crystal-legacy/` and `docs/workflows-future/` — historical reference, not current
  truth.

## Gotchas

- ALL backlog-entity writes go through the router chokepoints (`TaskChangeRouter.applyChange`,
  `ReviewItemRouter`) — nothing UPDATEs `ideas`/`epics`/`tasks`/`review_items` directly; the
  one sanctioned exception is the synchronous folded-gate co-write in `reviewItemListing.ts`
  (see `docs/CODE-PATTERNS.md`). The product's flow agents write entities via the
  `cyboflow_*` MCP tools, never markdown state files — that describes the built-in flows, not
  you (see "Two layers").
- `any` is forbidden (`@typescript-eslint/no-explicit-any` = `error`, CI-enforced). Type
  declarations that drift across an IPC/tRPC boundary silently drop fields instead of failing
  the build — read `docs/CODE-PATTERNS.md` → "IPC / type-parity rules" before touching any
  IPC surface.
- `@cyboflow-hidden` marks intentionally unreachable code: do NOT delete it, and do NOT add
  the marker to actively-called code (template and examples in `docs/CODE-PATTERNS.md`).
- localStorage key renames go through `frontend/src/utils/migrateLocalStorageKey.ts` — never
  ad-hoc `getItem`/`setItem` logic.
- Directory-scoped rules live in nested `AGENTS.md` files — currently
  `main/src/database/migrations/` (numbering, idempotence, schema sync) and
  `main/src/services/panels/` (substrate seam, integration-test requirement). Claude and
  Codex auto-load them; other runtimes must read them before editing there.

## Common commands

```bash
pnpm dev               # Electron dev (run `pnpm build:main` at least once first)
pnpm dev:perf          # dev + main-process perf tracer/timer census + --inspect (docs/PERFORMANCE.md)
pnpm typecheck && pnpm lint
pnpm test:unit         # THE headless AC gate — for a SETTLED tree, not per-change (see below)
pnpm test:integration  # Mocked-SDK itest suite (required for panels/claude changes)
pnpm test:e2e          # Built-bundle Playwright; needs a real display. The minimal
                       # smoke tier (test:ci:minimal) IS blocking: PR CI + release gate
pnpm test:gate         # Day-gate integration; needs `claude` on PATH — manual only
node scripts/ensure-sqlite-abi.mjs <host|electron>   # better-sqlite3 ABI (normally automatic)
```

**better-sqlite3 ABI.** Since better-sqlite3 v13 (the Electron 44 upgrade) the addon is
N-API: one prebuild loads under both host Node/vitest (NMV 127) and Electron (NMV 149), so
there is normally nothing to flip. `test:unit` / `test:integration` / `test:gate` and
`pnpm dev` still run `scripts/ensure-sqlite-abi.mjs` as a cheap guard — a no-op on the
prebuild, a cached-copy swap only if a compiled `build/Release` artifact is ever present. If
vitest dies on `NODE_MODULE_VERSION`, run `node scripts/ensure-sqlite-abi.mjs host`; add
`--check <target>` to diagnose without mutating anything. If it dies on an **arch** mismatch
in `pty.node` after an x64 packaging build, run
`pnpm rebuild @homebridge/node-pty-prebuilt-multiarch`. Details: `docs/ARCHITECTURE.md` →
"The better-sqlite3 ABI ping-pong".

**Which tests to run when.** `pnpm test:unit` is the *final* gate, not the per-change gate.
**Inside a sprint/ship lane** (an implement / write-tests / task-verify subagent) run only
the tests covering your files — `cd main && npx vitest run <paths>` — never the full suite:
lanes share ONE worktree, so a full-suite run there also executes siblings' half-finished
uncommitted edits, making failures noise and a green result meaningless. The full suite is
`sprint-verify`'s job, once, over the settled tree. Prefer `npx vitest run` inside a package
over `pnpm --filter` — filter recursion has broken bin PATH resolution in this repo. Detail:
`docs/ARCHITECTURE.md` → "Build & Run".

Full test-tier and ABI mechanics: `docs/ARCHITECTURE.md` → "Build & Run".
Packaging/releases: `docs/RELEASE-RUNBOOK.md` (per-arch DMGs — `build:mac:universal`
currently fails).

## Conventions

- `pnpm` only (Node ≥ 22.14, pnpm ≥ 8). Secrets via `.env` for local dev; never commit them.
- Commits: present tense, focused, one concern per commit. PRs: clear description, linked
  issues, testing notes; screenshots/GIFs for UI changes.
- Do not alter build targets (package.json build scripts, electron-builder config) without
  discussion.
- To avoid clobbering local data when hacking on cyboflow with cyboflow:
  `CYBOFLOW_DIR=~/.cyboflow_test pnpm dev`.

## Seeing the UI + debug logs

Frontend verification requires `pnpm dev` (full Electron) — the Vite renderer at `:4521`
cannot bootstrap standalone (it needs preload-injected `electronTRPC`); see
`docs/VISUAL-VERIFICATION-SETUP.md`. In dev mode the app writes
`cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` at the project root (truncated
on each launch) — read those instead of asking the user to paste console output.
