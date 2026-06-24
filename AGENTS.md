# Repository Guidelines

## Project Structure & Module Organization
- Root `pnpm` workspace with packages: `main/` (Electron main process, TypeScript), `frontend/` (React + Vite), `shared/` (shared types), and `tests/` (Playwright E2E).
- Key paths: `main/src/{services,ipc,utils}/`, `frontend/src/{components,hooks,stores,utils}/`, `main/assets/`, `scripts/`.
- Build artifacts: `frontend/dist/`, `main/dist/`, packaged output `dist-electron/`.

## Build, Test, and Development Commands
- Dev app: `pnpm dev` (spawns frontend + Electron).
- Build all: `pnpm build` (frontend, main, then electron package).
- Package (examples): `pnpm build:mac`, `pnpm build:mac:arm64` (macOS-only; no Linux/Windows targets).
- Lint: `pnpm lint`; Type-check: `pnpm typecheck` (runs per package).
- **Code-change gate: `pnpm test:unit`** (main + frontend vitest + schema parity + build scripts). Use this to verify changes.
- E2E (`pnpm test:e2e`, `pnpm test:ui`): currently non-functional headless (renderer needs the Electron preload) — treat failures as environmental, not a gate. See `CLAUDE.md`.
- Main unit tests (if added): `pnpm --filter main test`, coverage: `pnpm --filter main run test:coverage`.

## Coding Style & Naming Conventions
- Use TypeScript throughout; follow ESLint configs in `frontend/eslint.config.js` and `main/eslint.config.js`.
- Indentation 2 spaces; prefer explicit types at module boundaries.
- Naming: `camelCase` for variables/functions, `PascalCase` for React components/types, `kebab-case` for filenames (React files may match component name).
- Run `pnpm lint && pnpm typecheck` before sending PRs.

## Testing Guidelines
- Run `pnpm test:unit` as the verifier gate for any code change (see `CLAUDE.md` for why E2E is not the gate).
- For backend logic in `main/`, use Vitest colocated under `main/src/**/__tests__` or `*.spec.ts`; frontend likewise.
- E2E tests live in `tests/*.spec.ts` (Playwright) but the suite hangs headless until the config is reworked to `_electron.launch()`.

## Commit & Pull Request Guidelines
- Commits: present tense, focused, reference issues (e.g., "Fix session diff flicker, closes #123").
- PRs must include: clear description, linked issues, testing notes; screenshots/GIFs for UI changes.

## Security & Configuration Tips
- Node >= `22.14`; `pnpm` >= `8`. Use `pnpm` only.
- Secrets via `.env` (dotenv) for local dev; never commit secrets.
- To avoid clobbering local data when hacking on Cyboflow with Cyboflow: `CYBOFLOW_DIR=~/.cyboflow_test pnpm dev`.

## Agent Notes (for automation)
- Keep changes minimal and scoped; prefer small patches.
- Update docs alongside code; do not alter build targets without discussion.
- Use repository scripts (pnpm) and keep formatting consistent with existing files.
- Always review the root `CLAUDE.md` before beginning any work. 
- Scan the repository for every `CLAUDE.md`, and when working in a folder or any of its subfolders that has one, read and follow that file too.
