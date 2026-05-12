# Cyboflow

Cyboflow is a desktop application for managing multiple AI code assistant sessions (Claude Code) against a single repository using git worktrees. It provides a streamlined interface for running parallel AI sessions with isolated workspaces, enabling you to explore different approaches to the same problem simultaneously.

## About

Cyboflow is a focused fork of Crystal (by Stravu), stripped down and rebranded for the Cyboflow workflow. The upstream Crystal project was pinned at commit `7a5ee42` before diverging.

**Pinned Crystal commit:** `7a5ee42`

## Features

- **Multi-session support**: Run multiple Claude Code instances simultaneously
- **Git worktree isolation**: Each session runs in its own git worktree to prevent conflicts
- **Session persistence**: SQLite-backed session history across restarts
- **Real-time output streaming**: Live terminal output with syntax highlighting
- **Diff visualization**: View all changes with syntax highlighting
- **Project management**: Support for multiple projects with easy switching
- **Tool panel system**: Multiple terminal panels per session
- **Prompt history**: Full history of prompts with search and reuse

## Data Directory

Cyboflow stores all data (database, logs, sockets) in `~/.cyboflow/` by default.

To override: set the `CYBOFLOW_DIR` environment variable before launching.

## Development

```bash
pnpm run setup         # One-time setup (install, build, rebuild native modules)
pnpm dev               # Run in development mode (Electron + frontend)
pnpm build:main        # Build main process only
pnpm build:frontend    # Build frontend only
pnpm typecheck         # Type checking across all workspaces
pnpm lint              # Linting across all workspaces
```

## Building

```bash
pnpm build:mac         # Build for macOS (universal)
pnpm build:mac:arm64   # Build for macOS (Apple Silicon)
pnpm build:mac:x64     # Build for macOS (Intel)
```

## Testing

```bash
pnpm test              # Run Playwright E2E tests
pnpm test:ui           # Run tests with Playwright UI
```

## License

MIT — see [LICENSE](./LICENSE).

## Attribution

Forked from [Crystal](https://github.com/stravu/crystal) by Stravu. Crystal is Copyright (c) Stravu. Claude™ is a trademark of Anthropic, PBC. Cyboflow is not affiliated with, endorsed by, or sponsored by Anthropic.
