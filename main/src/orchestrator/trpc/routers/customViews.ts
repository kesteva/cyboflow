/**
 * cyboflow.customViews sub-router — the renderer's typed contract for Custom
 * Views (docs/proposals/CUSTOM-VIEWS.md §4.6, §9 row S3).
 *
 * Every procedure is a thin zod-validated wrapper over `CustomViewsServiceLike`
 * (`main/src/orchestrator/customViews/customViewsService.ts`), the ONE narrow
 * dep this router imports — never `DatabaseService`, `better-sqlite3`, or a
 * concrete store/service class, per the standalone-typecheck invariant (see
 * `../context.ts`'s own header comment).
 *
 * Store errors (`CustomViewsStoreError.code`) map onto `TRPCError` codes:
 * `not_found` -> `NOT_FOUND`; every other code (`name_taken` / `concurrency` /
 * `in_use` / `corrupt_layout` / `session_mismatch` / `no_draft` /
 * `unknown_widget` / `draft_only`) -> `CONFLICT` with `message = code` — the
 * renderer switches on the message string, exactly as the widget-action error
 * codes (`stale_view` / `stale_row` / `invalid_action` / `invalid_params:*`)
 * do for `previewAction`. `executeAction` is the one exception: its result is
 * a discriminated union the service NEVER throws to produce, so the mutation
 * returns it unchanged (§4.4 step 6 — "the discriminated result ... passed
 * through unchanged").
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { Context } from '../context';
import type { CustomViewsServiceLike, RunWidgetRef, WidgetDraftEvent } from '../../customViews/customViewsService';
import { CustomViewsStoreError } from '../../customViews/types';
import {
  CUSTOM_VIEW_SURFACES,
  WIDGET_LIMITS,
  type CustomView,
  type CustomWidget,
  type WidgetDataPayload,
} from '../../../../../shared/types/customViews';
import { scalarSchema, viewLayoutSchema, widgetSpecSchema, customViewNameSchema } from '../../../../../shared/customViews/validate';
import type { StoredCustomView } from '../../customViews/types';
import type { ExecuteWidgetActionResult, WidgetActionPreview } from '../../customViews/widgetActionService';
import type { CustomViewsDbSchemaTable } from '../../customViews/customViewsService';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireCustomViews(ctx: Context): CustomViewsServiceLike {
  if (!ctx.customViews) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: '[customViews] CustomViewsService not wired into tRPC context',
    });
  }
  return ctx.customViews;
}

/**
 * `CustomViewsStoreError` -> `NOT_FOUND`/`CONFLICT`; a widget-action error
 * string (`not_found` / `stale_view` / `stale_row` / `invalid_action` /
 * `draft_only` / `invalid_params:*`) or a spec-resolution `invalid_spec:*` ->
 * `NOT_FOUND`/`BAD_REQUEST`/`CONFLICT` by the same convention: the renderer
 * always has a message string to switch on.
 */
function mapServiceError(err: unknown): TRPCError {
  if (err instanceof CustomViewsStoreError) {
    return new TRPCError({
      code: err.code === 'not_found' ? 'NOT_FOUND' : 'CONFLICT',
      message: err.code,
    });
  }
  if (err instanceof Error) {
    if (err.message === 'not_found') {
      return new TRPCError({ code: 'NOT_FOUND', message: err.message });
    }
    if (
      err.message.startsWith('invalid_') ||
      err.message.startsWith('missing_param:') ||
      err.message.startsWith('unbindable_param:')
    ) {
      return new TRPCError({ code: 'BAD_REQUEST', message: err.message });
    }
    return new TRPCError({ code: 'CONFLICT', message: err.message });
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: String(err) });
}

// ---------------------------------------------------------------------------
// zod inputs
// ---------------------------------------------------------------------------

const surfaceSchema = z.enum(CUSTOM_VIEW_SURFACES);
const idSchema = z.string().min(1);
const refreshSecSchema = z.number().int().min(WIDGET_LIMITS.minRefreshSec).max(WIDGET_LIMITS.maxRefreshSec);
const settingsSchema = z.record(scalarSchema);
const contextSchema = z.object({ projectId: z.number().int().positive().nullable() });

/** `WidgetRef | { inline: WidgetSpec } | { draftOf: string }` — §4.6's `runWidget`/`resetBreaker` `widget` input. */
const runWidgetRefSchema: z.ZodType<RunWidgetRef> = z.union([
  z.object({ type: z.literal('catalog'), catalogId: idSchema }),
  z.object({ type: z.literal('custom'), widgetId: idSchema }),
  z.object({ inline: widgetSpecSchema }),
  z.object({ draftOf: idSchema }),
]);

const runWidgetKeyInputSchema = {
  widget: runWidgetRefSchema,
  settings: settingsSchema,
  context: contextSchema,
};

const actionTargetInputSchema = {
  viewId: idSchema,
  viewRevision: z.number().int(),
  instanceId: idSchema,
  actionId: idSchema,
  rowKeyValue: scalarSchema.optional(),
  context: contextSchema,
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const customViewsRouter = router({
  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  listViews: protectedProcedure
    .input(z.object({ surface: surfaceSchema }))
    .query(({ ctx, input }): StoredCustomView[] => {
      return requireCustomViews(ctx).listViews(input.surface);
    }),

  getActiveView: protectedProcedure
    .input(z.object({ surface: surfaceSchema }))
    .query(({ ctx, input }): { viewId: string } => {
      return requireCustomViews(ctx).getActiveView(input.surface);
    }),

  setActiveView: protectedProcedure
    .input(z.object({ surface: surfaceSchema, viewId: idSchema }))
    .mutation(({ ctx, input }): { ok: true } => {
      try {
        requireCustomViews(ctx).setActiveView(input.surface, input.viewId);
        return { ok: true };
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  createView: protectedProcedure
    .input(z.object({ surface: surfaceSchema, name: customViewNameSchema, layout: viewLayoutSchema }))
    .mutation(({ ctx, input }): CustomView => {
      try {
        return requireCustomViews(ctx).createView(input);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  updateView: protectedProcedure
    .input(
      z.object({
        id: idSchema,
        expectedRevision: z.number().int(),
        name: customViewNameSchema.optional(),
        layout: viewLayoutSchema.optional(),
      }),
    )
    .mutation(({ ctx, input }): CustomView => {
      try {
        return requireCustomViews(ctx).updateView(input);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  deleteView: protectedProcedure
    .input(z.object({ id: idSchema }))
    .mutation(({ ctx, input }): { ok: true } => {
      try {
        requireCustomViews(ctx).deleteView(input.id);
        return { ok: true };
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Widgets
  // -------------------------------------------------------------------------

  listWidgets: protectedProcedure.query(({ ctx }): CustomWidget[] => {
    return requireCustomViews(ctx).listWidgets();
  }),

  getWidget: protectedProcedure
    .input(z.object({ id: idSchema }))
    .query(({ ctx, input }): CustomWidget => {
      const widget = requireCustomViews(ctx).getWidget(input.id);
      if (!widget) throw new TRPCError({ code: 'NOT_FOUND', message: 'not_found' });
      return widget;
    }),

  publishDraft: protectedProcedure
    .input(z.object({ id: idSchema, authoringSessionId: idSchema }))
    .mutation(({ ctx, input }): CustomWidget => {
      try {
        return requireCustomViews(ctx).publishDraft(input);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  discardDraft: protectedProcedure
    .input(z.object({ id: idSchema, authoringSessionId: idSchema }))
    .mutation(({ ctx, input }): CustomWidget | null => {
      try {
        return requireCustomViews(ctx).discardDraft(input);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  deleteWidget: protectedProcedure
    .input(z.object({ id: idSchema }))
    .mutation(({ ctx, input }): { ok: true } => {
      try {
        requireCustomViews(ctx).deleteWidget(input.id);
        return { ok: true };
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Query engine
  // -------------------------------------------------------------------------

  runWidget: protectedProcedure
    .input(z.object({ ...runWidgetKeyInputSchema, refreshSec: refreshSecSchema.optional() }))
    .query(async ({ ctx, input }): Promise<WidgetDataPayload> => {
      try {
        return await requireCustomViews(ctx).runWidget({
          widget: input.widget,
          settings: input.settings,
          context: input.context,
          ...(input.refreshSec !== undefined ? { refreshSec: input.refreshSec } : {}),
        });
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  resetBreaker: protectedProcedure
    .input(z.object(runWidgetKeyInputSchema))
    .mutation(({ ctx, input }): { ok: true } => {
      try {
        requireCustomViews(ctx).resetBreaker({
          widget: input.widget,
          settings: input.settings,
          context: input.context,
        });
        return { ok: true };
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  previewAction: protectedProcedure
    .input(z.object(actionTargetInputSchema))
    .query(async ({ ctx, input }): Promise<WidgetActionPreview> => {
      try {
        return await requireCustomViews(ctx).previewAction(input);
      } catch (err) {
        throw mapServiceError(err);
      }
    }),

  executeAction: protectedProcedure
    .input(z.object({ ...actionTargetInputSchema, operationId: idSchema }))
    .mutation(async ({ ctx, input }): Promise<ExecuteWidgetActionResult> => {
      // Returned UNCHANGED — see the module header: this result is a
      // discriminated union the service never throws to produce.
      return requireCustomViews(ctx).executeAction(input);
    }),

  // -------------------------------------------------------------------------
  // Schema introspection
  // -------------------------------------------------------------------------

  dbSchema: protectedProcedure.query(({ ctx }): CustomViewsDbSchemaTable[] => {
    try {
      return requireCustomViews(ctx).dbSchema();
    } catch (err) {
      throw mapServiceError(err);
    }
  }),

  // -------------------------------------------------------------------------
  // onWidgetDraft
  // -------------------------------------------------------------------------

  /**
   * Widget draft/publish notifications (§7.3), emitted by the MCP
   * `cyboflow_widget_save` handler (S6) via `customViews.emitWidgetDraft`. No
   * throttle — saves are human/agent-paced and every one must surface so the
   * renderer's session-bound slot binding (`evt.authoringSessionId ===
   * authoring.sessionId`) never misses a transition.
   */
  onWidgetDraft: protectedProcedure.subscription(async function* ({ ctx, signal }): AsyncGenerator<WidgetDraftEvent> {
    const service = requireCustomViews(ctx);
    const abortSignal = signal ?? new AbortController().signal;
    if (abortSignal.aborted) return;

    const queue: WidgetDraftEvent[] = [];
    let wake: (() => void) | null = null;
    const onEvent = (evt: WidgetDraftEvent): void => {
      queue.push(evt);
      wake?.();
      wake = null;
    };
    const onAbort = (): void => {
      wake?.();
      wake = null;
    };

    const unsubscribe = service.onWidgetDraft(onEvent);
    abortSignal.addEventListener('abort', onAbort, { once: true });
    try {
      while (!abortSignal.aborted) {
        if (queue.length > 0) {
          yield queue.shift() as WidgetDraftEvent;
        } else {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      }
    } finally {
      unsubscribe();
      abortSignal.removeEventListener('abort', onAbort);
    }
  }),
});
