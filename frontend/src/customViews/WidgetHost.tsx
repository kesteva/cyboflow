/**
 * WidgetHost — one layout item: its data poll, its state chrome, and its body
 * (docs/proposals/CUSTOM-VIEWS.md §5.3).
 *
 * ## Why the poll lives here and not in the store
 *
 * Two instances of the same widget with different settings are different data,
 * and the main process already owns the cache, the coalescing and the breaker
 * (§4.3). A renderer-side cache would be a second, weaker copy of that. So each
 * host holds exactly its own payload, keyed by its own item.
 *
 * ## States, from the "Widget states" artboard
 *
 *   - **loading**   — first fetch, nothing to show yet: a skeleton.
 *   - **empty**     — the run succeeded and every source came back with no rows.
 *   - **error**     — the run failed and there is no previous payload: the
 *                     message plus Retry.
 *   - **paused**    — the main process's repeat-suppression breaker tripped on a
 *                     slow run. Retry means `resetBreaker` THEN refetch; a plain
 *                     refetch would just be suppressed again.
 *   - **stale**     — the run failed but a previous payload exists: keep showing
 *                     it, and say so in the status line. Blanking good data
 *                     because a refresh failed is strictly worse than saying the
 *                     data is old.
 *   - **unavailable** — no spec resolves (an unknown catalog id, or a custom
 *                     widget that has only ever been drafted).
 *
 * ## Refresh
 *
 * `refreshSec` comes from the item's override, else the spec, clamped to the
 * shared limits. The interval is suspended while the document is hidden — a
 * backgrounded window polling SQL every 15s is pure waste — and a refetch fires
 * immediately on becoming visible again, so coming back to the app shows fresh
 * data rather than whatever was on screen when it was hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { catalogEntry } from './catalog';
import { useCustomViewsStore } from '../stores/customViewsStore';
import { WidgetFrame, UnavailableBody } from './WidgetFrame';
import { SandboxedWidgetFrame } from './SandboxedWidgetFrame';
import { useWidgetActions } from './useWidgetActions';
import { StatCard } from './shape/StatCard';
import { DataTable } from './shape/DataTable';
import { StackedColumns } from './shape/StackedColumns';
import { BarList } from './shape/BarList';
import { ItemList } from './shape/ItemList';
import { PALETTE } from '../components/Insights/charts/DailyUsageChart';
import { SecondaryButton } from '../components/landing/QueuePrimitives';
import { formatDistanceToNow } from '../utils/timestampUtils';
import {
  WIDGET_LIMITS,
  type LayoutItem,
  type Scalar,
  type SourceResult,
  type WidgetDataPayload,
  type WidgetSpec,
} from '../../../shared/types/customViews';

export interface WidgetHostProps {
  item: LayoutItem;
  /**
   * The resolved spec. Omitted (the ordinary case from `ViewSurface`) resolves
   * it from the store, so callers do not have to duplicate the catalog/library
   * lookup; `null` states explicitly that nothing resolves.
   */
  spec?: WidgetSpec | null;
  context: { projectId: number | null };
  /** True in customize mode — disables every action control. */
  editing?: boolean;
  /** Render the widget's DRAFT document (tier 3, authoring slot only). */
  draft?: boolean;
  /**
   * Reported on every payload change (including back to `null` on unmount's
   * final generation bump never firing this — only real fetches do). S5's
   * `WidgetSettingsPopover` reads it through `ViewSurface`'s per-instance map
   * for the Reads row's live source names + warnings — the host is the only
   * place that ever sees a payload, so anything that wants to show the same
   * data has to be told about it rather than re-fetching it.
   */
  onPayload?: (payload: WidgetDataPayload | null) => void;
}

/** WidgetHost — see {@link WidgetHostProps}. */
export function WidgetHost({
  item,
  spec: specProp,
  context,
  editing = false,
  draft = false,
  onPayload,
}: WidgetHostProps): React.JSX.Element {
  const resolveWidgetSpec = useCustomViewsStore((s) => s.resolveWidgetSpec);
  const widgets = useCustomViewsStore((s) => s.widgets);
  const spec = specProp !== undefined ? specProp : resolveWidgetSpec(item.widget);

  const [payload, setPayload] = useState<WidgetDataPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(spec !== null);

  useEffect(() => {
    onPayload?.(payload);
  }, [onPayload, payload]);

  const refreshSec = clampRefresh(item.refreshSec ?? spec?.refreshSec);
  const settingsKey = JSON.stringify(item.settings);

  // A generation counter beats a per-effect boolean here: Retry fires a fetch
  // OUTSIDE the effect, and both must be able to invalidate each other.
  const generationRef = useRef(0);

  // A draft preview polls the DRAFT spec (`{draftOf}` is the only server
  // path that reads draft_spec_json); the plain `{type:'custom'}` ref always
  // resolves the published spec, which a never-published widget lacks
  // (`draft_only`). Actions stay off the draft path (§4.4).
  const widgetRef = draft && item.widget.type === 'custom' ? { draftOf: item.widget.widgetId } : item.widget;

  const fetchData = useCallback(async (): Promise<void> => {
    if (spec === null) return;
    const generation = ++generationRef.current;
    try {
      const next = await trpc.cyboflow.customViews.runWidget.query({
        widget: widgetRef,
        settings: item.settings,
        context,
        refreshSec,
      });
      if (generationRef.current !== generation) return;
      setPayload(next);
      setError(null);
    } catch (err: unknown) {
      if (generationRef.current !== generation) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generationRef.current === generation) setLoading(false);
    }
    // `item.settings` is compared by its serialization (settingsKey) — a fresh
    // object with identical values must not re-fire the poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.projectId, item.widget.type, draft, refreshSec, settingsKey, spec]);

  // Mount + interval, suspended while the document is hidden.
  useEffect(() => {
    if (spec === null) return;
    let timer: number | null = null;

    const stop = (): void => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const start = (): void => {
      stop();
      timer = window.setInterval(() => void fetchData(), refreshSec * 1000);
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void fetchData();
        start();
      } else {
        stop();
      }
    };

    void fetchData();
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      generationRef.current += 1;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchData, refreshSec, spec]);

  const retry = useCallback((): void => {
    setLoading(payload === null);
    void fetchData();
  }, [fetchData, payload]);

  const resumeFromPaused = useCallback((): void => {
    void (async (): Promise<void> => {
      try {
        await trpc.cyboflow.customViews.resetBreaker.mutate({
          widget: widgetRef,
          settings: item.settings,
          context,
        });
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }
      await fetchData();
    })();
  }, [context, fetchData, item.settings, widgetRef]);

  const actions = useWidgetActions({ instanceId: item.instanceId, spec, context });

  const title = item.title ?? defaultTitle(item, spec);

  if (spec === null) {
    return (
      <WidgetFrame title={title} testId={frameTestId(item)}>
        <UnavailableBody reason="This widget is not available" />
      </WidgetFrame>
    );
  }

  const headerRight = (
    <>
      {actions.headerActions.map((action) => (
        <SecondaryButton
          key={action.id}
          disabled={!actions.enabled || editing || actions.busyActionKey !== null}
          onClick={() => actions.request(action.id)}
          data-testid={`widget-header-action-${action.id}`}
        >
          {action.label}
        </SecondaryButton>
      ))}
    </>
  );

  const meta = payload === null ? undefined : metaLine(payload);
  const paused = payload?.paused;

  // ---- paused ------------------------------------------------------------
  if (paused !== undefined) {
    return (
      <WidgetFrame title={title} meta={meta} testId={frameTestId(item)}>
        <StateWell
          testId="widget-paused"
          text={`Paused — the last run took ${Math.round(paused.tookMs)}ms and repeats are suppressed.`}
          onRetry={resumeFromPaused}
        />
      </WidgetFrame>
    );
  }

  // ---- loading -----------------------------------------------------------
  if (loading && payload === null) {
    return (
      <WidgetFrame title={title} testId={frameTestId(item)}>
        <div data-testid="widget-loading" className="h-20 animate-pulse bg-surface-sunken" />
      </WidgetFrame>
    );
  }

  // ---- error, nothing to fall back on ------------------------------------
  if (payload === null) {
    return (
      <WidgetFrame title={title} testId={frameTestId(item)}>
        <StateWell testId="widget-error" text={error ?? 'This widget could not load.'} onRetry={retry} />
      </WidgetFrame>
    );
  }

  const status =
    error !== null
      ? `Showing the last good data — refresh failed: ${error}`
      : actions.status;

  return (
    <WidgetFrame title={title} meta={meta} headerRight={headerRight} status={status} testId={frameTestId(item)}>
      <WidgetBody
        item={item}
        spec={spec}
        payload={payload}
        context={context}
        widgetsRevision={customWidgetRevision(item, widgets)}
        editing={editing}
        draft={draft}
        actions={actions}
      />
      {actions.dialog}
    </WidgetFrame>
  );
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

interface WidgetBodyProps {
  item: LayoutItem;
  spec: WidgetSpec;
  payload: WidgetDataPayload;
  context: { projectId: number | null };
  widgetsRevision: number | null;
  editing: boolean;
  draft: boolean;
  actions: ReturnType<typeof useWidgetActions>;
}

function WidgetBody({
  item,
  spec,
  payload,
  context,
  widgetsRevision,
  editing,
  draft,
  actions,
}: WidgetBodyProps): React.JSX.Element {
  const disabled = editing || !actions.enabled;

  if (spec.render.type === 'html') {
    if (item.widget.type !== 'custom' || widgetsRevision === null) {
      // Only a SAVED custom widget has a document the server can serve.
      return <UnavailableBody reason="This widget has no published document" />;
    }
    return (
      <SandboxedWidgetFrame
        widgetId={item.widget.widgetId}
        revision={widgetsRevision}
        draft={draft}
        sources={okSources(payload)}
        settings={item.settings}
        context={context}
        onAct={(actionId, rowKeyValue) =>
          actions.request(actionId, rowKeyValue, { fromFrame: true })
        }
      />
    );
  }

  const source = payload.sources[spec.render.source];
  if (source === undefined) {
    return <UnavailableBody reason={`Source '${spec.render.source}' produced nothing`} />;
  }
  if ('error' in source) {
    return <StateWell testId="widget-source-error" text={source.error} />;
  }
  if (source.rows.length === 0) {
    return <StateWell testId="widget-empty" text="Nothing to show yet." />;
  }

  const rows: ReadonlyArray<Record<string, Scalar>> = source.rows;
  const shapeActions = {
    rowActions: actions.rowActions,
    actionsDisabled: disabled,
    busyActionKey: actions.busyActionKey,
    onAction: (actionId: string, rowKeyValue: Scalar) => actions.request(actionId, rowKeyValue),
  };

  switch (spec.render.shape) {
    case 'stat':
      return (
        <StatCard
          rows={rows}
          value={spec.render.value}
          label={spec.render.label}
          format={spec.render.format}
        />
      );
    case 'table':
      return <DataTable rows={rows} columns={spec.render.columns} {...shapeActions} />;
    case 'columns':
      return (
        <StackedColumns
          rows={rows}
          x={spec.render.x}
          series={spec.render.series}
          y={spec.render.y}
          palette={PALETTE}
          testIdPrefix={`widget-columns-${item.instanceId}`}
        />
      );
    case 'bars':
      return <BarList rows={rows} label={spec.render.label} value={spec.render.value} />;
    case 'list':
      return (
        <ItemList
          rows={rows}
          title={spec.render.title}
          subtitle={spec.render.subtitle}
          meta={spec.render.meta}
          {...shapeActions}
        />
      );
    default:
      return <UnavailableBody reason="Unsupported widget shape" />;
  }
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function StateWell({
  testId,
  text,
  onRetry,
}: {
  testId: string;
  text: string;
  onRetry?: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex flex-col items-center gap-2 border border-dashed border-border-primary bg-surface-raised px-[18px] py-5 text-center text-[11px] text-text-tertiary"
    >
      <span>{text}</span>
      {onRetry !== undefined && (
        <SecondaryButton onClick={onRetry} data-testid={`${testId}-retry`}>
          Retry
        </SecondaryButton>
      )}
    </div>
  );
}

function frameTestId(item: LayoutItem): string {
  return `widget-frame-${item.instanceId}`;
}

/** The item's own title, else the catalog entry's, else the raw ref. */
function defaultTitle(item: LayoutItem, spec: WidgetSpec | null): string {
  if (item.widget.type === 'catalog') {
    return catalogEntry(item.widget.catalogId)?.title ?? item.widget.catalogId;
  }
  return spec === null ? 'Widget' : 'Custom widget';
}

/** "sources: usage, stats · updated 2 minutes ago". */
function metaLine(payload: WidgetDataPayload): string {
  const names = Object.keys(payload.sources);
  const when = formatDistanceToNow(payload.computedAt);
  const sources = names.length === 0 ? '' : `${names.join(', ')} · `;
  return `${sources}updated ${when}`;
}

/** Only the sources that produced rows — a tier-3 frame never sees an error slot. */
function okSources(payload: WidgetDataPayload): Record<string, SourceResult> {
  const out: Record<string, SourceResult> = {};
  for (const [name, outcome] of Object.entries(payload.sources)) {
    if (!('error' in outcome)) out[name] = outcome;
  }
  return out;
}

/** The revision the widget document server should serve for a custom ref. */
function customWidgetRevision(
  item: LayoutItem,
  widgets: ReadonlyArray<{ id: string; revision: number }>,
): number | null {
  if (item.widget.type !== 'custom') return null;
  const widgetId = item.widget.widgetId;
  return widgets.find((w) => w.id === widgetId)?.revision ?? null;
}

function clampRefresh(value: number | undefined): number {
  const raw = value ?? WIDGET_LIMITS.defaultRefreshSec;
  return Math.min(WIDGET_LIMITS.maxRefreshSec, Math.max(WIDGET_LIMITS.minRefreshSec, Math.round(raw)));
}
