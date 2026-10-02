# Cyboflow Provenance

## Fork

- **Upstream:** https://github.com/stravu/crystal
- **Upstream commit (tag `0.3.5`):** `1e18e0bc981225f75b5226f82a300fa741970c6f`
- **Local baseline commit:** `e611db8afc1bdaccf031c038a89bae8c18908056`
- **Fork date:** 2026-05-11
- **Fork commit message:** `chore: fork stravu/crystal at HEAD as cyboflow baseline`
- **Crystal tag at fork:** `0.3.5` (Crystal's final public tag before the project was renamed to Nimbalyst)

To verify the fork point independently:

```bash
git log e611db8afc1bdaccf031c038a89bae8c18908056 --pretty=fuller
```

## License

Cyboflow is MIT-licensed, inheriting Crystal's pre-Nimbalyst MIT posture. See [/LICENSE](/LICENSE) for the canonical text. What the packaged app bundles, and under which terms, is listed in [/docs/packaging/THIRD-PARTY-LICENSES.md](/docs/packaging/THIRD-PARTY-LICENSES.md).

## Do not merge from Nimbalyst

Crystal was deprecated in early 2026 and replaced by a new product called Nimbalyst (https://github.com/Nimbalyst/nimbalyst). Nimbalyst is also MIT-licensed, so this is **not** a license-contamination concern — but it is a separate product on its own scope and direction, and Cyboflow has diverged substantially from the `0.3.5` fork point.

**The rule is absolute:** do not cherry-pick, rebase, or apply patches from https://github.com/Nimbalyst/nimbalyst into this repository. If a fix is needed that Nimbalyst happens to have implemented, reproduce the fix from first principles on the Cyboflow side.

**Rationale:** The goal is a clean, auditable provenance and a single coherent product direction. Cyboflow forked Crystal `0.3.5` deliberately and has narrowed and rebuilt large parts of it; importing commits from a now-divergent codebase would muddy that lineage and re-introduce decisions Cyboflow has intentionally moved away from. The safe posture is a hard no-merge boundary at the fork point — independent of license, which is MIT on both sides.

## What Cyboflow inherits from Crystal

Cyboflow forked Crystal for its Electron shell, PTY management, git-worktree handling,
SQLite persistence, and orphaned-process reaping. Most other subsystems have since been
rebuilt or replaced: the orchestrator and entity model, the cross-workflow review queue,
the SDK `canUseTool` approval path, the `cyboflow_*` MCP server, macOS/Windows packaging and
signing, and the R2 update channel. `docs/ARCHITECTURE.md` describes what exists today.

## Author

Cyboflow is maintained by Krishna Esteva ([@kesteva](https://github.com/kesteva)).
