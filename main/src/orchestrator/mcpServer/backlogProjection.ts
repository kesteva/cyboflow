/**
 * backlogProjection — the READ shapes the MCP backlog tools hand to a flow agent
 * (cyboflow_list_tasks → toCompactTask, cyboflow_get_task → toFullTask).
 *
 * Pure projections over `BacklogTaskItem` (the shared taskListing.ts read
 * model): no database, no side effects. Extracted from mcpQueryHandler.ts under
 * the issue-#19 file-size ratchet; the handler still owns scoping, the
 * approved-design enrichment and the response envelope. `toMcpAttachments`
 * (the attachment path projection, filesystem read-only) lives here too so the
 * run-bound get-task read and the global agent's entity read share it.
 */
import * as path from 'path';
import { existsSync } from 'fs';
import { getCyboflowSubdirectory } from '../../utils/cyboflowDirectory';
import type { BacklogTaskItem, IdeaAttachment } from '../../../../shared/types/tasks';

/**
 * The compact projection cyboflow_list_tasks returns per item — deliberately
 * WITHOUT `body` / `inFlow` / `children` (an agent enumerating the backlog
 * does not need the full markdown spec or the live-run overlay for every
 * row; cyboflow_get_task fetches one item's full body on demand).
 */
export function toCompactTask(item: BacklogTaskItem): Record<string, unknown> {
  return {
    id: item.id,
    ref: item.ref,
    type: item.type,
    title: item.title,
    summary: item.summary,
    priority: item.priority,
    category: item.category,
    // WHO performs the work (migration 137). 'human' work never becomes a
    // sprint lane, so an agent reading this list knows not to plan around it.
    executor: item.executor,
    stage_id: item.stage_id,
    stage_position: item.stage_position,
    parent_epic_id: item.parent_epic_id,
    originating_idea_id: item.originating_idea_id,
    archived: item.archived_at !== null,
    decomposed: item.decomposed_at !== null,
    approved: item.approved_at !== null,
    is_done: item.isDone,
    awaiting_review: item.awaitingReview,
    // Only tasks carry a computed dependency overlay (selectProjectBacklog
    // applies it to type='task' rows only); ideas/epics are never blocked,
    // so an absent overlay defaults to "ready" rather than "unknown".
    ready_to_work: item.readyToWork ?? true,
    blocked_by: (item.blockedBy ?? []).map((dep) => dep.ref),
    // The subset of blocked_by whose prerequisite is a HUMAN task (migration
    // 137). Those edges are real but NON-GATING — they are already excluded
    // from ready_to_work, and this field is why: without it an agent would see
    // a task that is both `ready_to_work: true` and `blocked_by: [TASK-009]`
    // and have no way to tell that contradiction from a bug.
    waiting_on_human: item.waitingOnHuman ?? [],
    version: item.version,
    updated_at: item.updated_at,
  };
}

/**
 * Project a full BacklogTaskItem for cyboflow_get_task. A CURATED ALLOW-LIST,
 * not a pass-through: the fields below are the tool's external contract, and a
 * field newly added to `BacklogTaskItem` is absent here until it is added
 * DELIBERATELY. It does include `body`, `blockedBy`/`relatedTo`/`readyToWork`
 * and (for an epic) `children`/`childCount`/`pendingTasks`.
 *
 * Deliberately omitted:
 *  - `inFlow` — an internal live-run overlay with no stable external contract;
 *  - `memberships` (sprint/experiment labels, TASK-190) — a backlog-UI filter
 *    overlay; no flow agent consumes it, and widening an agent-facing payload
 *    is a product decision, not a projection detail.
 */
export function toFullTask(item: BacklogTaskItem): Record<string, unknown> {
  return {
    id: item.id,
    project_id: item.project_id,
    type: item.type,
    ref: item.ref,
    title: item.title,
    summary: item.summary,
    body: item.body,
    priority: item.priority,
    category: item.category,
    // WHO performs the work (migration 137) — 'agent' on every idea/epic.
    executor: item.executor,
    repo: item.repo,
    parent_epic_id: item.parent_epic_id,
    originating_idea_id: item.originating_idea_id,
    scope: item.scope,
    board_id: item.board_id,
    stage_id: item.stage_id,
    archived_at: item.archived_at,
    decomposed_at: item.decomposed_at,
    approved_at: item.approved_at,
    version: item.version,
    stage_position: item.stage_position,
    awaitingReview: item.awaitingReview,
    isDone: item.isDone,
    blockedBy: item.blockedBy,
    relatedTo: item.relatedTo,
    readyToWork: item.readyToWork,
    // The non-gating slice of blockedBy — prerequisites that are HUMAN tasks
    // (migration 137). Present so a reader can reconcile a task that is
    // readyToWork AND blockedBy something.
    waitingOnHuman: item.waitingOnHuman,
    children: item.children,
    childCount: item.childCount,
    pendingTasks: item.pendingTasks,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

/**
 * Project an idea's image attachments (migration 028) into the MCP read shape
 * for cyboflow_get_task: [{ id, label, mimeType, path }], `path` RESOLVED to
 * an absolute on-disk path — never base64/dataURLs (flow agents fetch bytes
 * themselves via Read). Reuses the EXACT resolution + containment guard the
 * ideas:load-attachments IPC handler applies (main/src/ipc/ideaAttachments.ts)
 * so this read-only surface can never be used to escape the artifacts root:
 * an attachment whose stored path resolves outside CYBOFLOW_DIR/artifacts, or
 * that no longer exists on disk, is silently dropped rather than surfaced.
 */
export function toMcpAttachments(attachments: IdeaAttachment[]): Array<{
  id: string;
  label: string;
  mimeType: string;
  path: string;
}> {
  // Common case (an idea with no attachments — and every epic/task, though those
  // never reach here): nothing to resolve or containment-check, so return early
  // WITHOUT touching getCyboflowSubdirectory. Behaviour-preserving (the loop below
  // would yield [] anyway) and it keeps the read path off the CYBOFLOW_DIR
  // resolver for the zero-attachment majority.
  if (attachments.length === 0) return [];
  const artifactsRoot = path.resolve(getCyboflowSubdirectory('artifacts'));
  const result: Array<{ id: string; label: string; mimeType: string; path: string }> = [];
  for (const att of attachments) {
    const resolved = path.resolve(att.path);
    if (resolved !== artifactsRoot && !resolved.startsWith(artifactsRoot + path.sep)) {
      continue;
    }
    if (!existsSync(resolved)) continue;
    result.push({ id: att.id, label: att.name, mimeType: att.type, path: resolved });
  }
  return result;
}
