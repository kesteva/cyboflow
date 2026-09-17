/**
 * WidgetActionService — the SERVER core of a widget CTA
 * (docs/proposals/CUSTOM-VIEWS.md §4.4).
 *
 * Consent lives in the renderer (the confirm dialog a frame-originated request
 * always opens); this class owns everything that must not be client-decided:
 *
 *   - **The view is authoritative.** The layout item, its settings, and the
 *     widget's spec are re-read from the STORE, and the caller's
 *     `viewRevision` must still match — an action never executes against a
 *     layout the user has since changed, nor against an unsaved draft.
 *   - **Row identity is re-derived.** A row action carries only the value of
 *     its declared `rowKey` column. The widget's data is re-run through the
 *     cache and the matching row is found server-side; the templates are
 *     substituted from THAT row, never from client-supplied fields. No match
 *     is `stale_row`.
 *   - **One executor, one audit trail.** Anything that is not pure navigation
 *     goes through the same `prepareProposal` the assistant's tool uses and the
 *     same `agentProposalExecutor`, so a widget click and an assistant proposal
 *     are the same durable object. `widget_action_log` marks which proposals
 *     came from a widget (so the rail can exclude them) and makes a click
 *     idempotent through its UNIQUE `operation_id`.
 */
import type {
  AgentProposal,
  AgentProposalPayload,
  AgentProposalPreconditions,
} from '../../../../shared/types/agentThread';
import type {
  JsonValue,
  LayoutItem,
  Scalar,
  WidgetAction,
  WidgetSpec,
} from '../../../../shared/types/customViews';
import { substituteTemplates } from '../../../../shared/customViews/validate';
import type { ExecuteProposalResult } from '../agentThread/proposalExecutor';
import type { PrepareProposalResult } from '../agentThread/prepareProposal';
import type { DatabaseLike } from '../types';
import type { CustomViewsStoreLike } from './types';
import type { WidgetDataService } from './widgetDataService';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/** Everything that identifies WHICH action on WHICH saved widget instance. */
export interface WidgetActionTarget {
  viewId: string;
  viewRevision: number;
  instanceId: string;
  actionId: string;
  /** The value of `action.rowKey` in the clicked row; required for row actions. */
  rowKeyValue?: Scalar;
  context: { projectId: number | null };
}

/** Why an action could not be resolved. Every one is a refusal, never a throw. */
export type WidgetActionError =
  | 'stale_view'
  | 'not_found'
  | 'invalid_action'
  | 'draft_only'
  | 'stale_row'
  | `invalid_params:${string}`;

export type ResolveActionResult =
  | { ok: true; action: WidgetAction; resolvedParams: JsonValue; item: LayoutItem; spec: WidgetSpec }
  | { ok: false; error: WidgetActionError };

/** The dry run the confirm dialog renders: what will run, with what arguments. */
export interface WidgetActionPreview {
  label: string;
  kind: WidgetAction['kind'];
  resolvedParams: JsonValue;
}

export type ExecuteWidgetActionResult =
  /** navigate / open-session: renderer-only, no proposal row. */
  | { ok: true; navigation: JsonValue }
  /** A repeat of an `operationId` already logged: the FIRST proposal, unchanged. */
  | { ok: true; replay: true; proposal: AgentProposal | null }
  /** The executor's discriminated result, passed through verbatim. */
  | { ok: true; result: ExecuteProposalResult }
  | { ok: false; error: string };

export interface WidgetActionServiceDeps {
  store: CustomViewsStoreLike;
  data: WidgetDataService;
  /** Catalog SPEC entries by id. Section entries have no spec and are absent. */
  catalogSpecs: Record<string, WidgetSpec>;
  db: DatabaseLike;
  ensureGlobalThreadId: () => string;
  createProposal(input: {
    id: string;
    threadId: string;
    payload: AgentProposalPayload;
    preconditions: AgentProposalPreconditions | null;
  }): AgentProposal;
  prepare(raw: unknown): PrepareProposalResult;
  execute(proposalId: string): Promise<ExecuteProposalResult>;
  getProposal(id: string): AgentProposal | null;
  newId(): string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WidgetActionService {
  constructor(private readonly deps: WidgetActionServiceDeps) {}

  /**
   * Steps 1-2 of §4.4 with no side effects: load the saved view, check the
   * revision, resolve the widget's PUBLISHED spec, find the action, re-derive
   * the clicked row server-side, and substitute the templates in `params`.
   */
  async resolve(target: WidgetActionTarget): Promise<ResolveActionResult> {
    const view = this.deps.store.getView(target.viewId);
    // A corrupt layout carries `layout: null` — it is shown in the switcher so
    // the user can delete it, but nothing executes out of one.
    if (!view || view.layout === null) return { ok: false, error: 'not_found' };
    if (view.revision !== target.viewRevision) return { ok: false, error: 'stale_view' };

    const item = view.layout.items.find((candidate) => candidate.instanceId === target.instanceId);
    if (!item) return { ok: false, error: 'not_found' };

    const spec = this.resolveSpec(item);
    if (!spec.ok) return spec;

    const action = (spec.spec.actions ?? []).find((candidate) => candidate.id === target.actionId);
    if (!action) return { ok: false, error: 'invalid_action' };

    const settings = withDeclaredDefaults(spec.spec, item.settings);

    let row: Record<string, Scalar> | undefined;
    if (action.placement === 'row') {
      // A row action with no declared key cannot identify a row at all — that is
      // a spec defect, distinct from "the row is gone".
      if (!action.rowKey) return { ok: false, error: 'invalid_action' };
      if (target.rowKeyValue === undefined || target.rowKeyValue === null) {
        return { ok: false, error: 'stale_row' };
      }
      const found = await this.findRow(spec.spec, item, target, action.rowKey, target.rowKeyValue);
      if (!found) return { ok: false, error: 'stale_row' };
      row = found;
    }

    const substituted = substituteTemplates(action.params, {
      ...(row ? { row } : {}),
      setting: settings,
      context: { projectId: target.context.projectId },
    });
    if (!substituted.ok) return { ok: false, error: `invalid_params:${substituted.error}` };

    return { ok: true, action, resolvedParams: substituted.value, item, spec: spec.spec };
  }

  /** `resolve` shaped for the confirm dialog — the label, the kind, the arguments. */
  async preview(target: WidgetActionTarget): Promise<{ ok: true; preview: WidgetActionPreview } | { ok: false; error: WidgetActionError }> {
    const resolved = await this.resolve(target);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      preview: {
        label: resolved.action.label,
        kind: resolved.action.kind,
        resolvedParams: resolved.resolvedParams,
      },
    };
  }

  /**
   * Resolve, then either navigate (renderer-only) or mint one proposal and run
   * it through the shared executor.
   *
   * `operationId` is minted once per click by the renderer and reused for any
   * transport retry: the `widget_action_log` UNIQUE constraint turns a repeat
   * into a replay of the FIRST proposal rather than a second execution.
   */
  async executeAction(input: WidgetActionTarget & { operationId: string }): Promise<ExecuteWidgetActionResult> {
    const resolved = await this.resolve(input);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { action, resolvedParams } = resolved;

    if (action.kind === 'navigate') {
      // The navigation target is a template too — `{context.projectId}` in a
      // projectId field is the common case.
      const navigation = substituteTemplates((action.navigation ?? null) as JsonValue, {
        setting: withDeclaredDefaults(resolved.spec, resolved.item.settings),
        context: { projectId: input.context.projectId },
      });
      if (!navigation.ok) return { ok: false, error: `invalid_params:${navigation.error}` };
      return { ok: true, navigation: navigation.value };
    }
    if (action.kind === 'open-session') {
      // The executor treats open-session as renderer-only navigation; the
      // resolved params ARE that navigation object.
      return { ok: true, navigation: resolvedParams };
    }

    if (resolvedParams === null || typeof resolvedParams !== 'object' || Array.isArray(resolvedParams)) {
      return { ok: false, error: 'invalid_params:action params must resolve to an object' };
    }

    const prepared = this.deps.prepare({ kind: action.kind, ...resolvedParams });
    if (!prepared.ok) return { ok: false, error: prepared.error };

    const logged = this.logProposal(input, prepared.payload, prepared.preconditions);
    if (logged.replay) {
      return { ok: true, replay: true, proposal: this.deps.getProposal(logged.proposalId) };
    }

    const result = await this.deps.execute(logged.proposalId);
    return { ok: true, result };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The spec this layout item renders. A custom widget executes only from its
   * PUBLISHED spec — a draft is rendered in the authoring slot and never runs
   * actions (`draft_only`).
   */
  private resolveSpec(item: LayoutItem): { ok: true; spec: WidgetSpec } | { ok: false; error: WidgetActionError } {
    if (item.widget.type === 'catalog') {
      const spec = this.deps.catalogSpecs[item.widget.catalogId];
      // Section entries carry no spec (the page owns their data and callbacks),
      // so there is nothing here to resolve an action against.
      if (!spec) return { ok: false, error: 'not_found' };
      return { ok: true, spec };
    }
    const widget = this.deps.store.getWidget(item.widget.widgetId);
    if (!widget) return { ok: false, error: 'not_found' };
    if (!widget.publishedSpec) return { ok: false, error: 'draft_only' };
    return { ok: true, spec: widget.publishedSpec };
  }

  /**
   * Re-run the widget's data through the cache and find the row whose `rowKey`
   * column equals the clicked value. Compared as strings, because the value
   * crossed the wire as JSON and a numeric id may arrive as either.
   */
  private async findRow(
    spec: WidgetSpec,
    item: LayoutItem,
    target: WidgetActionTarget,
    rowKey: string,
    rowKeyValue: Scalar,
  ): Promise<Record<string, Scalar> | undefined> {
    let payload;
    try {
      payload = await this.deps.data.run({
        spec,
        settings: item.settings,
        ...(item.refreshSec !== undefined ? { refreshSec: item.refreshSec } : {}),
        context: { projectId: target.context.projectId },
      });
    } catch {
      // An unresolvable spec here is the same refusal as a missing row: no row
      // could be produced to act on.
      return undefined;
    }

    // A shape render names its source; an html render receives all of them, so
    // the first declared source is the row space its actions address.
    const sourceName =
      spec.render.type === 'shape' ? spec.render.source : Object.keys(spec.sources)[0];
    const slot = sourceName === undefined ? undefined : payload.sources[sourceName];
    if (!slot || 'error' in slot) return undefined;

    const wanted = String(rowKeyValue);
    return slot.rows.find(
      (row) => Object.prototype.hasOwnProperty.call(row, rowKey) && String(row[rowKey]) === wanted,
    );
  }

  /**
   * Mint (or replay) the proposal for one click, inside ONE transaction.
   *
   * The `widget_action_log` row FKs to `agent_proposals`, so the order is:
   * look for an existing `operation_id`, else create the proposal, then log it.
   * The transaction is what makes a race between two retries resolve on the
   * UNIQUE constraint rather than leaving a proposal with no log row.
   */
  private logProposal(
    input: WidgetActionTarget & { operationId: string },
    payload: AgentProposalPayload,
    preconditions: AgentProposalPreconditions | null,
  ): { proposalId: string; replay: boolean } {
    const run = this.deps.db.transaction(() => {
      const existing = this.deps.db
        .prepare('SELECT proposal_id AS proposalId FROM widget_action_log WHERE operation_id = ?')
        .get(input.operationId) as { proposalId?: unknown } | undefined;
      if (existing && typeof existing.proposalId === 'string') {
        return { proposalId: existing.proposalId, replay: true };
      }

      const proposalId = this.deps.newId();
      this.deps.createProposal({
        id: proposalId,
        threadId: this.deps.ensureGlobalThreadId(),
        payload,
        preconditions,
      });
      this.deps.db
        .prepare(
          `INSERT INTO widget_action_log (proposal_id, operation_id, view_id, view_revision, instance_id, action_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(proposalId, input.operationId, input.viewId, input.viewRevision, input.instanceId, input.actionId);
      return { proposalId, replay: false };
    });
    return run() as { proposalId: string; replay: boolean };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The item's settings backfilled with every declared default, so a
 * `{setting.x}` template resolves for a knob the user never touched.
 */
function withDeclaredDefaults(spec: WidgetSpec, settings: Record<string, Scalar>): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const field of spec.settings ?? []) out[field.name] = field.default;
  for (const [name, value] of Object.entries(settings)) out[name] = value;
  return out;
}
