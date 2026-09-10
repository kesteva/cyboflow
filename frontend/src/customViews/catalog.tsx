/**
 * CATALOG — the built-in widget registry the library modal, the inspector and
 * `ViewSurface` all read (docs/proposals/CUSTOM-VIEWS.md §5.1).
 *
 * Two kinds of entry, distinguished by whether they carry a `spec`:
 *
 *   - **Section entries** (tier 1, `singleton: true`, no `spec`). These name a
 *     section the PAGE already owns and renders — its data, its callbacks, its
 *     component, all untouched. The registry only describes it, so the library
 *     card can say what it shows and the layout can reference it by id. A
 *     section is surface-specific: `queue.*` only exists on the review queue,
 *     `overview.*` only on the project overview.
 *   - **Spec entries** (tier 2, `surface: 'any'`). Real `WidgetSpec`s from
 *     `shared/customViews/catalogSpecs.ts` — the one place main AND the
 *     renderer both read them from, so a built-in can never drift between the
 *     runner that executes it and the card that advertises it. Their `settings`
 *     are DERIVED from the spec (never re-typed here) for the same reason.
 *
 * `singleton: true` on the section entries is what makes `ViewSurface`'s
 * "pull the node out of the `sections` map" lookup total: a section id can
 * appear at most once in a layout, so a ref always maps to exactly one node.
 * Spec entries are not singletons — the same chart pinned to two projects is a
 * legitimate layout.
 *
 * This file is `.tsx` (not `.ts`) so S5's library cards can grow inline icon
 * nodes here without a rename; it currently exports values only.
 */
import type { CustomViewSurface, WidgetSettingField, WidgetSpec } from '../../../shared/types/customViews';
import { CATALOG_WIDGET_SPECS } from '../../../shared/customViews/catalogSpecs';

// ---------------------------------------------------------------------------
// Entry shape
// ---------------------------------------------------------------------------

/** Library grouping for the "Add widget" modal's sections. */
export type CatalogCategory = 'queue' | 'overview' | 'insights' | 'stats' | 'sessions';

export interface CatalogEntry {
  id: string;
  /** `'any'` = placeable on both surfaces; a surface name pins it to that page. */
  surface: CustomViewSurface | 'any';
  category: CatalogCategory;
  /** Card headline, and the default widget-frame title. */
  title: string;
  /** One muted sentence on the library card. */
  description: string;
  /** Inspector knobs. Section entries declare none; spec entries mirror their spec. */
  settings: WidgetSettingField[];
  /** What the widget reads, in human words — the card's "Reads" line. */
  reads: string[];
  /** What the widget can DO, in human words — the card's "Actions" line. */
  actions: string[];
  /** True when at most ONE instance may exist in a layout (every section entry). */
  singleton: boolean;
  /** Present only on tier-2 spec entries; absent on section entries. */
  spec?: WidgetSpec;
}

// ---------------------------------------------------------------------------
// Canonical default orders
// ---------------------------------------------------------------------------

/**
 * The Human Review Queue's section order — the EXACT JSX order of
 * `LandingHome`'s normal branch. `ViewSurface` renders this list in Default
 * mode, so the Default view is the current page rather than a reconstruction
 * of it. Changing this array changes the page.
 */
export const QUEUE_SECTION_ORDER = [
  'queue.usage-cards',
  'queue.recommended',
  'queue.needs-input',
  'queue.blocked-runs',
  'queue.human-tasks',
  'queue.ready-for-review',
  'queue.notifications',
  'queue.working',
  'queue.backlog',
] as const;
export type QueueSectionId = (typeof QUEUE_SECTION_ORDER)[number];

/** The Project Overview's section order — the exact JSX order of that page. */
export const OVERVIEW_SECTION_ORDER = [
  'overview.active-agents',
  'overview.recommended',
  'overview.backlog',
] as const;
export type OverviewSectionId = (typeof OVERVIEW_SECTION_ORDER)[number];

export type SectionId = QueueSectionId | OverviewSectionId;

/** The canonical section order for one surface. */
export function sectionOrderFor(surface: CustomViewSurface): readonly string[] {
  return surface === 'review-queue' ? QUEUE_SECTION_ORDER : OVERVIEW_SECTION_ORDER;
}

// ---------------------------------------------------------------------------
// Section entries
// ---------------------------------------------------------------------------

function section(
  id: SectionId,
  surface: CustomViewSurface,
  category: CatalogCategory,
  title: string,
  description: string,
  reads: string[],
  actions: string[],
): CatalogEntry {
  return { id, surface, category, title, description, settings: [], reads, actions, singleton: true };
}

const SECTION_ENTRIES: CatalogEntry[] = [
  section(
    'queue.usage-cards',
    'review-queue',
    'queue',
    'Provider usage',
    'Per-provider plan usage and reset windows for every connected agent account.',
    ['Provider accounts', 'Usage windows'],
    ['Connect an account'],
  ),
  section(
    'queue.recommended',
    'review-queue',
    'queue',
    'Recommended actions',
    'What to do next, ranked — with the dismissed cards tucked behind a toggle.',
    ['Ideas', 'Tasks', 'Runs', 'Verification setup'],
    ['Run the suggested flow', 'Dismiss a card'],
  ),
  section(
    'queue.needs-input',
    'review-queue',
    'queue',
    'Needs your input',
    'Blocked sessions, decision review items, and pending tool approvals in one list.',
    ['Quick sessions', 'Review items', 'Approvals'],
    ['Open the session', 'Approve or deny'],
  ),
  section(
    'queue.blocked-runs',
    'review-queue',
    'queue',
    'Blocked runs',
    'Flow runs parked on a blocking finding, oldest first.',
    ['Workflow runs', 'Blocking findings'],
    ['Open the run'],
  ),
  section(
    'queue.human-tasks',
    'review-queue',
    'queue',
    'Human tasks',
    'Review-queue items an agent filed for a person to do by hand.',
    ['Review items'],
    ['Resolve the item'],
  ),
  section(
    'queue.ready-for-review',
    'review-queue',
    'queue',
    'Ready for review',
    'Finished sessions and runs waiting to be merged, dismissed, or read.',
    ['Quick sessions', 'Workflow runs', 'Experiments'],
    ['Merge', 'Dismiss', 'Open'],
  ),
  section(
    'queue.notifications',
    'review-queue',
    'queue',
    'Notifications',
    'Informational review items — no decision needed, just a read and a dismiss.',
    ['Review items'],
    ['Dismiss'],
  ),
  section(
    'queue.working',
    'review-queue',
    'queue',
    'Working',
    'Everything running right now: flow runs, quick sessions, dynamic workflows.',
    ['Workflow runs', 'Quick sessions', 'Dynamic workflows'],
    ['Open the session'],
  ),
  section(
    'queue.backlog',
    'review-queue',
    'queue',
    'Backlog',
    'The planning funnel plus the two launch surfaces — ideas to planner, tasks to sprint.',
    ['Ideas', 'Epics', 'Tasks', 'Boards'],
    ['Add an idea', 'Launch planner', 'Launch sprint'],
  ),
  section(
    'overview.active-agents',
    'project-overview',
    'overview',
    'Active agents',
    'What is live in this project right now, with each run’s current phase.',
    ['Workflow runs', 'Quick sessions', 'Approvals'],
    ['Open the run or session'],
  ),
  section(
    'overview.recommended',
    'project-overview',
    'overview',
    'Recommended actions',
    'The project’s ranked next steps, with the dismissed ones behind a toggle.',
    ['Ideas', 'Tasks', 'Workflow stats', 'Tracker connections'],
    ['Run a flow', 'Pick a task batch', 'Dismiss a card'],
  ),
  section(
    'overview.backlog',
    'project-overview',
    'overview',
    'Backlog',
    'This project’s planning pipeline and its two launch surfaces.',
    ['Ideas', 'Tasks', 'Board stages'],
    ['Open the backlog', 'Launch planner'],
  ),
];

// ---------------------------------------------------------------------------
// Spec entries
// ---------------------------------------------------------------------------

/**
 * Wrap one shared `WidgetSpec` as a library entry. `settings` is read OFF the
 * spec — the inspector and the runner must agree on the knob list, and the
 * only way to guarantee that is to have exactly one source for it.
 */
function specEntry(
  id: string,
  category: CatalogCategory,
  title: string,
  description: string,
  reads: string[],
  actions: string[],
): CatalogEntry {
  const spec = CATALOG_WIDGET_SPECS[id];
  if (spec === undefined) {
    throw new Error(`[catalog] no shared spec for catalog id '${id}'`);
  }
  return {
    id,
    surface: 'any',
    category,
    title,
    description,
    settings: spec.settings ?? [],
    reads,
    actions,
    singleton: false,
    spec,
  };
}

const SPEC_ENTRIES: CatalogEntry[] = [
  specEntry(
    'insights.daily-usage',
    'insights',
    'Token usage over time',
    'Stacked columns of token spend per model, daily or weekly, over a lookback window.',
    ['Run usage'],
    [],
  ),
  specEntry(
    'insights.workflow-stats',
    'insights',
    'Workflow outcomes',
    'A table of runs per workflow: total, completed, failed, and still active.',
    ['Workflow runs'],
    [],
  ),
  specEntry(
    'stats.tokens-today',
    'stats',
    'Tokens today',
    'A single figure: every token billed against runs today.',
    ['Run usage'],
    [],
  ),
  specEntry(
    'stats.open-review-items',
    'stats',
    'Open review items',
    'A single figure: how many review-queue items are still pending.',
    ['Review items'],
    [],
  ),
  specEntry(
    'sessions.recent',
    'sessions',
    'Recent sessions',
    'The twenty most recently touched sessions, each with an Open button.',
    ['Sessions'],
    ['Open the session'],
  ),
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Every built-in entry, keyed by catalog id. */
export const CATALOG: Record<string, CatalogEntry> = Object.fromEntries(
  [...SECTION_ENTRIES, ...SPEC_ENTRIES].map((entry) => [entry.id, entry]),
);

/** One entry, or `null` for an id this build does not know (a stale layout). */
export function catalogEntry(id: string): CatalogEntry | null {
  return CATALOG[id] ?? null;
}

/** True when the id names a tier-1 page section rather than a runnable spec. */
export function isSectionEntry(entry: CatalogEntry): boolean {
  return entry.spec === undefined;
}

/**
 * Everything placeable on `surface`, in library order: that surface's sections
 * in canonical page order first, then the surface-agnostic spec widgets.
 */
export function catalogEntriesFor(surface: CustomViewSurface): CatalogEntry[] {
  const sections = sectionOrderFor(surface)
    .map((id) => CATALOG[id])
    .filter((entry): entry is CatalogEntry => entry !== undefined);
  return [...sections, ...SPEC_ENTRIES];
}
