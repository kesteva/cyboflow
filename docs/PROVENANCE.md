# Cyboflow Provenance

## Fork

- **Upstream:** https://github.com/stravu/crystal
- **Fork commit:** `7a5ee427b0f3595db69e237eda1718c87215ad97`
- **Fork date:** 2026-05-11
- **Fork commit message:** `chore: fork stravu/crystal at HEAD as cyboflow baseline`
- **Crystal tag at fork:** `0.3.5` (Crystal's final public tag before the project was renamed to Nimbalyst)

To verify the fork point independently:

```bash
git log 7a5ee427b0f3595db69e237eda1718c87215ad97 --pretty=fuller
```

## License

Cyboflow is MIT-licensed, inheriting Crystal's pre-Nimbalyst MIT posture. See [/LICENSE](/LICENSE) for the canonical text. License compatibility notes for inherited dependencies are tracked in [/docs/crystal-legacy/LICENSE-COMPATIBILITY.md](/docs/crystal-legacy/LICENSE-COMPATIBILITY.md).

## Do not merge from Nimbalyst

Crystal was deprecated in early 2026 and replaced by a new product called Nimbalyst (https://github.com/Nimbalyst/nimbalyst). Nimbalyst is also MIT-licensed, so this is **not** a license-contamination concern — but it is a separate product on its own scope and direction, and Cyboflow has diverged substantially from the `0.3.5` fork point.

**The rule is absolute:** do not cherry-pick, rebase, or apply patches from https://github.com/Nimbalyst/nimbalyst into this repository. If a fix is needed that Nimbalyst happens to have implemented, reproduce the fix from first principles on the Cyboflow side.

**Rationale:** The goal is a clean, auditable provenance and a single coherent product direction. Cyboflow forked Crystal `0.3.5` deliberately and has narrowed and rebuilt large parts of it; importing commits from a now-divergent codebase would muddy that lineage and re-introduce decisions Cyboflow has intentionally moved away from. The safe posture is a hard no-merge boundary at the fork point — independent of license, which is MIT on both sides.

## What Cyboflow inherits from Crystal

Crystal `0.3.5` provides six of Cyboflow's eight required primitives in production-tested form:

1. **PTY management** — pseudo-terminal lifecycle for Claude Code sessions
2. **Git worktrees** — create, mount, and tear down isolated worktrees per run
3. **SQLite persistence** — `better-sqlite3`-backed run and session history
4. **macOS packaging** — Electron Builder configuration, DMG signing, notarization pipeline
5. **Permission bridge** — the IPC channel that Claude Code uses to request human approval
6. **Zombie-process detection** — reaping orphaned child processes on app restart

Cyboflow adds:

7. **Cross-workflow review queue** — aggregates approval requests from all concurrent runs into one keyboard-driven UI
8. **CyboflowMcpServer outbound bridge** — typed stream parser and MCP server exposing the `cyboflow_*` tools the built-in flows use to write the backlog

## Author

Cyboflow is maintained by Krishna Esteva (github.com/kesteva).
