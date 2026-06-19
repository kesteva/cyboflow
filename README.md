# Cyboflow

Cyboflow is a self-contained macOS desktop app designed to make it easier to build and run complex multi-agent workflows using Claude Code. 

## What it does

Cyboflow comes with five core features:
1. **Multi-agent workflows**: Cyboflow is designed to make it easier to run complex multi-step, multi-agent workflows including three natively included as well as a custom workflow and agent builder. 
2. **Centralized review queue**: Cyboflow has a built in central human review queue to make it easier to monitor activity across agents, grant approvals as needed, and triage any issues. 
3. **Analytics, insights, and observability**: Cyboflow tracks token usage, failure rates, errors, and bugs across workflow runs so you can iterate and improve on them over time
4. **Worktree isolated SDK or PTY session**: Every session runs in its own worktree and can be run via SDK (for a chat experience) or PTY (for an interactive terminal experience)
5. **Native task tracking**: Built into Cyboflow is a native task tracking module that lets you take ideas through clarification, extraction, execution and review. 

#### Multi-agent workflows
Cyboflow ships three flows out of the box:
- **Planner** turns a raw idea into a reviewed backlog: it captures the idea, optionally researches it, decomposes it into epics and tasks, and pauses at human approval gates. 
- **Sprint** executes the ready tasks — implement, test, review, verify — across isolated worktrees, optionally fanning a batch of tasks out across parallel subagents. 
- **Compound** mines completed work for cleanups, follow-up tasks, and codebase-doc improvements

Edit these workflows or build your own custom agents + workflows and get built in tracking. 

#### Centralized review queue
Cyboflow comes with a centralized human review queue. It shows you all your running agents across projects and surfaces the ones that need input. Input is categorized into one of three buckets:
- **Permission request**: the simplest kind of input, permission to perform a sensitive action. Depends on the permission mode you're using for each run, infrequent in auto but frequent in 'Allow Edits' and very frequent in 'Ask before edits'
- **Decisions**: agents that require you to make a specific decision (e.g. design direction, architecture). Still contained within the session but requires your input before proceeding.
- **Actions**: concrete steps you need to take that the agent can't (e.g. add an API key, run a migration, test something with a live device)

All inputs are categorized as blocking or non-blocking so you can focus on taking care of the blocking ones first.

#### Analytics, insights, and observability
Cyboflow comes with a centralized insights pane that includes:
- **Findings**: surfaced by agents during their work to be triaged for future improvements to the codebase, documentation, and workflows.
- **Usage**: View token usage and success rates by agent and workflow.
- **Code quality**: Issues that surface from in-workflow code-review, human review, or post-merge issues are all tagged to the specific workflows they came from so you can evaluate code quality alongside workflow cost + token efficiency.

#### Worktree isolated SDK or PTY sessions

Every session gets its own isolated worktree for parallel execution. Within these sessions you can run a workflow or just open a **quick session** to launch an ad-hoc Claude Code conversation in its own worktree. Every session runs on one of two substrates: the Claude **SDK** for a chat experience or an **interactive PTY** that streams a real terminal you can type into. 

## Quick Start

Download Cyboflow from https://www.cyboflow.com/download/ and then drag the Cyboflow app to `/Applications`. On first launch, add a project (any local git repo), pick a flow (or start a quick session), and go. Incoming approval requests, findings, and decisions appear in the review queue. After several runs, go to the insights queue to review insights from across those runs.

### Requirements

- macOS 13 Ventura or later
- [Claude Code](https://claude.ai/code) installed and authenticated

The Planner, Sprint, and Compound flows are built into the app — no external workflow runner needs to be installed in your project.

## Provenance

Cyboflow is a fork of [stravu/crystal](https://github.com/stravu/crystal) pinned at commit `7a5ee427b0f3595db69e237eda1718c87215ad97`. Crystal provides six of Cyboflow's eight required primitives — PTY management, git worktrees, SQLite persistence, macOS packaging, the permission bridge, and zombie-process detection — in production-tested form. Cyboflow adds the cross-workflow review queue, the typed stream parser, and the CyboflowMcpServer outbound bridge.

The fork was taken from Crystal `0.3.5` (Crystal's final public tag) before the Crystal project was renamed to Nimbalyst and put on a different product footing.

See [docs/PROVENANCE.md](docs/PROVENANCE.md) for the full lineage and audit trail.

## License

Cyboflow is licensed under the MIT License (see [LICENSE](LICENSE)), inheriting Crystal's MIT license. The LICENSE retains Stravu's original Crystal copyright alongside Cyboflow's, as MIT requires.

### Do not merge from Nimbalyst

Crystal was renamed to Nimbalyst in early 2026 and became a separate product with its own scope and direction. Nimbalyst is also MIT-licensed, but Cyboflow deliberately forked at Crystal `0.3.5` and has diverged substantially in scope and architecture. To keep a clean, auditable provenance and avoid importing decisions from a now-divergent codebase, **do not** apply patches, cherry-picks, or merges from the Nimbalyst repository (https://github.com/Nimbalyst/nimbalyst). If a bug surfaces in Cyboflow that was independently fixed in Nimbalyst, reproduce the fix from first principles or from Cyboflow-side analysis.

See [docs/PROVENANCE.md](docs/PROVENANCE.md) for the full rationale.

## Development

See [CLAUDE.md](CLAUDE.md) for the codebase tour and common commands. 

```bash
pnpm run setup         # One-time setup (install, build, rebuild native modules)
pnpm dev               # Run in development mode (Electron + frontend)
pnpm build:main        # Build main process only
pnpm typecheck         # Type checking across all workspaces
pnpm lint              # Linting across all workspaces
```

## Attribution

Forked from [Crystal](https://github.com/stravu/crystal) by Stravu. Crystal is Copyright (c) Stravu. Claude is a trademark of Anthropic, PBC. Cyboflow is not affiliated with, endorsed by, or sponsored by Anthropic.
