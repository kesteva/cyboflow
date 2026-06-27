# Implementation plan: per-agent / per-session MCP & Plugin toggles

Companion to `docs/proposals/mcp-plugin-toggles.md` (read that first for feasibility + decisions).
This plan is sliced into **5 atomic commits**, each independently gate-greenable (`pnpm typecheck`
+ `pnpm test:unit`). All line numbers are from the `falcon-ristra` worktree at authoring time;
re-confirm before editing. Verbatim stubs below are copy-pasteable.

## Locked decisions (from the proposal)

- Plugins: **session-scoped** (quick **and** workflow sessions), never per-agent.
- Catalogue: **read-only discovery** from `~/.claude.json` + `~/.claude/plugins/installed_plugins.json`.
- v1: **per-agent + per-session, SDK substrate only**. Interactive (PTY) parity is a fast-follow.

## Polarity (the subtle invariant — preserve current defaults)

Today **all** discovered MCP servers load into every SDK run (global all-on), and plugins follow
the user's `~/.claude/settings.json`. To keep the no-op default byte-identical, the three stores use
**different polarity**:

| Store | Column | Semantics | Empty `[]` default means |
|---|---|---|---|
| Per-agent MCP | `agent_overrides.enabled_mcps_json` | **ALLOW** (grant `mcp__<server>__*` in frontmatter) | agent gets no extra MCP — current behavior for restricted override/custom agents |
| Per-session MCP | `sessions.disabled_mcp_servers_json` | **DENY** (delete from the spawn record) | nothing disabled → all servers load — current behavior |
| Per-session plugins | `sessions.enabled_plugins_json` | **ALLOW** (emit `{id:true}` into inline settings) | no `enabledPlugins` key emitted → inherit file settings — current behavior |

The UI hides this: the per-session MCP pill shows every discovered server **checked**; unchecking adds
to the deny set. The per-session plugin pill shows installed plugins **unchecked**; checking force-enables.

## Migration numbers

Highest on this branch is `034`. This plan uses **035** (agent allow-list) and **036** (session columns).
Migrations are auto-glob in production (`database.ts runFileBasedMigrations`, prefix `^(\d{3})_.*\.sql$`,
filename-keyed idempotent ledger, duplicate-column-tolerant) — **no manifest to edit**. The *parity test*
`entitySchemaParity.test.ts` has a hand-maintained `buildDb()` exec list that **only** needs the `035`
entry (it never creates the legacy `sessions` table, so `036` needs no test edit). ⚠️ Collision risk:
`ridge-ravine` (unmerged) already uses `035` for unrelated work — renumber at merge time (safe; the ledger
+ duplicate-column catch make ADD-COLUMN renames a pure rename). Reference columns by **name** in code,
never by migration number.

---

# Slice 1 — Read-only discovery catalogue (Workflows page MCPs + Plugins sections)

Ships visible value first, no migration, self-contained. Both new routers are pure disk reads with
**no ctx deps** (no DB / registry) — they preserve the standalone-typecheck invariant (`fs`/`os`/`path`
node builtins are already used across this subtree).

**New `shared/types/integrations.ts`** — `McpEntry` / `PluginEntry` (full shapes in the ground-truth
report; `McpEntry = {name, transport:'stdio'|'http'|'sse', url, command, args, scope}`,
`PluginEntry = {id, name, marketplace, scope, version, lastUpdated, projectPath}`).

**New `main/src/orchestrator/trpc/routers/mcps.ts`** — reads `~/.claude.json` global + per-project
`mcpServers`, adapts to `McpEntry[]`, never throws (missing/malformed → `[]`):

```ts
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { router, protectedProcedure } from '../trpc';
import type { McpEntry } from '../../../../../shared/types/integrations';

function adaptServer(name: string, def: unknown, scope: string): McpEntry | null {
  if (typeof def !== 'object' || def === null) return null;
  const d = def as Record<string, unknown>;
  const type = typeof d.type === 'string' ? d.type : 'stdio';
  const transport: McpEntry['transport'] = type === 'http' ? 'http' : type === 'sse' ? 'sse' : 'stdio';
  return {
    name, transport,
    url: typeof d.url === 'string' ? d.url : null,
    command: typeof d.command === 'string' ? d.command : null,
    args: Array.isArray(d.args) ? d.args.filter((a): a is string => typeof a === 'string') : [],
    scope,
  };
}

export function readMcpEntries(): McpEntry[] {
  const file = path.join(os.homedir(), '.claude.json');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const root = parsed as Record<string, unknown>;
  const out: McpEntry[] = [];
  const globalMap = root.mcpServers;
  if (typeof globalMap === 'object' && globalMap !== null)
    for (const [name, def] of Object.entries(globalMap)) { const e = adaptServer(name, def, 'global'); if (e) out.push(e); }
  const projects = root.projects;
  if (typeof projects === 'object' && projects !== null)
    for (const [projPath, projDef] of Object.entries(projects)) {
      if (typeof projDef !== 'object' || projDef === null) continue;
      const pm = (projDef as Record<string, unknown>).mcpServers;
      if (typeof pm !== 'object' || pm === null) continue;
      for (const [name, def] of Object.entries(pm)) { const e = adaptServer(name, def, projPath); if (e) out.push(e); }
    }
  return out;
}

export const mcpsRouter = router({
  list: protectedProcedure.query(async (): Promise<McpEntry[]> => readMcpEntries()),
});
```

**New `main/src/orchestrator/trpc/routers/plugins.ts`** — reads `installed_plugins.json`
(`{version, plugins:{ "<name>@<marketplace>": [record…] }}`), one `PluginEntry` per install record
(full body in ground-truth report; same never-throws shape, `readPluginEntries()` + `list` query).

**`router.ts`** — register both:
```diff
+import { mcpsRouter } from './routers/mcps';
+import { pluginsRouter } from './routers/plugins';
     insights: insightsRouter,
+    mcps: mcpsRouter,
     monitor: monitorRouter,
+    plugins: pluginsRouter,
```

**`workflowsStore.ts`** — add `mcps: McpEntry[]` / `plugins: PluginEntry[]` to `WorkflowsState`
(+ init `[]`); fetch both **once** (machine-global, not per-project) in `runFetch` parallel to the
per-project fan-out via a `safeGlobal` wrapper; commit `mcps: mcps ?? prev.mcps` /
`plugins: plugins ?? prev.plugins` (independent of `anyData`). Exact diff in ground-truth report §3e.

**`GalleryStacked.tsx`** — add `mcps`/`plugins` props and **two more `<GallerySection>` blocks** after
Agents (read-only cards — `AgentCard` markup minus the Edit button; full JSX in report §3f). Optionally
extract `McpCard.tsx`/`PluginCard.tsx`. **`WorkflowsView.tsx`** — read the two slices and pass them in.
No modal/handler state (read-only).

**Tests**: `routers/__tests__/mcps.test.ts` + `plugins.test.ts` (parse fixtures incl. malformed→`[]`);
`workflowsStore.test.ts` (assert the two global lists commit + survive a failed per-project fan-out);
`GalleryStacked.test.tsx` (two new sections render + empty states). `frontend/src/trpc` types come from
`AppRouter` inference — `trpc.cyboflow.mcps.list.query()` appears automatically after `pnpm build:main`.

**Commit**: `feat: add read-only MCPs + Plugins sections to the Workflows page`

---

# Slice 2 — Per-agent MCP scoping (backend: migration 035 + frontmatter emission)

Grants chosen MCP servers to an agent by emitting `mcp__<server>__*` into its
`.claude/agents/cyboflow-<key>.md` frontmatter `tools:` allowlist. Affects **override + custom** agents
only (un-overridden builtins are written verbatim from `rawContent`).

**New `main/src/database/migrations/035_agent_mcp_access.sql`** (no BEGIN/COMMIT — the runner wraps each
file in a transaction):
```sql
-- Migration 035: agent_overrides.enabled_mcps_json — per-agent MCP allow-list.
-- JSON string[] of MCP SERVER NAMES; renderAgentMarkdown expands each to mcp__<server>__*
-- on the frontmatter tools: line. '[]' default = none. Validation in code (mirrors tools_json).
ALTER TABLE agent_overrides ADD COLUMN enabled_mcps_json TEXT NOT NULL DEFAULT '[]';
```

**`models.ts`** — add `enabled_mcps_json: string;` to `AgentOverrideRow` after `tools_json`.

**`entitySchemaParity.test.ts`** — add `db.exec(readFileSync(join(migDir, '035_agent_mcp_access.sql')…))`
**after** the `029` exec in `buildDb()`, and add `'enabled_mcps_json'` to `agentOverrideRowKeys`.

**`agentMarkdown.ts`** — `RenderableAgent` gains `enabledMcps: string[]`; the emitter appends wildcards:
```ts
export function renderAgentMarkdown(a: RenderableAgent): string {
  const name = `cyboflow-${a.agentKey}`;
  const description = escapeYamlScalar(a.description);
  const mcpWildcards = a.enabledMcps.map((server) => `mcp__${server}__*`);
  const tools = [...a.tools, ...mcpWildcards].join(', ');
  return `---\nname: ${name}\ndescription: ${description}\ntools: ${tools}\n---\n\n${a.systemPrompt}`;
}
```

**`effectiveAgents.ts`** — `EffectiveAgent` gains `enabledMcps: string[]`; add a `parseMcps()` helper
(JSON→filtered `string[]`); `mergeAgent` (both paths: builtin→`[]`, override→`parseMcps(override.enabled_mcps_json)`)
and `customAgent` set it. (`agentOverlayWriter` passes `EffectiveAgent` straight to `renderAgentMarkdown`,
so this threads with no call-site change.)

**`agentValidation.ts`** — `AgentDraft` gains `enabledMcps: string[]`; add error code `'invalid_mcp'`,
a `MCP_SERVER_RE = /^[A-Za-z0-9_-]+$/`, and a loop rejecting bad names **and** `server === 'cyboflow'` /
`cyboflow_*` (single-writer invariant — the entity-write server is never grantable).

**`agentOverrideRouter.ts`** — `AgentUpsertChange` + `AgentCreateCustomChange` gain `enabledMcps: string[]`;
both drafts set it; both INSERTs add the `enabled_mcps_json` column + `JSON.stringify(change.enabledMcps)`
value (upsert also adds `enabled_mcps_json = excluded.enabled_mcps_json` to the `ON CONFLICT … DO UPDATE`).

**`agents.ts` router** — add `enabledMcpsSchema = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).default([])`;
add `enabledMcps` to the `upsertOverride` + `createCustom` zod inputs and their `applyChange` payloads;
add `invalid_mcp: 'BAD_REQUEST'` to the `codeMap`; `duplicate` seeds `enabledMcps: source.enabledMcps`.

**`shared/types/agents.ts`** — add `enabledMcps: string[]` to `AgentEntry`; `buildEffectiveEntry` copies
`effective.enabledMcps` (so the editor can display the current value in Slice 3).

**Tests to update** (will red the gate otherwise): `agentOverlayWriter.test.ts` + `agentCatalogue.test.ts`
`renderAgentMarkdown({…})` literals need `enabledMcps: []`; `agentValidation.test.ts` add `invalid_mcp`
cases; `agentOverrideRouter.test.ts` round-trip the new column; `entitySchemaParity` as above.

**Commit**: `feat: per-agent MCP scoping via agent_overrides.enabled_mcps_json`

> Behavioral caveat to document: `mcp__<server>__*` in frontmatter only **allows** tools the SDK has
> actually loaded for that server at spawn time — it scopes the agent's allowlist, it does not register
> a server. The server must still be configured on the run (it is, by default — all global servers load).

---

# Slice 3 — Agent editor: MCP access selector (frontend)

Depends on Slice 1 (catalogue query) + Slice 2 (backend field).

- **`AgentEditorForm.tsx`** — add an "MCP access" checkbox grid beside the Tools grid, options from
  `trpc.cyboflow.mcps.list` (dedupe by `name`), value bound to the draft's `enabledMcps`.
- **`useAgentEditorState.ts`** — `AgentDraft` gains `enabledMcps: string[]` + a `toggleMcp` reducer action;
  seed from `agents.get` on edit.
- **`AgentEditorModal.tsx`** — pass `enabledMcps` into the `upsertOverride`/`createCustom` mutations.
- **Tests**: `AgentEditorModal.test.tsx` — selecting a server persists it; round-trips on reopen.

**Commit**: `feat: MCP access selector in the Agent editor`

---

# Slice 4 — Session columns + SDK read-at-spawn consumption (per-session MCP off + plugin on)

This is the load-bearing runtime slice. **Recommended approach: read-at-spawn from the session row**
(mirrors `resolveSessionAgentPermissionMode`) — the SDK manager reads the columns off
`sessionManager.getDbSession(options.sessionId)` directly, so it covers **both quick and workflow
sessions uniformly with zero `runs.start` / `RunExecutor` threading** (workflow runs execute inside the
host session and carry its `sessionId`). This is why it satisfies the "workflow sessions too" requirement.

**New `main/src/database/migrations/036_session_mcp_plugins.sql`** (sessions is a legacy `schema.sql`
table excluded from parity → no test edit):
```sql
-- Migration 036: per-session MCP-disable / plugin-enable toggles.
--   disabled_mcp_servers_json — JSON string[] of MCP server names DISABLED for this session ('[]'=none).
--   enabled_plugins_json      — JSON string[] of plugin ids force-ENABLED for this session ('[]'=inherit).
ALTER TABLE sessions ADD COLUMN disabled_mcp_servers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN enabled_plugins_json TEXT NOT NULL DEFAULT '[]';
```

**`models.ts`** — `Session` gains `disabled_mcp_servers_json?: string` / `enabled_plugins_json?: string`;
`UpdateSessionData` gains the same two (for Slice 5's writes).

**`claudeCodeManager.ts`** — two read-at-spawn helpers + their use:
- `composeMcpServers` filter (delete the deny-set, never `'cyboflow'`), reading the session row:
```ts
private async composeMcpServers(options: ClaudeSpawnOptions): Promise<Record<string, McpServerConfig>> {
  const { mcpServers } = this.getBaseProjectMcpServers(options.sessionId);

  // Per-session MCP removal (deny-list from sessions.disabled_mcp_servers_json). Never the
  // 'cyboflow' entry — it carries the orchestrator socket the permission bridge needs.
  for (const name of this.resolveSessionDisabledMcps(options.sessionId)) {
    if (name === 'cyboflow') continue;
    if (name in mcpServers) { delete mcpServers[name]; this.logger?.info(`[MCP] disabled for ${options.sessionId}: ${name}`); }
  }

  if (this.orchSocketPath) { /* …unchanged cyboflow injection… */ }
  return mcpServers as Record<string, McpServerConfig>;
}
```
- `buildSdkOptions` — merge `enabledPlugins` into the **existing** inline `settings` overlay (the one that
already holds `fastMode`/`fastModePerSessionOptIn`); **do not touch `settingSources: ['user','project']`**:
```ts
  const enabledPlugins = this.resolveSessionEnabledPlugins(options.sessionId); // Record<id,true> | undefined
  sdkOptions.settings = {
    ...(typeof sdkOptions.settings === 'object' ? sdkOptions.settings : {}),
    fastMode: options.fastMode === true,
    fastModePerSessionOptIn: true,
    ...(enabledPlugins ? { enabledPlugins } : {}),
  };
```
- Helpers: `resolveSessionDisabledMcps(sessionId): string[]` (parse `disabled_mcp_servers_json`),
  `resolveSessionEnabledPlugins(sessionId): Record<string, boolean> | undefined`
  (parse `enabled_plugins_json` → `{id:true}` map; `undefined` when empty so no key is emitted). Both
  read `this.sessionManager.getDbSession(sessionId)` and tolerate missing rows / bad JSON (→ none).

**`interactiveClaudeManager.ts`** — no consumption in v1 (SDK-only). No interface change needed since
read-at-spawn lives in the SDK manager. (Interactive parity fast-follow: emit `--strict-mcp-config` +
filter `enabledMcpjsonServers`, and the plugin set into the `--settings` JSON blob.)

**`sessionManager.ts`** — optionally map the parsed arrays onto the runtime session (used by Slice 5's
store-mirror); not required for spawn (the manager reads the DB row directly).

**Tests**: `claudeCodeManager.composeMcpServers.test.ts` — a session row with `disabled_mcp_servers_json`
removes that server, never `'cyboflow'`, empty `[]` is byte-identical; a new `buildSdkOptions` plugins test —
`enabled_plugins_json` → `settings.enabledPlugins: {id:true}`, empty → no key, `settingSources` untouched.

**Commit**: `feat: consume per-session MCP-disable + plugin-enable at SDK spawn`

---

# Slice 5 — Session toggle pills + IPC (write the session columns)

Depends on Slice 1 (catalogue) + Slice 4 (columns). Mirrors the `updateAgentPermissionMode` chain exactly.

**IPC chain (4 points + DB):**
- `api.ts` — `updateSessionMcps(sessionId, mcps: string[])` / `updateSessionPlugins(…)`.
- `preload.ts` — `sessions:update-session-mcps` / `…-plugins` invokers.
- `electron.d.ts` — decls returning `IPCResponse<void>` (parity with `updateAgentPermissionMode`).
- `ipc/session.ts` — two handlers cloning the permission-mode handler: validate `string[]`,
  `databaseService.updateSession(sessionId, { disabled_mcp_servers_json: JSON.stringify(x) })`
  (MCP pill persists the **deny** set) / `{ enabled_plugins_json: JSON.stringify(x) }`, mirror onto the
  runtime session, `emit('session-updated')`.
- `database.ts updateSession` — two `if (data.… !== undefined) { updates.push(…); values.push(…) }` blocks,
  and append `|| updates[0] === 'disabled_mcp_servers_json = ?' || updates[0] === 'enabled_plugins_json = ?'`
  to the `isOnlyToggleUpdate` guard (so a toggle doesn't bump `updated_at`/unview the session).

**Pills:**
- **`McpTogglePill.tsx`** — multi-select clone of `PermissionModePill` (`closeOnSelect={false}`,
  `item.showDot = !disabled.includes(id)`); options from `trpc.cyboflow.mcps.list`. The pill works in
  **enabled mental-model** (servers checked by default) but persists the **complement** (the deny set):
  `onToggle(id)` → `next = checked ? [...disabled, id] : disabled.filter(x=>x!==id)`. Label `MCP` / `MCP · N off`.
- **`PluginTogglePill.tsx`** — multi-select; options from `trpc.cyboflow.plugins.list`; persists the
  **enable** set directly (unchecked by default). Label `Plugins` / `Plugins · N`.
- **`UnifiedComposer.tsx`** — add `mcpSlot` / `pluginSlot` props, render after `permissionSlot` under the
  same `visibility.showModelEffort` gate.
- **`QuickSessionComposer.tsx`** — construct both slots under the existing `!interactive && !running`
  idle-SDK gate, seeding from the session row and mirroring `onChange` into the session store
  (`updateSession({ ...activeSession, … })`).

**Tests**: pill tests (toggle persists correct polarity, store-mirror updates the label); an
`ipc/session` handler test for the two new channels.

**Commit**: `feat: per-session MCP/plugin toggle pills in the quick-session composer`

---

# Sequencing & dependencies

```
Slice 1 (catalogue) ──┬─→ Slice 3 (agent editor UI)   [also needs Slice 2]
                      └─→ Slice 5 (session pills)       [also needs Slice 4]
Slice 2 (per-agent backend) ─→ Slice 3
Slice 4 (session cols + SDK) ─→ Slice 5
```
Recommended order: **1 → 2 → 3 → 4 → 5**. Slices 2 and 4 are independent backend work and can be done in
either order / in parallel worktrees.

# Verification per slice

- Gate: `pnpm typecheck` + `pnpm test:unit` (the AC gate per CLAUDE.md; **not** `test:e2e`).
- After any migration: `pnpm rebuild better-sqlite3` may be needed to restore host-Node ABI before
  `pnpm --filter main test` (dev rebuilds for Electron ABI). Dev DB lives at `~/.cyboflow_dev/sessions.db`.
- Live smoke (needs `pnpm dev`): Slice 1 — the two sections list your real servers/plugins; Slice 3 —
  grant Peekaboo to one agent, confirm `mcp__peekaboo__*` lands in `<worktree>/.claude/agents/cyboflow-<key>.md`;
  Slice 4/5 — disable a server for a session and confirm it's absent at spawn; enable a plugin and confirm
  `enabledPlugins` reaches the run (frontend/backend debug logs).

# Residual risks (verify during build)

1. **Committed project `.mcp.json` re-introduction** — `settingSources:['project']` may re-read a
   worktree-committed `.mcp.json` and re-add a server the deny-set deleted from the record. The global
   `~/.claude.json` case (Peekaboo) is fully covered; smoke-test a committed-`.mcp.json` server before
   claiming isolation for it. If needed, reconcile by also rewriting the worktree `.mcp.json` at spawn.
2. **`'cyboflow'` server pinned** — every filter path must skip it (entity writes / approvals depend on it).
3. **Exact plugin keys** — `enabled_plugins_json` ids must be the literal `name@marketplace` from
   `installed_plugins.json`; a typo silently no-ops. The pill sources ids from the catalogue, so this is safe
   as long as the catalogue is the only writer.
4. **Migration renumber on rebase** — see "Migration numbers" above.

# Out of scope (v1)

Per-agent plugins (platform can't); a cyboflow-owned MCP/plugin registry; interactive/PTY substrate
consumption (fast-follow); per-session "force-OFF a file-enabled plugin" (the enable-set only force-ON;
tri-state deferred).
