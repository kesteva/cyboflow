# Custom Views — implementation plan

Status: REVIEWED (Codex adversarial review 2026-09-10, 21 findings, all incorporated — §12).
Owner: Krishna.
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
  queries), optional pure `transforms`, a `render` (tier 1 = an existing page section from
  the catalog; tier 2 = a generic shape: stat / table / columns / bars / list; tier 3 =
  author-supplied HTML+JS in a sandboxed, cross-origin frame) and `actions`.
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
or exporting views, a pre-emptive SQL time budget (worker thread + `terminate()`; see
§4.3), and widget-level assistant chat about data ("ask about this").

## 2. Vocabulary and naming

The app already uses **variants** for workflow A/B variants, so this feature never says
"variant". Names: **view** (a saved layout for a surface), **widget** (a spec), **catalog**
(the built-in widget list), **custom widget** (a user-owned widget in the library's "Mine"
section), **surface** (`review-queue` | `project-overview`), **layout item** (a widget placed
in a view, with settings), **authoring session** (one create/edit round trip through the
assistant, identified by a token the page mints).

## 3. Data model

### 3.1 Shared types — `shared/types/customViews.ts` (new)

The single cross-package contract (renderer, tRPC router, MCP handler, prompt text all import
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
  revision: number;           // CAS token for updateView / executeAction
  createdAt: string; updatedAt: string;
}
export interface ViewLayout { version: 1; items: LayoutItem[] }
export interface LayoutItem {
  instanceId: string;         // uuid; stable across edits (cache + action audit key)
  widget: WidgetRef;
  settings: Record<string, Scalar>;      // values for the widget's declared settings
  title?: string;             // override
  refreshSec?: number;        // override; clamped to [15, 3600]
  hidden?: boolean;
}
export type WidgetRef =
  | { type: 'catalog'; catalogId: string }
  | { type: 'custom'; widgetId: string };

/** Values SQLite can bind (booleans are normalized to 1/0 before binding). */
export type Scalar = string | number | boolean | null;

export interface CustomWidget {
  id: string; name: string; description: string | null;
  publishedSpec: WidgetSpec | null;   // what every non-editing surface renders; null until first publish
  draftSpec: WidgetSpec | null;       // the assistant's in-progress spec; rendered only in the authoring slot
  authoringSessionId: string | null;  // token of the authoring session that owns draftSpec
  revision: number;
  threadId: string | null;            // agent thread that authored it (audit only)
  createdAt: string; updatedAt: string;
}

export interface WidgetSpec {
  version: 1;
  sources: Record<string, WidgetSource>;                 // name -> source; 1..4 entries
  transforms?: Record<string, TransformStep[]>;          // keyed by source name; applies to that source's rows
  render: WidgetRender;
  actions?: WidgetAction[];                              // 0..6
  settings?: WidgetSettingField[];                       // declared knobs (drive the inspector)
  refreshSec?: number;                                   // default 60
}

export type WidgetSource =
  | { type: 'sql'; sql: string; params?: Record<string, SourceParam> }   // named :params only
  | { type: 'query'; name: QuerySourceName; input: Record<string, SourceParam> };
export type SourceParam =
  | { literal: Scalar }
  | { setting: string }                         // LayoutItem.settings[name], falling back to the declared default
  | { context: 'projectId' | 'nowIso' | 'todayIso' };
/** Anywhere a transform takes a value, a setting reference is accepted and resolved server-side
 *  BEFORE the spec is hashed or executed. */
export type SettingRef = { setting: string };

/** Allowlisted read helpers, resolved server-side to the pure SELECT functions in
 *  main/src/orchestrator/insightsQueries.ts through one adapter each (their signatures differ). */
export const QUERY_SOURCE_NAMES = ['insights.dailyUsage', 'insights.workflowStats',
  'insights.usageTrend'] as const;

export type TransformStep =
  | { op: 'filter'; field: string; cmp: 'eq'|'ne'|'gt'|'gte'|'lt'|'lte'|'in'|'contains'; value: Scalar | Scalar[] | SettingRef }
  | { op: 'sort'; field: string; dir: 'asc'|'desc' | SettingRef }
  | { op: 'limit'; n: number | SettingRef }
  | { op: 'bucketDate'; field: string; unit: 'day'|'week'|'month' | SettingRef; as: string }  // ISO input → 'YYYY-MM-DD' bucket start (UTC, week = Monday)
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
  | { type: 'html'; html: string };     // tier 3; receives ALL sources; html ≤ 64 KB

export interface WidgetAction {
  id: string; label: string;
  kind: AgentProposalKind | 'navigate';
  params: JsonValue;             // template: strings "{row.field}" / "{setting.name}" / "{context.projectId}" are substituted
  placement?: 'header' | 'row';  // row actions receive the clicked row
  rowKey?: string;               // REQUIRED for placement:'row' — the source column that identifies a row
  /** Only parent-rendered buttons (tier 1/2) may opt out of the confirm dialog. A tier-3 frame's
   *  `cyboflow.act()` ALWAYS confirms (§4.4); this flag is ignored for html renders. */
  confirm?: boolean;
  navigation?: AgentNavigationTarget | { target: 'backlog' | 'insights' | 'workflows' | 'project-overview'; projectId?: number };
}

export interface WidgetSettingField {
  name: string; label: string;
  kind: 'select' | 'number' | 'project' | 'boolean' | 'text';
  options?: Array<{ value: Scalar; label: string }>;  // select
  min?: number; max?: number; step?: number;          // number
  default: Scalar;
}

export const WIDGET_LIMITS = { maxSources: 4, maxActions: 6, maxHtmlBytes: 65_536,
  maxSqlBytes: 8_192, maxRows: 500, maxRowBytes: 16_384, maxPayloadBytes: 250_000,
  minRefreshSec: 15, defaultRefreshSec: 60, maxRefreshSec: 3600, slowQueryMs: 2000 } as const;
```

`shared/customViews/transform.ts` (new, pure) implements `applyTransform(rows, steps)` on an
already setting-resolved step list. It runs in the **main process** (so tier 3 frames and
tables receive final rows) and is unit-tested directly.

`shared/customViews/validate.ts` (new, zod) exports `widgetSpecSchema`, `viewLayoutSchema`,
`customViewNameSchema`, plus `resolveSpecSettings(spec, settings)` → a spec with every
`SettingRef` / `{setting}` param replaced by a validated scalar (unknown setting name,
type mismatch, or an unresolvable ref is a validation error, never a runtime surprise).
The tRPC router, the MCP **handler** (not the registry — §7.2) and the renderer's draft editor
all validate with the same schemas.

Validation rules beyond shape: `sources` non-empty; `render.source` (shape) names a declared
source; every `transforms` key names a declared source; `rowKey` present for row actions and
names a column the widget's own render source exposes (checked at runtime against the result
columns too); a catalog **section** may appear at most once per layout; template references
in `params` may only name `row.<field>`, `setting.<declared>`, `context.projectId`.

### 3.2 Tables — migration `132_custom_views.sql` (+ `schema.sql` in the same commit)

```sql
CREATE TABLE IF NOT EXISTS custom_views (
  id TEXT PRIMARY KEY,
  surface TEXT NOT NULL CHECK (surface IN ('review-queue','project-overview')),
  name TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_views_surface_name
  ON custom_views (surface, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS custom_widgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  published_spec_json TEXT,            -- NULL until first publish
  draft_spec_json TEXT,                -- NULL when no draft is pending
  authoring_session_id TEXT,           -- owner of draft_spec_json
  revision INTEGER NOT NULL DEFAULT 1,
  thread_id TEXT,                      -- soft link, no FK (threads may be reset)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Widget-triggered actions reuse agent_proposals for the audit trail + executor, but
-- agent_proposals itself is NOT altered (migration 125 recreates it from a fixed column
-- list, so an added column would not survive a ledger-wiped replay). This side table
-- (a) marks which proposals came from a widget click, so the rail's listProposals can
-- exclude them with a LEFT JOIN, and (b) gives every click an idempotent operation id.
CREATE TABLE IF NOT EXISTS widget_action_log (
  proposal_id TEXT PRIMARY KEY REFERENCES agent_proposals(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  view_id TEXT NOT NULL,
  view_revision INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Active view per surface is stored in the existing `user_preferences` KV table under
`customViews.active.<surface>` (`DatabaseService.getUserPreference/setUserPreference` already
exist and are exposed to the router through the narrow service in §4.6, never by importing
`DatabaseService`).

`entitySchemaParity.test.ts` pins entity/review tables only, so no TS row-type pin is needed;
`verify:schema` parity and `migrationPrefixes.test.ts` are required. A migration replay test
(fresh DB → all migrations → `PRAGMA table_info` for the three tables) is added beside
`migration125.test.ts`.

### 3.3 Store — `main/src/orchestrator/customViews/customViewsStore.ts` (new)

`CustomViewsDbStore(db: DatabaseLike)` with: `listViews(surface)`, `getView(id)`,
`createView`, `updateView({ id, expectedRevision, name?, layout? })` (CAS: `UPDATE … WHERE
revision = ?`, zero rows → `concurrency`; bumps `revision` + `updated_at`), `deleteView`,
`listWidgets()`, `getWidget(id)`, `saveDraft({ id?, name, description, spec,
authoringSessionId })`, `publishDraft({ id, authoringSessionId })` (draft → published,
draft cleared, revision bump; refuses when the session token does not match),
`discardDraft({ id, authoringSessionId })`, `deleteWidget(id)`.

`deleteWidget` and `createView`/`updateView` run inside one `db.transaction`:
`deleteWidget` parses every `custom_views.layout_json` (never a substring match) and refuses
with `in_use` if any item references the widget; a layout that fails to parse makes the delete
**fail closed** (`corrupt_layout:<viewId>`). `createView`/`updateView` verify every
`custom` ref points at an existing widget (`unknown_widget`). Read paths parse JSON through
the shared zod schemas; an unparsable view is returned with `layout: null` and a `corrupt`
flag so the switcher can show it (and offer delete) rather than hiding it.

## 4. Query engine (main process)

### 4.1 Shared read-only SQL executor — `main/src/orchestrator/readOnlyQuery.ts` (new)

Extract from `mcpQueryHandler.ts` (validator ~1107-1227, sibling connection + iterate loop
~7636-7709) into one module used by both the MCP `cyboflow_db_query` handler and the widget
services:

- `validateReadonlySql(sql, { profile: 'agent' | 'widget' })`: the agent profile is today's
  rules verbatim. The widget profile additionally rejects `EXPLAIN` (a widget must return
  data) and `WITH RECURSIVE` (the one construct that can spin before producing a first row
  with no data-size bound) — reason codes `explain_not_allowed`, `recursive_not_allowed`.
- `openReadonlySibling(db: DatabaseLike)` → cached `better-sqlite3` handle on `db.name` with
  `{ readonly: true, fileMustExist: true }`; throws `db_query_unavailable` for `:memory:`.
- `runReadonlyQuery(handle, sql, params, limits)` → `{ columns, rows, rowCount, truncated,
  tookMs }`: `stmt.reader` check, then `stmt.iterate(params)` with early stop exactly as
  today, plus `sanitizeDbQueryValue`. Params are bound through `iterate(params)`; values are
  coerced to SQLite-bindable scalars first (`true/false` → `1/0`; arrays/objects are rejected
  by validation before this point); better-sqlite3's `Missing named parameter "x"` is caught
  and re-raised as `missing_param:x`; extra params are ignored (better-sqlite3 tolerates them).
- Widget limits add `maxRowBytes`: a single row larger than that fails the source with
  `row_too_large` instead of being returned (the agent profile keeps today's behaviour).

`mcpQueryHandler.ts` keeps its behaviour byte-for-byte — scope checks, the
unavailable-database path, sanitization, the non-reader empty response and the WARN logging
`mcpDbQuery.test.ts` pins all stay in the handler; only the pure pieces move.

### 4.2 Source resolution — `main/src/orchestrator/customViews/sourceRunner.ts` (new)

`runWidgetSources({ resolvedSpec, context, db })` where `resolvedSpec` came from
`resolveSpecSettings` (§3.1):

1. Resolve each `SourceParam` (`literal` / resolved setting / `context.projectId` from the
   request, `nowIso`, `todayIso`).
2. `sql` sources → §4.1 with `WIDGET_LIMITS` (widget profile). `query` sources → one adapter
   per `QUERY_SOURCE_NAMES` entry: `insights.dailyUsage` → `selectDailyModelUsage(db,
   projectId, days)`; `insights.workflowStats` → `selectWorkflowRunStats(db, projectId)`;
   `insights.usageTrend` → `selectUsageTrend(db, { workflowId, projectId, days })`. Inputs are
   validated with the same zod schemas `insights.ts` uses (factored out into
   `insightsInputSchemas.ts`). Helper results are **truncated to `maxRows`** and measured
   against `maxPayloadBytes` like SQL rows — the helpers materialize with `.all()`, so the
   widget-wide output cap is enforced on their output, not their input.
3. Apply each `transforms[source]` with `applyTransform`.
4. Return `{ sources: Record<name, SourceResult>, warnings: string[] }` where
   `SourceResult = { columns, rows, truncated, tookMs }`.

### 4.3 Cache, refresh and the repeat-suppression breaker — `main/src/orchestrator/customViews/widgetDataService.ts` (new)

- **Cache key** = `hash(canonicalJson(resolvedSpec), canonicalJson({ projectId, todayIso }))`
  (sorted keys; `nowIso` is resolved at run time and deliberately **excluded** from the key so
  it cannot defeat caching or the breaker; `todayIso` is included because it changes the
  meaning of "today" queries). In-memory LRU ≤ 200 entries, each `{ payload, computedAt }`.
- **Freshness is per request:** `runWidget` carries a validated `refreshSec` (the layout
  item's override or the spec default, clamped); an entry is a hit when
  `now - computedAt < refreshSec`. Two layout items with different overrides therefore share
  one entry and differ only in how stale they accept. Concurrent misses on one key coalesce
  onto one in-flight promise.
- **Breaker = repeat suppression, not a time budget.** If a run's total `tookMs >
  slowQueryMs`, the key is marked `paused` and later calls return `{ paused: { tookMs } }`
  without querying until the resolved spec changes (new key) or the user clicks Retry
  (`customViews.resetBreaker`). This does **not** stop the first slow run: better-sqlite3 is
  synchronous and has no interrupt, so a pathological first execution blocks the main
  process until SQLite returns. That risk is accepted for v1 and bounded by the validator
  (no recursive CTEs, no multi-statement), the caps, the refresh floor and the fact that
  every widget is authored through the assistant's preview tool, which runs the same query
  once before it is ever saved. A worker-thread executor with `terminate()` is the follow-up.
- **Query plan advisory:** on first execution of a `sql` source the service runs
  `EXPLAIN QUERY PLAN <sql>` on the sibling handle and stores the planner lines verbatim.
  Any line containing `SCAN` produces the warning `"full scan (see query plan)"`; the
  inspector's Reads row shows the plan lines themselves. No table attribution is claimed
  (aliases make `SCAN s` common).
- All state is per app instance and cleared on boot.

### 4.4 Actions — `main/src/orchestrator/customViews/widgetActionService.ts` (new)

**Consent model.**
- Tier 1/2 buttons are rendered by the parent (React), so a click is a real user gesture;
  those may set `confirm:false`.
- A tier-3 frame's `cyboflow.act(actionId, rowKeyValue)` is only a *request*: script can call
  it on load. The parent therefore **always** opens `ConfirmDialog` for frame-originated
  requests, showing the action label and the **server-resolved** arguments (returned by a
  dry-run `previewAction` call), and only the dialog's Confirm click triggers execution.
- No action executes from an unsaved state: in customize mode (§5.5) every action control is
  disabled, and `executeAction` requires the saved `viewId` + `viewRevision`.

**Row identity.** Row actions never trust client-supplied row values. The client sends
`rowKeyValue` (the value of the action's declared `rowKey` column); the server re-runs the
widget's data through the cache (§4.3), finds the row whose `rowKey` equals it, and
substitutes templates from **that** row. No match → `stale_row`.

`executeWidgetAction({ operationId, viewId, viewRevision, instanceId, actionId, rowKeyValue?, context })`:

1. Load the **stored** view; `revision !== viewRevision` → `stale_view`. Find the layout
   item; resolve its widget (`published_spec_json` only — a draft never executes actions);
   find `actionId` in `spec.actions`; unknown → `invalid_action`.
2. Resolve the row (above) and substitute templates in `params` from the row, the item's
   settings and the request context. Templates resolve to scalars only; objects are never
   spliced.
3. `kind === 'navigate'` or `'open-session'` → return `{ ok: true, navigation }` (no
   proposal row; navigation is renderer-only exactly as the executor treats `open-session`,
   and the renderer routes it through the existing `proposalNavigation.ts`).
4. Otherwise run the **shared proposal preparation** (§4.5): the same code
   `handleProposeAction` uses today, extracted to `agentThread/prepareProposal.ts` — it
   validates the payload, captures preconditions server-side (effective workflow spec hash,
   backlog `expectedVersion`s), resolves entity references and navigation ownership, and
   returns either a normalized payload or the same error codes the tool returns.
5. **Idempotency:** inside one transaction, `INSERT` the `widget_action_log` row keyed by
   `operationId`; on a UNIQUE conflict, read the existing `proposal_id` and return that
   proposal's current status/result instead of creating a second proposal. Otherwise
   `createProposal({ threadId: ensureGlobalThread().id, payload, preconditions })` and log it.
   The renderer mints one `operationId` per click and reuses it for any transport retry.
6. `agentProposalExecutor.execute(proposalId)` and return the **discriminated**
   `ExecuteProposalResult` unchanged (`ok:false reason:'claimed' | 'not-found' | …`, `ok:true`
   with `status:'executed' | 'failed'` and per-kind partial results, the edit-workflow
   `superseded` loopback). The widget shows the outcome inline (executed / failed with the
   executor's message / partially applied N of M); a retry is a new click = new
   `operationId`.

The rail's `listProposals` excludes widget proposals with
`LEFT JOIN widget_action_log w ON w.proposal_id = p.id WHERE w.proposal_id IS NULL`.
Recovery paths use the unfiltered `listProposalsByStatus`, which is unchanged.

### 4.5 Shared proposal preparation — `main/src/orchestrator/agentThread/prepareProposal.ts` (new)

The body of `mcpQueryHandler.handleProposeAction` (parse → `parseAgentProposalPayload` →
per-kind enrichment: effective workflow hash, backlog versions, navigation ownership, entity
reference resolution → error codes) moves into `prepareProposal(deps, rawPayload)` returning
`{ ok: true, payload, preconditions } | { ok: false, error, detail }`. The MCP handler and
the widget action service both call it; `cyboflowMcpServerGlobalAgentScope.test.ts` and the
propose-action handler tests pin that the tool's observable replies are unchanged.

### 4.6 tRPC router — `main/src/orchestrator/trpc/routers/customViews.ts` (new), mounted as `cyboflow.customViews`

| procedure | kind | input → output |
|---|---|---|
| `listViews` | query | `{surface}` → `CustomView[]` |
| `getActiveView` | query | `{surface}` → `{ viewId }` (`'default'` when unset or dangling) |
| `setActiveView` | mutation | `{surface, viewId}` |
| `createView` | mutation | `{surface, name, layout}` → `CustomView` (`name_taken`, `unknown_widget`) |
| `updateView` | mutation | `{id, expectedRevision, name?, layout?}` → `CustomView` (`concurrency`) |
| `deleteView` | mutation | `{id}`; clears the active pref if it pointed here |
| `listWidgets` | query | → `CustomWidget[]` (published and/or drafted) |
| `getWidget` | query | `{id}` |
| `publishDraft` / `discardDraft` | mutation | `{id, authoringSessionId}` |
| `deleteWidget` | mutation | `{id}` (`in_use`, `corrupt_layout`) |
| `runWidget` | query | `{ widget: WidgetRef \| { inline: WidgetSpec } \| { draftOf: widgetId }, settings, refreshSec, context:{projectId} }` → `{ sources, warnings, plan?, computedAt, paused? }` (inline specs are validated and are what the inspector's live preview sends; `draftOf` renders a pending draft in the authoring slot) |
| `resetBreaker` | mutation | same key inputs as `runWidget` |
| `previewAction` | query | `{viewId, viewRevision, instanceId, actionId, rowKeyValue?, context}` → `{ label, kind, resolvedParams }` (steps 1-2 of §4.4, no side effects) |
| `executeAction` | mutation | `{operationId, viewId, viewRevision, instanceId, actionId, rowKeyValue?, context}` → `{ navigation? } \| ExecuteProposalResult` |
| `dbSchema` | query | → `Array<{ table, columns:[{name,type,pk,notnull}], rowEstimate }>` from `sqlite_master` + `pragma_table_info` on the sibling handle |
| `onWidgetDraft` | subscription | emits `{ widgetId, authoringSessionId, kind: 'draft' \| 'published' }` (§7.3) |

Context deps added in `context.ts` (all optional, `PRECONDITION_FAILED` when absent, every
`createContext` forwarding site updated): `customViews?: CustomViewsServiceLike` — ONE narrow
interface built in `index.ts` that bundles the store (§3.3), the data service (§4.3), the
action service (§4.4 — which itself receives `ensureGlobalThread`, `createProposal`, the
executor, and the two preference accessors as closures over `DatabaseService`), and
`dbSchema`. Routers import neither `DatabaseService` nor `better-sqlite3`.

## 5. Rendering (renderer)

### 5.1 Catalog registry — `frontend/src/customViews/catalog.tsx` (new)

`CATALOG: Record<CatalogId, CatalogEntry>` where
`CatalogEntry = { id, surface: CustomViewSurface | 'any', category, title, description, settings: WidgetSettingField[], reads: string[], actions: string[], singleton: boolean, spec?: WidgetSpec }`.

Two kinds of entry:

- **Section entries** (tier 1, `surface`-specific, `singleton: true`, no `spec`): the page
  owns their data and callbacks; the registry only describes them. Queue:
  `queue.usage-cards`, `queue.recommended`, `queue.needs-input`, `queue.blocked-runs`,
  `queue.human-tasks`, `queue.ready-for-review`, `queue.notifications`, `queue.working`,
  `queue.backlog`. Overview: `overview.active-agents`, `overview.recommended`,
  `overview.backlog`. Every section keeps its current component and props untouched. The
  library disables a section already present in the draft layout.
- **Spec entries** (tier 2, `surface:'any'`): built-in shape widgets shipped as specs, e.g.
  `insights.daily-usage` (source `query insights.dailyUsage` with settings `groupBy`
  day|week → `bucketDate.unit: { setting: 'groupBy' }` + `group`, `days` 7..365, `project`;
  render `columns`), `insights.workflow-stats` (table), `stats.tokens-today` (stat over
  `run_usage`), `stats.open-review-items` (stat), `sessions.recent` (list with an
  `open-session` row action keyed by `rowKey: 'id'`). These are also the assistant's worked
  examples in the prompt.

### 5.2 Page integration — view-aware render tails, page chrome untouched

`LandingHome` keeps its three early-return layouts (`error`, `no-accounts`, `no-projects`)
exactly as they are — a custom view only applies to the `normal` branch. In that branch the
tail becomes:

```tsx
const sections: Record<QueueSectionId, ReactNode | null> = {
  'queue.usage-cards': <ProviderUsageCards/>, 'queue.recommended': <RecommendedActionsSection …/>,
  'queue.needs-input': showSessionSections ? <NeedsInputSection ref={needsInputRef} …/> : null, …
};
return page(<>
  <QueueHeader … controls={<ViewHeaderControls surface="review-queue"/>}/>
  <ViewSurface surface="review-queue" sections={sections} context={{ projectId: null }}
    chrome={{ afterHeader: stateWells /* caught-up / all-idle / no-sessions, unchanged */ }} />
  {dialogs}
</>);
```

`ViewSurface` (new, `frontend/src/customViews/ViewSurface.tsx`) reads the active view from
`customViewsStore`. In **default** mode it renders `chrome.afterHeader` then the sections in
the canonical order — the exact JSX order today, so the Default view is byte-for-byte the
current page (a `null` section renders nothing, as the conditional does today). In a custom
view it renders `chrome.afterHeader`, then `layout.items` in order: a catalog section ref
pulls from `sections` (`null` stays `null`; a section id not in `sections` — a ref from the
other surface — renders the "unavailable here" state chip); anything else mounts a
`WidgetHost`. Singleton sections cannot repeat (validator + library), so refs stay unique.

Navigation targets that assume a section exists (`focusQueue` scrolling to
`readyRef`/`needsInputRef`, recommendation-driven scrolls at `LandingHome.tsx:443`) are
guarded: when the target section is hidden or absent from the active view, the page scrolls
to the top and skips the flash (a helper `scrollToSectionOrTop(ref)`), and nothing else
changes. `ProjectOverviewPage` gets the same tail treatment with `context={{ projectId }}`;
its launch-error row stays page chrome rendered between the header and the surface exactly
where it is today. Tests cover every `QueuePageState`, both surfaces, and both scroll paths.

### 5.3 `WidgetHost` — `frontend/src/customViews/WidgetHost.tsx` (new)

Owns one layout item: resolves the spec (catalog spec, published custom widget, or — only in
the authoring slot — the draft), polls `customViews.runWidget` imperatively
(`trpc.cyboflow.customViews.runWidget.query`) on mount and every `refreshSec` while
`document.visibilityState === 'visible'`, and renders a frame (title, meta line, state
chrome from the "Widget states" artboard: loading skeleton, empty, error with Retry,
paused/slow with Retry, stale-with-last-good, unavailable-here) around the body:

- `ShapeRenderer` (`shape/*.tsx`): `StatCard`, `DataTable`, `StackedColumns` (extracted from
  `DailyUsageChart`'s SVG so both share one implementation; `DailyUsageChart` becomes a thin
  adapter), `BarList` (reuses `BarRow`), `ItemList`.
- `SandboxedWidgetFrame` (§5.4) for `render.type === 'html'`.
- Actions → `useWidgetActions()`: parent-rendered buttons honour `confirm`; frame requests
  always confirm; both call `previewAction` for the dialog body, then `executeAction` with a
  fresh `operationId`; navigation results go through
  `frontend/src/components/agentRail/proposalNavigation.ts` (already extracted); executor
  results render inline per §4.4 step 6. All controls are disabled while the page is in
  customize mode or the item is unsaved.

### 5.4 Tier 3 sandbox — the loopback **widget document server**

Tier 3 documents are NOT `srcdoc`. An `about:srcdoc` frame is governed by
`shouldBlockArtifactFrameNavigation`, which offers blocked `http(s)` targets to
`shell.openExternal` — for a script-enabled frame that is an exfiltration channel
(`location.href = 'https://host/?data=…'`), documented at `artifactFrameGuard.ts:81`.
The app already has the right primitive for scripted frames: the token-gated loopback
server + the scripted-frame origin registry, whose guard blocks every off-origin navigation
with **no external open**.

`main/src/services/customWidgetServer.ts` (new) generalizes `designPrototypeServer.ts`'s
mechanics (one `http.Server` on `127.0.0.1`, an unguessable per-spawn token, 404 for
anything else, `registerScriptedFrameOrigin` on spawn / unregister on stop, watchdog
target) into a single process-global server that serves
`GET /<token>/widget/<widgetId>/<revision>` (published spec) and
`GET /<token>/widget-draft/<widgetId>/<revision>` (draft spec) with
`Content-Security-Policy: ARTIFACT_INTERACTIVE_CSP` as a **header** and the document built
by `buildWidgetDocument(spec)` (`shared/customViews/widgetDocument.ts`, pinned by tests in
both packages):

1. `<meta http-equiv="Content-Security-Policy">` repeating the header policy
   (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;
   font-src data:; base-uri 'none'; form-action 'none'`). No network of any kind.
2. A theme `<style>` exposing the paper tokens as CSS variables and the base font.
3. The prelude `<script>` defining `window.cyboflow`: `onData(cb)` (called with
   `{ sources, settings, context, theme }` on every refresh), `act(actionId, rowKeyValue?)`
   (posts `{ type:'cyboflow-widget-act', actionId, rowKeyValue }` — a *request*; §4.4),
   `resize()` (posts `document.documentElement.scrollHeight`; parent clamps 80..1200 px).
4. The author's HTML.

Renderer: `window.electronAPI.customWidgetServer.ensure()` → `{ baseUrl, token }` (preload +
IPC mirroring `designPrototypeServer`), then
`<iframe sandbox="allow-scripts" src={…} />`. The frame is cross-origin to the shell, so it
gets its own OOPIF process; without `allow-same-origin` it has no storage; the CSP blocks
subresources; the scripted-frame guard blocks navigation off the origin with no external
open (the server serves nothing but the blessed documents anyway). Parent → frame:
`postMessage({ type:'cyboflow-widget-data', payload }, origin)` targeted at the server origin.
Frame → parent: accepted only when `event.source === iframe.contentWindow` **and**
`event.origin === serverOrigin`.

### 5.5 Store — `frontend/src/stores/customViewsStore.ts` (new, zustand)

State: `viewsBySurface`, `activeViewId` per surface, `widgets` (library), `loaded` flags,
`draft: { surface, layout, baseViewId, baseRevision, dirty } | null` (customize mode),
`authoring: { sessionId, instanceId, mode: 'create' | 'edit', widgetId: string | null } | null`
(the placeholder slot awaiting an assistant-built widget). Widget data is NOT in the store
(owned per `WidgetHost`). Actions: `init(surface)` (opens `onWidgetDraft` before the seed
queries — seed-query + subscription race policy), `setActive`, `enterCustomize`,
`moveItem`, `toggleHidden`, `updateItemSettings`, `removeItem`, `insertItem(at, ref)`,
`save({ mode:'update'|'new', name })` (`update` passes `baseRevision`; `concurrency` surfaces
as "This view changed elsewhere — save as new or discard"), `discard` (also discards a
pending draft widget through `discardDraft` when the authoring session owns it),
`openAuthoring(at | widgetId)` (mints `sessionId`), `onDraftEvent(evt)` (binds only when
`evt.authoringSessionId === authoring.sessionId`; anything else is ignored),
`finishAuthoring()`.

## 6. Customize mode UI

All in `frontend/src/customViews/edit/`, matching the artboards:

- `ViewHeaderControls` — rendered inside `QueueHeader` (a `justify-between` row is added;
  the header's doc comment about "no header-right block" is updated to name this control)
  and beside the overview `<h1>`. Contains the **view switcher** (`Dropdown` primitive:
  Default + named views, corrupt views flagged, footer "Manage views…") and **Customize**
  (`SecondaryButton`). In customize mode the same slot shows **Save** (primary),
  **Save as…**, **Discard**.
- `DraftBanner` — thin strip under the header while `draft` exists ("Customizing · Ship
  week — unsaved"), with the same three buttons for tall pages.
- `EditableBlock` — wraps every rendered item in customize mode: grip (native HTML5
  drag/drop reorder on the stack; keyboard ↑/↓ on the grip for accessibility), eye (hide),
  gear (settings), trash (remove). Hidden items render collapsed with a "Hidden" pill.
- `InsertBar` — the "+ Add widget" bar between blocks; opens `WidgetLibraryModal` with the
  insertion index.
- `WidgetLibraryModal` (`Modal` size `xl`) — categories: Sections (this surface; already
  placed ones disabled), Insights, Stats, Lists, **Mine** (custom widgets with a published
  spec); each card: title, description, Reads/Can do chips; footer CTA **Create a custom
  widget** → §7.1.
- `WidgetSettingsPopover` — from a widget's declared `settings` fields: `select` renders as
  a two/three-option segmented row (composed from `Toggle` pills), `number` as a stepper,
  `project` as a `Dropdown` of projects, `boolean` as `Toggle`; `title` and `refresh`
  always present. Two read-only rows: **Reads** (source names / tables + the breaker or
  plan warnings, plan lines on hover) and **Can do** (action labels). Footer: "Ask the
  assistant" (sends a `contextHint` naming the widget) for catalog widgets, "Edit with
  assistant" for custom ones (§7.3). Changes apply to the draft immediately (`runWidget`
  re-fetches with the new settings).
- `SaveViewDialog` — name field with uniqueness check, "Update <name>" vs "Save as new",
  "Set as active" checkbox (default on).
- `ManageViewsDialog` — rename / delete (delete confirms; Default is not listable).

## 7. Assistant integration

### 7.1 Kickoff — "Create a custom widget" / "Edit with assistant"

The library CTA (or the inspector's "Edit with assistant") calls
`customViewsStore.openAuthoring(...)`, which mints an `authoringSessionId`, places a
placeholder `LayoutItem` (`widget: { type:'custom', widgetId: '' }`) at the insertion index
(create) or marks the existing item (edit), expands the rail (`layoutStore.toggleAgentRail`
when collapsed) and pre-fills the composer with the two-question kickoff from the artboard
(the user sends it; nothing is sent silently). The turn goes through the existing
`agentThreadStore.sendMessage(text, { contextHint })` with a machine-readable envelope:

```
[custom-widget-session]
sessionId=<uuid> surface=review-queue viewName="Ship week" projectId=null
mode=create|edit widgetId=<id when editing>
```

`contextHint` is prompt-only and never persisted (both runtimes), so the transcript stays
clean. The `sessionId` is what ties the assistant's saves back to this slot (§7.3).

### 7.2 New tools — registry entries in `globalAgentTools.ts`, envelopes + handlers in `mcpQueryHandler.ts`

| tool | shape | notes |
|---|---|---|
| `cyboflow_db_schema` | `{ table? }` → tables/columns/row estimates | read-only; replaces the "query sqlite_master" instruction in the prompt |
| `cyboflow_widget_preview` | `{ spec_json, settings_json?, project_id? }` → `runWidget` result (rows capped at 50 for the transcript) + validation errors | runs the exact §4.2 path so what the agent sees is what the widget will get |
| `cyboflow_widget_save` | `{ session_id, widget_id?, name, description?, spec_json, publish: boolean }` → `{ widgetId, revision }` | the second write-shaped tool; it writes ONLY `custom_widgets` (never a view, never entities). `publish:false` saves a draft owned by `session_id`; `publish:true` saves and promotes it. A `widget_id` whose draft is owned by a different live session is refused (`session_mismatch`). Emits `onWidgetDraft`. |

The `McpQueryMessage` union lives in `mcpQueryHandler.ts` (line ~279; `defineTool.ts`
imports it type-only and the ratchet test scans it there) — the three new members
(`mcp-db-schema`, `mcp-widget-preview`, `mcp-widget-save`) are added to that union, to the
registry mappings, and to `handleMessage`'s dispatch with the per-handler global-agent scope
check every existing global tool performs. The registry keeps `spec_json` / `settings_json`
as **string** fields (the registry may import only zod and its siblings, and its JSON-Schema
converter does not take arbitrary unions); the handler decodes and validates with the shared
zod schema and returns `invalid_spec` with the zod issue path. The handler's expected-error
WARN exemption (today only `mcp-db-query`) is extended to `mcp-widget-preview` so a bad
preview SQL logs at WARN like a bad ad-hoc query does.

`cyboflowMcpServerGlobalAgentScope.test.ts` and the ratchet test are updated for the new
entries.

### 7.3 Live landing — drafts vs published

Every `cyboflow_widget_save` emits `onWidgetDraft { widgetId, authoringSessionId, kind }`.
The renderer binds an event to the open slot **only** when the session ids match; a late
event from an earlier session, or one for another surface, is ignored. On `kind:'draft'` the
placeholder becomes a `WidgetHost` rendering `{ draftOf: widgetId }` (the "Custom widget
landed" live preview); on `kind:'published'` the slot's item is rewritten to
`{ type:'custom', widgetId }` and rendering switches to the published spec; the assistant's
own reply is the confirm card ("Saved to your library under Mine"). A widget that only ever
had a draft is not listed under Mine and is deleted when the draft is discarded.

For `mode=edit`, saves target the existing `widgetId`: drafts never overwrite the published
spec, every other surface keeps rendering `published_spec_json` throughout, and only
`publish:true` (or the inspector's "Publish" on the slot) promotes. Discarding the customize
draft discards the widget draft too. `custom_widgets.revision` gates concurrent saves.

### 7.4 Prompt — `agentThreadPrompt.ts`

The existing contract sentence ("your only write-shaped tool records proposals", line ~74)
is revised to name **two** write-shaped tools with disjoint targets: `cyboflow_propose_action`
(proposal rows, human-confirmed) and `cyboflow_widget_save` (the user's own widget library —
`custom_widgets` rows only, no entities, no views). A new "Custom widgets" section (~45
lines) covers: the `WidgetSpec` contract summarized from the shared type file, the workflow
(schema → preview → iterate → save as draft early → publish when the user is happy), the
two worked examples (daily→weekly token usage; a "stale sessions" list with an
`open-session` row action keyed by `rowKey` and a `launch-run` header action), the tier-3
bridge (`cyboflow.onData / act / resize`), and the rules: SELECT-only SQL with `:params`, no
`EXPLAIN` / `WITH RECURSIVE`, respect `WIDGET_LIMITS`, `session_id` comes from the page's
`[custom-widget-session]` envelope. `agentThreadPrompt.test.ts`'s line budget (260) is raised
to 300 in the same commit with the reason in the test; a second pin asserts every render
shape, transform op and the three tool names appear in the prompt (drift guard for the
literals; schema drift is caught by the handler's zod validation, which the prompt tells the
model to read errors from).

## 8. Files touched (summary)

New: `shared/types/customViews.ts`, `shared/customViews/{transform,validate,widgetDocument}.ts`,
`main/src/database/migrations/132_custom_views.sql`, `main/src/orchestrator/readOnlyQuery.ts`,
`main/src/orchestrator/agentThread/prepareProposal.ts`,
`main/src/orchestrator/customViews/{customViewsStore,sourceRunner,widgetDataService,widgetActionService,customViewsService}.ts`,
`main/src/orchestrator/trpc/routers/customViews.ts`, `main/src/orchestrator/insightsInputSchemas.ts`,
`main/src/services/customWidgetServer.ts`, `shared/types/customWidgetServer.ts`,
`frontend/src/stores/customViewsStore.ts`,
`frontend/src/customViews/{catalog.tsx,ViewSurface.tsx,WidgetHost.tsx,SandboxedWidgetFrame.tsx,useWidgetActions.ts,scrollToSectionOrTop.ts,shape/*.tsx,edit/*.tsx}`,
tests beside each.

Modified: `main/src/database/schema.sql`, `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`
(extract + 3 envelopes/handlers), `main/src/orchestrator/mcpServer/toolRegistry/globalAgentTools.ts`,
`main/src/orchestrator/agentThread/{agentThreadPrompt,agentThreadDbStore}.ts` (prompt;
`listProposals` LEFT JOIN), `main/src/orchestrator/agentThread/agentThreadPrompt.test.ts`,
`main/src/orchestrator/trpc/{context,router}.ts`, `main/src/orchestrator/trpc/routers/{agentThread,insights}.ts`,
`main/src/index.ts` (wire `CustomViewsService`, the widget server, the MCP handler deps),
`main/src/preload.ts` + `frontend/src/types/electron.d.ts` (`customWidgetServer.ensure`),
`frontend/src/components/landing/{LandingHome,QueueHeader}.tsx`,
`frontend/src/components/overview/ProjectOverviewPage.tsx`,
`frontend/src/components/Insights/charts/DailyUsageChart.tsx` (adapter over `StackedColumns`),
`docs/SHELL-LAYOUT.md`, `docs/ARCHITECTURE.md` (data model + tool family + widget server),
`docs/README.md`.

## 9. Delivery stages (each stage = green typecheck/lint + its tests, atomic commits per task)

| stage | scope | verification |
|---|---|---|
| S0 | Shared types, zod schemas + `resolveSpecSettings`, `applyTransform`, `buildWidgetDocument` | `shared` unit tests (`main` vitest) |
| S1 | Migration 132 + `schema.sql`, `CustomViewsDbStore` (CAS, parse-based in-use, fail-closed), `listProposals` LEFT JOIN, replay test | store tests on a temp DB; `verify:schema`; `migrationPrefixes.test.ts`; agentThread store tests |
| S2 | `readOnlyQuery.ts` extraction (MCP behaviour pinned), `prepareProposal.ts` extraction (propose-action replies pinned), `sourceRunner` + adapters, `widgetDataService` (cache, per-request freshness, coalescing, breaker, plan lines), `widgetActionService` (consent-free server core: revision check, row resolution, idempotent log, executor result passthrough) | `mcpDbQuery.test.ts` + propose-action tests unchanged and green; new unit tests |
| S3 | tRPC router + `CustomViewsServiceLike` + context wiring + `index.ts`; `customWidgetServer` + preload/IPC + guard registration | router tests with fake ctx (`routers/__tests__` createCaller idiom); server tests modeled on `designPrototypeServer.test.ts`; guard test: off-origin navigation from a widget origin is blocked with no external open |
| S4 | Renderer read path: store, catalog, `ViewSurface` tails in both pages (Default unchanged, chrome explicit, scroll guards), `WidgetHost`, shape renderers, sandbox frame (origin-checked bridge), actions (preview → confirm → execute, frame requests always confirm, disabled in draft) | RTL tests: every `QueuePageState` renders the same section order in default mode; custom layout renders WidgetHost; scroll-or-top; frame ignores wrong-origin messages; action flow incl. `stale_row` / `stale_view` / partial-failure display |
| S5 | Customize mode: header controls, switcher, editable blocks, insert bar, library modal (singleton disable), settings popover, save/manage dialogs (`concurrency` path), draft banner | RTL tests per component + a store test for the draft lifecycle |
| S6 | Assistant: 3 tools + envelopes + handlers, prompt section + budget, kickoff envelope, `onWidgetDraft` session-bound landing, draft/publish/discard, "Edit with assistant" | registry scope/ratchet tests, prompt pin tests, handler tests (`session_mismatch`, `invalid_spec`), store test for slot binding + ignored stale events |
| S7 | Docs (`ARCHITECTURE`, `SHELL-LAYOUT`, `README` index), then the full gate `pnpm typecheck && pnpm lint && pnpm test:unit`, then a dev smoke on a **freshly allocated** data dir (`CYBOFLOW_DIR=$(mktemp -d …) pnpm dev` — never the normal `~/.cyboflow_dev`) | gate green; smoke: create a view, add the daily-usage widget, switch weekly, save, switch views, build one custom widget via the rail (draft → publish), click a row action and a header action, verify the rail shows no widget proposal cards |

## 10. Test plan highlights

- **Read-only guarantee:** the widgets path executes on a `{readonly:true}` handle — an
  `UPDATE` slipped past the validator fails with SQLite's `attempt to write a readonly
  database`; `PRAGMA`/`ATTACH`/multi-statement/`EXPLAIN`/`WITH RECURSIVE` are rejected up
  front with their reason codes; booleans bind as 1/0; a missing param maps to
  `missing_param:x`; an oversized row fails `row_too_large`.
- **Actions never bypass the executor and never trust the client:** fake executor spy; the
  `widget_action_log` + proposal rows exist before `execute` is called; a second call with
  the same `operationId` returns the first proposal without a second insert; unknown
  `actionId`, `stale_view`, `stale_row`, draft-only widgets and template references to
  non-source fields are rejected; `ExecuteProposalResult` passes through unchanged
  (`failed`, partial, `superseded`).
- **Consent:** a frame-originated `act` with `confirm:false` still opens the dialog; the
  dialog body equals `previewAction`'s resolved params.
- **Default view is the current page:** for each `QueuePageState`, the section order rendered
  by `ViewSurface` in default mode equals the hard-coded list, including `null` sections.
- **Frame isolation:** the built doc starts with the CSP meta; the server sends the CSP
  header; the frame has no `allow-same-origin`; the parent ignores messages whose origin or
  source differ; the scripted-frame guard blocks `https://` navigation from a widget origin
  and `shell.openExternal` is never called.
- **Cache/breaker:** two concurrent `runWidget` calls hit the runner once; per-request
  freshness; a slow run flips the key to paused; `resetBreaker` clears it; a settings change
  yields a new key; `nowIso` does not.
- **Drafts:** a draft save leaves `published_spec_json` untouched; publish promotes; discard
  clears; a mismatched `session_id` is refused; the renderer ignores events for other
  sessions.
- **Prompt pins:** literal presence of shapes / ops / tool names; line budget.

## 11. Risks and open decisions

1. **No pre-emptive SQL timeout** (accepted for v1; §4.3). The breaker suppresses repeats;
   the validator, caps, refresh floor and preview-before-save bound the first run.
2. **`LandingHome` refactor blast radius.** Early returns and chrome untouched; only the
   normal branch's section list becomes a map. Per-state order tests guard it.
3. **A second loopback server.** Reuses `designPrototypeServer.ts`'s token/404/watchdog
   mechanics and the same guard registry; one process-global instance for all widgets.
4. **Proposal rows on the global thread, marked via `widget_action_log`,** keep one audit
   trail and one executor without altering `agent_proposals`.
5. **Assistant runtime on Codex** (`assistantRuntime`): the new tools go through the same
   registry, so both runtimes see them; the prompt section is runtime-neutral.
6. **Migration numbering:** 132 is next free on `main` as of 2026-09-10; re-check before
   merge.

## 12. Codex review disposition (2026-09-10)

| # | finding | disposition |
|---|---|---|
| 1 | srcdoc frames exfiltrate via the guard's external-open path | Tier 3 moved to the loopback widget server + scripted-frame registry (§5.4) |
| 2 | bridge `act()` does not prove consent; rows unauthenticated | Frame requests always confirm with server-resolved args; `rowKey` + server-side row resolution (§4.4) |
| 3 | payload parser extraction misses proposal preparation | Whole `prepareProposal` shared (§4.5); `proposalNavigation.ts` reused (§5.3) |
| 4 | no idempotency across clicks/retries | `operationId` + `widget_action_log` UNIQUE (§4.4 step 5) |
| 5 | draft edits overwrite the published widget | `published_spec_json` / `draft_spec_json` split, publish/discard (§3.2, §7.3) |
| 6 | saves not correlated to the slot; no conflict checks | `authoringSessionId` on saves/events; `revision` CAS on views and widgets (§3.1, §7.3) |
| 7 | actions execute a different config than the displayed draft | actions disabled in draft/unsaved; `viewRevision` checked (§4.4) |
| 8 | queue refactor is not an ordered map | early returns + chrome untouched; scroll-or-top; singleton sections; per-state tests (§5.2) |
| 9 | `McpQueryMessage` location wrong | corrected (§7.2) |
| 10 | `origin` column unsafe under 125 replay | no ALTER; `widget_action_log` side table + LEFT JOIN; replay test (§3.2) |
| 11 | query budget not enforceable as described | breaker reframed as repeat suppression; first-run hang accepted explicitly; helper output caps; `row_too_large`; no recursive CTEs (§4.1, §4.3) |
| 12 | SQL params accept unbindable values | `Scalar` only; boolean → 1/0; `iterate(params)`; error mapping (§3.1, §4.1) |
| 13 | weekly knob not expressible; html transform target undefined | `SettingRef` in transforms + `resolveSpecSettings`; `transforms` keyed by source (§3.1) |
| 14 | refresh override never reaches the cache | per-request `refreshSec` freshness; canonical key; `nowIso` excluded (§4.3) |
| 15 | executor result contract lost | discriminated result passed through and shown; WARN exemption extended (§4.4, §7.2) |
| 16 | registry importing shared zod / union schemas | registry keeps string fields; handler validates (§7.2) |
| 17 | substring in-use check | parsed refs, transactional, fail closed; refs validated on save (§3.3) |
| 18 | context deps incomplete | one narrow `CustomViewsServiceLike`; `ensureGlobalThread`; no `DatabaseService` in routers (§4.6) |
| 19 | prompt contradicts existing contract; exceeds line pin | contract sentence revised; budget raised with reason; two pins (§7.4) |
| 20 | scan heuristic misses aliases | plan lines verbatim; generic "full scan" warning, no table attribution (§4.3) |
| 21 | smoke dir not fresh | freshly allocated `CYBOFLOW_DIR` (§9 S7) |
