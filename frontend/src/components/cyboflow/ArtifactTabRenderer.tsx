/**
 * ArtifactTabRenderer — center-pane artifact tab CONTENT, dispatched by atype.
 *
 * Called by RunCenterPane.renderActiveTab() for `kind:'artifact'` tabs with the
 * pinned props `{ artifact, projectId, runId }`. It renders the shared
 * ArtifactHeader (eyebrow + commit-state badge + Commit button) atop a per-atype
 * body:
 *
 *   - 'idea-spec'          -> a rendered markdown doc (the idea `body`), centered
 *                             on white, max-width 680px (blue accent #3b6dd6).
 *   - 'arch-design'        -> the idea body's '## Architecture design' section as
 *                             a markdown doc, same chrome (teal accent #2d7a8a).
 *   - 'decomposed-stories' -> an epic/task card grid: one card per epic, tasks in
 *                             a 2-col grid (indigo accent #5a4ad6).
 *   - 'screenshots'        -> a 2-col gallery; no disk image source yet, so a
 *                             graceful empty state (green accent #2d8a5b).
 *   - 'ui-prototype'/'generic' -> a LIVE CANVAS placeholder: header + hatched
 *                             backdrop + "Open in browser" / commit affordances
 *                             (rust accent #c96442). The iframe embed lands later.
 *
 * Templated CONTENT is re-derived from the live entity model (useArtifactData),
 * never trusted from a stale payload snapshot. Markdown is rendered via the app's
 * MarkdownPreview (react-markdown) — never raw dangerouslySetInnerHTML.
 *
 * Design hexes are inline (warm-paper palette); the M7 polish pass tokenizes them.
 */
import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { trpc } from '../../trpc/client';
import { MarkdownPreview } from '../MarkdownPreview';
import { ArtifactHeader } from './ArtifactHeader';
import { TaskDetailModal } from './TaskDetailModal';
import { LiveCanvasEmbed, isLocalhostUrl } from './LiveCanvasEmbed';
import { useArtifactData } from '../../hooks/useArtifactData';
import { useArtifactImages } from '../../hooks/useArtifactImages';
import { ARTIFACT_COLORS, extractArchDesignSection } from '../../../../shared/types/artifacts';
import type { Artifact } from '../../../../shared/types/artifacts';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { VerdictV1 } from '../../../../shared/types/visualVerification';

const PAGE = 'var(--color-bg-primary)';
const HAIRLINE = 'var(--color-border-primary)';
const SOFT = 'var(--color-border-tertiary)';
const FAINT = 'var(--color-text-tertiary)';
const MUTED = 'var(--color-text-secondary)';
const INK = 'var(--color-text-primary)';
const RUST = 'var(--color-interactive-primary)';
const HOVER_WASH = '#faf7ef';
const STORIES = 'var(--color-phase-refine)';

// Verdict-banner accents (warm-paper palette; M7 polish tokenizes them). Mirrors
// the screenshots-tab green for PASS, the artifact-error rust for FAIL, and an
// amber for the never-auto-loop low_confidence "needs human review" state.
const VERDICT_PASS = '#2d8a5b';
const VERDICT_FAIL = '#c0392b';
const VERDICT_LOW = '#b8860b';

interface ArtifactTabRendererProps {
  artifact: Artifact;
  projectId: number;
  runId: string;
}

/** Full-bleed scroll container shared by every atype body. */
function Shell({ testid, children }: { testid: string; children: ReactNode }): ReactElement {
  return (
    <div
      data-testid={testid}
      className="cf-scroll"
      style={{ height: '100%', overflow: 'auto', background: PAGE, display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </div>
  );
}

function StateRow({ testid, color, text }: { testid: string; color: string; text: string }): ReactElement {
  return (
    <div data-testid={testid} style={{ padding: 20, fontSize: '12px', color }}>
      {text}
    </div>
  );
}

// ---------------------------------------------------------------------------
// idea-spec — rendered markdown doc on white, centered, max-width 680px.
// ---------------------------------------------------------------------------
function IdeaSpecBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['idea-spec'];
  const { loading, error, data } = useArtifactData(artifact, projectId);
  const idea = data?.kind === 'idea' ? data.idea : null;

  // Render whichever field actually carries the structured markdown spec. The
  // planner agent's rich spec historically landed in `summary` (a write-path gap:
  // the cyboflow_create_task/update_task MCP tools had no `body` field), while
  // `body` held only the idea-picker one-liner — so rendering `body` verbatim
  // produced a flat paragraph with literal '#'/'##'. Prefer `body` when it has
  // line structure; otherwise fall back to `summary`; otherwise whatever is
  // non-empty. Keep `summary` as the small caption only when it is NOT the doc.
  const bodyHasStructure = idea?.body?.includes('\n') ?? false;
  const specMarkdown = bodyHasStructure ? (idea?.body ?? '') : (idea?.summary || idea?.body || '');
  const summaryIsCaption = !!idea?.summary && idea?.summary !== specMarkdown;

  return (
    <Shell testid="artifact-idea-spec">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · idea spec"
        meta={artifact.sourceRef ? `${artifact.sourceRef} · ${artifact.stepOrigin ?? 'idea-extractor'}` : undefined}
      />
      {loading ? (
        <StateRow testid="artifact-idea-loading" color={MUTED} text="Loading idea spec…" />
      ) : error ? (
        <StateRow testid="artifact-idea-error" color={RUST} text={error} />
      ) : !idea ? (
        <StateRow testid="artifact-idea-empty" color={MUTED} text="No idea content to display." />
      ) : (
        <div style={{ flex: 1 }}>
          <div
            data-testid="artifact-idea-doc"
            style={{
              maxWidth: 680,
              margin: '0 auto',
              background: 'var(--color-surface-primary)',
              border: `1px solid ${HAIRLINE}`,
              padding: '34px 40px 56px',
              marginTop: 18,
              marginBottom: 18,
            }}
          >
            <div
              style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', color: accent, marginBottom: 8 }}
            >
              {idea.ref}
            </div>
            <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 6px' }}>
              {idea.title}
            </h1>
            {summaryIsCaption && (
              <div style={{ fontSize: '11px', color: FAINT, marginBottom: 18 }}>{idea.summary}</div>
            )}
            {specMarkdown ? (
              <MarkdownPreview content={specMarkdown} />
            ) : (
              <div data-testid="artifact-idea-nobody" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
                This idea has no spec body yet.
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// arch-design — the '## Architecture design' section of the originating idea's
// body, rendered as a markdown doc (same chrome as idea-spec, teal accent).
// The section is extracted with the SHARED extractArchDesignSection — the same
// function the backend content gate uses, so mint and render never disagree.
// ---------------------------------------------------------------------------
function ArchDesignBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['arch-design'];
  const { loading, error, data } = useArtifactData(artifact, projectId);
  const idea = data?.kind === 'arch' ? data.idea : null;
  const section = idea ? extractArchDesignSection(idea.body) : null;

  return (
    <Shell testid="artifact-arch-design">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · architecture design"
        meta={artifact.sourceRef ? `${artifact.sourceRef} · ${artifact.stepOrigin ?? 'architect'}` : undefined}
      />
      {loading ? (
        <StateRow testid="artifact-arch-loading" color={MUTED} text="Loading architecture design…" />
      ) : error ? (
        <StateRow testid="artifact-arch-error" color={RUST} text={error} />
      ) : !idea ? (
        <StateRow testid="artifact-arch-empty" color={MUTED} text="No architecture design yet." />
      ) : (
        <div style={{ flex: 1 }}>
          <div
            data-testid="artifact-arch-doc"
            style={{
              maxWidth: 680,
              margin: '0 auto',
              background: 'var(--color-surface-primary)',
              border: `1px solid ${HAIRLINE}`,
              padding: '34px 40px 56px',
              marginTop: 18,
              marginBottom: 18,
            }}
          >
            <div
              style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', color: accent, marginBottom: 8 }}
            >
              {idea.ref}
            </div>
            <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 18px' }}>
              Architecture design
            </h1>
            {section ? (
              <MarkdownPreview content={section} />
            ) : (
              <div data-testid="artifact-arch-nosection" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
                No architecture design yet.
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// compound-recommendations — the Compound flow's summary-of-recommendations doc,
// rendered as a markdown doc (same chrome as idea-spec / arch-design, violet
// accent). Payload-backed: the compound orchestrator wrote the doc into
// payload_json.markdown, so it renders straight from the payload (no entity
// source, no fetch) — the surface the approve-learnings gate points at.
// ---------------------------------------------------------------------------
function RecommendationsBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['compound-recommendations'];
  const { data } = useArtifactData(artifact, projectId);
  // `markdown` comes verbatim from orchestrator-supplied payload_json (laundered
  // through parsePayload as Record<string, unknown>), so narrow to a string.
  const markdown =
    data?.kind === 'recommendations' && typeof data.payload.markdown === 'string'
      ? data.payload.markdown
      : '';

  return (
    <Shell testid="artifact-compound-recommendations">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · recommendations"
        meta={artifact.stepOrigin ?? 'compounder'}
      />
      <div style={{ flex: 1 }}>
        <div
          data-testid="artifact-recommendations-doc"
          style={{
            maxWidth: 680,
            margin: '0 auto',
            background: 'var(--color-surface-primary)',
            border: `1px solid ${HAIRLINE}`,
            padding: '34px 40px 56px',
            marginTop: 18,
            marginBottom: 18,
          }}
        >
          <div
            style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', color: accent, marginBottom: 8 }}
          >
            Compound
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 18px' }}>
            Recommendations
          </h1>
          {markdown ? (
            <MarkdownPreview content={markdown} />
          ) : (
            <div data-testid="artifact-recommendations-empty" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
              No recommendations drafted yet.
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// decomposed-stories — one card per epic; tasks stacked vertically (one card
// per row), each card a clickable button that opens the TaskDetailModal.
// ---------------------------------------------------------------------------
function taskChildren(epic: BacklogTaskItem): BacklogTaskItem[] {
  return epic.children ?? [];
}

/** Vertical task stack — one clickable card per row (was a 2-col grid). */
function TaskGrid({
  tasks,
  onSelect,
}: {
  tasks: BacklogTaskItem[];
  onSelect: (task: BacklogTaskItem) => void;
}): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        background: SOFT,
      }}
    >
      {tasks.map((task) => (
        <button
          key={task.id}
          type="button"
          data-testid="artifact-task-cell"
          onClick={() => onSelect(task)}
          aria-label={`View details for ${task.ref}: ${task.title}`}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            font: 'inherit',
            cursor: 'pointer',
            background: 'var(--color-surface-primary)',
            border: 'none',
            padding: '9px 11px',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = HOVER_WASH;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'var(--color-surface-primary)';
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            <span style={{ fontSize: '9px', fontWeight: 700, color: STORIES, letterSpacing: '.03em' }}>{task.ref}</span>
            {task.priority && (
              <span
                style={{
                  fontSize: '8px',
                  fontWeight: 700,
                  color: FAINT,
                  border: `1px solid ${SOFT}`,
                  borderRadius: 2,
                  padding: '0 4px',
                }}
              >
                {task.priority}
              </span>
            )}
          </div>
          <div style={{ fontSize: '11.5px', fontWeight: 600, color: INK, lineHeight: 1.35 }}>{task.title}</div>
          {task.summary && (
            <div style={{ fontSize: '10px', color: MUTED, marginTop: 3, lineHeight: 1.4 }}>{task.summary}</div>
          )}
        </button>
      ))}
    </div>
  );
}

function EpicCard({
  epic,
  onSelect,
}: {
  epic: BacklogTaskItem;
  onSelect: (task: BacklogTaskItem) => void;
}): ReactElement {
  const tasks = taskChildren(epic);
  return (
    <div data-testid="artifact-epic-card" style={{ border: `1px solid ${HAIRLINE}`, background: 'var(--color-surface-primary)', marginBottom: 14 }}>
      {/* Epic header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 12px',
          background: HOVER_WASH,
          borderBottom: `1px solid ${HAIRLINE}`,
        }}
      >
        <span style={{ width: 7, height: 13, background: STORIES, flexShrink: 0 }} />
        <span style={{ fontSize: '9px', fontWeight: 700, color: FAINT, letterSpacing: '.04em' }}>{epic.ref}</span>
        <span style={{ fontSize: '12px', fontWeight: 700, color: INK }}>{epic.title}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: '9px', color: FAINT }}>{tasks.length} tasks</span>
      </div>
      {/* Tasks — vertical stack */}
      {tasks.length === 0 ? (
        <div style={{ padding: '10px 12px', fontSize: '11px', color: FAINT, fontStyle: 'italic' }}>
          No tasks under this epic.
        </div>
      ) : (
        <TaskGrid tasks={tasks} onSelect={onSelect} />
      )}
    </div>
  );
}

function DecomposedStoriesBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['decomposed-stories'];
  const { loading, error, data } = useArtifactData(artifact, projectId);
  const idea = data?.kind === 'stories' ? data.idea : null;
  // The task selected for the detail modal; null = modal closed.
  const [selectedTask, setSelectedTask] = useState<BacklogTaskItem | null>(null);
  // idea.children is epics FOLLOWED BY tasks decomposed directly under the idea
  // (small-idea path). Split by type: epics get cards, direct tasks get a stack.
  const children = idea?.children ?? [];
  const epics = children.filter((c) => c.type === 'epic');
  const directTasks = children.filter((c) => c.type === 'task');
  const taskCount =
    epics.reduce((sum, epic) => sum + taskChildren(epic).length, 0) + directTasks.length;

  return (
    <Shell testid="artifact-decomposed-stories">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · decomposed stories"
        meta={artifact.stepOrigin ?? undefined}
      />
      {loading ? (
        <StateRow testid="artifact-stories-loading" color={MUTED} text="Loading stories…" />
      ) : error ? (
        <StateRow testid="artifact-stories-error" color={RUST} text={error} />
      ) : !idea ? (
        <StateRow testid="artifact-stories-empty" color={MUTED} text="No decomposition to display." />
      ) : (
        <div style={{ padding: '16px 20px 28px' }}>
          <div data-testid="artifact-stories-summary" style={{ fontSize: '11px', color: MUTED, marginBottom: 14 }}>
            {epics.length} {epics.length === 1 ? 'epic' : 'epics'} · {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
            {artifact.stepOrigin ? ` · ${artifact.stepOrigin}` : ''}
          </div>
          {epics.length === 0 && directTasks.length === 0 ? (
            <div data-testid="artifact-stories-noepics" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
              This idea has not been decomposed yet.
            </div>
          ) : (
            <>
              {epics.map((epic) => <EpicCard key={epic.id} epic={epic} onSelect={setSelectedTask} />)}
              {directTasks.length > 0 && (
                <div data-testid="artifact-direct-tasks" style={{ marginBottom: 14 }}>
                  <TaskGrid tasks={directTasks} onSelect={setSelectedTask} />
                </div>
              )}
            </>
          )}
        </div>
      )}
      <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// screenshots — verdict banner (P9) — a compact visual-verification result strip
// above the gallery, driven by the optional payload.verdict (VerdictV1) the
// scheduler's verdict-delivery chokepoint enriches onto the SAME 'screenshots'
// artifact (P8a). Three states:
//   - pass            → green check + confidence%.
//   - fail            → red, the judge feedback + a per-issue list.
//   - low_confidence  → amber "needs human visual review" + feedback.
// Per-image issues (issue.fileName) ALSO annotate the matching thumbnail below.
// ---------------------------------------------------------------------------

/**
 * Runtime guard for the optional payload.verdict. `payload` is typed
 * ScreenshotsArtifactPayload (verdict?: VerdictV1), but the bytes arrive as JSON
 * laundered through parsePayload (Record<string, unknown>), so a malformed verdict
 * (e.g. a bare string, a missing status) must not reach the banner. Validate the
 * load-bearing shape (status + numeric confidence + an issues array) and tolerate
 * the rest; an invalid verdict is treated as absent (no banner).
 */
function isVerdictV1(v: unknown): v is VerdictV1 {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o.status === 'pass' || o.status === 'fail' || o.status === 'low_confidence') &&
    typeof o.confidence === 'number' &&
    Array.isArray(o.issues)
  );
}

/** Visual styling per verdict status (accent + label + summary line). */
function verdictPresentation(status: VerdictV1['status']): {
  accent: string;
  icon: string;
  label: string;
} {
  switch (status) {
    case 'pass':
      return { accent: VERDICT_PASS, icon: '✓', label: 'Visual check passed' };
    case 'fail':
      return { accent: VERDICT_FAIL, icon: '✕', label: 'Visual check failed' };
    case 'low_confidence':
      return { accent: VERDICT_LOW, icon: '?', label: 'Needs human visual review' };
    default: {
      // Closed union; never executes. Treat anything unexpected as low-confidence.
      void (status satisfies never);
      return { accent: VERDICT_LOW, icon: '?', label: 'Needs human visual review' };
    }
  }
}

/** Per-issue severity dot color. */
function severityColor(severity: VerdictV1['issues'][number]['severity']): string {
  switch (severity) {
    case 'high':
      return VERDICT_FAIL;
    case 'medium':
      return VERDICT_LOW;
    case 'low':
      return MUTED;
    default:
      void (severity satisfies never);
      return MUTED;
  }
}

/**
 * Compact verdict banner rendered above the gallery. Square-cornered card on a
 * faint status-tinted wash (consistent with the artifact-tab idiom), accent stripe
 * on the leading edge. PASS shows only the confidence; FAIL / low_confidence add
 * the feedback line and a per-issue list when present.
 */
function VerdictBanner({
  verdict,
  projectId,
  runId,
  baselineKey,
}: {
  verdict: VerdictV1;
  projectId: number;
  runId: string;
  /**
   * The STABLE key the accepted baseline PNGs are filed under (R7): the delivered
   * request's hydrated `input.baselineKey` (deliverable.baselineKey ?? deliverable.id),
   * carried through the verdict block by the verdict-delivery chokepoint. `undefined`
   * when the request declared no baseline key — the Accept button is then DISABLED
   * (a baseline filed under an ad-hoc key the SSIM pre-diff never resolves would be
   * orphaned git-committed junk).
   */
  baselineKey?: string;
}): ReactElement {
  const { accent, icon, label } = verdictPresentation(verdict.status);
  const confidencePct = Math.round((verdict.confidence ?? 0) * 100);
  const showDetail = verdict.status !== 'pass';
  const issues = Array.isArray(verdict.issues) ? verdict.issues : [];

  // Accept-as-baseline (S5) — only offered on a PASS verdict. Sends the judged PNGs
  // to the artifacts.acceptAsBaseline mutation (which copies them into the git-tracked
  // baselines tree + commits). Local in-flight + done/error state; the button never
  // optimistically mutates the verdict.
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const judgedFileNames = Array.isArray(verdict.judgedFileNames)
    ? verdict.judgedFileNames.filter((n): n is string => typeof n === 'string')
    : [];
  // Gated on a PRESENT baselineKey (R7): without a stable key the accepted PNGs
  // would file under an ad-hoc namespace the SSIM pre-diff never resolves (orphaned
  // git junk), so the button is disabled + explained via tooltip instead.
  const hasBaselineKey = typeof baselineKey === 'string' && baselineKey.length > 0;
  const canAccept =
    verdict.status === 'pass' && judgedFileNames.length > 0 && hasBaselineKey && !accepted;

  const onAcceptBaseline = (): void => {
    // Narrow baselineKey to a non-empty string here so the mutation input (which
    // requires a string key) type-checks — the button is already disabled when it
    // is absent (canAccept), this is the defensive re-check.
    if (accepting || !canAccept) return;
    if (typeof baselineKey !== 'string' || baselineKey.length === 0) return;
    setAccepting(true);
    setAcceptError(null);
    trpc.cyboflow.artifacts.acceptAsBaseline
      .mutate({ projectId, runId, baselineKey, fileNames: judgedFileNames })
      .then(
        () => {
          setAccepting(false);
          setAccepted(true);
        },
        (err: unknown) => {
          setAccepting(false);
          setAcceptError(err instanceof Error ? err.message : 'Accept as baseline failed.');
        },
      );
  };

  return (
    <div
      data-testid="artifact-verdict-banner"
      data-verdict-status={verdict.status}
      style={{
        margin: '16px 20px 0',
        border: `1px solid ${accent}`,
        borderLeft: `4px solid ${accent}`,
        background: 'var(--color-surface-primary)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          data-testid="artifact-verdict-icon"
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: accent,
            color: 'var(--color-surface-primary)',
            fontSize: '10px',
            fontWeight: 700,
            lineHeight: '16px',
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 700, color: accent }}>{label}</span>
        <span style={{ flex: 1 }} />
        <span data-testid="artifact-verdict-confidence" style={{ fontSize: '10px', color: FAINT }}>
          {confidencePct}% confidence
        </span>
      </div>
      {showDetail && verdict.feedback && (
        <div data-testid="artifact-verdict-feedback" style={{ fontSize: '11px', color: MUTED, lineHeight: 1.45 }}>
          {verdict.feedback}
        </div>
      )}
      {showDetail && issues.length > 0 && (
        <ul
          data-testid="artifact-verdict-issues"
          style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          {issues.map((issue, i) => (
            <li
              key={`${issue.severity}-${i}`}
              data-testid="artifact-verdict-issue"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '10.5px', color: INK, lineHeight: 1.4 }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: severityColor(issue.severity),
                  flexShrink: 0,
                  marginTop: 4,
                }}
              />
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 700, color: severityColor(issue.severity), textTransform: 'uppercase', fontSize: '8.5px', letterSpacing: '.04em', marginRight: 6 }}>
                  {issue.severity}
                </span>
                {issue.description}
                {issue.fileName && (
                  <span style={{ color: FAINT, marginLeft: 6 }}>· {issue.fileName}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* Accept-as-baseline footer — ONLY on a PASS verdict (S5). Copies the judged
          PNGs into the git-tracked baselines tree + commits them. */}
      {verdict.status === 'pass' && (
        <div
          data-testid="artifact-verdict-footer"
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}
        >
          <button
            type="button"
            data-testid="artifact-accept-baseline-button"
            onClick={onAcceptBaseline}
            disabled={!canAccept || accepting}
            title={
              !hasBaselineKey
                ? 'No stable baseline key — declare the deliverable in .cyboflow/verify.json'
                : undefined
            }
            style={{
              fontSize: '10px',
              fontWeight: 700,
              letterSpacing: '.02em',
              padding: '4px 10px',
              border: `1px solid ${accent}`,
              background: 'transparent',
              color: accent,
              cursor: !canAccept || accepting ? 'default' : 'pointer',
              opacity: !canAccept || accepting ? 0.55 : 1,
            }}
          >
            {accepted
              ? '✓ Saved as baseline'
              : accepting
                ? 'Saving baseline…'
                : 'Accept as baseline'}
          </button>
          {acceptError && (
            <span
              data-testid="artifact-accept-baseline-error"
              style={{ fontSize: '10px', color: VERDICT_FAIL }}
            >
              {acceptError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// screenshots — 2-col gallery rendering on-disk PNGs (FU4 display half).
//
// PRODUCER CONVENTION (capture half is environmental / out of scope): a
// visual-verifier agent writes PNG bytes under CYBOFLOW_DIR/artifacts/runs/
// <runId>/ and reports a 'screenshots' artifact via the cyboflow_report_artifact
// MCP tool whose payload.fileNames are the BASENAMES. The bytes are served back
// as data URLs by useArtifactImages → artifacts:load-images (path-validated,
// fail-soft per file). The actual capture (Peekaboo TCC) is NOT built here.
// The optional payload.verdict (P8a) renders the VerdictBanner above the grid.
// ---------------------------------------------------------------------------
function ScreenshotsBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS.screenshots;
  const { loading, error, data } = useArtifactData(artifact, projectId);
  // `fileNames` is typed string[]|undefined but is laundered through parsePayload
  // (Record<string, unknown>): a malformed payload like {"fileNames":"x.png"} or
  // {"fileNames":{}} leaves it a non-array, so the ?? []-then-.map path would
  // throw a TypeError → white screen (no error boundary). Narrow at runtime.
  const fileNames =
    data?.kind === 'screenshots' && Array.isArray(data.payload.fileNames)
      ? data.payload.fileNames.filter((n): n is string => typeof n === 'string')
      : [];

  // The optional verdict (P8a) enriched onto the SAME artifact payload by the
  // verdict-delivery chokepoint. Absent until a judged outcome exists (a
  // skipped/timeout request enriches none) — narrowed via isVerdictV1.
  const verdict = data?.kind === 'screenshots' && isVerdictV1(data.payload.verdict) ? data.payload.verdict : null;

  // Per-image issues, keyed by the issue's optional fileName, to annotate the
  // matching thumbnail (a file with no issue is left unannotated).
  const issuesByFile = new Map<string, VerdictV1['issues']>();
  if (verdict) {
    for (const issue of verdict.issues) {
      if (!issue.fileName) continue;
      const existing = issuesByFile.get(issue.fileName);
      if (existing) existing.push(issue);
      else issuesByFile.set(issue.fileName, [issue]);
    }
  }

  // Resolve the on-disk bytes (basename -> data URL) for the reported files.
  // A file that fails the main-side containment guard / is missing simply has no
  // entry, so the card below shows its per-card fallback instead of an <img>.
  const { images } = useArtifactImages(artifact.runId, fileNames);

  return (
    <Shell testid="artifact-screenshots">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · screenshots"
        meta={artifact.stepOrigin ?? 'visual-verifier'}
      />
      {/* Verdict strip above the gallery — present whenever the payload carries a
          judged verdict, independent of whether bytes resolved. */}
      {!loading && !error && verdict && (
        <VerdictBanner
          verdict={verdict}
          projectId={projectId}
          runId={artifact.runId}
          // R7: the baseline key is the STABLE handle threaded through the verdict
          // block by the verdict-delivery chokepoint (the request's hydrated
          // input.baselineKey). It is the ONLY key the SSIM pre-diff later resolves
          // baselines by — so accepting under the opaque per-run artifact id would
          // orphan the baseline. Absent ⇒ the banner disables the Accept button.
          baselineKey={
            typeof verdict.baselineKey === 'string' && verdict.baselineKey.length > 0
              ? verdict.baselineKey
              : undefined
          }
        />
      )}
      {loading ? (
        <StateRow testid="artifact-shots-loading" color={MUTED} text="Loading screenshots…" />
      ) : error ? (
        <StateRow testid="artifact-shots-error" color={RUST} text={error} />
      ) : fileNames.length === 0 ? (
        <div
          data-testid="artifact-shots-empty"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            color: FAINT,
            textAlign: 'center',
            padding: 32,
          }}
        >
          <span style={{ fontSize: '28px', color: accent, opacity: 0.55 }}>▦</span>
          <span style={{ fontSize: '12px' }}>No screenshots captured.</span>
          <span style={{ fontSize: '10px', color: FAINT }}>
            Visual-verification steps attach their snapshots here.
          </span>
        </div>
      ) : (
        <div
          data-testid="artifact-shots-grid"
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '16px 20px 28px' }}
        >
          {fileNames.map((name) => {
            const dataUrl = images[name];
            const shotIssues = issuesByFile.get(name) ?? [];
            const worstSeverity = shotIssues.reduce<VerdictV1['issues'][number]['severity'] | null>(
              (worst, issue) => {
                if (issue.severity === 'high') return 'high';
                if (issue.severity === 'medium' && worst !== 'high') return 'medium';
                if (issue.severity === 'low' && worst === null) return 'low';
                return worst;
              },
              null,
            );
            return (
              <div
                key={name}
                data-testid="artifact-shot-card"
                style={{
                  border: `1px solid ${worstSeverity ? severityColor(worstSeverity) : HAIRLINE}`,
                  background: 'var(--color-surface-primary)',
                  position: 'relative',
                }}
              >
                {shotIssues.length > 0 && (
                  <span
                    data-testid="artifact-shot-issue-badge"
                    title={shotIssues.map((iss) => iss.description).join('\n')}
                    style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      zIndex: 1,
                      fontSize: '9px',
                      fontWeight: 700,
                      color: 'var(--color-surface-primary)',
                      background: worstSeverity ? severityColor(worstSeverity) : VERDICT_FAIL,
                      borderRadius: 2,
                      padding: '1px 5px',
                    }}
                  >
                    {shotIssues.length} {shotIssues.length === 1 ? 'issue' : 'issues'}
                  </span>
                )}
                {/* 16:10 image area — the resolved on-disk PNG, or a hatched
                    fallback when the file did not resolve (missing / blocked). */}
                {dataUrl ? (
                  <img
                    data-testid="artifact-shot-image"
                    src={dataUrl}
                    alt={name}
                    style={{
                      display: 'block',
                      width: '100%',
                      aspectRatio: '16 / 10',
                      objectFit: 'cover',
                      borderBottom: `1px solid ${HAIRLINE}`,
                    }}
                  />
                ) : (
                  <div
                    data-testid="artifact-shot-missing"
                    style={{
                      aspectRatio: '16 / 10',
                      background: 'repeating-linear-gradient(135deg,var(--color-bg-tertiary) 0 10px,var(--color-bg-primary) 10px 20px)',
                      borderBottom: `1px solid ${HAIRLINE}`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '10px',
                      color: FAINT,
                    }}
                  >
                    image unavailable
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: accent, flexShrink: 0 }} />
                  <span style={{ fontSize: '10.5px', color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// ui-prototype / generic — LIVE CANVAS placeholder (iframe embed lands later).
// ---------------------------------------------------------------------------
function CanvasBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS[artifact.atype === 'generic' ? 'generic' : 'ui-prototype'];
  const { data } = useArtifactData(artifact, projectId);
  // `url` comes verbatim from agent-supplied payload_json (laundered through
  // parsePayload as Record<string, unknown>), so narrow to a string at runtime.
  const url = data?.kind === 'canvas' && typeof data.payload.url === 'string' ? data.payload.url : undefined;
  const label = artifact.atype === 'generic' ? 'generic' : 'ui prototype';

  // Only a localhost http(s) URL gets a LIVE anchor — a javascript:/file://
  // /remote URL from the payload must NOT become a clickable link (same gate as
  // the iframe in LiveCanvasEmbed); otherwise fall back to the disabled span.
  const openInBrowser: ReactNode = url && isLocalhostUrl(url) ? (
    <a
      data-testid="artifact-canvas-open"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontSize: '10px',
        fontWeight: 700,
        color: INK,
        background: PAGE,
        border: `1px solid ${HAIRLINE}`,
        borderRadius: 3,
        padding: '3px 10px',
        textDecoration: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      Open in browser ↗
    </a>
  ) : (
    <span
      data-testid="artifact-canvas-open-disabled"
      style={{ fontSize: '10px', fontWeight: 600, color: FAINT, border: `1px solid ${HAIRLINE}`, borderRadius: 3, padding: '3px 10px' }}
    >
      Open in browser ↗
    </span>
  );

  return (
    <Shell testid="artifact-canvas">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow={`◳ Live canvas · ${label}`}
        meta={<span style={{ fontStyle: 'italic' }}>no template — embedded live</span>}
        actions={openInBrowser}
      />
      {/* Live embed when the agent has reported a localhost dev-server URL;
          otherwise a hatched placeholder explaining there is no preview yet. */}
      {url ? (
        <LiveCanvasEmbed url={url} />
      ) : (
        <div
          data-testid="artifact-canvas-placeholder"
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 32,
            background: 'repeating-linear-gradient(135deg,var(--color-bg-tertiary) 0 10px,var(--color-bg-primary) 10px 20px)',
          }}
        >
          <span style={{ fontSize: '34px', color: accent }}>◳</span>
          <span style={{ fontSize: '12px', fontWeight: 600, color: INK }}>Live canvas — no preview yet</span>
          <span style={{ fontSize: '10.5px', color: MUTED, textAlign: 'center', maxWidth: 360, lineHeight: 1.5 }}>
            This artifact has no template. Its body embeds a live preview once the
            agent reports a localhost dev-server URL (via cyboflow_report_artifact).
          </span>
        </div>
      )}
    </Shell>
  );
}

export function ArtifactTabRenderer({ artifact, projectId }: ArtifactTabRendererProps): ReactElement {
  switch (artifact.atype) {
    case 'idea-spec':
      return <IdeaSpecBody artifact={artifact} projectId={projectId} />;
    case 'arch-design':
      return <ArchDesignBody artifact={artifact} projectId={projectId} />;
    case 'compound-recommendations':
      return <RecommendationsBody artifact={artifact} projectId={projectId} />;
    case 'decomposed-stories':
      return <DecomposedStoriesBody artifact={artifact} projectId={projectId} />;
    case 'screenshots':
      return <ScreenshotsBody artifact={artifact} projectId={projectId} />;
    case 'ui-prototype':
    case 'generic':
      return <CanvasBody artifact={artifact} projectId={projectId} />;
    default: {
      // Exhaustive guard — ArtifactType is a closed union; this never executes.
      // Falls back to the canvas (generic) view if a new atype is ever added.
      void (artifact.atype satisfies never);
      return <CanvasBody artifact={{ ...artifact, atype: 'generic' }} projectId={projectId} />;
    }
  }
}
