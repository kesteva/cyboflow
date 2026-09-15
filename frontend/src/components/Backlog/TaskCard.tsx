/**
 * TaskCard / TaskChildren — the card (Kanban) and the inner task body shared by
 * both Kanban cards and List rows.
 *
 * A card shows: a project chip row (All-projects view only, above the tag
 * pills); type tag, priority tag, FlowMarker(s) (multiple when parallel runs),
 * ReviewMarker, DoneFlag, the display ref; the title; the summary; and a
 * footer with repo, compact "Nm ago", and the per-card primary action — "Run"
 * for epics/tasks, **"Open"** for ideas (idea sessions plan, Stage 4:
 * find-or-create the idea's persistent home session; unlike Run, never
 * disabled by `inFlow`/In-development — opening the home is always valid —
 * but disabled with a reason for an archived idea, since the door rejects
 * one). Epics show an expand control ("N tasks") that reveals nested
 * {@link TaskChildren}.
 *
 * Archive-in-place: an archived item (`archived_at` stamped) only reaches a card
 * while the header Archived toggle is on — it then renders dimmed (opacity-60)
 * with an ArchivedChip next to its type tag. Children arrive PRE-FILTERED from
 * filterTasks (archived children already dropped, childCount recomputed), so
 * the card renders `task.children` as given — it never refetches/refilters.
 *
 * The card body itself carries no drag handlers — same-column drag-and-drop
 * lives on the wrapper slot in KanbanView (which sets `draggable`). The
 * breathing-glow on an in-flight card honours prefers-reduced-motion
 * (motion-reduce:* variants in the marker + ring).
 *
 * In-flight state is threaded as `launchingTaskId` (not a pre-computed
 * boolean) so nested epic children also reflect their own in-flight launch
 * correctly. BacklogPane merges TWO launchers into this one prop — a Run
 * launch (useTaskRunLauncher) and an idea Open (useIdeaSessionOpener) can
 * never collide on the same card (an idea never renders Run; an epic/task
 * never renders Open), so one shared id is enough.
 *
 * Idea component ledger (shared/types/ideaComponents.ts): ideas render five
 * LedgerChips (always all five, including skipped ones, so the row reads as a
 * checklist) plus a SECOND, sibling expand block — `ledger-expand` — next to
 * the epic's `epic-expand`. Gated on `task.type === 'idea'` so the strip never
 * reaches a nested child in TaskChildren (children are always epics/tasks,
 * never ideas, but the guard is the thing that keeps it that way).
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Play, Loader2, Pencil, Lightbulb } from 'lucide-react';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import { IDEA_COMPONENT_KEYS } from '../../../../shared/types/ideaComponents';
import { trpc } from '../../trpc/client';
import { useBacklogStore } from '../../stores/backlogStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  TypeTag,
  PriorityTag,
  CategoryTag,
  ScopeTag,
  ExecutorBadge,
  ArchivedChip,
  ExperimentBadge,
  ProjectChip,
  FlowMarker,
  ReviewMarker,
  DoneFlag,
  LedgerChip,
} from './markers';
import { compactAgo, isArchived, hasRunningFlow, type MatchedChildEvidence } from './backlogSelectors';
import { CardActionsMenu, type ReorderDirection } from './CardActionsMenu';
import { LedgerExpand } from './LedgerExpand';
import { IdeaDetailEditor } from '../IdeaDetailEditor';
import { EpicDetailEditor } from '../EpicDetailEditor';
import { TaskDetailModal } from '../cyboflow/TaskDetailModal';
import { DesignAffordance } from '../cyboflow/DesignAffordance';

interface TaskBodyProps {
  task: BacklogTaskItem;
  /** Launch a run for this task. */
  onRun: (task: BacklogTaskItem) => void;
  /** Task id whose run launch is currently in flight (or null). */
  launchingTaskId: string | null;
  /** Compact "now" basis so all cards share one clock tick. */
  now: number;
  /**
   * Context-menu reorder (Move up / down / to top — WCAG 2.5.7 alternative to
   * DnD). Only Kanban BOARD cards wire it (KanbanView owns direction→index
   * translation); ListView and nested epic children leave it undefined, which
   * hides the Move items in {@link CardActionsMenu}.
   */
  onReorder?: (task: BacklogTaskItem, dir: ReorderDirection) => void;
  /** False on the column's first card — disables Move up / Move to top. */
  canMoveUp?: boolean;
  /** False on the column's last card — disables Move down. */
  canMoveDown?: boolean;
  /**
   * Whether same-column reorder is offered at all — sort mode `'manual'` AND
   * no active search/membership filter (default `true`). Forwarded to
   * {@link CardActionsMenu} — reorder (drag + Move items) is enabled ONLY
   * when this is true (IDEA-053, TASK-203).
   */
  reorderEnabled?: boolean;
  /**
   * Accessible evidence for a card retained ONLY because a nested child
   * matched the active search/membership filter (IDEA-053, TASK-203) — never
   * set when the card itself matched, or with no active filter. Rendered as
   * "Matches REF — Title" text; only ever populated on an epic (the only
   * `type` with `children`).
   */
  matchedChildRefs?: readonly MatchedChildEvidence[];
}

/**
 * The marker row (flow / review / done) — only renders when something applies.
 * Each flow pill sits on its OWN line (a long "agent · session" label was
 * overflowing the card when sharing a wrap row) and, when the run has a hosting
 * session, clicking it opens that session (SessionListItem's activate gesture:
 * setActiveSession + navigateToSessions, via getState() like ProjectDashboard
 * so this presentational row subscribes to nothing).
 */
function MarkerRow({ task }: { task: BacklogTaskItem }): React.JSX.Element | null {
  const hasAny = task.inFlow.length > 0 || task.awaitingReview || task.isDone;
  if (!hasAny) return null;
  const openSession = (sessionId: string): void => {
    void useSessionStore.getState().setActiveSession(sessionId);
    useNavigationStore.getState().navigateToSessions();
  };
  return (
    <div className="flex flex-col items-start gap-1.5">
      {task.inFlow.map((flow) => {
        const sessionId = flow.sessionId;
        return (
          <FlowMarker
            key={flow.runId}
            flow={flow}
            onOpen={sessionId !== null ? () => openSession(sessionId) : undefined}
          />
        );
      })}
      {(task.awaitingReview || task.isDone) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {task.awaitingReview && <ReviewMarker />}
          {task.isDone && <DoneFlag />}
        </div>
      )}
    </div>
  );
}

/** Footer: repo · time · root-idea back-link · Edit · Run (Open, for ideas). */
function CardFooter({
  task,
  onRun,
  onEdit,
  onOpenRootIdea,
  loadingRootIdea,
  launchingTaskId,
  now,
  onReorder,
  canMoveUp,
  canMoveDown,
  reorderEnabled,
  onShowComponents,
}: TaskBodyProps & {
  onEdit: (e: React.MouseEvent) => void;
  /** Open the originating idea's detail; rendered only when the card has one. */
  onOpenRootIdea: (e: React.MouseEvent) => void;
  /** True while the root-idea fetch is in flight (spins the back-link icon). */
  loadingRootIdea: boolean;
  /** Open the ledger expand (ideas with a resolved component set only). */
  onShowComponents?: () => void;
}): React.JSX.Element {
  // Shared in-flight indicator for BOTH the idea "Open" and the epic/task
  // "Run" action — BacklogPane merges useTaskRunLauncher's launchingTaskId
  // with useIdeaSessionOpener's openingTaskId before it ever reaches this
  // prop (idea sessions plan, Stage 4), so a single guard works for whichever
  // one this card renders (an idea never renders Run; an epic/task never
  // renders Open).
  const isLaunching = launchingTaskId === task.id;
  // A live run association = the task is In development — the backend rejects a
  // second pull (double-pull guard), so don't offer one. The flow pill above
  // carries the "why" (and opens the working session). Ideas are exempt:
  // opening the idea's persistent home is always valid, in-development or not.
  const inDevelopment = task.type !== 'idea' && task.inFlow.length > 0;
  // An archived idea's home cannot be opened — the door rejects it
  // (validateIdeaSessionLink). Only ideas render the Open button, but this is
  // computed unconditionally since it's cheap and keeps the JSX below simple.
  const isIdea = task.type === 'idea';
  const archived = isIdea && isArchived(task);
  return (
    <div className="flex items-center justify-between gap-2 pt-1.5">
      <div className="flex min-w-0 items-center gap-2 text-[10.5px] text-text-tertiary">
        {task.repo && <span className="truncate font-medium">{task.repo}</span>}
        <span className="flex-shrink-0">{compactAgo(task.created_at, now)}</span>
        {/* Back-link to the originating idea — a decomposed idea is off the board
            but still inspectable via its children (epics carry originating_idea_id;
            solo tasks too). Hidden on ideas (originating_idea_id === null). */}
        {task.originating_idea_id !== null && (
          <button
            type="button"
            onClick={onOpenRootIdea}
            disabled={loadingRootIdea}
            data-testid="open-root-idea"
            aria-label={`Open originating idea of ${task.ref}`}
            className="inline-flex flex-shrink-0 items-center gap-1 font-medium text-text-tertiary transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingRootIdea ? (
              <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Lightbulb className="h-3 w-3" />
            )}
            Idea
          </button>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">
        {/* Dedicated Edit affordance — opens the type-appropriate detail editor.
            stopPropagation guards against the click bubbling into the
            epic-expand toggle or any future full-card handler. */}
        <button
          type="button"
          onClick={onEdit}
          data-testid="task-edit-button"
          aria-label={`Edit ${task.ref}`}
          className="inline-flex items-center gap-1 rounded-button border border-border-primary px-2 py-0.5 text-[10.5px] font-semibold text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Pencil className="h-3 w-3" strokeWidth={2.5} />
          Edit
        </button>
        {/* Design affordance — opens the approved design bound to this
            epic/task's originating idea (Tier 2, item 8c). Ideas are excluded:
            an idea's OWN design is reached via its "Open" home session, not a
            back-link button. No sessionKey here (the Backlog board has no
            running-session context), so the affordance opens its own preview
            modal instead of a center-pane tab. Renders nothing until
            forEntity resolves a bound design. */}
        {!isIdea && <DesignAffordance entityId={task.id} projectId={task.project_id} />}
        {/* Ideas: "Open" — find-or-create the idea's persistent home session
            (idea sessions plan, Stage 4). Epics/tasks: "Run" — launch a new
            workflow run, unchanged. Same Play glyph + position; the label,
            testid, and disable reason are the only things that differ. */}
        <button
          type="button"
          onClick={() => onRun(task)}
          disabled={isLaunching || (isIdea ? archived : inDevelopment)}
          title={
            isIdea
              ? archived
                ? 'Archived — restore to open'
                : undefined
              : inDevelopment
                ? 'Already in development — a live session is working on this'
                : undefined
          }
          data-testid={isIdea ? 'task-open-button' : 'task-run-button'}
          className="inline-flex items-center gap-1 rounded-button border border-interactive/50 px-2 py-0.5 text-[10.5px] font-semibold text-interactive transition-colors hover:bg-interactive hover:text-text-on-interactive disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-interactive"
        >
          {isLaunching ? (
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <Play className="h-3 w-3" strokeWidth={2.5} />
          )}
          {isIdea ? 'Open' : 'Run'}
        </button>
        {/* Secondary actions (Move up/down/top / Change stage… / Archive)
            tucked behind a ⋯ menu. */}
        <CardActionsMenu
          task={task}
          onReorder={onReorder}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          reorderEnabled={reorderEnabled}
          onShowComponents={onShowComponents}
        />
      </div>
    </div>
  );
}

/**
 * Render the type-appropriate detail editor for a card. Ideas open the
 * IdeaDetailEditor (with the scope hint); epics and solo tasks open the
 * EpicDetailEditor (title / summary / priority / markdown body).
 */
function DetailEditor({
  task,
  isOpen,
  onClose,
}: {
  task: BacklogTaskItem;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  if (task.type === 'idea') {
    return <IdeaDetailEditor idea={task} isOpen={isOpen} onClose={onClose} />;
  }
  return <EpicDetailEditor epic={task} isOpen={isOpen} onClose={onClose} />;
}

/**
 * The shared inner body of a task (used by both the Kanban card and the List
 * row).
 */
export function TaskBody({
  task,
  onRun,
  launchingTaskId,
  now,
  onReorder,
  canMoveUp,
  canMoveDown,
  reorderEnabled,
  matchedChildRefs,
}: TaskBodyProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // Sibling to the epic `expanded` state above — ideas have no expanded state
  // today, so this is a SECOND, independently-toggled expand (see file header).
  const [ledgerExpanded, setLedgerExpanded] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Root-idea back-link: the fetched originating idea (with its decomposition
  // children) shown in a read-only detail modal; null = closed.
  const [rootIdea, setRootIdea] = useState<BacklogTaskItem | null>(null);
  const [loadingRootIdea, setLoadingRootIdea] = useState(false);
  const isEpic = task.type === 'epic';
  const childCount = task.childCount ?? task.children?.length ?? 0;
  // Archive-in-place: archived items only render while the header Archived
  // toggle is on — dim the whole body and badge it next to the type tag.
  const archived = isArchived(task);
  // Read the project filter straight from the store (CardActionsMenu precedent)
  // so the chip needs no prop-drilling through the Kanban/List card tree. The
  // chip only appears in the cross-project view (filter = All AND >1 project).
  const filterProjectId = useBacklogStore((s) => s.filterProjectId);
  const projects = useBacklogStore((s) => s.projects);
  const projectName =
    filterProjectId === null && projects.length > 1
      ? projects.find((p) => p.id === task.project_id)?.name ?? null
      : null;

  // Guard the Edit click from bubbling into the epic-expand toggle / card body.
  const handleEdit = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setEditorOpen(true);
  };

  // Open the originating idea's detail. Fetch via the dedicated decomposition
  // read (selectIdeaDecomposition) so the idea arrives WITH its spawned epics +
  // direct tasks nested — a decomposed idea is off the board but stays
  // inspectable + navigable. Soft-fail: a fetch error just leaves it closed.
  const handleOpenRootIdea = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    const ideaId = task.originating_idea_id;
    if (ideaId === null || loadingRootIdea) return;
    setLoadingRootIdea(true);
    try {
      const idea = await trpc.cyboflow.tasks.ideaDecomposition.query({ ideaId });
      setRootIdea(idea);
    } catch {
      // Convenience affordance — swallow and leave the modal closed.
    } finally {
      setLoadingRootIdea(false);
    }
  };

  return (
    <div
      className={`flex flex-col gap-1.5 ${archived ? 'opacity-60' : ''}`}
      data-archived={archived ? 'true' : 'false'}
    >
      {/* Project chip row — its own line ABOVE the tag pills (All-projects view only). */}
      {projectName !== null && (
        <div className="flex items-center">
          <ProjectChip name={projectName} />
        </div>
      )}

      {/* Tag header row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <TypeTag type={task.type} />
        {archived && <ArchivedChip />}
        <PriorityTag priority={task.priority} />
        <CategoryTag category={task.category} />
        {task.scope !== null && <ScopeTag scope={task.scope} />}
        {/* Human task (migration 137) — no badge on the 'agent' default. */}
        {task.executor === 'human' && <ExecutorBadge />}
        {task.experimentSeed && <ExperimentBadge />}
        <span className="ml-auto font-mono text-[10px] text-text-tertiary">{task.ref}</span>
      </div>

      {/* Idea component ledger chips — ALWAYS all five (including skipped ones)
          so the row reads as a checklist, not a variable badge pile. May wrap
          to a second line in a narrow kanban column. */}
      {task.type === 'idea' && task.components && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="ledger-chips-row">
          {IDEA_COMPONENT_KEYS.map((key) => {
            const entry = task.components?.find((c) => c.component === key);
            return entry ? <LedgerChip key={key} component={entry} /> : null;
          })}
        </div>
      )}

      <MarkerRow task={task} />

      {/* Human prerequisites (migration 137). These edges are real but NON-gating
          — nothing in a sprint moves a human task to Done — so they read as
          neutral prose here, never as a blocked state. */}
      {task.waitingOnHuman && task.waitingOnHuman.length > 0 && (
        <p className="text-[10.5px] text-text-tertiary" data-testid="waiting-on-human">
          {task.waitingOnHuman.length === 1
            ? `waits on ${task.waitingOnHuman[0]} (human)`
            : `waits on ${task.waitingOnHuman.join(', ')} (human)`}
        </p>
      )}

      {/* Title */}
      <div className="text-[13px] font-semibold leading-snug text-text-primary">{task.title}</div>

      {/* Summary */}
      {task.summary && (
        <p className="line-clamp-3 text-[11.5px] leading-snug text-text-secondary">{task.summary}</p>
      )}

      {/* Child-match evidence (IDEA-053, TASK-203): this card is retained ONLY
          because a nested descendant matched the active search/membership
          filter — surfaced identically in Kanban and List since both render
          through this shared body. Accessible text names the matching
          child(ren) by ref + title, e.g. "Matches TASK-014 — Add retry guard". */}
      {matchedChildRefs && matchedChildRefs.length > 0 && (
        <p
          className="text-[10.5px] italic text-text-tertiary"
          data-testid="matched-child-evidence"
        >
          Matches {matchedChildRefs.map((c) => `${c.ref} — ${c.title}`).join(', ')}
        </p>
      )}

      <CardFooter
        task={task}
        onRun={onRun}
        onEdit={handleEdit}
        onOpenRootIdea={(e) => void handleOpenRootIdea(e)}
        loadingRootIdea={loadingRootIdea}
        launchingTaskId={launchingTaskId}
        now={now}
        onReorder={onReorder}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        reorderEnabled={reorderEnabled}
        onShowComponents={
          task.type === 'idea' && task.components ? () => setLedgerExpanded(true) : undefined
        }
      />

      {/* Type-appropriate detail editor — opened by the dedicated Edit affordance. */}
      <DetailEditor task={task} isOpen={editorOpen} onClose={() => setEditorOpen(false)} />

      {/* Root-idea detail — opened by the back-link; lists the idea's children. */}
      <TaskDetailModal task={rootIdea} onClose={() => setRootIdea(null)} />

      {/* Epic expand → nested children */}
      {isEpic && childCount > 0 && (
        <div className="mt-1 border-t border-border-tertiary pt-1.5">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid="epic-expand"
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-text-secondary hover:text-text-primary"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {childCount} {childCount === 1 ? 'task' : 'tasks'}
          </button>
          {expanded && task.children && task.children.length > 0 && (
            <TaskChildren tasks={task.children} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />
          )}
        </div>
      )}

      {/* Idea component ledger expand — a SECOND, sibling expand block to the
          epic one above (ideas have no expanded state today). Distinct
          data-testid ('ledger-expand') so it can't collide with the
          epic-expand / task-children tests. */}
      {task.type === 'idea' && task.components && task.components.length > 0 && (
        <div className="mt-1 border-t border-border-tertiary pt-1.5">
          <button
            type="button"
            onClick={(e) => {
              // stopPropagation: mirrors every other interactive addition on
              // this card — it sits inside draggable/clickable ancestors.
              e.stopPropagation();
              setLedgerExpanded((v) => !v);
            }}
            aria-expanded={ledgerExpanded}
            data-testid="ledger-expand"
            className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-text-secondary hover:text-text-primary"
          >
            {ledgerExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Components
          </button>
          {ledgerExpanded && <LedgerExpand ideaId={task.id} components={task.components} now={now} />}
        </div>
      )}
    </div>
  );
}

interface TaskChildrenProps {
  tasks: BacklogTaskItem[];
  onRun: (task: BacklogTaskItem) => void;
  launchingTaskId: string | null;
  now: number;
}

/**
 * Nested child tasks of an expanded epic. Rendered exactly as given — archived
 * children were already dropped (and childCount recomputed) by filterTasks
 * upstream when the Archived toggle is off.
 */
export function TaskChildren({ tasks, onRun, launchingTaskId, now }: TaskChildrenProps): React.JSX.Element {
  return (
    <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="task-children">
      {tasks.map((child) => (
        <li
          key={child.id}
          className="rounded-card border border-border-tertiary bg-bg-tertiary px-2 py-1.5"
        >
          <TaskBody task={child} onRun={onRun} launchingTaskId={launchingTaskId} now={now} />
        </li>
      ))}
    </ul>
  );
}

/** The Kanban board card. */
export function BoardCard({
  task,
  onRun,
  launchingTaskId,
  now,
  onReorder,
  canMoveUp,
  canMoveDown,
  reorderEnabled,
  matchedChildRefs,
}: TaskBodyProps): React.JSX.Element {
  // Breathing is an ACTIVE-RUN visual — a live-but-idle association (queued,
  // awaiting_review, a batch-pulled task not yet picked up) must not pulse.
  const breathing = hasRunningFlow(task);
  return (
    <div
      data-testid="board-card"
      data-in-flow={breathing ? 'true' : 'false'}
      className={`rounded-card border bg-card-bg p-2.5 shadow-sm transition-shadow ${
        breathing
          ? 'border-interactive/60 ring-1 ring-interactive/30 animate-pulse motion-reduce:animate-none'
          : 'border-card-border hover:border-border-hover'
      }`}
    >
      <TaskBody
        task={task}
        onRun={onRun}
        launchingTaskId={launchingTaskId}
        now={now}
        onReorder={onReorder}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        reorderEnabled={reorderEnabled}
        matchedChildRefs={matchedChildRefs}
      />
    </div>
  );
}
