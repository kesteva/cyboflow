# Proposal: per-agent / per-session MCP & Plugin toggles + Workflows-page sections

Status: **proposal / not yet scheduled.** Author: research-driven (multi-agent investigation, 2026-06-26).

## 1. Goal

Add two new sections — **MCPs** and **Plugins** — to the Workflows page, and let users
toggle them so a given capability is available to one agent/session but not another. The
two motivating examples:

- *"Enable Peekaboo for one agent type"* — Peekaboo is an **MCP server**.
- *"Enable the Superpowers plugin for another"* — Superpowers is a **Claude Code plugin**.

## 2. Feasibility verdict (verified against the installed SDK + CLI)

| Capability | Per **session** (quick **and** workflow) | Per **agent-type** (a flow subagent) |
|---|---|---|
| **MCP servers** | ✅ Yes | ✅ Yes |
| **Plugins** | ✅ Yes | ❌ Not natively — scope the plugin's *contributed* MCP/skills instead |

The plugin per-agent gap is a hard platform fact: Claude Code's `AgentDefinition` and the
subagent `.md` frontmatter expose `tools`, `disallowedTools`, `model`, `skills`, `memory`,
`mcpServers`, `permissionMode`… **but no `plugins` field.** Plugin enablement is a
session/process-level concern. Per the product decision, **plugins are scoped to sessions
(both quick sessions and workflow sessions), never per-agent.**

### Verified SDK seams (high confidence — read from `@anthropic-ai/claude-agent-sdk/sdk.d.ts`)

**Plugins (per-session).** `Settings.enabledPlugins?: Record<"name@marketplace", boolean>`
(sdk.d.ts ~4399). `Options.settings?: string | Settings` lands in the **flag layer
(highest user-controlled precedence: user < project < local < flag < policy)**. So:

```ts
query({ prompt, options: {
  cwd: worktree,
  settingSources: ['user','project'],     // keep — needed for agent-overlay discovery
  settings: { enabledPlugins: { 'superpowers@its-marketplace': true } }, // flag layer wins
}})
```

- `options.plugins: SdkPluginConfig[]` is a **different** thing (loads *new* local plugin
  code from a path); it does **not** toggle an installed marketplace plugin. Use
  `enabledPlugins` for the Superpowers case.
- Key format must be exact `name@marketplace` — a typo silently no-ops.
- Each run is a fresh `query()` subprocess, so no restart concerns.

**MCP servers (per-session, true removal).** cyboflow already *builds* the `mcpServers`
record in `composeMcpServers` (`claudeCodeManager.ts:989`) by merging `~/.claude.json`
(global + project) + base-project `.mcp.json` + its own `cyboflow` server. The
`mcpServers` option is authoritative; there is **no SDK `--strict-mcp-config`**, so the
record *is* the allowlist. To drop Peekaboo for a session: `delete record['peekaboo']`
before returning.

- **Do NOT** drop `'user'`/`'project'` from `settingSources` to isolate MCP — agent
  overlays (`.claude/agents/*.md`) and user settings load through the same sources;
  removing them breaks overlay discovery. Filtering the record is the correct lever.
- Caveat: a **committed** project `.mcp.json` (present in the worktree because worktrees
  share tracked files) may be re-read by `settingSources:['project']` and re-introduce a
  server even after we delete it from the record. The global-`~/.claude.json` case
  (Peekaboo) is fully covered; committed-`.mcp.json` servers need worktree reconciliation
  — see Risks. **Verify with a smoke test during build.**

**MCP servers (per-agent).** Emit `mcp__<server>__*` patterns into the subagent's
`.claude/agents/cyboflow-<key>.md` frontmatter `tools:` / `disallowedTools:` line. cyboflow
already writes these overlays (`agentOverlayWriter.installAgentOverlay`), and
`renderAgentMarkdown` (`agentMarkdown.ts:39`) currently emits only `name/description/tools`
— so this is a frontmatter-emission change on an existing seam, no new spawn plumbing.
This **restricts** which already-loaded MCP tools a subagent may call (it does not add a
server — servers are per-run/process). For the v1 use case ("Peekaboo for agent A only")
that is exactly right.

## 3. Scope decisions (locked)

1. **Plugins**: session-scoped, applied to **both quick sessions and workflow sessions**
   (not per-agent).
2. **Catalogue**: **read-only discovery** from the user's existing Claude Code config
   (`~/.claude.json`, `~/.claude/plugins/`). cyboflow toggles/scopes; it does not add or
   remove servers/plugins. No new registry tables for the catalogue itself.
3. **v1 scope**: **per-agent + per-session, SDK substrate only.** Interactive (PTY)
   substrate parity is a fast-follow.

## 4. Where state lives

| Toggle | Home | Why |
|---|---|---|
| Per-agent MCP allowlist | **new `agent_overrides.enabled_mcps_json`** (migration `035`) | agent_overrides is the per-agent (per-project) model; rides `AgentOverrideRouter.applyChange` → `effectiveAgents` → frontmatter |
| Per-session MCP disable/allow set | **new `sessions` column** (e.g. `disabled_mcp_servers_json`) | sessions own the worktree; the filter happens per-spawn in `composeMcpServers` |
| Per-session plugin enable set | **new `sessions` column** `enabled_plugins_json` | session-level, inherited by every run in the session; written into inline `settings.enabledPlugins` at spawn |

Workflow sessions: runs nest under sessions, so plugin/MCP session state is inherited by
every run launched into that session. The workflow-launch path (`useLaunchWorkflow` →
`runs.start`) surfaces the same selection and persists it onto the session before
`runs.start`, so one source of truth covers quick + workflow.

## 5. The three UI surfaces

### 5a. Workflows page — two new gallery sections (read-only catalogue)
`GalleryStacked.tsx:70` already renders two `<GallerySection>` blocks (Workflows, Agents).
Add **two more** in the same idiom:
- **MCPs** — `MCPCard` per server discovered from `~/.claude.json` + `.mcp.json` (name,
  transport/command, health via `mcpHealth.ts`).
- **Plugins** — `PluginCard` per installed plugin from
  `~/.claude/plugins/installed_plugins.json` + `known_marketplaces.json` (name@marketplace,
  version, and **what it contributes**: subagents / skills / MCP / commands — so the
  per-agent story is legible).

Backed by new `cyboflow.mcps.list` / `cyboflow.plugins.list` tRPC routers (read-only),
registered in `router.ts:24-41` beside `agents`/`workflows`, fanned out in
`workflowsStore.runFetch` alongside the existing `.list` calls. The MCP read logic already
exists in `getBaseProjectMcpServers` (`claudeCodeManager.ts:1548`) — extract & reuse.

### 5b. Agent editor — MCP access block
Add an "MCP access" checkbox grid to `AgentEditorForm.tsx` (alongside the Tools grid),
listing discovered MCP servers. Persist via `agent_overrides.enabled_mcps_json`
(migration 035), threaded through `AgentOverrideRouter` → `effectiveAgents` →
`renderAgentMarkdown` (emit `mcp__<server>__*` into the frontmatter `tools:` line). Plugins
are **not** editable here (no per-subagent plugin scoping); show an explanatory note.

### 5c. Composer + workflow-launch — session pills
Mirror `PermissionModePill`:
- **MCP pill** in `QuickSessionComposer.tsx` → new `mcpSlot` on `UnifiedComposer` → persists
  `sessions.disabled_mcp_servers_json` → filtered in `composeMcpServers`.
- **Plugins pill** → new `pluginSlot` → persists `sessions.enabled_plugins_json` → applied
  via inline `settings.enabledPlugins` in `buildSdkOptions`.
- Workflow launches surface the same selection (workflow picker / wizard) and write it onto
  the session before `runs.start` (`useLaunchWorkflow.ts:73`).

## 6. Backend seams (file-level)

- `composeMcpServers` (`claudeCodeManager.ts:989`) — `delete record[name]` for the session's
  disabled set (read from `ClaudeSpawnOptions.disabledMcpServers`); keep the `cyboflow`
  entry pinned.
- `buildSdkOptions` (`claudeCodeManager.ts:870`) — add `settings.enabledPlugins` (inline,
  flag layer) from `ClaudeSpawnOptions.enabledPlugins`; keep `settingSources:['user','project']`.
- `renderAgentMarkdown` (`agentMarkdown.ts:39`) — emit per-agent `mcp__<server>__*` patterns
  into the `tools:` line; `bundledAgentParser.ts` parse-symmetry not required (MCP patterns
  are only written, not round-tripped from bundled files).
- `ClaudeSpawnOptions` (`claudeCodeManager.ts:84`) + the interactive twin — add
  `disabledMcpServers?: string[]` and `enabledPlugins?: Record<string, boolean>`; thread
  through `SubstrateDispatchFacade` / `RunExecutor` the same way `fastMode` /
  `agentPermissionMode` flow.
- Migration `035_agent_mcp_plugins.sql`:
  `ALTER TABLE agent_overrides ADD COLUMN enabled_mcps_json TEXT NOT NULL DEFAULT '[]';`
  plus the two new `sessions` columns. Update `AgentOverrideRow` (`models.ts:463`) and the
  parity test (`entitySchemaParity.test.ts:189`, which pins the column set **and** execs
  each migration in `buildDb`).
- New routers: `routers/mcps.ts`, `routers/plugins.ts` (read-only `list`/`onChanged`);
  shared shapes `McpEntry` / `PluginEntry` in `shared/types/` next to `mcpHealth.ts`.
- New session IPC: `API.sessions.updateSessionMcps` / `updateSessionPlugins`
  (parity `frontend/src/types/session.ts` ↔ `main/src/types/session.ts`).

## 7. Implementation phasing

1. **Discovery + catalogue** — `cyboflow.mcps.list` / `cyboflow.plugins.list` + the two
   gallery sections (read-only). Lowest risk, immediately useful.
2. **Per-agent MCP scoping** — migration 035 column + editor block + frontmatter emission.
   Highest value, rides existing overlay seam.
3. **Per-session MCP toggle (SDK)** — sessions column + composer pill + `composeMcpServers`
   filter.
4. **Per-session plugin toggle (SDK, quick + workflow)** — sessions column + composer pill +
   `buildSdkOptions` inline `enabledPlugins` + `runs.start` threading.
5. *(fast-follow)* Interactive-substrate parity (`--mcp-config`/`--strict-mcp-config`,
   `enabledMcpjsonServers`, settings write for plugins).

## 8. Risks / smoke items

- **Committed `.mcp.json` re-introduction**: confirm whether `settingSources:['project']`
  re-reads a worktree-committed `.mcp.json` and overrides the filtered record. If so,
  per-session "off" for those servers also needs worktree `.mcp.json` reconciliation.
  Smoke-test before claiming true isolation for committed-project servers.
- **`cyboflow` server must stay pinned** through every filter (load-bearing for
  `cyboflow_report_step` / entity writes / approvals).
- **Exact `name@marketplace` keys** for `enabledPlugins` — derive from
  `installed_plugins.json`, never hand-type.
- **Substrate asymmetry**: SDK vs interactive currently see slightly different server sets;
  reconcile when interactive parity lands.

## 9. Non-goals (v1)

- Per-agent **plugin** scoping (platform doesn't support it).
- A cyboflow-owned MCP/plugin **registry** (read-only discovery only).
- **Interactive/PTY** substrate parity (fast-follow).
