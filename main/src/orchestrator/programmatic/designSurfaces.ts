/**
 * composeDesignSurfaces — the `# Design surfaces` block threaded into every step
 * prompt of a sprint / ship run.
 *
 * WHY IT EXISTS. A design is approved in one run (Launch or Planner) and built in
 * another (Sprint or Ship), and nothing carried it across. The prototype is a RUN
 * artifact — it belongs to the run that drew it, no MCP tool on a sprint lane can
 * read it, and it is cascade-deleted with that run — so the lane that implements
 * the screens has literally never seen the design it is supposed to match. The
 * observed result (Distractodo post-mortem) is a build that ships placeholder
 * screens no navigation reaches while the approved mockup shows a finished flow.
 *
 * What survives the design run is durable and idea-bound: the `approved_designs`
 * snapshot path (written by the gate's side-effects, on disk outside the run's
 * artifact tree) and the idea body's `## Design spec` section. This module reads
 * both back at the sprint's own step boundaries, keyed off the tasks in the run's
 * batch, and renders them as one prompt section.
 *
 * SHAPE. Batch tasks → their distinct originating ideas (task → own idea, else
 * task → epic → idea, the taskChangeRouter lineage chain) → for each idea with a
 * current approved design and/or a design-spec section, one block naming the
 * snapshot path, the approval date, and the spec verbatim, plus the task refs in
 * THIS batch that belong to it. An idea with neither is omitted entirely; nothing
 * qualifying at all yields `undefined`, so every run that has no approved design
 * gets a byte-identical prompt to before this existed.
 *
 * Fail-soft by construction: every read is wrapped, and any throw (a missing
 * table on an old DB, an unparseable row) degrades to `undefined` rather than
 * failing the step. A design section is an enrichment; losing it must never fail
 * a sprint.
 */
import type { DatabaseLike } from '../types';
import { extractDesignSpecSection } from '../../../../shared/types/artifacts';
import { getCurrentApprovedDesign } from '../design/approvedDesigns';

/** One idea's design surface, as rendered. */
interface IdeaDesignSurface {
  ideaRef: string;
  ideaTitle: string;
  /** Task refs IN THIS BATCH that trace back to this idea, in batch order. */
  taskRefs: string[];
  snapshotPath?: string;
  approvedAt?: string;
  source?: string;
  designSpec?: string;
}

interface BatchTaskRow {
  taskId?: string | null;
  taskRef?: string | null;
  originatingIdeaId?: string | null;
  parentEpicId?: string | null;
}

interface IdeaRow {
  id?: string | null;
  ref?: string | null;
  title?: string | null;
  body?: string | null;
}

/**
 * The run's batch tasks with their lineage columns, in batch insertion order.
 * Empty for a run with no batch (planner/launch), which is the fast exit.
 */
function readBatchTasks(db: DatabaseLike, runId: string): BatchTaskRow[] {
  const rows = db
    .prepare(
      `SELECT t.id AS taskId, t.ref AS taskRef,
              t.originating_idea_id AS originatingIdeaId,
              t.parent_epic_id AS parentEpicId
         FROM sprint_batch_tasks sbt
         JOIN workflow_runs r ON r.batch_id = sbt.batch_id
         JOIN tasks t ON t.id = sbt.task_id
        WHERE r.id = ?
        ORDER BY sbt.id ASC`,
    )
    .all(runId) as BatchTaskRow[];
  return rows;
}

/** An epic's originating idea id, or null. */
function readEpicIdeaId(db: DatabaseLike, epicId: string): string | null {
  const row = db
    .prepare('SELECT originating_idea_id AS ideaId FROM epics WHERE id = ? LIMIT 1')
    .get(epicId) as { ideaId?: string | null } | undefined;
  return typeof row?.ideaId === 'string' && row.ideaId.length > 0 ? row.ideaId : null;
}

/** An idea's ref/title/body, or null when the row is gone. */
function readIdea(db: DatabaseLike, ideaId: string): IdeaRow | null {
  const row = db
    .prepare('SELECT id, ref, title, body FROM ideas WHERE id = ? LIMIT 1')
    .get(ideaId) as IdeaRow | undefined;
  return row ?? null;
}

/**
 * The design surfaces covering a sprint/ship run's batch, as a ready-to-render
 * prompt section — or `undefined` when the run has no batch, no traceable ideas,
 * or no idea with either an approved design or a design-spec section.
 */
export function composeDesignSurfaces(db: DatabaseLike, runId: string): string | undefined {
  let surfaces: IdeaDesignSurface[];
  try {
    const tasks = readBatchTasks(db, runId);
    if (tasks.length === 0) return undefined;

    // Distinct ideas, first-seen order, each carrying the batch task refs that
    // reached it. A task with no lineage at all (neither its own idea nor an
    // epic with one) simply contributes nothing — it is not an error.
    const byIdea = new Map<string, string[]>();
    for (const task of tasks) {
      const taskRef = typeof task.taskRef === 'string' ? task.taskRef : '';
      let ideaId = typeof task.originatingIdeaId === 'string' ? task.originatingIdeaId : '';
      if (ideaId.length === 0 && typeof task.parentEpicId === 'string' && task.parentEpicId.length > 0) {
        ideaId = readEpicIdeaId(db, task.parentEpicId) ?? '';
      }
      if (ideaId.length === 0) continue;
      const refs = byIdea.get(ideaId);
      if (refs) {
        if (taskRef.length > 0) refs.push(taskRef);
      } else {
        byIdea.set(ideaId, taskRef.length > 0 ? [taskRef] : []);
      }
    }
    if (byIdea.size === 0) return undefined;

    surfaces = [];
    for (const [ideaId, taskRefs] of byIdea) {
      const idea = readIdea(db, ideaId);
      if (!idea) continue;
      const design = getCurrentApprovedDesign(db, ideaId);
      const designSpec = extractDesignSpecSection(idea.body ?? null);
      // The whole point of the section is a design a builder can read. An idea
      // with neither a snapshot nor a spec has nothing to say here.
      if (!design && (designSpec === null || designSpec.trim().length === 0)) continue;
      surfaces.push({
        ideaRef: typeof idea.ref === 'string' && idea.ref.length > 0 ? idea.ref : ideaId,
        ideaTitle: typeof idea.title === 'string' ? idea.title : '',
        taskRefs,
        ...(design
          ? { snapshotPath: design.snapshotPath, approvedAt: design.approvedAt, source: design.source }
          : {}),
        ...(designSpec !== null && designSpec.trim().length > 0 ? { designSpec: designSpec.trim() } : {}),
      });
    }
  } catch {
    return undefined;
  }
  if (surfaces.length === 0) return undefined;

  const blocks = surfaces.map((s) => {
    const heading = s.ideaTitle.length > 0 ? `## ${s.ideaRef} · ${s.ideaTitle}` : `## ${s.ideaRef}`;
    const tasks = s.taskRefs.length > 0 ? `  (tasks: ${s.taskRefs.join(', ')})` : '';
    const lines: string[] = [`${heading}${tasks}`];
    if (s.snapshotPath !== undefined) {
      const meta = [
        s.approvedAt !== undefined && s.approvedAt.length > 0 ? `approved ${s.approvedAt}` : '',
        s.source !== undefined && s.source.length > 0 ? `source: ${s.source}` : '',
      ].filter((part) => part.length > 0);
      lines.push(
        `Approved design snapshot: ${s.snapshotPath}${meta.length > 0 ? `  (${meta.join(', ')})` : ''}`,
      );
    }
    if (s.designSpec !== undefined) {
      lines.push('', s.designSpec);
    }
    return lines.join('\n');
  });

  return [
    '# Design surfaces',
    '',
    "These are the APPROVED designs the tasks below must match — approved by a human in an earlier run, and the reason those tasks exist. Read each snapshot with the Read tool before you build any screen it shows; it is a static HTML file on disk, not a URL. Match its layout and its copy strings. Every screen named here must be reachable from the app's entry point by real navigation, and no task may leave a placeholder, a stub, or a disabled control where the design shows a working screen.",
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
