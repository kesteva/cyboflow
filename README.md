# Cyboflow

Cyboflow is a macOS desktop app that concentrates tool-use approvals from parallel Claude Code SoloFlow workflows into a single keyboard-driven cross-workflow review queue.

## What it does

When you run SoloFlow orchestration across several git worktrees simultaneously, every Claude Code session that needs to execute a shell command, read a file outside its sandbox, or apply a patch pauses and sends a permission request. Without Cyboflow, those requests queue silently inside each worktree and you must context-switch between terminals to approve or reject them. Cyboflow aggregates all pending approvals into one place so a single `y` or `n` keypress moves the right session forward.

The app manages the full lifecycle: it creates and tears down worktrees, maintains a SQLite-backed run history across restarts, streams live terminal output with syntax highlighting, and surfaces a side-by-side diff for every change set before you approve it. All sessions and their approval state survive an app restart.

## Quick Start

Download `Cyboflow-1.0.0-macOS-universal.dmg` from the GitHub Releases page (<v1.0.0 release link — populated at release time>). Drag the Cyboflow app to `/Applications`. On first launch, add a project (any local git repo), select a SoloFlow workflow, and start a run. Incoming Claude Code approval requests appear in the review queue on the right; press `y` to approve or `n` to reject.

### Requirements

- macOS 13 Ventura or later
- [Claude Code](https://claude.ai/code) installed and authenticated
- [SoloFlow](https://github.com/stravu/soloflow) (or a compatible workflow runner) installed in your project

## Provenance

Cyboflow is a fork of [stravu/crystal](https://github.com/stravu/crystal) pinned at commit `7a5ee427b0f3595db69e237eda1718c87215ad97`. Crystal provides six of Cyboflow's eight required primitives — PTY management, git worktrees, SQLite persistence, macOS packaging, the permission bridge, and zombie-process detection — in production-tested form. Cyboflow adds the cross-workflow review queue, the typed stream parser, and the CyboflowMcpServer outbound bridge.

The fork was taken from Crystal `0.3.5` (Crystal's final public tag) before the Crystal project was renamed to Nimbalyst and placed on a different license and product footing.

See [docs/PROVENANCE.md](docs/PROVENANCE.md) for the full lineage and audit trail.

## License

Cyboflow is licensed under the MIT License (see [LICENSE](LICENSE)). This inherits Crystal's pre-Nimbalyst-rename MIT posture.

### Do not merge from Nimbalyst

Crystal was renamed to Nimbalyst in early 2026. The rename coincided with a license and scope shift; Nimbalyst is a different product on a different license footing. Merging changes from the Nimbalyst codebase risks AGPL or other non-MIT contamination of this repository. **Do not** apply patches, cherry-picks, or merges from the Nimbalyst repository (https://github.com/Nimbalyst/nimbalyst). If a bug surfaces in Cyboflow that was independently fixed in Nimbalyst, reproduce the fix from first principles or from Cyboflow-side analysis.

See [docs/PROVENANCE.md](docs/PROVENANCE.md) for the full rationale.

## Development

See [CLAUDE.md](CLAUDE.md) for the codebase tour and common commands. See [.soloflow/](.soloflow/) for the active roadmap, ideas, and plans.

```bash
pnpm run setup         # One-time setup (install, build, rebuild native modules)
pnpm dev               # Run in development mode (Electron + frontend)
pnpm build:main        # Build main process only
pnpm typecheck         # Type checking across all workspaces
pnpm lint              # Linting across all workspaces
```

## Attribution

Forked from [Crystal](https://github.com/stravu/crystal) by Stravu. Crystal is Copyright (c) Stravu. Claude is a trademark of Anthropic, PBC. Cyboflow is not affiliated with, endorsed by, or sponsored by Anthropic.
