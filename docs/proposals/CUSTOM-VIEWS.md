# Custom Views — implementation plan

Status: DRAFT for Codex review (2026-09-10). Owner: Krishna.
Design reference: the "Custom Views" design canvas (ten artboards: Entry, Customizing, Widget
library, Widget settings, Create a custom widget, Custom widget landed, Save view, View
switcher, Widget states, Project overview). Product decisions below were locked in the design
session; this document turns them into code.

## 1. Product intent (locked)

Users can customize the two landing-family pages — the **Human review queue**
(`frontend/src/components/landing/LandingHome.tsx`) and the **Project overview**
(`frontend/src/components/overview/ProjectOverviewPage.tsx`) — by composing **widgets** into
named **views**.

- **Entry:** a `Customize` button in each page header, next to a **view switcher**.
- **Widget model, three tiers.** Every widget is a declarative spec: `sources` (named read
  queries), an optional pure `transform` pipeline, a `render` (tier 1 = an existing page
  section from the catalog; tier 2 = a generic shape: stat / table / columns / bars / list;
  tier 3 = author-supplied HTML+JS in a sandboxed iframe) and `actions`.
- **Two hard requirements.** (1) Any data in `sessions.db` is queryable from a widget
  (read-only SQL, same guarantees as the assistant's `cyboflow_db_query`). (2) Any action the
  global assistant can propose (`AGENT_PROPOSAL_KINDS`) can be a CTA on a widget, executed
  through the same proposal executor, stamped `actor:'user'`.
- **Customizing is direct manipulation:** reorder / hide / settings / remove per widget,
  "+ Add widget" bars open a **widget library**. The **global assistant** is the only path
  to a **custom widget** (tier 2/3): "Create a custom widget" opens the rail with a kickoff
  and lands the result in a placeholder slot; "Edit with assistant" re-opens it for an
  existing custom widget. Custom widgets are saved to the library ("Mine") for reuse.
- **Views are global** (not per project), stored in `sessions.db`. Multiple named views per
  surface; **Default** is always present and is the unmodified page. The active view is
  remembered per surface.
- **Not TypeScript:** tier 3 is HTML+JS inside a sandbox with a tiny `cyboflow.*` bridge; no
  custom React/TS ever enters the renderer bundle.

Deliberately deferred (not in this plan): multi-column grid layouts (v1 is the single-column
stack both pages already use), cross-project catalog sections on the overview page, sharing
or exporting views, a worker-thread SQL executor (see §4.3 for the v1 guard), and
widget-level assistant chat about data ("ask about this").

## 2. Vocabulary and naming

The app already uses **variants** for workflow A/B variants, so this feature never says
"variant". Names: **view** (a saved layout for a surface), **widget** (a spec), **catalog**
(the built-in widget list), **custom widget** (a user-owned widget in the library's "Mine"
section), **surface** (`review-queue` | `project-overview`), **layout item** (a widget placed
in a view, with settings).

## 3. Data model

### 3.1 Shared types — `shared/types/customViews.ts` (new)

The single cross-package contract (renderer, tRPC router, MCP registry, prompt text all import
from here — the "shared types as the cross-package contract" rule in `docs/CODE-PATTERNS.md`).

```ts
export const CUSTOM_VIEW_SURFACES = ['review-queue', 'project-overview'] as const;
export type CustomViewSurface = (typeof CUSTOM_VIEW_SURFACES)[number];

/** Sentinel id of the unmodified page; never stored. */
export const DEFAULT_VIEW_ID = 'default';

export interface CustomView {
  id: string;                 // uuid
  surface: CustomViewSurface;
  name: string;               // unique per surface, case-insensitive, 1..60 chars
  layout: ViewLayout;
  createdAt: string; updatedAt: string;
}
export interface ViewLayout { version: 1; items: LayoutItem[] }
export interface LayoutItem {
  instanceId: string;         // uuid; stable across edits (cache + action audit key)
  widget: WidgetRef;
  settings: Record<string, JsonValue>;   // values for the widget's declared settings
  title?: string;             // override
  refreshSec?: number;        // override; clamped to [15, 3600]
  hidden?: boolean;
}
export type WidgetRef =
  | { type: 'catalog'; catalogId: string }
  | { type: 'custom'; widgetId: string };

export interface CustomWidget {
  id: string; name: string; description: string | null;
  status: 'draft' | 'ready';  // draft = assistant is still building it
  spec: WidgetSpec;
  threadId: string | null;    // agent thread that authored it (audit only)
  createdAt: string; updatedAt: string;
}

export interface WidgetSpec {
  version: 1;
  sources: Record<string, WidgetSource>;    // name -> source; 0..4 entries
  transform?: TransformStep[];              // applies to `render.source` rows
  render: WidgetRender;
  actions?: WidgetAction[];                 // 0..6
  settings?: WidgetSettingField[];          // declared knobs (drive the inspector)
  refreshSec?: number;                      // default 60
}

export type WidgetSource =
  | { type: 'sql'; sql: string; params?: Record<string, SourceParam> }   // named :params only
  | { type: 'query'; name: QuerySourceName; input: Record<string, SourceParam> };
export type SourceParam =
  | { literal: JsonValue }
  | { setting: string }                         // from LayoutItem.settings[name]
  | { context: 'projectId' | 'nowIso' | 'todayIso' };

/** Allowlisted read procedures, resolved server-side to the pure SELECT helpers in
 *  main/src/orchestrator/insightsQueries.ts (never by calling tRPC internally). */
export const QUERY_SOURCE_NAMES = ['insights.dailyUsage', 'insights.workflowStats',
  'insights.usageTrend'] as const;

export type TransformStep =
  | { op: 'filter'; field: string; cmp: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'in'|'contains'; value: JsonValue }
  | { op: 'sort'; field: string; dir: 'asc'|'desc' }
  | { op: 'limit'; n: number }
  | { op: 'bucketDate'; field: string; unit: 'day'|'week'|'month'; as: string }  // ISO input → 'YYYY-MM-DD' bucket start (UTC, week = Monday)
  | { op: 'group'; by: string[]; aggregates: Array<{ fn: 'sum'|'count'|'avg'|'min'|'max'; field?: string; as: string }> }
  | { op: 'derive'; as: string; expr: DeriveExpr };   // small arithmetic on numeric fields
export type DeriveExpr = { add: [Operand, Operand] } | { sub: … } | { mul: … } | { div: … } | { coalesce: [Operand, Operand] };
type Operand = { field: string } | { literal: number };

export type WidgetRender =
  | { type: 'shape'; shape: 'stat';    source: string; value: string; label?: string; format?: 'number'|'tokens'|'usd'|'percent'|'duration' }
  | { type: 'shape'; shape: 'table';   source: string; columns: Array<{ field: string; label?: string; format?: … }> }
  | { type: 'shape'; shape: 'columns'; source: string; x: string; series: string; y: string }   // stacked columns (DailyUsageChart style)
  | { type: 'shape'; shape: 'bars';    source: string; label: string; value: string }           // horizontal BarRow list
  | { type: 'shape'; shape: 'list';    source: string; title: string; subtitle?: string; meta?: string }
  | { type: 'html'; html: string; sources?: string[] };   // tier 3; html ≤ 64 KB

export interface WidgetAction {
  id: string; label: string;
  kind: AgentProposalKind | 'navigate';
  params: JsonValue;             // template: strings "{row.field}" / "{setting.name}" / "{context.projectId}" are substituted
  confirm?: boolean;             // default true → ConfirmDialog before executing
  placement?: 'header' | 'row';  // row actions receive the clicked row
  navigation?: AgentNavigationTarget | { target: 'backlog' | 'insights' | 'workflows' | 'project-overview'; projectId?: number };
}

export interface WidgetSettingField {
  name: string; label: string;
  kind: 'select' | 'number' | 'project' | 'boolean' | 'text';
  options?: Array<{ value: JsonValue; label: string }>;  // select
  min?: number; max?: number; step?: number;             // number
  default: JsonValue;
}

export const WIDGET_LIMITS = { maxSources: 4, maxActions: 6, maxHtmlBytes: 65_536,
  maxSqlBytes: 8_192, maxRows: 500, maxPayloadBytes: 250_000, minRefreshSec: 15,
  defaultRefreshSec: 60, maxRefreshSec: 3600, slowQueryMs: 2000 } as const;
```

`shared/customViews/transform.ts` (new, pure, no imports beyond the types) implements
`applyTransform(rows, steps)`. It runs in the **main process** (so tier 3 frames and tables
receive final rows) and is unit-tested directly.

`shared/customViews/validate.ts` (new, zod) exports `widgetSpecSchema`, `viewLayoutSchema`,
`customViewNameSchema`. The tRPC router, the MCP tool and the renderer's draft editor all
validate with the same schemas. zod is already a dependency of both packages; the MCP bundle
constraint ("registry may import only zod and its siblings") is respected because the schema
file imports only zod and shared types.

### 3.2 Tables — migration `132_custom_views.sql` (+ `schema.sql` in the same commit)

```sql
CREATE TABLE IF NOT EXISTS custom_views (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL CHECK (surface IN ('review-queue','project-overview')),
  name TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_views_surface_name
  ON custom_views (surface, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS custom_widgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('draft','ready')),
  spec_json TEXT NOT NULL,
  thread_id TEXT,                    -- soft link, no FK (threads may be reset)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Widget-triggered actions reuse agent_proposals for the audit trail + executor.
-- 'agent' = proposed by the assistant (existing rows); 'widget' = a user click on a
-- widget CTA. ADD COLUMN with a DEFAULT is idempotent under the runner's
-- duplicate-column tolerance.
ALTER TABLE agent_proposals ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent';
```

Active view per surface is stored in the existing `user_preferences` KV table under
`customViews.active.<surface>` (`DatabaseService.getUserPreference/setUserPreference` already
exist; the tRPC router exposes them for these two keys only).

The `agent_proposals` CHECK on `kind` is unchanged; widget actions map onto existing kinds.
`entitySchemaParity.test.ts` pins entity/review tables only, so no TS row-type pin is needed;
`verify:schema` parity is required.

### 3.3 Store — `main/src/orchestrator/customViews/customViewsStore.ts` (new)

`CustomViewsDbStore(db: DatabaseLike)` with: `listViews(surface)`, `getView(id)`,
`createView`, `updateView` (name/layout; `updated_at` bump), `deleteView`, `listWidgets()`,
`getWidget(id)`, `upsertWidget`, `deleteWidget` (refused with `in_use` if any view layout
references it — checked by scanning `layout_json` for `"widgetId":"<id>"`; views are few).
JSON columns parsed through the shared zod schemas on read; an unparsable row is skipped with
a logged warning, never thrown into a page render.

## 4. Query engine (main process)

### 4.1 Shared read-only SQL executor — `main/src/orchestrator/readOnlyQuery.ts` (new)

Extract from `mcpQueryHandler.ts` (lines ~1107-1227 and ~7636-7709) into one module used by
both the MCP `cyboflow_db_query` handler and the widgets router:

- `validateReadonlySql(sql)` (moved verbatim; `EXPLAIN` stays allowed for the agent, but the
  widgets path additionally rejects `EXPLAIN` — a widget must return data).
- `openReadonlySibling(db: DatabaseLike)` → cached `better-sqlite3` handle on `db.name` with
  `{ readonly: true, fileMustExist: true }`; throws `db_query_unavailable` for `:memory:`.
- `runReadonlyQuery(handle, sql, params, { maxRows, maxPayloadBytes, maxStringLen })` →
  `{ columns, rows, rowCount, truncated, tookMs }`, using `stmt.reader` + `stmt.iterate()`
  with early stop exactly as today, plus `sanitizeDbQueryValue`.
- `named params`: widgets bind `:name` parameters (better-sqlite3 `stmt.run({name})`
  style); a param the SQL does not reference is ignored, a referenced-but-missing param
  fails with `missing_param:<name>`. The agent's path keeps `params = {}`.

`mcpQueryHandler.ts` keeps its behaviour byte-for-byte (`mcpDbQuery.test.ts` must stay
green unchanged) — it just calls into the module.

### 4.2 Source resolution — `main/src/orchestrator/customViews/sourceRunner.ts` (new)

`runWidgetSources({ spec, settings, context, db })`:

1. Resolve each `SourceParam` (`literal` / `setting` with the declared default fallback /
   `context.projectId` from the request, `nowIso`, `todayIso`).
2. `sql` sources → §4.1 with `WIDGET_LIMITS`. `query` sources → `QUERY_SOURCE_NAMES` switch
   calling `selectDailyModelUsage` / `selectWorkflowRunStats` / `selectUsageTrend` from
   `insightsQueries.ts` with zod-validated inputs (the same input schemas `insights.ts` uses;
   factor those schemas out of the router into `insightsInputSchemas.ts` so both share one).
   Output rows are the helpers' typed objects (already column-shaped).
3. Apply `transform` to the render source's rows (`applyTransform`).
4. Return `{ sources: Record<name, SourceResult>, warnings: string[] }` where
   `SourceResult = { columns, rows, truncated, tookMs }`.

### 4.3 Cache, refresh and the slow-query breaker — `main/src/orchestrator/customViews/widgetDataService.ts` (new)

- In-memory LRU (≤ 200 entries) keyed by `hash(specJson, settingsJson, contextJson)`; TTL =
  the effective `refreshSec`. A hit returns the cached payload with `cachedAt`; a miss runs
  §4.2. Two renderers polling the same widget share one query.
- **Breaker:** if a run's total `tookMs > WIDGET_LIMITS.slowQueryMs`, the key is marked
  `paused` (with the measured time) and later calls return `{ paused: { tookMs } }` without
  querying until (a) the spec/settings change (new key) or (b) the user clicks "Retry"
  (`customViews.resetBreaker`). This cannot abort a query already running — better-sqlite3
  has no interrupt — but it stops a bad widget from repeating on every refresh, which is the
  actual failure mode for a dashboard. The design's "2 s budget" is honoured as post-hoc
  enforcement; a true pre-emptive budget (worker thread + `terminate()`) is a deferred
  hardening item, listed in §11.
- `EXPLAIN QUERY PLAN` advisory: on first execution of a `sql` source the service runs
  `EXPLAIN QUERY PLAN <sql>` on the sibling handle and, if any line matches
  `/SCAN (raw_events|run_usage|sessions)\b/` without an index, adds a warning
  `"full scan of <table>"` surfaced in the inspector's Reads row. Never blocks.
- All state is per app instance and cleared on boot.

### 4.4 Actions — `main/src/orchestrator/customViews/widgetActionService.ts` (new)

`executeWidgetAction({ viewId, instanceId, actionId, row?, db, store, executor })`:

1. Load the **stored** view + widget spec (never trust a spec from the client) and find
   `actionId` in `spec.actions`; unknown → `invalid_action`.
2. Substitute templates in `params` from `row` (only fields present in the widget's own
   source columns), the layout item's settings, and the request context. Templates resolve
   to strings or numbers only; objects are never spliced.
3. `kind === 'navigate'` or `'open-session'` → return `{ navigation }` (no proposal row;
   navigation is renderer-only exactly as the executor treats `open-session`).
4. Otherwise build `AgentProposalPayload` with `kind`, validate with
   `parseAgentProposalPayload` (moved from `mcpQueryHandler.ts` next to the executor so the
   router can reuse it — same "declare once" logic as the tool registry), create the proposal
   on the global thread with `origin='widget'`, then call the boot-wired
   `AgentProposalExecutorLike.execute(proposalId)` and return its `ExecuteProposalResult`.
   Preconditions (edit-workflow spec hash) are captured server-side as today.
5. The rail's proposal list filters `origin='agent'` so widget clicks never surface as
   assistant cards; `listProposals` gains an `origin` filter param (default `'agent'`).

Consent model: the renderer shows `ConfirmDialog` unless the action declares
`confirm:false`; the click itself is the consent the executor's `actor:'user'` stamp
describes.

### 4.5 tRPC router — `main/src/orchestrator/trpc/routers/customViews.ts` (new), mounted as `cyboflow.customViews`

| procedure | kind | input → output |
|---|---|---|
| `listViews` | query | `{surface}` → `CustomView[]` |
| `getActiveView` | query | `{surface}` → `{ viewId }` (`'default'` when unset or dangling) |
| `setActiveView` | mutation | `{surface, viewId}` |
| `createView` | mutation | `{surface, name, layout}` → `CustomView` (`name_taken` on collision) |
| `updateView` | mutation | `{id, name?, layout?}` → `CustomView` |
| `deleteView` | mutation | `{id}`; clears the active pref if it pointed here |
| `listWidgets` | query | → `CustomWidget[]` |
| `getWidget` | query | `{id}` |
| `saveWidget` | mutation | `{id?, name, description?, spec, status?}` → `CustomWidget` |
| `deleteWidget` | mutation | `{id}` (`in_use` error) |
| `runWidget` | query | `{ widget: WidgetRef | { inline: WidgetSpec }, settings, context:{projectId} }` → `{ sources, warnings, cachedAt, paused? }` (inline specs are validated and are what the inspector's live preview and the assistant's preview send; they are still cached by hash) |
| `resetBreaker` | mutation | same key inputs as `runWidget` |
| `executeAction` | mutation | `{viewId, instanceId, actionId, row?, context}` → `{ ok, navigation? , result? }` |
| `dbSchema` | query | → `Array<{ table, columns:[{name,type,pk,notnull}], rowEstimate }>` from `sqlite_master` + `pragma_table_info` on the sibling handle |
| `onWidgetDraft` | subscription | emits `{ widgetId }` whenever the assistant saves a draft/ready widget (§7) |

Context deps added in `context.ts`: `customViewsStore?`, `widgetDataService?`,
`agentProposalExecutor` (already present). All optional, `PRECONDITION_FAILED` when absent,
matching the existing pattern.

## 5. Rendering (renderer)

### 5.1 Catalog registry — `frontend/src/customViews/catalog.tsx` (new)

`CATALOG: Record<CatalogId, CatalogEntry>` where
`CatalogEntry = { id, surface: CustomViewSurface | 'any', category, title, description, settings: WidgetSettingField[], reads: string[], actions: string[], spec?: WidgetSpec }`.

Two kinds of entry:

- **Section entries** (tier 1, `surface`-specific, no `spec`): the page owns their data
  and callbacks; the registry only describes them. Queue: `queue.usage-cards`,
  `queue.recommended`, `queue.needs-input`, `queue.blocked-runs`, `queue.human-tasks`,
  `queue.ready-for-review`, `queue.notifications`, `queue.working`, `queue.backlog`.
  Overview: `overview.active-agents`, `overview.recommended`, `overview.backlog`.
  Every section keeps its current component and props untouched.
- **Spec entries** (tier 2, `surface:'any'`): built-in shape widgets shipped as specs, e.g.
  `insights.daily-usage` (source `query insights.dailyUsage` with settings `groupBy`
  day|week via `bucketDate`+`group`, `days` 7..365, `project`; render `columns`),
  `insights.workflow-stats` (table), `stats.tokens-today` (stat over `run_usage`),
  `stats.open-review-items` (stat), `sessions.recent` (list with a `navigate` row action).
  These are also the assistant's worked examples in the prompt.

### 5.2 Page integration — data-driven section tails

`LandingHome` today computes every section's props and renders a fixed JSX list
(lines 663-784). Change the tail only:

```tsx
const sections: Record<QueueCatalogId, ReactNode> = { 'queue.usage-cards': <ProviderUsageCards/>, … };
return <ViewSurface surface="review-queue" sections={sections} header={<QueueHeader …/>} context={{ projectId: null }} />;
```

`ViewSurface` (new, `frontend/src/customViews/ViewSurface.tsx`) reads the active view from
`customViewsStore`; when it is `default` it renders `sections` in the canonical order (the
exact JSX order today, so the Default view is byte-for-byte the current page); otherwise it
renders `layout.items` in order: a `catalog` section ref pulls from `sections`, anything else
mounts a `WidgetHost`. The lifecycle dialogs and modals stay in the page. Same treatment for
`ProjectOverviewPage` (`context={{ projectId }}`). A section whose data is empty still
renders its empty well exactly as today — the view layer never re-derives page state.

### 5.3 `WidgetHost` — `frontend/src/customViews/WidgetHost.tsx` (new)

Owns one layout item: resolves the spec (catalog spec or custom widget from the store),
polls `customViews.runWidget` imperatively (`trpc.cyboflow.customViews.runWidget.query`)
on mount and every `refreshSec` while `document.visibilityState === 'visible'`, and renders
a frame (title, meta line, state chrome from the "Widget states" artboard: loading skeleton,
empty, error with Retry, paused/slow with Retry, stale-with-last-good) around the body:

- `ShapeRenderer` (`shape/*.tsx`): `StatCard`, `DataTable`, `StackedColumns` (extracted from
  `DailyUsageChart`'s SVG so both share one implementation; `DailyUsageChart` becomes a thin
  adapter), `BarList` (reuses `BarRow`), `ItemList`.
- `SandboxedWidgetFrame` (§5.4) for `render.type === 'html'`.
- Header/row actions → `useWidgetActions()` → `ConfirmDialog` → `executeAction` →
  navigation via `navigationStore` (`navigateToProject`, `openBacklog`, session open via the
  same `AgentNavigationTarget` handling the rail uses in `ProposalCard.tsx`).

### 5.4 Tier 3 sandbox — `frontend/src/customViews/SandboxedWidgetFrame.tsx` (new)

`<iframe sandbox="allow-scripts" srcdoc={doc} />` — no `allow-same-origin`, so the frame is
an opaque origin with no access to `window.electronTRPC`, cookies or storage. `doc` is
built by `buildWidgetDocument(spec)` (shared helper in `shared/customViews/widgetDocument.ts`
so tests in `main` and `frontend` pin the same bytes):

1. `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_INTERACTIVE_CSP}">` first
   (`shared/types/artifacts.ts`: `default-src 'none'; script-src 'unsafe-inline'; style-src
   'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'`),
   the same policy Design Mode's interactive canvas ships. No network of any kind.
2. A theme `<style>` exposing the paper tokens as CSS variables and the base font.
3. The prelude `<script>` defining `window.cyboflow`:
   `onData(cb)` (called with `{ sources, settings, context, theme }` on every refresh),
   `act(actionId, row?)` (posts `{ type:'cyboflow-widget-act', actionId, row }` — the parent
   validates `actionId` against the **stored** spec before doing anything), `resize()`
   (posts measured `document.documentElement.scrollHeight`; parent clamps 80..1200 px).
4. The author's HTML.

Parent → frame: `{ type:'cyboflow-widget-data', payload }` via `postMessage(…, '*')` (the
opaque origin cannot be targeted otherwise). Frame → parent: accepted only when
`event.source === iframe.contentWindow` (same reasoning as `InteractivePrototypeEmbed`).
Navigation out of the frame is already blocked by the `will-frame-navigate` guard for
`about:srcdoc` frames in `main/src/index.ts` (`shouldBlockArtifactFrameNavigation`).
Rationale for `srcdoc` over the loopback prototype server: widgets are the user's own code,
the threat model is "no network, no IPC, no app DOM", which the sandbox + CSP give; the
loopback server's OOPIF isolation is for agent-authored prototypes and is heavier than a
dashboard tile warrants.

### 5.5 Store — `frontend/src/stores/customViewsStore.ts` (new, zustand)

State: `viewsBySurface`, `activeViewId` per surface, `widgets` (library), `loaded` flags,
`draft: { surface, layout, baseViewId, dirty } | null` (customize mode), `createSlot:
{ instanceId } | null` (the placeholder slot awaiting an assistant-built widget),
`widgetData` is NOT in the store (owned per `WidgetHost`). Actions: `init(surface)`,
`setActive`, `enterCustomize`, `moveItem`, `toggleHidden`, `updateItemSettings`,
`removeItem`, `insertItem(at, ref)`, `save({ mode:'update'|'new', name })`, `discard`,
`openCreateSlot(at)`, `bindDraftWidgetToSlot(widgetId)`. `init` opens `onWidgetDraft`
before the seed query (seed-query + subscription race policy).

## 6. Customize mode UI

All in `frontend/src/customViews/edit/`, matching the artboards:

- `ViewHeaderControls` — rendered inside `QueueHeader` (a `justify-between` row is added;
  the header's doc comment about "no header-right block" is updated to name this control)
  and beside the overview `<h1>`. Contains the **view switcher** (`Dropdown` primitive:
  Default + named views, footer "Manage views…") and **Customize** (`SecondaryButton`).
  In customize mode the same slot shows **Save** (primary), **Save as…**, **Discard**.
- `DraftBanner` — thin strip under the header while `draft` exists ("Customizing · Ship
  week — unsaved"), with the same three buttons for tall pages.
- `EditableBlock` — wraps every rendered item in customize mode: grip (native HTML5
  drag/drop reorder on the stack; keyboard ↑/↓ on the grip for accessibility), eye (hide),
  gear (settings), trash (remove). Hidden items render collapsed with a "Hidden" pill.
- `InsertBar` — the "+ Add widget" bar between blocks; opens `WidgetLibraryModal` with the
  insertion index.
- `WidgetLibraryModal` (`Modal` size `xl`) — categories: Sections (this surface), Insights,
  Stats, Lists, **Mine** (custom widgets, `status='ready'`); each card: title, description,
  Reads/Can do chips; footer CTA **Create a custom widget** → §7.1.
- `WidgetSettingsPopover` — from a widget's declared `settings` fields: `select` renders as
  a two/three-option segmented row (composed from `Toggle` pills), `number` as a stepper,
  `project` as a `Dropdown` of projects, `boolean` as `Toggle`; `title` and `refresh`
  always present. Two read-only rows: **Reads** (source names / tables + the breaker or
  scan warnings) and **Can do** (action labels). Footer: "Ask the assistant" (sends a
  `contextHint` naming the widget) for catalog widgets, "Edit with assistant" for custom
  ones (§7.3). Changes apply to the draft immediately (`runWidget` re-fetches).
- `SaveViewDialog` — name field with uniqueness check, "Update <name>" vs "Save as new",
  "Set as active" checkbox (default on).
- `ManageViewsDialog` — rename / delete (delete confirms; Default is not listable).

## 7. Assistant integration

### 7.1 Kickoff — "Create a custom widget"

The library CTA (or the inspector's "Edit with assistant") calls
`customViewsStore.openCreateSlot(at)` (a placeholder `LayoutItem` with
`widget: { type:'custom', widgetId: '' }` and `instanceId`), expands the rail
(`layoutStore.toggleAgentRail` when collapsed) and sends a turn through the existing
`agentThreadStore.sendMessage(text, { contextHint })`. The text is the user's kickoff
("Build a widget that …" — the rail pre-fills the composer with the two-question prompt
from the artboard rather than sending silently; the user hits send). The `contextHint`
carries a machine-readable envelope:

```
[custom-widget-session]
surface=review-queue viewName="Ship week" slotInstanceId=<uuid> projectId=null
mode=create|edit widgetId=<id when editing>
```

`contextHint` is prompt-only and never persisted, so the transcript stays clean.

### 7.2 New tools — `globalAgentTools.ts` (registry only; `mcpQueryHandler` handlers)

| tool | shape | notes |
|---|---|---|
| `cyboflow_db_schema` | `{ table? }` → tables/columns/row estimates | read-only; replaces the "query sqlite_master" instruction in the prompt |
| `cyboflow_widget_preview` | `{ spec_json, settings_json?, project_id? }` → `runWidget` result (rows capped at 50 for the transcript) + validation errors | runs the exact §4.2 path so what the agent sees is what the widget will get |
| `cyboflow_widget_save` | `{ widget_id?, name, description?, spec_json, status:'draft'\|'ready' }` → `{ widgetId }` | the second write-shaped tool; it writes ONLY `custom_widgets` (never a view, never entities). Emits `onWidgetDraft`. |

Envelope types added to `McpQueryMessage` (`mcp-db-schema`, `mcp-widget-preview`,
`mcp-widget-save`), handlers in `mcpQueryHandler.ts` delegating to §4 services (the handler
already holds `db`; the store/service instances are injected the same way
`agentThreadStore` is). `cyboflowMcpServerGlobalAgentScope.test.ts` and the ratchet test
are updated for the new entries.

### 7.3 Live landing

The renderer subscribes to `customViews.onWidgetDraft`. When a `draft` save arrives while
`createSlot` is open, `bindDraftWidgetToSlot(widgetId)` swaps the placeholder for a real
`WidgetHost` rendering the draft (the "Custom widget landed" artboard's live preview). A
`ready` save flips the item's status chip and closes the slot; the confirm card in the rail
is the assistant's own reply ("Saved to your library under Mine"). For `mode=edit`, saves
target the existing `widgetId`; every mounted `WidgetHost` for that widget re-resolves the
spec (the draft in customize mode, ready widgets everywhere).

### 7.4 Prompt — `agentThreadPrompt.ts`

A new section "Custom widgets" (≈ 60 lines) describing the `WidgetSpec` contract (copied
from the shared type file's doc comments so they cannot drift — the test
`agentThreadPrompt.test.ts` pins that every `WidgetRender.shape` and `TransformStep.op`
literal appears in the prompt), the workflow (schema → preview with `cyboflow_widget_preview`
→ iterate → `cyboflow_widget_save` as `draft` early and `ready` when the user is happy),
the two worked examples (daily→weekly token usage; a "stale sessions" list with an
`open-session` row action and a `launch-run` header action), the tier-3 bridge
(`cyboflow.onData / act / resize`), and the rules: SELECT-only SQL with `:params`, no
`EXPLAIN`, respect `WIDGET_LIMITS`, save as `draft` before asking the user to look. The
`[custom-widget-session]` envelope is documented so the model knows `slotInstanceId` and
`mode` come from the page, not the user.

## 8. Files touched (summary)

New: `shared/types/customViews.ts`, `shared/customViews/{transform,validate,widgetDocument}.ts`,
`main/src/database/migrations/132_custom_views.sql`, `main/src/orchestrator/readOnlyQuery.ts`,
`main/src/orchestrator/customViews/{customViewsStore,sourceRunner,widgetDataService,widgetActionService}.ts`,
`main/src/orchestrator/trpc/routers/customViews.ts`, `main/src/orchestrator/insightsInputSchemas.ts`,
`frontend/src/stores/customViewsStore.ts`, `frontend/src/customViews/{catalog.tsx,ViewSurface.tsx,WidgetHost.tsx,SandboxedWidgetFrame.tsx,useWidgetActions.ts,shape/*.tsx,edit/*.tsx}`,
tests beside each.

Modified: `main/src/database/schema.sql`, `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`
(extract + 3 handlers), `main/src/orchestrator/mcpServer/toolRegistry/globalAgentTools.ts`,
`main/src/orchestrator/types.ts` (envelopes), `main/src/orchestrator/agentThread/{agentThreadPrompt,agentThreadDbStore,proposalExecutor}.ts`
(prompt section; `origin` column + `listProposals` filter; `parseAgentProposalPayload`
relocation), `main/src/orchestrator/trpc/{context,router}.ts`, `main/src/orchestrator/trpc/routers/{agentThread,insights}.ts`,
`main/src/index.ts` (wire store/services into context + MCP handler),
`frontend/src/components/landing/{LandingHome,QueueHeader}.tsx`,
`frontend/src/components/overview/ProjectOverviewPage.tsx`,
`frontend/src/components/Insights/charts/DailyUsageChart.tsx` (adapter over `StackedColumns`),
`frontend/src/components/agentRail/ProposalCard.tsx` (navigation helper export),
`docs/SHELL-LAYOUT.md`, `docs/ARCHITECTURE.md` (data model + tool family), `docs/README.md`.

## 9. Delivery stages (each stage = green typecheck/lint + its tests, atomic commits per task)

| stage | scope | verification |
|---|---|---|
| S0 | Shared types, zod schemas, `applyTransform`, `buildWidgetDocument` | `shared` unit tests (`main` vitest) |
| S1 | Migration 132 + `schema.sql`, `CustomViewsDbStore`, `origin` column + `listProposals` filter | store tests on a temp DB; `verify:schema`; `migrationPrefixes.test.ts` |
| S2 | `readOnlyQuery.ts` extraction (MCP behaviour pinned), `sourceRunner`, `widgetDataService` (cache + breaker + explain warning), `widgetActionService`, `parseAgentProposalPayload` relocation | `mcpDbQuery.test.ts` unchanged and green; new unit tests incl. breaker + template substitution + `origin='widget'` |
| S3 | tRPC router + context wiring + `index.ts` | router tests with fake ctx (pattern: existing `routers/__tests__`) |
| S4 | Renderer read path: store, catalog, `ViewSurface` tails in both pages (Default unchanged), `WidgetHost`, shape renderers, sandbox frame, actions | RTL tests: Default renders identical section order; custom layout renders WidgetHost; frame doc pinned; action → confirm → mutate |
| S5 | Customize mode: header controls, switcher, editable blocks, insert bar, library modal, settings popover, save/manage dialogs, draft banner | RTL tests per component + a store test for the draft lifecycle |
| S6 | Assistant: 3 tools + envelopes + handlers, prompt section, kickoff + `onWidgetDraft` landing, "Edit with assistant" | registry scope/ratchet tests, prompt pin test, handler tests, store test for slot binding |
| S7 | Docs (`ARCHITECTURE`, `SHELL-LAYOUT`, `README` index), then the full gate `pnpm typecheck && pnpm lint && pnpm test:unit`, then a dev smoke on a fresh `~/.cyboflow_dev` data dir | gate green; smoke: create a view, add the daily-usage widget, switch weekly, save, switch views, build one custom widget via the rail, click an action |

## 10. Test plan highlights

- **Read-only guarantee:** a test proves the widgets path executes on a `{readonly:true}`
  handle by asserting an `UPDATE` slipped past the validator fails with SQLite's
  `attempt to write a readonly database`, and that `PRAGMA`/`ATTACH`/multi-statement are
  rejected up front.
- **Actions never bypass the executor:** `executeWidgetAction` is tested with a fake
  executor spy; the proposal row exists with `origin='widget'` before `execute` is called;
  unknown `actionId` and template references to non-source fields are rejected.
- **Default view is the current page:** snapshot the section order rendered by
  `ViewSurface` in default mode against the hard-coded list.
- **Sandbox document:** the built doc starts with the CSP meta; contains no `allow-same-origin`;
  the prelude ignores messages from other sources.
- **Cache/breaker:** two concurrent `runWidget` calls hit the runner once; a slow run flips
  the key to paused; `resetBreaker` clears it; a settings change yields a new key.
- **Prompt drift pin:** every render shape / transform op / tool name appears in the
  prompt text.

## 11. Risks and open decisions

1. **No pre-emptive SQL timeout.** Mitigated by the breaker, the row/byte caps, the
   refresh floor and the scan warning; a worker-thread executor with `terminate()` is the
   follow-up if a user hits it in practice.
2. **`LandingHome` refactor blast radius.** Only the render tail changes; props/derivation
   untouched. The Default-order test guards the regression.
3. **`srcdoc` + inline script inside the app renderer.** The main frame has no CSP header
   today; the widget document carries its own restrictive CSP meta and the frame is
   sandboxed without `allow-same-origin`. `will-frame-navigate` already covers
   `about:srcdoc` frames.
4. **Proposal rows on the global thread with `origin='widget'`** keep one audit trail and
   one executor. Alternative considered: a second `agent_threads` row per surface —
   rejected, it would fork thread bootstrap logic for no user-visible benefit.
5. **Assistant runtime on Codex** (`assistantRuntime`): the new tools go through the same
   registry, so both runtimes see them; the prompt section is runtime-neutral.
6. **Migration numbering:** 132 is next free on `main` as of 2026-09-10; re-check before
   merge.
