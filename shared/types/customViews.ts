/**
 * Shared types for Custom Views (docs/proposals/CUSTOM-VIEWS.md §3.1) — the
 * single cross-package contract for widgets and views. The renderer, the
 * tRPC router, the MCP handler, and the assistant prompt text all import
 * from here; nothing re-declares these shapes locally.
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer).
 */

import type { AgentNavigationTarget, AgentProposalKind } from './agentThread';

// ---------------------------------------------------------------------------
// JSON value (local — no shared JsonValue exists yet; grepped shared/types)
// ---------------------------------------------------------------------------

/** Recursive JSON value — used for action params templates. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// Surfaces and views
// ---------------------------------------------------------------------------

/** The two landing-family pages a view can be attached to. */
export const CUSTOM_VIEW_SURFACES = ['review-queue', 'project-overview'] as const;
export type CustomViewSurface = (typeof CUSTOM_VIEW_SURFACES)[number];

/** Sentinel id of the unmodified page; never stored. */
export const DEFAULT_VIEW_ID = 'default';

/** A saved, named layout for one surface. `revision` is the CAS token for updateView / executeAction. */
export interface CustomView {
  id: string; // uuid
  surface: CustomViewSurface;
  name: string; // unique per surface, case-insensitive, 1..60 chars
  layout: ViewLayout;
  revision: number; // CAS token for updateView / executeAction
  createdAt: string;
  updatedAt: string;
}

/** The ordered widget stack a view renders. `version` is a forward-compat discriminant. */
export interface ViewLayout {
  version: 1;
  items: LayoutItem[];
}

/** One widget placed in a view, with its per-instance settings and overrides. */
export interface LayoutItem {
  instanceId: string; // uuid; stable across edits (cache + action audit key)
  widget: WidgetRef;
  settings: Record<string, Scalar>; // values for the widget's declared settings
  title?: string; // override
  refreshSec?: number; // override; clamped to [WIDGET_LIMITS.minRefreshSec, WIDGET_LIMITS.maxRefreshSec]
  hidden?: boolean;
}

/** A reference to either a built-in catalog entry or a user-owned custom widget. */
export type WidgetRef = { type: 'catalog'; catalogId: string } | { type: 'custom'; widgetId: string };

/** Values SQLite can bind (booleans are normalized to 1/0 before binding). */
export type Scalar = string | number | boolean | null;

// ---------------------------------------------------------------------------
// Custom widgets (library)
// ---------------------------------------------------------------------------

/**
 * A user-owned widget saved to the library ("Mine"). `publishedSpec` is what
 * every non-editing surface renders (null until first publish); `draftSpec`
 * is the assistant's in-progress spec, rendered only in the authoring slot
 * that owns `authoringSessionId`.
 */
export interface CustomWidget {
  id: string;
  name: string;
  description: string | null;
  publishedSpec: WidgetSpec | null; // what every non-editing surface renders; null until first publish
  draftSpec: WidgetSpec | null; // the assistant's in-progress spec; rendered only in the authoring slot
  authoringSessionId: string | null; // token of the authoring session that owns draftSpec
  revision: number;
  threadId: string | null; // agent thread that authored it (audit only)
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Widget spec
// ---------------------------------------------------------------------------

/** The declarative contract of one widget: sources, optional transforms, a render, actions, settings. */
export interface WidgetSpec {
  version: 1;
  sources: Record<string, WidgetSource>; // name -> source; 1..4 entries
  transforms?: Record<string, TransformStep[]>; // keyed by source name; applies to that source's rows
  render: WidgetRender;
  actions?: WidgetAction[]; // 0..6
  settings?: WidgetSettingField[]; // declared knobs (drive the inspector)
  refreshSec?: number; // default WIDGET_LIMITS.defaultRefreshSec
}

/** A named read query: raw SELECT-only SQL, or an allowlisted read helper. */
export type WidgetSource =
  | { type: 'sql'; sql: string; params?: Record<string, SourceParam> } // named :params only
  | { type: 'query'; name: QuerySourceName; input: Record<string, SourceParam> };

/** How one source param resolves at run time. */
export type SourceParam =
  | { literal: Scalar }
  | { setting: string } // LayoutItem.settings[name], falling back to the declared default
  | { context: 'projectId' | 'nowIso' | 'todayIso' };

/**
 * Anywhere a transform takes a value, a setting reference is accepted and
 * resolved server-side BEFORE the spec is hashed or executed.
 */
export type SettingRef = { setting: string };

/**
 * Allowlisted read helpers, resolved server-side to the pure SELECT
 * functions in `main/src/orchestrator/insightsQueries.ts` through one
 * adapter each (their signatures differ).
 */
export const QUERY_SOURCE_NAMES = ['insights.dailyUsage', 'insights.workflowStats', 'insights.usageTrend'] as const;
export type QuerySourceName = (typeof QUERY_SOURCE_NAMES)[number];

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/** A pure, ordered transform step applied to one source's rows. */
export type TransformStep =
  | { op: 'filter'; field: string; cmp: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains'; value: Scalar | Scalar[] | SettingRef }
  | { op: 'sort'; field: string; dir: 'asc' | 'desc' | SettingRef }
  | { op: 'limit'; n: number | SettingRef }
  | { op: 'bucketDate'; field: string; unit: 'day' | 'week' | 'month' | SettingRef; as: string } // ISO input -> 'YYYY-MM-DD' bucket start (UTC, week = Monday)
  | { op: 'group'; by: string[]; aggregates: Array<{ fn: 'sum' | 'count' | 'avg' | 'min' | 'max'; field?: string; as: string }> }
  | { op: 'derive'; as: string; expr: DeriveExpr }; // small arithmetic on numeric fields

/** Small arithmetic on numeric fields/literals; `coalesce` returns the first non-null operand. */
export type DeriveExpr =
  | { add: [Operand, Operand] }
  | { sub: [Operand, Operand] }
  | { mul: [Operand, Operand] }
  | { div: [Operand, Operand] }
  | { coalesce: [Operand, Operand] };

/** One operand of a `derive` expression: a field reference or a numeric literal. */
type Operand = { field: string } | { literal: number };

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Shared numeric-display format used by both the `stat` shape and `table` columns. */
export type WidgetValueFormat = 'number' | 'tokens' | 'usd' | 'percent' | 'duration';

/** How a widget's rows become UI: a tier-2 generic shape, or tier-3 author-supplied HTML. */
export type WidgetRender =
  | { type: 'shape'; shape: 'stat'; source: string; value: string; label?: string; format?: WidgetValueFormat }
  | { type: 'shape'; shape: 'table'; source: string; columns: Array<{ field: string; label?: string; format?: WidgetValueFormat }> }
  | { type: 'shape'; shape: 'columns'; source: string; x: string; series: string; y: string } // stacked columns (DailyUsageChart style)
  | { type: 'shape'; shape: 'bars'; source: string; label: string; value: string } // horizontal BarRow list
  | { type: 'shape'; shape: 'list'; source: string; title: string; subtitle?: string; meta?: string }
  | { type: 'html'; html: string }; // tier 3; receives ALL sources; html <= WIDGET_LIMITS.maxHtmlBytes

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** A CTA on a widget — either a navigation, or a proposal executed through the shared executor. */
export interface WidgetAction {
  id: string;
  label: string;
  kind: AgentProposalKind | 'navigate';
  params: JsonValue; // template: strings "{row.field}" / "{setting.name}" / "{context.projectId}" are substituted
  placement?: 'header' | 'row'; // row actions receive the clicked row
  rowKey?: string; // REQUIRED for placement:'row' — the source column that identifies a row
  /**
   * Only parent-rendered buttons (tier 1/2) may opt out of the confirm
   * dialog. A tier-3 frame's `cyboflow.act()` ALWAYS confirms (§4.4); this
   * flag is ignored for html renders.
   */
  confirm?: boolean;
  navigation?: AgentNavigationTarget | { target: 'backlog' | 'insights' | 'workflows' | 'project-overview'; projectId?: number };
}

// ---------------------------------------------------------------------------
// Settings (declared knobs)
// ---------------------------------------------------------------------------

/** One declared, inspector-editable knob on a widget spec. */
export interface WidgetSettingField {
  name: string;
  label: string;
  kind: 'select' | 'number' | 'project' | 'boolean' | 'text';
  options?: Array<{ value: Scalar; label: string }>; // select
  min?: number;
  max?: number;
  step?: number; // number
  default: Scalar;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const WIDGET_LIMITS = {
  maxSources: 4,
  maxActions: 6,
  maxHtmlBytes: 65_536,
  maxSqlBytes: 8_192,
  maxRows: 500,
  maxRowBytes: 16_384,
  maxPayloadBytes: 250_000,
  minRefreshSec: 15,
  defaultRefreshSec: 60,
  maxRefreshSec: 3600,
  slowQueryMs: 2000,
} as const;

// ---------------------------------------------------------------------------
// Query engine results (main process -> renderer, over runWidget)
// ---------------------------------------------------------------------------

/** The rows and metadata one source produced, after transforms are applied. */
export interface SourceResult {
  columns: string[];
  rows: Array<Record<string, Scalar>>;
  truncated: boolean;
  tookMs: number;
}

/** The full payload `customViews.runWidget` returns for one widget run. */
/** A source slot: its result, or the per-source error that replaced it (§4.2 — one bad
 *  source never fails the whole widget). */
export type SourceOutcome = SourceResult | { error: string };

export interface WidgetDataPayload {
  sources: Record<string, SourceOutcome>;
  warnings: string[];
  plan?: Record<string, string[]>;
  computedAt: string;
  paused?: { tookMs: number };
}
