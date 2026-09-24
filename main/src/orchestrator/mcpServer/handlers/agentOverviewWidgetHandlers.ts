/**
 * AgentOverviewWidgetHandlers — the global agent's cross-project backlog reads
 * (overview / backlog / entity) and the custom-view widget authoring tools
 * (docs/proposals/CUSTOM-VIEWS.md §7.2), split out of mcpQueryHandler.ts
 * (issue #19).
 *
 * Standalone-typecheck invariant (orchestrator/**): no 'electron',
 * 'better-sqlite3', or concrete main/src/services import — the custom-views
 * store arrives through McpQueryHandlerDeps.
 */
import * as net from 'net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scalarSchema, widgetSpecSchema } from '../../../../../shared/customViews/validate';
import { WIDGET_LIMITS } from '../../../../../shared/types/customViews';
import type { Scalar } from '../../../../../shared/types/customViews';
import { CustomViewsStoreError } from '../../customViews/types';
import type { DatabaseLike, LoggerLike } from '../../types';
import {
  resolveBacklogRef,
  selectIdeaAttachments,
  selectProjectBacklog,
  selectTaskById,
} from '../../taskListing';
import { toCompactTask, toFullTask, toMcpAttachments } from '../backlogProjection';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';
import { resolveGlobalAgentContext } from '../globalAgentContext';

/**
 * The context McpQueryHandler composes this family with. `writeResponse` is a
 * private method on the handler, handed over as a closure so the moved bodies
 * keep calling it as `this.writeResponse(...)` unchanged.
 */
export interface AgentOverviewWidgetContext {
  readonly db: DatabaseLike;
  readonly logger?: LoggerLike;
  readonly deps: McpQueryHandlerDeps;
  /** Serialize one reply onto the requesting socket. */
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
}

/**
 * The global agent's read + widget-authoring MCP tool family: `cyboflow_overview`,
 * `cyboflow_backlog`, `cyboflow_entity`, `cyboflow_db_schema`,
 * `cyboflow_widget_preview` and `cyboflow_widget_save`. Split out of
 * McpQueryHandler (issue #19) with every method body verbatim; the handler
 * routes the six message types here.
 */
export class AgentOverviewWidgetHandlers {
  private readonly db: DatabaseLike;
  private readonly logger?: LoggerLike;
  private readonly deps: McpQueryHandlerDeps;
  private readonly writeResponse: AgentOverviewWidgetContext['writeResponse'];

  constructor(ctx: AgentOverviewWidgetContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
    this.deps = ctx.deps;
    this.writeResponse = ctx.writeResponse;
  }

  /**
   * Resolve a display ref (e.g. 'TASK-014') to its opaque id in ANY project.
   * Unlike resolveBacklogRef (single-project-scoped — used by the run-write
   * guarded tools to prevent cross-project ref-probing), the global agent has
   * legitimate cross-project visibility, so an unscoped scan is intended, not
   * a leak. Returns the FIRST match across ideas -> epics -> tasks; a ref
   * collision across two projects is NOT disambiguated here (pass an explicit
   * projectId to disambiguate).
   */
  private resolveBacklogRefAnyProject(ref: string): string | null {
    const tables = ['ideas', 'epics', 'tasks'] as const;
    for (const table of tables) {
      const row = this.db.prepare(`SELECT id FROM ${table} WHERE ref = ? LIMIT 1`).get(ref) as
        | { id: string }
        | undefined;
      if (row) return row.id;
    }
    return null;
  }

  handleAgentOverview(
    msg: Extract<McpQueryMessage, { type: 'mcp-overview' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    const projects = this.db
      .prepare('SELECT id, name FROM projects ORDER BY name')
      .all() as Array<{ id: number; name: string }>;

    interface SessionOverviewRow {
      session_id: string;
      session_name: string;
      session_status: string;
      project_id: number;
      is_quick: number;
      updated_at: string;
      run_id: string | null;
      run_status: string | null;
      current_step_id: string | null;
      workflow_name: string | null;
    }
    // Capped at the 200 most-recently-updated non-archived sessions across
    // every project — "active/recent" per the tool contract, not an
    // exhaustive dump. A run can never be session-less (WorkflowRegistry.
    // createRun's hard invariant), so this single LEFT JOIN also covers every
    // running/awaiting-human run — there is no run reachable ONLY off a
    // session-less path.
    const sessionRows = this.db
      .prepare(
        `SELECT s.id AS session_id, s.name AS session_name, s.status AS session_status,
                s.project_id AS project_id, s.is_quick AS is_quick, s.updated_at AS updated_at,
                wr.id AS run_id, wr.status AS run_status, wr.current_step_id AS current_step_id,
                w.name AS workflow_name
           FROM sessions s
           LEFT JOIN workflow_runs wr ON wr.id = s.run_id
           LEFT JOIN workflows w ON w.id = wr.workflow_id
          WHERE s.archived = 0
          ORDER BY s.updated_at DESC
          LIMIT 200`,
      )
      .all() as SessionOverviewRow[];

    const blockedRows = this.db
      .prepare(
        // audience='machine' items (migration 085) are the orchestrator's durable
        // mailbox — never human-actionable, so they must not inflate this
        // human-facing per-project blocked badge. NULL counts as human (pre-085 /
        // defensive; the NOT NULL default makes NULL impossible post-migration).
        `SELECT project_id, COUNT(*) AS n FROM review_items
          WHERE blocking = 1 AND status = 'pending' AND (audience IS NULL OR audience != 'machine')
          GROUP BY project_id`,
      )
      .all() as Array<{ project_id: number; n: number }>;
    const blockedByProject = new Map(blockedRows.map((r) => [r.project_id, r.n]));

    const questionRows = this.db
      .prepare(
        `SELECT wr.project_id AS project_id, COUNT(*) AS n
           FROM questions q JOIN workflow_runs wr ON wr.id = q.run_id
          WHERE q.status = 'pending'
          GROUP BY wr.project_id`,
      )
      .all() as Array<{ project_id: number; n: number }>;
    const questionsByProject = new Map(questionRows.map((r) => [r.project_id, r.n]));

    const sessionsByProject = new Map<number, Array<Record<string, unknown>>>();
    for (const row of sessionRows) {
      const bucket = sessionsByProject.get(row.project_id) ?? [];
      bucket.push({
        session_id: row.session_id,
        name: row.session_name,
        status: row.session_status,
        is_quick: row.is_quick === 1,
        updated_at: row.updated_at,
        run:
          row.run_id !== null
            ? {
                run_id: row.run_id,
                workflow_name: row.workflow_name,
                status: row.run_status,
                current_step_id: row.current_step_id,
              }
            : null,
      });
      sessionsByProject.set(row.project_id, bucket);
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: {
        projects: projects.map((p) => ({
          project_id: p.id,
          project_name: p.name,
          sessions: sessionsByProject.get(p.id) ?? [],
          blocked_gates_count: blockedByProject.get(p.id) ?? 0,
          pending_questions_count: questionsByProject.get(p.id) ?? 0,
        })),
      },
    });
  }

  handleAgentBacklog(
    msg: Extract<McpQueryMessage, { type: 'mcp-backlog' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    // selectProjectBacklog(db, null) merges EVERY project's backlog into one
    // list — the cross-project read this tool is for. msg.projectId narrows
    // to a single project exactly like cyboflow_list_tasks does.
    const tree = selectProjectBacklog(this.db, msg.projectId ?? null);
    const flat: BacklogTaskItem[] = [];
    for (const item of tree) {
      flat.push(item);
      if (item.type === 'epic' && item.children) {
        flat.push(...item.children);
      }
    }

    const includeArchived = msg.includeArchived ?? false;
    const includeDone = msg.includeDone ?? false;
    const filtered = flat.filter((item) => {
      if (item.archived_at !== null && !includeArchived) return false;
      const isDoneOrRetired = item.isDone === true || item.decomposed_at !== null;
      if (isDoneOrRetired && !includeDone) return false;
      if (msg.taskType !== undefined && item.type !== msg.taskType) return false;
      return true;
    });

    // Cross-project rows need project_id on the wire (the run-scoped
    // toCompactTask omits it — a single-project caller already knows its own
    // project); spread + add rather than duplicate the whole projection.
    const tasks = filtered.map((item) => ({
      ...toCompactTask(item),
      project_id: item.project_id,
    }));

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { tasks, total: tasks.length, hidden_count: flat.length - tasks.length },
    });
  }

  handleAgentEntity(
    msg: Extract<McpQueryMessage, { type: 'mcp-entity' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }

    let item = selectTaskById(this.db, msg.taskId);
    if (!item) {
      const resolvedId =
        msg.projectId !== undefined
          ? resolveBacklogRef(this.db, msg.projectId, msg.taskId)
          : this.resolveBacklogRefAnyProject(msg.taskId);
      if (resolvedId) item = selectTaskById(this.db, resolvedId);
    }

    if (!item || (msg.projectId !== undefined && item.project_id !== msg.projectId)) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }

    // Hide experiment-sandboxed drafts (migration 053): a run-scoped
    // handleGetTask scopes this to the owning arm; the global agent has no
    // arm of its own to scope against, so a tagged row is never safe to
    // surface here — treat it exactly like a genuine miss.
    if (item.experiment_id) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'not_found' });
      return;
    }

    const task = toFullTask(item);
    if (item.type === 'idea') {
      const attachments = selectIdeaAttachments(this.db, item.id);
      task['attachments'] = toMcpAttachments(attachments);
    }

    this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { task } });
  }

  // --------------------------------------------------------------------------
  // Custom-widget authoring tools (cyboflow_db_schema / _widget_preview /
  // _widget_save) — docs/proposals/CUSTOM-VIEWS.md §7.2 / §9 row S6. All three
  // fail closed with 'custom_views_unavailable' when the `customViews` dep is
  // absent, mirroring the workflowConfig / agentThreadStore precedent above.
  // --------------------------------------------------------------------------

  handleDbSchema(
    msg: Extract<McpQueryMessage, { type: 'mcp-db-schema' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const customViews = this.deps.customViews;
    if (!customViews) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'custom_views_unavailable' });
      return;
    }
    const tables = customViews.dbSchema();
    const filtered = msg.table ? tables.filter((t) => t.table === msg.table) : tables;
    this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data: { tables: filtered } });
  }

  async handleWidgetPreview(
    msg: Extract<McpQueryMessage, { type: 'mcp-widget-preview' }>,
    client: net.Socket,
  ): Promise<void> {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const customViews = this.deps.customViews;
    if (!customViews) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'custom_views_unavailable' });
      return;
    }

    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(msg.specJson);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_json' });
      return;
    }
    const parsedSpec = widgetSpecSchema.safeParse(rawSpec);
    if (!parsedSpec.success) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'invalid_spec',
        data: { detail: parsedSpec.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
      });
      return;
    }

    let settings: Record<string, Scalar> = {};
    if (msg.settingsJson !== undefined) {
      let rawSettings: unknown;
      try {
        rawSettings = JSON.parse(msg.settingsJson);
      } catch {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_settings' });
        return;
      }
      const parsedSettings = z.record(scalarSchema).safeParse(rawSettings);
      if (!parsedSettings.success) {
        this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_settings' });
        return;
      }
      settings = parsedSettings.data;
    }

    // Errors from here (e.g. `invalid_spec:<message>` when a setting doesn't
    // resolve against the spec's declared settings) propagate to
    // handleMessage's outer try/catch, which — via the WARN exemption above —
    // logs this as a caller error, not an app fault: the spec is agent-authored.
    const payload = await customViews.runWidget({
      widget: { inline: parsedSpec.data },
      settings,
      refreshSec: WIDGET_LIMITS.minRefreshSec,
      context: { projectId: msg.projectId ?? null },
    });

    // Cap each source's rows to 50 for the transcript — the real page is not
    // capped this way; this only bounds what goes back over the wire to the
    // model.
    const sources: Record<string, unknown> = {};
    for (const [name, outcome] of Object.entries(payload.sources)) {
      if ('error' in outcome) {
        sources[name] = outcome;
        continue;
      }
      const cappedRows = outcome.rows.slice(0, 50);
      sources[name] = {
        columns: outcome.columns,
        rows: cappedRows,
        truncated: outcome.truncated,
        tookMs: outcome.tookMs,
        ...(cappedRows.length < outcome.rows.length ? { truncatedForTranscript: true } : {}),
      };
    }

    this.writeResponse(client, {
      type: 'mcp-query-response',
      requestId: msg.requestId,
      ok: true,
      data: { sources, warnings: payload.warnings, plan: payload.plan, paused: payload.paused },
    });
  }

  handleWidgetSave(
    msg: Extract<McpQueryMessage, { type: 'mcp-widget-save' }>,
    client: net.Socket,
  ): void {
    const ctx = resolveGlobalAgentContext(msg.runId);
    if (!ctx.ok) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: ctx.error });
      return;
    }
    const customViews = this.deps.customViews;
    if (!customViews) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'custom_views_unavailable' });
      return;
    }

    let rawSpec: unknown;
    try {
      rawSpec = JSON.parse(msg.specJson);
    } catch {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'invalid_json' });
      return;
    }
    const parsedSpec = widgetSpecSchema.safeParse(rawSpec);
    if (!parsedSpec.success) {
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: false,
        error: 'invalid_spec',
        data: { detail: parsedSpec.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
      });
      return;
    }

    // No authoring session = the user asked from the rail, not from
    // Customize -> Create a custom widget. Publish straight into the library
    // under a throwaway session id: publishDraft clears authoring_session_id,
    // so nothing is left claimed, and the library refresh the draft event
    // triggers on every surface makes it show up under "Mine". A draft-only
    // save has no slot to render in, so it is refused rather than orphaned.
    if (msg.sessionId === undefined && !msg.publish) {
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: 'draft_needs_session' });
      return;
    }
    const authoringSessionId = msg.sessionId ?? `library:${randomUUID()}`;

    try {
      const widget = customViews.saveWidget({
        id: msg.widgetId,
        name: msg.name,
        description: msg.description ?? null,
        spec: parsedSpec.data,
        authoringSessionId,
        threadId: ctx.threadId,
        publish: msg.publish,
      });
      this.writeResponse(client, {
        type: 'mcp-query-response',
        requestId: msg.requestId,
        ok: true,
        data: { widgetId: widget.id, revision: widget.revision },
      });
    } catch (err) {
      const error = err instanceof CustomViewsStoreError ? err.code : err instanceof Error ? err.message : String(err);
      this.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error });
    }
  }
}
