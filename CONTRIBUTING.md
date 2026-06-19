# Contributing to Cyboflow

Thank you for your interest in contributing to Cyboflow! We welcome contributions from the community and are excited to work with you.

If you have not contributed to this project in the past, do not submit substantial changes, they are likely to be ignored. If you have a larger change you'd like to see open an issue and I will review it for the backlog. Do not submit a change that you have not reviewed yourself. I don't know or trust your agents, if I'm integrating AI generated code it will be my own.


Cyboflow is a self-contained macOS desktop app for running AI coding flows in parallel across isolated git worktrees. It is a fork of [Crystal](https://github.com/stravu/crystal) by Stravu, now narrowed and rebuilt around its own native flows and review queue. See [README.md](README.md) for what it does and [docs/PROVENANCE.md](docs/PROVENANCE.md) for the fork lineage.

> **Do not** apply patches, cherry-picks, or merges from the Nimbalyst repository (the renamed successor to Crystal). Reproduce any needed fix from first principles on the Cyboflow side — see [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Right to Contribute this Code

- You represent and warrant that You are legally entitled to contribute the code you contribute to Cyboflow.
- You represent and warrant that each of Your Contributions is Your original creation, and that, to Your knowledge, none of Your Contributions infringe, violate, or misappropriate any third-party intellectual property or other proprietary rights.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork locally
3. Set up the development environment:
   ```bash
   pnpm run setup       # install, build main, rebuild native modules for the Electron ABI
   ```
4. Create a new branch for your feature or bug fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development Process

### Running in Development

```bash
pnpm dev               # Run the Electron app (Vite renderer + Electron main)
pnpm build:main        # Compile the main process (run at least once before pnpm dev)
pnpm typecheck         # Type-check all workspaces
pnpm lint              # Lint all workspaces
pnpm test:unit         # Unit chain — the code-change gate (see Testing below)
```

See [CLAUDE.md](CLAUDE.md) for the full command reference and codebase tour.

### Code Style

- TypeScript throughout. The `any` type is forbidden — `@typescript-eslint/no-explicit-any` is an error and CI enforces it. Use `unknown` with type guards or narrow generics.
- Code is formatted with Prettier and checked with ESLint.
- Follow the existing patterns documented in [docs/CODE-PATTERNS.md](docs/CODE-PATTERNS.md).

### Project Structure

```
cyboflow/
├── frontend/         # React renderer process
│   └── src/
│       ├── components/  # UI components
│       ├── hooks/       # Custom React hooks
│       ├── stores/      # Zustand state stores
│       └── utils/       # Utility functions
├── main/             # Electron main process
│   └── src/
│       ├── database/      # SQLite (better-sqlite3) + migrations
│       ├── orchestrator/  # Flow definitions, tRPC routers, MCP server
│       ├── services/      # Session, worktree, and CLI managers
│       └── utils/         # Utilities
└── shared/           # Shared types between processes
```

## Making Changes

### Before You Start

1. Check existing issues to avoid duplicates.
2. For significant changes, open an issue first to discuss.
3. Ensure your branch is up to date with `main`.

### Commit Guidelines

- Write clear, concise commit messages.
- Use conventional-commit prefixes: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`.
- Keep commits focused and atomic — one logical change per commit.
- Reference issues when applicable (`#123`).

Example:
```
feat: add color-coded session status indicators

- Add badges for session states with a running-state animation
- Update types for the new status field

Fixes #42
```

### Pull Request Process

1. Update documentation if needed (README, CLAUDE.md, or the docs/ references).
2. Add or update tests for new functionality.
3. Ensure the gate is green: `pnpm typecheck`, `pnpm lint`, and `pnpm test:unit`.
4. Submit a pull request with a clear title and description, links to related issues, and screenshots for UI changes.

## Testing

The code-change gate is `pnpm test:unit` — a one-shot chain that runs the main- and frontend-process Vitest suites plus schema-parity and build-script checks. Run it (or the per-workspace `pnpm --filter main test` / `pnpm --filter frontend test`) before opening a PR.

`pnpm test:e2e` (Playwright) currently cannot bootstrap in headless environments because the renderer depends on Electron's `preload`-injected tRPC bridge; treat its failures as environmental and do **not** use it as the gate. See [CLAUDE.md](CLAUDE.md) for details and for the native-module ABI note (`pnpm electron:rebuild`) if you hit `NODE_MODULE_VERSION` errors.

### Manual Testing

**IMPORTANT**: For UI and packaging changes, also test in the packaged DMG before submitting a PR — the packaged app often reveals issues that don't appear in development mode.

```bash
pnpm build:mac        # Build the universal macOS DMG (output in dist-electron/)
```

No Apple Developer certificates are required for a local build. `pnpm build:mac` runs `scripts/configure-build.js`, which detects the absence of signing credentials and emits an **unsigned** build config — the build still succeeds, it just isn't signed or notarized. macOS will quarantine an unsigned app on first launch, so open it with right-click → **Open** (or clear the quarantine flag: `xattr -dr com.apple.quarantine /Applications/Cyboflow.app`). Signed, notarized release builds require the Apple credentials documented in [docs/signing/APPLE_DEVELOPER_SETUP.md](docs/signing/APPLE_DEVELOPER_SETUP.md). The generated config is written to `build/electron-builder.generated.json` (git-ignored); the tracked `package.json` is never modified by the build.

Manual testing checklist:
- [ ] Create a project and start a flow (Planner / Sprint / Compound)
- [ ] Start a quick session and interact with the live terminal
- [ ] Approve/reject items in the review queue (`y` / `n`)
- [ ] Git operations (merge / PR / dismiss) work correctly
- [ ] UI is responsive
- [ ] Sessions, backlog, and review items persist after restart
- [ ] **DMG build works correctly** ⚠️

## Reporting Issues

When reporting issues, please include:
- Cyboflow version
- Operating system
- Steps to reproduce
- Expected vs. actual behavior
- Screenshots if applicable
- Relevant error messages (the dev build writes `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` to the project root)

## Feature Requests

We love hearing ideas for new features! When suggesting features:
- Explain the use case
- Describe the expected behavior
- Consider how it fits with existing features
- Be open to discussion and alternatives

## Code of Conduct

### Our Standards

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Accept constructive criticism gracefully
- Focus on what's best for the community
- Show empathy towards others

### Unacceptable Behavior

- Harassment or discrimination
- Trolling or insulting comments
- Public or private harassment
- Publishing others' private information
- Other unprofessional conduct

## Questions?

Feel free to:
- Open an issue for questions
- Join discussions in existing issues
- Reach out to the maintainer

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

Thank you for contributing to Cyboflow! 🎉
