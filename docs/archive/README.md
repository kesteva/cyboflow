# docs/archive

Historical, point-in-time documents whose work has **already shipped to `main`**. They are
preserved for provenance and design rationale but no longer describe forward-looking work — do
not treat them as current. For live architecture and patterns, see `docs/ARCHITECTURE.md` and
`docs/CODE-PATTERNS.md`.

| File | What it covered | Shipped |
|------|-----------------|---------|
| `workflows-agents-pane-plan.md` | Workflows + Agents pane (P0–P4) implementation plan | yes |
| `agents-workflows-pane-polish-plan.md` | 3 approved polish fixes for that pane | yes |
| `custom-flow-execution-plan.md` | Custom-flow execution (injected `spec_json` graph) | yes |
| `global-workflow-scope-plan.md` | Global workflow scope (migration `030`) | yes |
| `sdk-migration-smoke-results.md` | One-time SDK-migration smoke-test report | n/a (record) |
| `crystal-signing-0.3.5/` | First signed-build + Gatekeeper records, shipped at the inherited Crystal version `0.3.5` | n/a (record) |
| `blocking-finding-escalation.md` | Blocking-finding escalation design (audience column, migration 085) | yes |
| `ci-gate-mocked-sdk-integration.md` | Mocked-SDK integration suite + blocking CI job | yes |
| `codex-provider-integration.md` | Codex as a second agent provider (SDK + PTY, workflow launches) | yes |
| `codex-provider-ui-prototype.html` | Static UI mockup for the Codex provider proposal | n/a (mockup) |
| `config-level-agent-config.md` | Config-level agent config — investigated → DEFERRED decision record | n/a (decision) |
| `experiment-grading-final-gate.md` | A/B ship-arm materialize bug diagnosis (Option A shipped) | yes |
| `initial_research/` | Pre-fork stack/architecture research (conclusions absorbed into PROVENANCE.md) | n/a (record) |
| `mcp-orphan-reaper-plan.md` | cyboflowMcpServer orphan-reaper plan (still cited by section from `mcpServer/` comments) | yes |
| `mcp-plugin-toggles.md` + `mcp-plugin-toggles-impl-plan.md` | Per-agent/per-session MCP + plugin toggles (migrations 038/039) | yes |
| `omp-substrate-plan.md` | OMP substrate phase plan — superseded by the as-built bridge integration | superseded |
| `parallel-stage-ui-treatment.md` | Parallel-stage UI treatment — superseded design | superseded |
| `permission-mode-redesign.md` | 4-mode agent permission redesign (migration 040) | yes |
| `pty-dynamic-workflow-orchestration.md` + `pty-dynamic-workflow-implementation-plan.md` | PTY dynamic-workflow dispatch (shipped ON by default 2026-08-20) | yes |
| `test-coverage-tightening-plan.md` | Test-coverage tightening — executed 2026-07-02 | yes |
