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
 *   - 'idea-summary'       -> a HUB (gray accent) over the five ledger components
 *                             (idea-spec/prototype/architecture/epics/stories),
 *                             each with its four-way status (complete/needs
 *                             review/not started/skipped), plus links out to each
 *                             real sibling deliverable tab. It points at those
 *                             tabs — it never inlines them. A SINGLE-idea run
 *                             renders the per-idea doc; a multi-idea batch's
 *                             COMBINED tab renders a compact matrix, one row per
 *                             idea against the five components as columns.
 *   - 'decomposed-stories' -> an epic/task card grid: one card per epic, tasks in
 *                             a 2-col grid (indigo accent #5a4ad6).
 *   - 'screenshots'        -> a 2-col gallery; no disk image source yet, so a
 *                             graceful empty state (green accent #2d8a5b).
 *   - 'ui-prototype'/'generic'/'interactive-prototype' -> a LIVE CANVAS: header +
 *                             hatched backdrop + "Open in browser" / commit
 *                             affordances (rust accent). interactive-prototype
 *                             adds a Stage-A note bar and previews statically
 *                             until the Stage-C OOPIF embed lands.
 *
 * Templated CONTENT is re-derived from the live entity model (useArtifactData),
 * never trusted from a stale payload snapshot. Markdown is rendered via the app's
 * MarkdownPreview (react-markdown) — never raw dangerouslySetInnerHTML.
 *
 * Design hexes are inline (warm-paper palette); the M7 polish pass tokenizes them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { trpc } from '../../trpc/client';
import { MarkdownPreview } from '../MarkdownPreview';
import { ArtifactHeader } from './ArtifactHeader';
import { DesignApproveControl } from './DesignApproveControl';
import { TaskDetailModal } from './TaskDetailModal';
import { LiveCanvasEmbed, isLocalhostUrl } from './LiveCanvasEmbed';
import { FeedbackDocPanel } from './feedback/FeedbackDocPanel';
import { FeedbackChip } from './feedback/FeedbackChip';
import { latestBatchStatus } from './feedback/feedbackLogic';
import { useArtifactData } from '../../hooks/useArtifactData';
import type { IdeaSummaryEntry } from '../../hooks/useArtifactData';
import { useArtifactImages } from '../../hooks/useArtifactImages';
import { useArtifactHtml } from '../../hooks/useArtifactHtml';
import { useArtifactsList } from '../../hooks/useArtifactsList';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { gateDeclineOutcome } from '../../utils/gateActionPolicy';
import { useReviewItemsSlice } from '../../stores/reviewItemsSlice';
import { useFeedback } from '../../hooks/useFeedback';
import { useQuestionStore } from '../../stores/questionStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useDesignModeStore } from '../../stores/designModeStore';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { ScoreSummary, findingLocation, findingCategory } from './WorkflowSummaryPanel';
import type { FindingRow } from './WorkflowSummaryPanel';
import type { RunEval } from '../../../../shared/types/insights';
import {
  ARTIFACT_COLORS,
  extractArchDesignSection,
  isCombinedBatchArtifact,
} from '../../../../shared/types/artifacts';
import type {
  Artifact,
  ApproveIdeasArtifactPayload,
  ApproveDesignsArtifactPayload,
  LoadArtifactHtmlAtype,
  TaskVerificationReportEntry,
} from '../../../../shared/types/artifacts';
// adversarial-review's payload shape isn't imported by name — it's read the
// same way verify-runbook's is (a laundered Record<string, unknown> off
// useArtifactData, narrowed with typeof), so no extra type import is needed
// here beyond ARTIFACT_COLORS['adversarial-review'] resolving once Lane B
// lands the atype on the shared union.
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import { IDEA_COMPONENT_KEYS, IDEA_COMPONENT_LABELS } from '../../../../shared/types/ideaComponents';
import type { IdeaComponentKey, IdeaComponentState } from '../../../../shared/types/ideaComponents';
import type { VerdictV1 } from '../../../../shared/types/visualVerification';
import type { IdeaVerdict, IdeaVerdictMap, ReviewItem } from '../../../../shared/types/reviews';
import type { Question, QuestionPayload } from '../../../../shared/types/questions';

/** One presented option of a live AskUserQuestion (label + optional preview). */
type QuestionOption = QuestionPayload['options'][number];

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
/**
 * One idea's rendered spec doc (shared by the single tab and the combined
 * multi-idea tab). Renders whichever field actually carries the structured
 * markdown spec. The planner agent's rich spec historically landed in
 * `summary` (a write-path gap: the cyboflow_create_task/update_task MCP tools
 * had no `body` field), while `body` held only the idea-picker one-liner — so
 * rendering `body` verbatim produced a flat paragraph with literal '#'/'##'.
 * Prefer `body` when it has line structure; otherwise fall back to `summary`;
 * otherwise whatever is non-empty. Keep `summary` as the small caption only
 * when it is NOT the doc.
 */
function IdeaSpecDoc({
  idea,
  runId,
  projectId,
  accent,
}: {
  idea: BacklogTaskItem;
  runId: string;
  projectId: number;
  accent: string;
}): ReactElement {
  const bodyHasStructure = idea.body?.includes('\n') ?? false;
  const specMarkdown = bodyHasStructure ? (idea.body ?? '') : (idea.summary || idea.body || '');
  const summaryIsCaption = !!idea.summary && idea.summary !== specMarkdown;

  const doc = (
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
  );
  // Feedback is only coherent against the structured `body` doc — the
  // revision agent rewrites `body`, so commenting on the `summary`
  // fallback (bodyHasStructure=false) would have nothing to anchor to.
  return bodyHasStructure ? (
    <FeedbackDocPanel
      projectId={projectId}
      runId={runId}
      atype="idea-spec"
      sourceRef={idea.id}
      documentSource={specMarkdown}
      ideaDecomposed={idea.decomposed_at !== null}
      accent={accent}
    >
      {doc}
    </FeedbackDocPanel>
  ) : (
    doc
  );
}

function IdeaSpecBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['idea-spec'];
  const { loading, error, data } = useArtifactData(artifact, projectId);
  const idea = data?.kind === 'idea' ? data.idea : null;
  // The COMBINED multi-idea tab (payload_json.combined): useArtifactData took
  // the run-scoped path and resolved the batch's ideas (kind 'stories'). Render
  // one stacked doc per content-bearing, non-archived idea — each with its own
  // FeedbackDocPanel anchored to that idea's id.
  const batch =
    data?.kind === 'stories'
      ? data.ideas.filter((i) => i.archived_at === null && (i.body || i.summary))
      : null;

  return (
    <Shell testid="artifact-idea-spec">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · idea spec"
        meta={
          batch !== null
            ? `${batch.length} ideas · ${artifact.stepOrigin ?? 'idea-extractor'}`
            : artifact.sourceRef
              ? `${artifact.sourceRef} · ${artifact.stepOrigin ?? 'idea-extractor'}`
              : undefined
        }
      />
      {loading ? (
        <StateRow testid="artifact-idea-loading" color={MUTED} text="Loading idea spec…" />
      ) : error ? (
        <StateRow testid="artifact-idea-error" color={RUST} text={error} />
      ) : batch !== null ? (
        batch.length === 0 ? (
          <StateRow testid="artifact-idea-empty" color={MUTED} text="No idea content to display." />
        ) : (
          <div style={{ flex: 1 }} data-testid="artifact-idea-specs-combined">
            {batch.map((batchIdea) => (
              <IdeaSpecDoc
                key={batchIdea.id}
                idea={batchIdea}
                runId={artifact.runId}
                projectId={projectId}
                accent={accent}
              />
            ))}
          </div>
        )
      ) : !idea ? (
        <StateRow testid="artifact-idea-empty" color={MUTED} text="No idea content to display." />
      ) : (
        <div style={{ flex: 1 }}>
          <IdeaSpecDoc idea={idea} runId={artifact.runId} projectId={projectId} accent={accent} />
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
          {(() => {
            const doc = (
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
            );
            // Feedback needs an actual section to anchor comments against.
            return section ? (
              <FeedbackDocPanel
                projectId={projectId}
                runId={artifact.runId}
                atype="arch-design"
                sourceRef={idea.id}
                documentSource={section}
                ideaDecomposed={idea.decomposed_at !== null}
                accent={accent}
              >
                {doc}
              </FeedbackDocPanel>
            ) : (
              doc
            );
          })()}
        </div>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// idea-summary — the ledger HUB: each idea's five components (with their
// four-way status — complete / needs review / not started / skipped, per the
// "reset means re-verify" contract in shared/types/ideaComponents.ts) plus
// links out to each real sibling deliverable tab. A HUB, not an aggregator: it
// points at those tabs, it never inlines their content. NO "runs that touched
// this idea" lineage strip — explicitly out of scope.
//
// TWO SHAPES, one atype (matching how the orchestrator mints it):
//   - SINGLE idea  -> the per-idea doc: five labelled component rows, then the
//                     deliverable list. Unchanged since migration 102.
//   - MULTI-idea   -> the COMBINED batch tab: a compact MATRIX, one row per
//                     idea against five component columns, each row expanding
//                     to its own deliverable list. A batch used to mint N
//                     per-idea tabs that all carried the SAME fixed label and
//                     were therefore indistinguishable in the tab strip.
// ---------------------------------------------------------------------------

/** One sibling deliverable this hub can point at. */
interface IdeaSummaryLink {
  key: string;
  label: string;
  artifact: Artifact | undefined;
}

/** The four-way status chip for one ledger component (or its absence). */
function ideaSummaryChip(state: IdeaComponentState | undefined): { text: string; color: string } {
  if (!state) return { text: 'Not started', color: MUTED };
  if (state.state === 'skipped') return { text: 'Skipped', color: FAINT };
  if (state.state === 'complete') return { text: 'Complete', color: VERDICT_PASS };
  // state.state === 'incomplete': staleAt distinguishes "not started" from
  // "needs review" (prior work exists) — collapsing the two is the one thing
  // NOT to do here (see shared/types/ideaComponents.ts).
  return state.staleAt !== null
    ? { text: 'Needs review', color: VERDICT_LOW }
    : { text: 'Not started', color: MUTED };
}

/**
 * The matrix cell for one ledger component — the same four-way status as
 * {@link ideaSummaryChip}, compressed to a glyph for the combined tab's grid.
 *
 * Each status is distinguished by SHAPE as well as color (and carries a `title`
 * at the call site), so the grid never rests on color alone; the legend under
 * the matrix names all four. Glyphs stay inside the app's existing box/dingbat
 * register rather than introducing an icon set to this surface.
 */
function ideaSummaryMark(state: IdeaComponentState | undefined): {
  glyph: string;
  color: string;
  text: string;
} {
  const chip = ideaSummaryChip(state);
  if (chip.text === 'Complete') return { glyph: '✓', color: VERDICT_PASS, text: chip.text };
  if (chip.text === 'Needs review') return { glyph: '⟳', color: VERDICT_LOW, text: chip.text };
  if (chip.text === 'Skipped') return { glyph: '–', color: FAINT, text: chip.text };
  return { glyph: '·', color: FAINT, text: chip.text };
}

/** Legend entries under the matrix, in the same order as the status ladder. */
const IDEA_SUMMARY_LEGEND: ReadonlyArray<{ glyph: string; color: string; label: string }> = [
  { glyph: '✓', color: VERDICT_PASS, label: 'complete' },
  { glyph: '⟳', color: VERDICT_LOW, label: 'needs review' },
  { glyph: '·', color: FAINT, label: 'not started' },
  { glyph: '–', color: FAINT, label: 'skipped' },
];

/** Short column heads for the matrix, paired with the full labels by key. */
/**
 * Floor width for one matrix row: the five fixed 58px status columns + the 16px
 * chevron + the row's 10px padding either side + the idea column's own 112px
 * minimum. Applied to the column heads and the row list so a narrowed artifact
 * pane SCROLLS the matrix sideways instead of clipping the last column and
 * squeezing the idea title out of existence — a hidden status cell reads as
 * "no such component", which is exactly the confusion this tab exists to end.
 */
const IDEA_SUMMARY_MATRIX_MIN_WIDTH = 424;

/** Floor width for the idea (ref + title) column, so the title never collapses to nothing. */
const IDEA_SUMMARY_IDEA_COLUMN_MIN_WIDTH = 112;

const IDEA_SUMMARY_COLUMN_HEADS: Record<IdeaComponentKey, string> = {
  'idea-spec': 'SPEC',
  prototype: 'PROTO',
  architecture: 'ARCH',
  epics: 'EPICS',
  stories: 'STORY',
};

/**
 * The sibling deliverables this run has produced FOR ONE IDEA. Shared by both
 * shapes so a link can never resolve differently between them.
 *
 * The idea-spec link falls back to the run's COMBINED "Idea specs" tab: a
 * multi-idea batch mints ONE idea-spec artifact anchored on the first owned
 * idea, so a per-idea `sourceRef` lookup would find it for idea #1 only and
 * report "not yet" for every other idea in the very batch it renders.
 * Prototype / decomposed-stories are already run-scoped (no sourceRef);
 * arch-design stays genuinely per-idea (it is minted once per owned idea).
 */
function ideaSummaryLinks(idea: BacklogTaskItem, runArtifacts: Artifact[]): IdeaSummaryLink[] {
  const combinedSpec = runArtifacts.find(
    (a) => a.atype === 'idea-spec' && isCombinedBatchArtifact(a.payloadJson),
  );
  return [
    {
      key: 'idea-spec',
      label: 'Idea spec',
      artifact:
        runArtifacts.find((a) => a.atype === 'idea-spec' && a.sourceRef === idea.id) ?? combinedSpec,
    },
    {
      key: 'prototype',
      label: 'Prototype',
      artifact: runArtifacts.find(
        (a) => a.atype === 'ui-prototype' || a.atype === 'interactive-prototype',
      ),
    },
    {
      key: 'architecture',
      label: 'Architecture design',
      artifact: runArtifacts.find((a) => a.atype === 'arch-design' && a.sourceRef === idea.id),
    },
    {
      key: 'stories',
      label: 'Decomposed stories',
      artifact: runArtifacts.find((a) => a.atype === 'decomposed-stories'),
    },
  ];
}

/**
 * The deliverable list — one row per sibling tab, disabled ("not yet") when the
 * run has not produced it. Shared by the single-idea doc and each expanded
 * matrix row; `testidPrefix` keeps the two surfaces' test ids distinct.
 */
function IdeaSummaryDeliverables({
  links,
  accent,
  testidPrefix,
  onOpen,
}: {
  links: IdeaSummaryLink[];
  accent: string;
  testidPrefix: string;
  onOpen: (target: Artifact) => void;
}): ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {links.map((link) => {
        const exists = link.artifact !== undefined;
        return (
          <button
            key={link.key}
            type="button"
            data-testid={`${testidPrefix}-${link.key}`}
            disabled={!exists}
            onClick={() => {
              const target = link.artifact;
              if (!target) return;
              onOpen(target);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '7px 10px',
              border: `1px ${exists ? 'solid' : 'dashed'} ${exists ? SOFT : FAINT}`,
              background: 'transparent',
              textAlign: 'left',
              cursor: exists ? 'pointer' : 'default',
              opacity: exists ? 1 : 0.6,
            }}
          >
            <span style={{ fontSize: '11px', color: exists ? INK : FAINT }}>{link.label}</span>
            <span style={{ fontSize: '9px', fontWeight: 700, color: exists ? accent : FAINT }}>
              {exists ? 'open →' : 'not yet'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Open a sibling artifact's tab in the center pane.
 *
 * centerPaneStore's tab store is keyed by the run's PARENT SESSION (else the run
 * id itself for a legacy parentless run) — see centerPaneStore.ts /
 * RunCenterPane. ArtifactTabRendererProps carries no sessionKey, so this
 * recomputes the SAME derivation independently from the same source
 * (activeRunsStore) RunCenterPane itself reads.
 */
function useOpenSiblingArtifact(runId: string, projectId: number): (target: Artifact) => void {
  const openArtifactTab = useCenterPaneStore((s) => s.openArtifactTab);
  const sessionIdForRun = useActiveRunsStore(
    (s) => s.runsByProject[projectId]?.find((r) => r.id === runId)?.session_id ?? null,
  );
  const sessionKey = sessionIdForRun ?? runId;
  return (target: Artifact) =>
    openArtifactTab(sessionKey, {
      atype: target.atype,
      label: target.label,
      artifactId: target.id,
      committed: target.committed,
      isNew: false,
    });
}

/** The SINGLE-idea hub doc: five labelled component rows, then the deliverables. */
function IdeaSummaryDoc({
  idea,
  components,
  runArtifacts,
  accent,
  onOpen,
}: {
  idea: BacklogTaskItem;
  components: IdeaComponentState[];
  runArtifacts: Artifact[];
  accent: string;
  onOpen: (target: Artifact) => void;
}): ReactElement {
  return (
    <div
      data-testid="artifact-idea-summary-doc"
      style={{
        maxWidth: 680,
        margin: '18px auto',
        background: 'var(--color-surface-primary)',
        border: `1px solid ${HAIRLINE}`,
        padding: '34px 40px 56px',
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
      {idea.summary && (
        <div style={{ fontSize: '11px', color: FAINT, marginBottom: 24 }}>{idea.summary}</div>
      )}

      <div
        style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: MUTED, marginBottom: 10 }}
      >
        Components
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 28 }}>
        {IDEA_COMPONENT_KEYS.map((key) => {
          const state = components.find((c) => c.component === key);
          const chip = ideaSummaryChip(state);
          return (
            <div
              key={key}
              data-testid={`artifact-idea-summary-component-${key}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '7px 10px',
                border: `1px solid ${SOFT}`,
              }}
            >
              <span style={{ fontSize: '11px', color: INK }}>{IDEA_COMPONENT_LABELS[key]}</span>
              <span
                data-testid={`artifact-idea-summary-component-${key}-status`}
                style={{ fontSize: '9px', fontWeight: 700, color: chip.color }}
              >
                {chip.text}
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: MUTED, marginBottom: 10 }}
      >
        Deliverables
      </div>
      <IdeaSummaryDeliverables
        links={ideaSummaryLinks(idea, runArtifacts)}
        accent={accent}
        testidPrefix="artifact-idea-summary-link"
        onOpen={onOpen}
      />
    </div>
  );
}

/**
 * The COMBINED multi-idea matrix: one row per idea the run owns, against the
 * five ledger components as columns, with each row expanding to that idea's own
 * deliverable list. Expansion is per-row and local to the tab (several rows may
 * be open at once); nothing about which rows are open is persisted.
 */
function IdeaSummariesMatrix({
  entries,
  runArtifacts,
  accent,
  onOpen,
}: {
  entries: IdeaSummaryEntry[];
  runArtifacts: Artifact[];
  accent: string;
  onOpen: (target: Artifact) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div
      data-testid="artifact-idea-summaries-doc"
      style={{
        maxWidth: 680,
        margin: '18px auto',
        background: 'var(--color-surface-primary)',
        border: `1px solid ${HAIRLINE}`,
        padding: '30px 34px 34px',
        // Heads + rows both carry IDEA_SUMMARY_MATRIX_MIN_WIDTH, so they scroll
        // together here and stay column-aligned in a narrowed pane.
        overflowX: 'auto',
      }}
    >
      {/* Column heads */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 10px 8px', minWidth: IDEA_SUMMARY_MATRIX_MIN_WIDTH }}>
        <span
          style={{ flex: 1, minWidth: IDEA_SUMMARY_IDEA_COLUMN_MIN_WIDTH, fontSize: '9.5px', fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: FAINT }}
        >
          Idea
        </span>
        {IDEA_COMPONENT_KEYS.map((key) => (
          <span
            key={key}
            title={IDEA_COMPONENT_LABELS[key]}
            style={{ width: 58, flexShrink: 0, textAlign: 'center', fontSize: '9.5px', fontWeight: 700, letterSpacing: '.1em', color: FAINT }}
          >
            {IDEA_SUMMARY_COLUMN_HEADS[key]}
          </span>
        ))}
        <span style={{ width: 16, flexShrink: 0 }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: IDEA_SUMMARY_MATRIX_MIN_WIDTH }}>
        {entries.map(({ idea, components }) => {
          const open = expanded[idea.id] === true;
          return (
            <div key={idea.id}>
              <button
                type="button"
                data-testid={`artifact-idea-summaries-row-${idea.id}`}
                aria-expanded={open}
                onClick={() => setExpanded((prev) => ({ ...prev, [idea.id]: !prev[idea.id] }))}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  width: '100%',
                  padding: '9px 10px',
                  border: `1px solid ${SOFT}`,
                  background: 'transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: IDEA_SUMMARY_IDEA_COLUMN_MIN_WIDTH,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '.16em', color: accent }}>
                    {idea.ref}
                  </span>
                  <span
                    style={{ fontSize: '13px', color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {idea.title}
                  </span>
                </span>
                {IDEA_COMPONENT_KEYS.map((key) => {
                  const mark = ideaSummaryMark(components.find((c) => c.component === key));
                  return (
                    <span
                      key={key}
                      data-testid={`artifact-idea-summaries-cell-${idea.id}-${key}`}
                      title={`${IDEA_COMPONENT_LABELS[key]}: ${mark.text}`}
                      aria-label={`${IDEA_COMPONENT_LABELS[key]}: ${mark.text}`}
                      style={{ width: 58, flexShrink: 0, textAlign: 'center', fontSize: '15px', fontWeight: 700, color: mark.color }}
                    >
                      {mark.glyph}
                    </span>
                  );
                })}
                <span
                  aria-hidden
                  style={{ width: 16, flexShrink: 0, textAlign: 'right', fontSize: '11px', color: FAINT }}
                >
                  {open ? '▾' : '▸'}
                </span>
              </button>

              {open && (
                <div
                  data-testid={`artifact-idea-summaries-detail-${idea.id}`}
                  style={{
                    padding: '10px 10px 12px',
                    marginTop: -1,
                    borderLeft: `1px solid ${SOFT}`,
                    borderRight: `1px solid ${SOFT}`,
                    borderBottom: `1px solid ${SOFT}`,
                  }}
                >
                  <div
                    style={{ fontSize: '9.5px', fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: MUTED, marginBottom: 8 }}
                  >
                    Deliverables
                  </div>
                  <IdeaSummaryDeliverables
                    links={ideaSummaryLinks(idea, runArtifacts)}
                    accent={accent}
                    testidPrefix={`artifact-idea-summaries-link-${idea.id}`}
                    onOpen={onOpen}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend — the matrix compresses status to a glyph, so name all four. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginTop: 16, padding: '0 10px', flexWrap: 'wrap' }}>
        {IDEA_SUMMARY_LEGEND.map((entry) => (
          <span key={entry.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span aria-hidden style={{ fontSize: '13px', fontWeight: 700, color: entry.color }}>
              {entry.glyph}
            </span>
            <span style={{ fontSize: '11px', color: FAINT }}>{entry.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function IdeaSummaryBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['idea-summary'];
  const { loading, error, data } = useArtifactData(artifact, projectId);
  const idea = data?.kind === 'idea-summary' ? data.idea : null;
  const components = data?.kind === 'idea-summary' ? data.components : [];
  // The COMBINED multi-idea tab (payload_json.combined): useArtifactData took
  // the run-scoped path and resolved the batch's ideas zipped against their
  // ledgers (kind 'idea-summaries'). Null on the single-idea path.
  const batch = data?.kind === 'idea-summaries' ? data.entries : null;

  // The sibling deliverables this run has actually produced — the hub links out
  // to them rather than inlining their content.
  const { artifacts: runArtifacts } = useArtifactsList(artifact.runId, projectId);
  const openSibling = useOpenSiblingArtifact(artifact.runId, projectId);

  return (
    <Shell testid="artifact-idea-summary">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · idea summary"
        meta={
          batch !== null
            ? `${batch.length} ideas · ${artifact.stepOrigin ?? 'orchestrator'}`
            : artifact.sourceRef
              ? `${artifact.sourceRef} · ${artifact.stepOrigin ?? 'orchestrator'}`
              : undefined
        }
      />
      {loading ? (
        <StateRow testid="artifact-idea-summary-loading" color={MUTED} text="Loading idea summary…" />
      ) : error ? (
        <StateRow testid="artifact-idea-summary-error" color={RUST} text={error} />
      ) : batch !== null ? (
        batch.length === 0 ? (
          <StateRow testid="artifact-idea-summary-empty" color={MUTED} text="No idea to summarize." />
        ) : (
          <div style={{ flex: 1 }}>
            <IdeaSummariesMatrix
              entries={batch}
              runArtifacts={runArtifacts}
              accent={accent}
              onOpen={openSibling}
            />
          </div>
        )
      ) : !idea ? (
        <StateRow testid="artifact-idea-summary-empty" color={MUTED} text="No idea to summarize." />
      ) : (
        <div style={{ flex: 1 }}>
          <IdeaSummaryDoc
            idea={idea}
            components={components}
            runArtifacts={runArtifacts}
            accent={accent}
            onOpen={openSibling}
          />
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
// verify-runbook — the verify-setup flow's runbook PROPOSAL: per modality the
// build/serve commands and the attestation channel, the rung ladder of repo
// changes it wants, the risks, and (after the prove step enriches the same
// artifact) the per-modality proof outcome. Same markdown-doc chrome as
// compound-recommendations, teal accent. Payload-backed: the setup orchestrator
// composed the doc into payload_json.markdown, so it renders straight from the
// payload (no entity source, no fetch) — the single surface the approve-runbook
// gate points at, which is why it must not read as a Compound deliverable.
// ---------------------------------------------------------------------------
function VerifyRunbookBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['verify-runbook'];
  const { data } = useArtifactData(artifact, projectId);
  // `markdown` comes verbatim from orchestrator-supplied payload_json (laundered
  // through parsePayload as Record<string, unknown>), so narrow to a string.
  const markdown =
    data?.kind === 'verify-runbook' && typeof data.payload.markdown === 'string'
      ? data.payload.markdown
      : '';

  return (
    <Shell testid="artifact-verify-runbook">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · runbook proposal"
        meta={artifact.stepOrigin ?? 'verify-setup'}
      />
      <div style={{ flex: 1 }}>
        <div
          data-testid="artifact-verify-runbook-doc"
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
            Verify setup
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 18px' }}>
            Runbook proposal
          </h1>
          {markdown ? (
            <MarkdownPreview content={markdown} />
          ) : (
            <div data-testid="artifact-verify-runbook-empty" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
              No runbook drafted yet.
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// adversarial-review — the planner/launch/ship reviewer's machine-parseable
// `## Blocking` / `## Findings` doc (item 12a). Same markdown-doc chrome as
// verify-runbook/compound-recommendations, its own accent. Payload-backed: the
// orchestrator composes ONE doc from the subagent's `## Result` section and
// reports it into payload_json.markdown; a later re-review ENRICHES the same
// artifact in place (one per run, per the report-artifact contract), so the
// tab always shows the current revision. The approve-design gate reads this
// same artifact for its body and its accepted-risk findings — this tab is the
// human-readable twin of that machine parse, never a separate source.
// ---------------------------------------------------------------------------
function AdversarialReviewBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['adversarial-review'];
  const { data } = useArtifactData(artifact, projectId);
  // `markdown` comes verbatim from orchestrator-supplied payload_json (laundered
  // through parsePayload as Record<string, unknown>), so narrow to a string.
  const markdown =
    data?.kind === 'adversarial-review' && typeof data.payload.markdown === 'string'
      ? data.payload.markdown
      : '';

  return (
    <Shell testid="artifact-adversarial-review">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · adversarial review"
        meta={artifact.stepOrigin ?? 'adversarial-review'}
      />
      <div style={{ flex: 1 }}>
        <div
          data-testid="artifact-adversarial-review-doc"
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
            Design review
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 18px' }}>
            Adversarial review
          </h1>
          {markdown ? (
            <MarkdownPreview content={markdown} />
          ) : (
            <div data-testid="artifact-adversarial-review-empty" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
              No adversarial review filed yet.
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// eval-report — the ad-hoc code-review eval's full verdict, rendered with the
// SAME ScoreSummary module the end-of-sprint WorkflowSummaryPanel shows (band
// hero + CI scale + gate chips + per-dimension breakdown + findings), fed from
// the LIVE run_evals row (`origin: 'adhoc'` — never the run's canonical
// automatic eval) so a re-eval updates the tab in place. The EvalWorker-minted
// payload_json.markdown stays as the durable fallback for when the live row is
// unavailable (mid-requeue delete window, pruned DB, committed snapshot).
// SYSTEM-MINTED: this is the only score surface a quick session has.
// ---------------------------------------------------------------------------

/** Poll cadence while the ad-hoc eval row is pending/running (matches the summary panel). */
const EVAL_REPORT_POLL_MS = 10_000;

function EvalReportBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['eval-report'];
  const { data } = useArtifactData(artifact, projectId);
  // `markdown` comes verbatim from EvalWorker-supplied payload_json (laundered
  // through parsePayload as Record<string, unknown>), so narrow to a string.
  const markdown =
    data?.kind === 'eval-report' && typeof data.payload.markdown === 'string'
      ? data.payload.markdown
      : '';

  const [runEval, setRunEval] = useState<RunEval | null>(null);
  const [findings, setFindings] = useState<FindingRow[]>([]);
  // The tab IS the full report, so the breakdown starts open (the sprint panel
  // starts collapsed because the score is one module among many there).
  const [breakdownOpen, setBreakdownOpen] = useState(true);

  // Fetch the LATEST ad-hoc eval row; re-poll while it is pending/running so a
  // requeued re-eval lands live in the tab (same cadence as the sprint panel).
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      trpc.cyboflow.insights.runEval
        .query({ runId: artifact.runId, origin: 'adhoc' })
        .then((r) => {
          if (!alive) return;
          setRunEval(r);
          if (r !== null && (r.evalStatus === 'pending' || r.evalStatus === 'running')) {
            timer = setTimeout(tick, EVAL_REPORT_POLL_MS);
          }
        })
        .catch(() => {
          /* leave the last-known state; the markdown fallback still renders */
        });
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [artifact.runId]);

  // The eval's findings (source 'agent:eval*'), flattened exactly like the
  // sprint panel feeds ScoreSummary.
  useEffect(() => {
    if (runEval === null || runEval.evalStatus !== 'complete') return;
    let alive = true;
    trpc.cyboflow.reviewItems.list
      .query({ projectId, kind: 'finding', runId: artifact.runId })
      .then((items) => {
        if (!alive) return;
        const rows: FindingRow[] = items
          .filter((it) => (it.source ?? '').startsWith('agent:eval'))
          .map((it) => ({
            id: it.id,
            severity: it.severity ?? 'info',
            location: findingLocation(it),
            category: findingCategory(it),
            title: it.title,
          }));
        setFindings(rows);
      })
      .catch(() => {
        /* findings are advisory; a read error just leaves the list empty */
      });
    return () => {
      alive = false;
    };
  }, [projectId, artifact.runId, runEval]);

  const showLive = runEval !== null && runEval.evalStatus === 'complete';
  const inFlight =
    runEval !== null && (runEval.evalStatus === 'pending' || runEval.evalStatus === 'running');

  return (
    <Shell testid="artifact-eval-report">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · eval report"
        meta={artifact.stepOrigin ?? 'code-review eval'}
      />
      <div style={{ flex: 1 }}>
        <div data-testid="artifact-eval-report-doc" style={{ maxWidth: 680, margin: '0 auto', paddingTop: 18, paddingBottom: 18 }}>
          {showLive ? (
            <div data-testid="artifact-eval-report-live">
              <ScoreSummary
                runEval={runEval}
                findings={findings}
                breakdownOpen={breakdownOpen}
                onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
              />
            </div>
          ) : (
            <div
              style={{
                background: 'var(--color-surface-primary)',
                border: `1px solid ${HAIRLINE}`,
                padding: '34px 40px 56px',
              }}
            >
              <div
                style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', color: accent, marginBottom: 8 }}
              >
                Quality
              </div>
              <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 18px' }}>
                Eval report
              </h1>
              {inFlight && (
                <div data-testid="artifact-eval-report-inflight" style={{ fontSize: '12px', color: FAINT, marginBottom: 14 }}>
                  Re-assessment running — this report updates when it completes.
                </div>
              )}
              {markdown ? (
                <MarkdownPreview content={markdown} />
              ) : (
                <div data-testid="artifact-eval-report-empty" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
                  No eval verdict recorded yet.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// project-brief — the Launch flow's synthesized project-brief doc, rendered as
// a markdown doc (same chrome as compound-recommendations, Launch's
// interview-phase blue accent). Payload-backed: the Launch orchestrator wrote
// the doc into payload_json.markdown, so it renders straight from the payload
// (no entity source, no fetch) — mirrors RecommendationsBody exactly.
// ---------------------------------------------------------------------------
function ProjectBriefBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['project-brief'];
  const { data } = useArtifactData(artifact, projectId);
  // `markdown` comes verbatim from orchestrator-supplied payload_json (laundered
  // through parsePayload as Record<string, unknown>), so narrow to a string.
  const markdown =
    data?.kind === 'brief' && typeof data.payload.markdown === 'string' ? data.payload.markdown : '';

  return (
    <Shell testid="artifact-project-brief">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · project brief"
        meta={artifact.stepOrigin ?? 'interview'}
      />
      <div style={{ flex: 1 }}>
        <div
          data-testid="artifact-project-brief-doc"
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
            Launch
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, lineHeight: 1.25, color: INK, margin: '0 0 18px' }}>
            Project brief
          </h1>
          {markdown ? (
            <MarkdownPreview content={markdown} />
          ) : (
            <div data-testid="artifact-project-brief-empty" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
              No project brief drafted yet.
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

// A run's approve-plan gate surfaces via TWO mint paths (mirrors the
// approve-ideas dual-path recognition): the PROGRAMMATIC runner stamps a
// 'gate:human-step:approve-plan' decision review item, while the ORCHESTRATED
// planner asks a live AskUserQuestion whose first sub-question offers an
// Approve/Reject option set. This template resolves whichever is pending.
const GATE_SOURCE_APPROVE_PLAN = 'gate:human-step:approve-plan';
/**
 * TASK-222 provenance id for gate verdicts recorded from THIS artifact tab's
 * Approve/Reject pair — persisted as `resolvedSurface` in the item's
 * payload_json, alongside the queue/session `ReviewItemCardSurface` ids.
 */
const ARTIFACT_GATE_SURFACE = 'artifact:decomposed-stories';

/** True when any rendered epic/task is a hidden draft (approved_at === null). */
function hasDraftDescendant(ideas: BacklogTaskItem[]): boolean {
  for (const idea of ideas) {
    for (const child of idea.children ?? []) {
      // child = an epic OR a task decomposed directly under the idea.
      if (child.approved_at === null) return true;
      for (const task of child.children ?? []) {
        if (task.approved_at === null) return true;
      }
    }
  }
  return false;
}

/** First option on a live question's FIRST sub-question whose label starts with `prefix` (ci). */
function optionByPrefix(question: Question | null, prefix: string): QuestionOption | null {
  const opts = question?.questions[0]?.options ?? [];
  return opts.find((o) => o.label.trim().toLowerCase().startsWith(prefix)) ?? null;
}

/**
 * One idea section — a small header (idea ref + title, matching the epic-header
 * idiom) above that idea's epic cards and any tasks decomposed directly under it
 * (EpicCard + TaskGrid reused unchanged). Covers the multi-idea planner batch:
 * the stories tab renders one section per idea the run owns.
 */
function IdeaSection({
  idea,
  onSelect,
}: {
  idea: BacklogTaskItem;
  onSelect: (task: BacklogTaskItem) => void;
}): ReactElement {
  const children = idea.children ?? [];
  const epics = children.filter((c) => c.type === 'epic');
  const directTasks = children.filter((c) => c.type === 'task');
  return (
    <div data-testid="artifact-stories-idea-section" style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ width: 7, height: 13, background: STORIES, flexShrink: 0 }} />
        <span style={{ fontSize: '9px', fontWeight: 700, color: FAINT, letterSpacing: '.04em' }}>{idea.ref}</span>
        <span style={{ fontSize: '13px', fontWeight: 700, color: INK }}>{idea.title}</span>
      </div>
      {epics.length === 0 && directTasks.length === 0 ? (
        <div data-testid="artifact-stories-noepics" style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}>
          This idea has not been decomposed yet.
        </div>
      ) : (
        <>
          {epics.map((epic) => (
            <EpicCard key={epic.id} epic={epic} onSelect={onSelect} />
          ))}
          {directTasks.length > 0 && (
            <div data-testid="artifact-direct-tasks" style={{ marginBottom: 14 }}>
              <TaskGrid tasks={directTasks} onSelect={onSelect} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DecomposedStoriesBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['decomposed-stories'];
  const { loading, error, data } = useArtifactData(artifact, projectId);
  // Stable identity while `data` is unchanged (the [] fallback would otherwise be
  // a fresh array each render, churning the draftMode memo).
  const ideas = useMemo(() => (data?.kind === 'stories' ? data.ideas : []), [data]);
  // The task selected for the detail modal; null = modal closed.
  const [selectedTask, setSelectedTask] = useState<BacklogTaskItem | null>(null);

  // Aggregate counts across every idea the run owns (multi-idea batch).
  const allEpics = ideas.flatMap((idea) => (idea.children ?? []).filter((c) => c.type === 'epic'));
  const directTaskCount = ideas.reduce(
    (sum, idea) => sum + (idea.children ?? []).filter((c) => c.type === 'task').length,
    0,
  );
  const taskCount = allEpics.reduce((sum, epic) => sum + taskChildren(epic).length, 0) + directTaskCount;

  // DRAFT MODE: any rendered epic/task is a hidden draft (approved_at === null) —
  // i.e. the plan gate has not been approved yet. Drives the badge + footer.
  const draftMode = useMemo(() => hasDraftDescendant(ideas), [ideas]);

  // -- approve-plan gate resolution (draft mode) ------------------------------
  // Priority: (a) a live AskUserQuestion for this run (orchestrated planner),
  // then (b) a programmatic 'gate:human-step:approve-plan' decision item.

  // (a) Live question — reuse the app-lifetime questionStore singleton (init is
  // idempotent; do NOT unsubscribe here — CyboflowRoot owns the app-wide feed).
  useEffect(() => {
    useQuestionStore.getState().init();
  }, []);
  const questionQueue = useQuestionStore((s) => s.queue);
  const liveQuestion = useMemo(
    () =>
      questionQueue.find(
        (q) =>
          q.runId === artifact.runId &&
          q.status === 'pending' &&
          (q.questions[0]?.options.some((o) => o.label.trim().toLowerCase().startsWith('approve')) ?? false),
      ) ?? null,
    [questionQueue, artifact.runId],
  );

  // (b) Programmatic gate — reuse the already-wired review_items inbox (refcounted).
  useEffect(() => {
    const release = useReviewItemsSlice.getState().init(projectId);
    return () => { release(); };
  }, [projectId]);
  const reviewItems = useReviewItemsSlice((s) => s.items);
  const gateItem = useMemo(
    () =>
      reviewItems.find(
        (it) =>
          it.run_id === artifact.runId &&
          it.kind === 'decision' &&
          it.status === 'pending' &&
          it.source === GATE_SOURCE_APPROVE_PLAN,
      ) ?? null,
    [reviewItems, artifact.runId],
  );

  // Live wins over the programmatic gate; neither ⇒ badge only (no buttons).
  const variant: 'live' | 'gate' | null = liveQuestion ? 'live' : gateItem ? 'gate' : null;

  // The live question's Approve / Reject option labels. The backend matches the
  // EXACT presented label (questionRouter.isRejectAnswer), so Reject is HIDDEN for
  // the live variant when no reject-prefixed option was presented. The
  // programmatic gate always supports reject (outcome: 'reject').
  const approveOption = optionByPrefix(liveQuestion, 'approve');
  const rejectOption = optionByPrefix(liveQuestion, 'reject');
  const showReject = variant === 'live' ? rejectOption !== null : variant === 'gate';

  const { resolve, error: resolveError } = useReviewItemActions();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const submit = (kind: 'approve' | 'reject'): void => {
    if (submitting) return;
    setSubmitError(null);
    if (variant === 'live') {
      // Answer the live AskUserQuestion with the chosen option's EXACT label,
      // keyed by the first sub-question's full text (QuestionAnswer shape).
      const firstQuestion = liveQuestion?.questions[0];
      const option = kind === 'approve' ? approveOption : rejectOption;
      if (!liveQuestion || !firstQuestion || !option) return;
      setSubmitting(true);
      trpc.cyboflow.questions.answer
        .mutate({ questionId: liveQuestion.id, answers: { [firstQuestion.question]: option.label } })
        .then(
          () => setSubmitting(false),
          (err: unknown) => {
            setSubmitting(false);
            setSubmitError(err instanceof Error ? err.message : 'Failed to submit.');
          },
        );
      return;
    }
    if (variant === 'gate' && gateItem) {
      // Resolve the programmatic gate; the server reveals drafts + resumes on
      // 'approve', tears the drafts down + ends the run on 'reject'. `surface`
      // (TASK-222) stamps WHICH control answered the gate into payload_json
      // (`resolvedSurface`) so a post-mortem can tell this artifact-tab pair
      // apart from the queue/session cards.
      //
      // The decline path is routed through the shared `gateDeclineOutcome`
      // (utils/gateActionPolicy.ts), not a bare 'reject' literal — this gate is
      // discriminated to `approve-plan` only today, so it always resolves to
      // 'reject', but it keeps this control from silently reintroducing the
      // swift-bison class of bug if a future gate reusing this artifact ever
      // declares a loopback.
      setSubmitting(true);
      const outcome = kind === 'reject' ? gateDeclineOutcome(gateItem) : kind;
      resolve(projectId, gateItem.id, { outcome, surface: ARTIFACT_GATE_SURFACE }).then((result) => {
        setSubmitting(false);
        if (result === null) setSubmitError('Failed to submit.');
      });
    }
  };

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
      ) : ideas.length === 0 ? (
        <StateRow testid="artifact-stories-empty" color={MUTED} text="No decomposition to display." />
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, padding: '16px 20px 28px' }}>
            <div
              data-testid="artifact-stories-summary"
              style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}
            >
              <span style={{ fontSize: '11px', color: MUTED }}>
                {ideas.length} {ideas.length === 1 ? 'idea' : 'ideas'} · {allEpics.length}{' '}
                {allEpics.length === 1 ? 'epic' : 'epics'} · {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
                {artifact.stepOrigin ? ` · ${artifact.stepOrigin}` : ''}
              </span>
              {draftMode && (
                <span
                  data-testid="artifact-stories-draft-badge"
                  style={{
                    fontSize: '9px',
                    fontWeight: 700,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: VERDICT_LOW,
                    border: `1px solid ${VERDICT_LOW}`,
                    borderRadius: 2,
                    padding: '1px 6px',
                  }}
                >
                  Draft — pending plan approval
                </span>
              )}
            </div>
            {ideas.map((idea) => (
              <IdeaSection key={idea.id} idea={idea} onSelect={setSelectedTask} />
            ))}
          </div>
          {draftMode && variant && (
            <div
              data-testid="stories-plan-footer"
              style={{
                position: 'sticky',
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 20px',
                borderTop: `1px solid ${HAIRLINE}`,
                background: 'var(--color-bg-secondary)',
              }}
            >
              <span style={{ fontSize: '11px', color: MUTED, fontWeight: 600 }}>
                Approve this plan to reveal its tasks on the board.
              </span>
              <span style={{ flex: 1 }} />
              {(resolveError ?? submitError) && (
                <span data-testid="stories-plan-error" style={{ fontSize: '10px', color: VERDICT_FAIL }}>
                  {resolveError ?? submitError}
                </span>
              )}
              {showReject && (
                <button
                  type="button"
                  data-testid="stories-reject-plan"
                  disabled={submitting}
                  onClick={() => submit('reject')}
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '5px 14px',
                    border: `1px solid ${VERDICT_FAIL}`,
                    borderRadius: 3,
                    background: 'transparent',
                    color: VERDICT_FAIL,
                    cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  Reject
                </button>
              )}
              <button
                type="button"
                data-testid="stories-approve-plan"
                disabled={submitting}
                onClick={() => submit('approve')}
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '.02em',
                  color: 'var(--color-surface-primary)',
                  background: INK,
                  border: `1px solid ${INK}`,
                  borderRadius: 3,
                  padding: '5px 14px',
                  cursor: submitting ? 'default' : 'pointer',
                  opacity: submitting ? 0.5 : 1,
                }}
              >
                {submitting ? 'Submitting…' : 'Approve plan'}
              </button>
            </div>
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
function VerdictBanner({ verdict }: { verdict: VerdictV1 }): ReactElement {
  const { accent, icon, label } = verdictPresentation(verdict.status);
  const confidencePct = Math.round((verdict.confidence ?? 0) * 100);
  const showDetail = verdict.status !== 'pass';
  const issues = Array.isArray(verdict.issues) ? verdict.issues : [];

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// screenshots — "Behaviors tested" report table (verification-agent redesign
// §5.9), rendered under the verdict banner when payload.reports is non-empty.
// One block per task lane (grouped by taskRef; a null taskRef — a
// non-lane-attributed request — forms its own singleton group keyed by
// requestId): the LATEST attempt renders in full, older attempts collapse
// behind a toggle. Each behavior row shows its description, a pass/fail/
// not-testable badge, the expected text, and evidence screenshot links that
// jump to the matching thumbnail already rendered in the gallery below — a
// filename the gallery never resolved renders as plain text, not a link.
// No reports ⇒ this section renders nothing (legacy artifacts unaffected).
// ---------------------------------------------------------------------------

type ReportBehavior = TaskVerificationReportEntry['behaviors'][number];

/** Runtime guard for one payload.reports[] entry — a malformed entry is dropped, never thrown. */
function isTaskVerificationReportEntry(v: unknown): v is TaskVerificationReportEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    (o.taskRef === null || typeof o.taskRef === 'string') &&
    typeof o.requestId === 'string' &&
    o.requestId.length > 0 &&
    typeof o.attempt === 'number' &&
    typeof o.summary === 'string' &&
    Array.isArray(o.behaviors) &&
    typeof o.completedAt === 'string' &&
    // transcriptFileName (verifier-transcript capture) is OPTIONAL — tolerate its
    // absence, but a present value must be a string or the entry is malformed.
    (o.transcriptFileName === undefined || typeof o.transcriptFileName === 'string')
  );
}

/** Runtime guard for one behavior row inside a report entry. */
function isReportBehavior(v: unknown): v is ReportBehavior {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.description === 'string' &&
    typeof o.expected === 'string' &&
    (o.result === 'pass' || o.result === 'fail' || o.result === 'not_testable') &&
    Array.isArray(o.screenshots) &&
    typeof o.notes === 'string'
  );
}

/** Result-badge accent, mirroring the verdict-status palette (not_testable ~ low_confidence). */
function behaviorResultAccent(result: ReportBehavior['result']): string {
  switch (result) {
    case 'pass':
      return VERDICT_PASS;
    case 'fail':
      return VERDICT_FAIL;
    case 'not_testable':
      return VERDICT_LOW;
    default:
      void (result satisfies never);
      return VERDICT_LOW;
  }
}

/**
 * "View transcript" toggle for one report entry carrying a `transcriptFileName`
 * (verifier-transcript capture — the harness-captured verifier session, so a
 * wrong verdict is auditable). On first expand it loads the on-disk transcript
 * via `window.electronAPI.artifacts.loadText` and CACHES the result in local
 * state, so collapsing/re-expanding never re-fetches. Fail-soft: a missing
 * Electron API or a load error renders a brief inline message, never throws.
 */
function TranscriptToggle({ runId, fileName }: { runId: string; fileName: string }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'loaded'; text: string }
    | { status: 'error'; error: string }
  >({ status: 'idle' });

  const handleToggle = (): void => {
    setExpanded((v) => !v);
    if (state.status !== 'idle') return; // already loaded/loading/errored — never re-fetch
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api) {
      setState({ status: 'error', error: 'Electron API not available' });
      return;
    }
    setState({ status: 'loading' });
    api.artifacts.loadText({ runId, fileName }).then(
      (res) => {
        if (res.success && res.data) {
          setState({ status: 'loaded', text: res.data.text });
        } else {
          setState({ status: 'error', error: res.error ?? 'Failed to load transcript.' });
        }
      },
      (err: unknown) => {
        setState({ status: 'error', error: err instanceof Error ? err.message : 'Failed to load transcript.' });
      },
    );
  };

  return (
    <div>
      <button
        type="button"
        data-testid="artifact-transcript-toggle"
        onClick={handleToggle}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          fontSize: '10px',
          fontWeight: 600,
          color: MUTED,
          cursor: 'pointer',
        }}
      >
        {expanded ? '▾' : '▸'} View transcript
      </button>
      {expanded && (
        <div data-testid="artifact-transcript-body" style={{ marginTop: 4 }}>
          {state.status === 'loading' && (
            <span style={{ fontSize: '10px', color: FAINT }}>Loading transcript…</span>
          )}
          {state.status === 'error' && <span style={{ fontSize: '10px', color: RUST }}>{state.error}</span>}
          {state.status === 'loaded' && (
            <pre
              style={{
                maxHeight: 320,
                overflow: 'auto',
                margin: 0,
                fontSize: '10px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                color: MUTED,
                background: HOVER_WASH,
                border: `1px solid ${HAIRLINE}`,
                borderRadius: 2,
                padding: '8px 10px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {state.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** One behavior row: description / result badge / expected / evidence links. */
function BehaviorTableRow({
  behavior,
  availableFileNames,
  onJumpToImage,
}: {
  behavior: ReportBehavior;
  availableFileNames: Set<string>;
  onJumpToImage: (fileName: string) => void;
}): ReactElement {
  const accent = behaviorResultAccent(behavior.result);
  return (
    <tr data-testid="artifact-behavior-row">
      <td style={{ padding: '6px 10px 6px 0', fontSize: '11px', color: INK, verticalAlign: 'top' }}>
        {behavior.description}
      </td>
      <td style={{ padding: '6px 10px', verticalAlign: 'top' }}>
        <span
          data-testid="artifact-behavior-result-badge"
          style={{
            display: 'inline-block',
            fontSize: '8.5px',
            fontWeight: 700,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            color: accent,
            border: `1px solid ${accent}`,
            borderRadius: 2,
            padding: '1px 5px',
            whiteSpace: 'nowrap',
          }}
        >
          {behavior.result === 'not_testable' ? 'not testable' : behavior.result}
        </span>
      </td>
      <td style={{ padding: '6px 10px', fontSize: '10.5px', color: MUTED, verticalAlign: 'top' }}>
        {behavior.expected}
      </td>
      <td style={{ padding: '6px 0 6px 10px', verticalAlign: 'top' }}>
        {behavior.screenshots.length === 0 ? (
          <span style={{ fontSize: '10px', color: FAINT }}>—</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {behavior.screenshots.map((name) =>
              availableFileNames.has(name) ? (
                <button
                  key={name}
                  type="button"
                  data-testid="artifact-behavior-evidence-link"
                  onClick={() => onJumpToImage(name)}
                  style={{
                    textAlign: 'left',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    font: 'inherit',
                    fontSize: '10px',
                    color: RUST,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                  }}
                >
                  {name}
                </button>
              ) : (
                <span key={name} data-testid="artifact-behavior-evidence-missing" style={{ fontSize: '10px', color: FAINT }}>
                  {name}
                </span>
              ),
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

/** One task lane's report block — latest attempt in full, older attempts collapsed. */
function TaskReportGroup({
  runId,
  entries,
  availableFileNames,
  onJumpToImage,
}: {
  /** The run these reports belong to — needed to load an entry's transcript. */
  runId: string;
  /** Newest-attempt-first; at least one entry. */
  entries: TaskVerificationReportEntry[];
  availableFileNames: Set<string>;
  onJumpToImage: (fileName: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [latest, ...older] = entries;
  const outcomeAccent =
    latest.outcome === 'pass' ? VERDICT_PASS : latest.outcome === 'fail' ? VERDICT_FAIL : VERDICT_LOW;

  return (
    <div
      data-testid="artifact-task-report"
      data-task-ref={latest.taskRef ?? ''}
      style={{ border: `1px solid ${HAIRLINE}`, background: 'var(--color-surface-primary)', marginBottom: 10 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: HOVER_WASH,
          borderBottom: `1px solid ${HAIRLINE}`,
        }}
      >
        {latest.taskRef && (
          <span style={{ fontSize: '9px', fontWeight: 700, color: FAINT, letterSpacing: '.04em' }}>
            {latest.taskRef}
          </span>
        )}
        <span style={{ fontSize: '11.5px', fontWeight: 600, color: INK }}>{latest.summary}</span>
        <span style={{ flex: 1 }} />
        <span
          data-testid="artifact-task-report-outcome"
          style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: outcomeAccent }}
        >
          {latest.outcome.replace('_', ' ')}
        </span>
        {latest.transcriptFileName && <TranscriptToggle runId={runId} fileName={latest.transcriptFileName} />}
      </div>
      <div style={{ padding: '4px 12px 10px', overflowX: 'auto' }}>
        <table data-testid="artifact-behaviors-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Behavior', 'Result', 'Expected', 'Evidence'].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: 'left',
                    fontSize: '8.5px',
                    fontWeight: 700,
                    letterSpacing: '.04em',
                    textTransform: 'uppercase',
                    color: FAINT,
                    padding: h === 'Behavior' ? '4px 10px 4px 0' : '4px 10px',
                    borderBottom: `1px solid ${SOFT}`,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {latest.behaviors.filter(isReportBehavior).map((behavior) => (
              <BehaviorTableRow
                key={behavior.id}
                behavior={behavior}
                availableFileNames={availableFileNames}
                onJumpToImage={onJumpToImage}
              />
            ))}
          </tbody>
        </table>
      </div>
      {older.length > 0 && (
        <div style={{ borderTop: `1px dotted ${SOFT}`, padding: '6px 12px' }}>
          <button
            type="button"
            data-testid="artifact-task-report-toggle"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              font: 'inherit',
              fontSize: '10px',
              fontWeight: 600,
              color: MUTED,
              cursor: 'pointer',
            }}
          >
            {expanded ? '▾' : '▸'} {older.length} earlier attempt{older.length === 1 ? '' : 's'}
          </button>
          {expanded && (
            <div data-testid="artifact-task-report-older-list" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {older.map((entry) => (
                <div key={entry.requestId} data-testid="artifact-task-report-older" style={{ opacity: 0.7 }}>
                  <div style={{ fontSize: '10px', color: FAINT, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>
                      attempt {entry.attempt} · {entry.outcome.replace('_', ' ')} · {entry.completedAt}
                    </span>
                    {entry.transcriptFileName && <TranscriptToggle runId={runId} fileName={entry.transcriptFileName} />}
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {entry.behaviors.filter(isReportBehavior).map((behavior) => (
                        <BehaviorTableRow
                          key={behavior.id}
                          behavior={behavior}
                          availableFileNames={availableFileNames}
                          onJumpToImage={onJumpToImage}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Groups valid report entries by lane (taskRef, or requestId when un-attributed). */
function groupTaskReports(reports: TaskVerificationReportEntry[]): TaskVerificationReportEntry[][] {
  const groups = new Map<string, TaskVerificationReportEntry[]>();
  for (const entry of reports) {
    const key = entry.taskRef ?? `__request_${entry.requestId}`;
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  // Newest attempt first within a group; groups ordered by their newest entry's
  // completedAt, most recent first.
  const groupList = Array.from(groups.values()).map((entries) =>
    [...entries].sort((a, b) => b.attempt - a.attempt || (a.completedAt < b.completedAt ? 1 : -1)),
  );
  groupList.sort((a, b) => (a[0].completedAt < b[0].completedAt ? 1 : -1));
  return groupList;
}

/**
 * Top-level "Behaviors tested" section. Absent/empty `reports` renders nothing
 * (legacy screenshots artifacts are unaffected). `availableFileNames` gates
 * whether an evidence screenshot renders as a clickable jump-to-image link.
 */
function BehaviorsTestedSection({
  runId,
  reports,
  availableFileNames,
  onJumpToImage,
}: {
  /** The run these reports belong to — threaded down to each entry's transcript loader. */
  runId: string;
  reports: unknown;
  availableFileNames: Set<string>;
  onJumpToImage: (fileName: string) => void;
}): ReactElement | null {
  const validReports = Array.isArray(reports) ? reports.filter(isTaskVerificationReportEntry) : [];
  if (validReports.length === 0) return null;
  const groups = groupTaskReports(validReports);

  return (
    <div data-testid="artifact-behaviors-tested" style={{ margin: '16px 20px 0' }}>
      <div
        style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.16em', textTransform: 'uppercase', color: FAINT, marginBottom: 8 }}
      >
        Behaviors tested
      </div>
      {groups.map((entries) => (
        <TaskReportGroup
          key={entries[0].taskRef ?? entries[0].requestId}
          runId={runId}
          entries={entries}
          availableFileNames={availableFileNames}
          onJumpToImage={onJumpToImage}
        />
      ))}
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

  // The behaviors-tested report table (§5.9) links its evidence screenshots to
  // the matching thumbnail rendered in the gallery below. `shotRefs` maps a
  // basename to its rendered card so the click handler can scroll it into view;
  // `availableFileNames` gates whether a link renders at all (a report can
  // reference a filename the gallery never resolved).
  const shotRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // `fileNames` is already recomputed fresh every render (its own [] fallback
  // is not memoized), so wrapping this Set in useMemo would key off a
  // perpetually-new dependency and buy nothing — build it plain.
  const availableFileNames = new Set(fileNames);
  const scrollToShot = (name: string): void => {
    shotRefs.current[name]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

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
      {!loading && !error && verdict && <VerdictBanner verdict={verdict} />}
      {/* Behaviors-tested report table (§5.9) — present whenever the payload
          carries at least one valid verification-agent report. */}
      {!loading && !error && data?.kind === 'screenshots' && (
        <BehaviorsTestedSection
          runId={artifact.runId}
          reports={data.payload.reports}
          availableFileNames={availableFileNames}
          onJumpToImage={scrollToShot}
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
                ref={(el) => {
                  shotRefs.current[name] = el;
                }}
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
// ui-prototype / generic — LIVE CANVAS, dual-path (IDEA-039 / Approach C).
//   - a static `ui-prototype` mockup (fileName pointer) OR any committed canvas
//     resolves its on-disk HTML via useArtifactHtml and embeds it in a bare
//     `sandbox=""` `srcDoc` iframe (no scripts, no same-origin);
//   - a legacy `generic` `{ url }` live canvas keeps the cross-origin dev-server
//     iframe (allow-scripts);
//   - a pointer/committed artifact whose HTML is unreadable/absent shows an
//     explicit empty state — NEVER a blank iframe.
// ---------------------------------------------------------------------------
function CanvasBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  // CanvasBody renders for the three canvas atypes (the dispatcher's default
  // fallback coerces anything else to 'generic'); narrow to the load-html req
  // union so an interactive-prototype loads its HTML with the INTERACTIVE CSP
  // (the main handler selects the CSP from the registry by this atype).
  const canvasAtype: LoadArtifactHtmlAtype =
    artifact.atype === 'generic'
      ? 'generic'
      : artifact.atype === 'interactive-prototype'
        ? 'interactive-prototype'
        : 'ui-prototype';
  const isInteractive = artifact.atype === 'interactive-prototype';
  const accent = ARTIFACT_COLORS[canvasAtype];
  const { data } = useArtifactData(artifact, projectId);
  // `fileName`/`url` come verbatim from agent-supplied payload_json (laundered
  // through parsePayload as Record<string, unknown>), so narrow to strings.
  const payload = data?.kind === 'canvas' ? data.payload : undefined;
  const fileName = typeof payload?.fileName === 'string' ? payload.fileName : undefined;
  const url = typeof payload?.url === 'string' ? payload.url : undefined;
  const label = artifact.atype === 'generic' ? 'generic' : isInteractive ? 'interactive prototype' : 'ui prototype';

  // Render selection keys off the PAYLOAD SHAPE, not the committed flag: a
  // `fileName` pointer (or a committed canvas with no url — its snapshot may hold
  // HTML) resolves inline on-disk HTML; a `url` (with no fileName) embeds the
  // legacy live canvas whether committed or not. This keeps a legacy committed
  // {url} rendering as a url (not "unavailable") and loads an uncommitted generic
  // {fileName} (which the old committed-gated hook skipped).
  const hasFile = typeof fileName === 'string';
  const hasUrl = typeof url === 'string';
  const expectsHtml = hasFile || (artifact.committed && !hasUrl);
  const { html, loading } = useArtifactHtml(artifact.runId, canvasAtype, expectsHtml);

  // Only a localhost http(s) URL (the legacy live dev-server canvas) gets a LIVE
  // "Open in browser" anchor. A static srcDoc mockup has no URL to open, so the
  // action is omitted entirely — no dead/disabled button. A javascript:/file://
  // /remote URL from the payload must NOT become a clickable link either (same
  // gate as the iframe in LiveCanvasEmbed).
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
  ) : null;

  // A design session's prototype: sourceRef is server-stamped ONLY for
  // design-scoped artifact reports (see cyboflow_report_artifact / design.ts),
  // so its presence (alongside a sessionId) is what distinguishes a design
  // canvas from an ordinary ui-prototype/generic live canvas. BOTH
  // prototype-family atypes qualify: a mid-session tier switch leaves an
  // interactive-prototype tab alongside the lo-fi one, and an interactive-only
  // run would otherwise have NO entry door at all.
  const isDesignSessionCanvas =
    (artifact.atype === 'ui-prototype' || artifact.atype === 'interactive-prototype') &&
    artifact.sourceRef !== null &&
    artifact.sessionId !== null;

  // Reopening a prototype that never ran inside a design session (no
  // sourceRef — e.g. a planner/sprint-produced ui-prototype) into a NEW or
  // promoted design session is a real, prepared seam: it resolves to the
  // single idea its producing run belongs to via
  // cyboflow.design.resolveReopenIdea (main/src/orchestrator/design/
  // reopenIdeaResolver.ts) — both remain in place and tested. But actually
  // ADOPTING that resolved artifact into a session is session-creation
  // plumbing (main/src/services/*, ipc/session.ts) this component does not
  // own, so rather than advertise a CTA it cannot honour (a permanently
  // disabled button + a tooltip explaining internal plumbing), this canvas
  // withholds the affordance entirely — and never fires the resolver query,
  // since nothing here would consume its result. Re-enable by wiring an
  // onClick that starts/promotes a design session seeded from this artifact
  // once that adoption path exists, gating the CTA on the resolved idea again.

  // "Enter design mode" CTA (v0.5 fullscreen design surface, second entry
  // door) — rendered leftmost of the two, only for a live design-session
  // canvas (sourceRef + sessionId present).
  const enterDesignModeCta: ReactNode = isDesignSessionCanvas ? (
    <button
      type="button"
      data-testid="design-mode-enter-cta"
      onClick={() => {
        const sessionId = artifact.sessionId as string; // narrowed by isDesignSessionCanvas
        // The fullscreen surface's chat rail derives from the global active
        // session, so entering design mode for this artifact's session must
        // also make that session the selected session — only when it isn't
        // already, to avoid an unnecessary subscription teardown/restart.
        if (useCyboflowStore.getState().selectedSessionId !== sessionId) {
          useCyboflowStore.getState().setActiveQuickSession(sessionId);
        }
        useDesignModeStore.getState().enterDesignMode(sessionId);
      }}
      style={{
        fontSize: '10px',
        fontWeight: 700,
        letterSpacing: '.02em',
        color: INK,
        background: PAGE,
        border: `1px solid ${HAIRLINE}`,
        borderRadius: 3,
        padding: '3px 10px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
    >
      Design mode
    </button>
  ) : null;
  const designControl: ReactNode = isDesignSessionCanvas ? (
    <DesignApproveControl sessionId={artifact.sessionId as string} artifactRevision={artifact.revision} />
  ) : null;
  const actions: ReactNode = isDesignSessionCanvas ? (
    <>
      {enterDesignModeCta}
      {designControl}
      {openInBrowser}
    </>
  ) : (
    openInBrowser
  );

  let body: ReactNode;
  if (loading) {
    body = <StateRow testid="artifact-canvas-loading" color={MUTED} text="Loading prototype…" />;
  } else if (html !== null) {
    // Static mockup / committed snapshot — bare-sandbox srcDoc embed.
    body = <LiveCanvasEmbed html={html} />;
  } else if (hasUrl && url) {
    // Legacy live canvas (url with no resolved HTML) — cross-origin dev-server
    // iframe (allow-scripts), whether committed or not.
    body = <LiveCanvasEmbed url={url} interactive />;
  } else if (expectsHtml) {
    // Pointer/committed artifact whose HTML did not resolve — explicit empty
    // state, never a blank iframe.
    body = (
      <div
        data-testid="artifact-canvas-unavailable"
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
        <span style={{ fontSize: '12px', fontWeight: 600, color: INK }}>Prototype unavailable</span>
        <span style={{ fontSize: '10.5px', color: MUTED, textAlign: 'center', maxWidth: 360, lineHeight: 1.5 }}>
          This prototype&apos;s mockup file could not be read. It may have been
          removed, or its run&apos;s artifacts were cleared.
        </span>
      </div>
    );
  } else {
    // No pointer, no url, not committed — nothing to preview yet.
    body = (
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
          This artifact has no mockup yet. Its body embeds a static prototype once
          the agent reports one (via cyboflow_report_artifact).
        </span>
      </div>
    );
  }

  return (
    <Shell testid="artifact-canvas">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow={`◳ Live canvas · ${label}`}
        meta={<span style={{ fontStyle: 'italic' }}>no template — embedded live</span>}
        actions={actions}
      />
      {/* Stage A note bar for the JS-enabled canvas. Stage C replaces the static
          srcDoc preview below with the real process-isolated OOPIF embed; until
          then the interactive prototype previews statically like a ui-prototype,
          so the bar sets the expectation that JS runs in the design surface. */}
      {isInteractive && (
        <div
          data-testid="artifact-interactive-note"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 20px',
            fontSize: '10.5px',
            color: MUTED,
            background: 'var(--color-bg-secondary)',
            borderBottom: `1px solid ${HAIRLINE}`,
          }}
        >
          <span style={{ color: accent }}>◱</span>
          Interactive prototype — JS runs in design mode
        </div>
      )}
      {body}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// approve-ideas — the human-facing half of the approve-ideas BATCH gate
// (IDEA-009). One row per idea in the batch (from the artifact's payload_json,
// re-shaped fail-soft), a tri-state Approve/Deny control per row, and a sticky
// footer with the live counts + a single atomic Submit. The pending
// `gate:human-step:approve-ideas` decision review item for this run is looked
// up client-side from the ALREADY-WIRED reviewItemsSlice (no new subscription).
// Submit posts the complete verdict map via reviewItems.resolve — the server
// re-validates coverage against the gate's DecisionPayload.ideaRefs
// authoritatively (this template's rows are a display convenience only).
// When the batch has ideas but no pending gate (already resolved / a stale
// tab), the rows render read-only with an explanatory note instead of the
// footer.
// ---------------------------------------------------------------------------

/**
 * Tolerant parse of the `approve-ideas` payload_json into row data. Mirrors the
 * fail-soft idiom used elsewhere in this file (e.g. ScreenshotsBody's fileNames
 * narrowing): a malformed/missing payload yields an empty array rather than
 * throwing, and a malformed individual idea entry is dropped rather than
 * poisoning the whole batch.
 */
function parseApproveIdeasIdeas(payloadJson: string | null): ApproveIdeasArtifactPayload['ideas'] {
  if (!payloadJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const ideas = (parsed as Record<string, unknown>).ideas;
  if (!Array.isArray(ideas)) return [];
  const rows: ApproveIdeasArtifactPayload['ideas'] = [];
  for (const entry of ideas) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.ref !== 'string' || typeof e.title !== 'string') continue;
    rows.push({
      ref: e.ref,
      title: e.title,
      scope: typeof e.scope === 'string' ? e.scope : null,
      summary: typeof e.summary === 'string' ? e.summary : null,
    });
  }
  return rows;
}

const GATE_SOURCE_APPROVE_IDEAS = 'gate:human-step:approve-ideas';

// TASK-222: a stable surface id, mirroring ARTIFACT_GATE_SURFACE — stamped into
// payload_json (`resolvedSurface`) so a post-mortem can tell this per-idea
// verdict grid apart from the queue/session cards and the other artifact tabs.
const ARTIFACT_APPROVE_IDEAS_SURFACE = 'artifact:approve-ideas';

/**
 * The gate's authoritative batch ref list (`DecisionPayload.ideaRefs`), when the
 * review item carries one. Falls back to null so the caller can fall back to the
 * artifact payload's own rows — a gate minted before `ideaRefs` was added, or one
 * whose payload failed to parse, must not make the template unusable.
 */
function gateIdeaRefs(payload: ReviewItem['payload']): string[] | null {
  if (payload && payload.kind === 'decision' && Array.isArray(payload.ideaRefs)) {
    return payload.ideaRefs;
  }
  return null;
}

/**
 * One idea row: ref/title/scope/summary + the segmented Approve/Deny control.
 * The text block is itself a button — clicking it opens the idea's full
 * markdown spec in TaskDetailModal (a run only ever gets ONE idea-spec
 * artifact tab, so this is the only way to inspect a non-first idea's spec
 * before voting on it). The Approve/Deny control is a sibling, not a
 * descendant, so its clicks never bubble into onOpenSpec.
 */
function IdeaVerdictRow({
  idea,
  verdict,
  readOnly,
  onSetVerdict,
  onOpenSpec,
  chip,
}: {
  idea: ApproveIdeasArtifactPayload['ideas'][number];
  verdict: IdeaVerdict | null;
  readOnly: boolean;
  onSetVerdict: (verdict: IdeaVerdict) => void;
  onOpenSpec: () => void;
  /** The "changes requested" feedback chip (IDEA-033) — null when the idea has no feedback batches. */
  chip?: ReactElement | null;
}): ReactElement {
  const buttonStyle = (active: boolean, activeColor: string): CSSProperties => ({
    fontSize: '10.5px',
    fontWeight: 700,
    padding: '4px 12px',
    border: 'none',
    background: active ? activeColor : 'var(--color-surface-primary)',
    color: active ? 'var(--color-surface-primary)' : INK,
    cursor: readOnly ? 'default' : 'pointer',
    opacity: readOnly && !active ? 0.5 : 1,
  });

  return (
    <div
      data-testid="approve-ideas-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        border: `1px solid ${HAIRLINE}`,
        background: 'var(--color-surface-primary)',
        padding: '10px 14px',
        marginBottom: 8,
      }}
    >
      <button
        type="button"
        data-testid={`approve-ideas-open-spec-${idea.ref}`}
        onClick={onOpenSpec}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.04em', color: ARTIFACT_COLORS['approve-ideas'] }}>
            {idea.ref}
          </span>
          {idea.scope && (
            <span style={{ fontSize: '8px', fontWeight: 700, color: FAINT, border: `1px solid ${SOFT}`, borderRadius: 2, padding: '0 4px' }}>
              {idea.scope}
            </span>
          )}
          <span style={{ fontSize: '9px', color: FAINT }}>View spec →</span>
          {chip}
        </div>
        <div style={{ fontSize: '12px', fontWeight: 600, color: INK, marginTop: 2 }}>{idea.title}</div>
        {idea.summary && <div style={{ fontSize: '10.5px', color: MUTED, marginTop: 3, lineHeight: 1.4 }}>{idea.summary}</div>}
      </button>
      <div
        data-testid={`approve-ideas-verdict-${idea.ref}`}
        style={{ display: 'flex', border: `1px solid ${HAIRLINE}`, borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}
      >
        <button
          type="button"
          data-testid={`approve-ideas-approve-${idea.ref}`}
          aria-pressed={verdict === 'approve'}
          disabled={readOnly}
          onClick={() => onSetVerdict('approve')}
          style={buttonStyle(verdict === 'approve', VERDICT_PASS)}
        >
          Approve
        </button>
        <button
          type="button"
          data-testid={`approve-ideas-deny-${idea.ref}`}
          aria-pressed={verdict === 'deny'}
          disabled={readOnly}
          onClick={() => onSetVerdict('deny')}
          style={{ ...buttonStyle(verdict === 'deny', VERDICT_FAIL), borderLeft: `1px solid ${HAIRLINE}` }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function ApproveIdeasBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['approve-ideas'];
  const ideas = useMemo(() => parseApproveIdeasIdeas(artifact.payloadJson), [artifact.payloadJson]);

  // "Changes requested" chips (IDEA-033): ONE feedback.list call for the whole
  // run (not per-row) via the run-scoped useFeedback. The artifact payload's
  // rows carry only a display ref, while feedback batches key on the idea's
  // opaque id — so a one-time ref->id resolution (mirroring openSpec's lookup
  // below) lets each row find its own chip.
  const { batches: feedbackBatches } = useFeedback(projectId, artifact.runId);
  const hasFeedbackBatches = feedbackBatches.length > 0;
  const [refToId, setRefToId] = useState<Record<string, string>>({});
  useEffect(() => {
    // Only pay for the ref->id resolution once this run actually has feedback
    // batches to show chips for — the common case (no feedback yet) skips the
    // extra tasks.list call entirely.
    if (!hasFeedbackBatches) return;
    let cancelled = false;
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const row of rows) {
          if (row.type === 'idea') map[row.ref] = row.id;
        }
        setRefToId(map);
      })
      .catch(() => {
        // Best-effort — a failed resolution just means no chips render.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, hasFeedbackBatches]);

  // Reuse the already-wired project-scoped review_items inbox (refcounted) —
  // no new subscription. Filter client-side to THIS run's pending batch gate.
  useEffect(() => {
    const release = useReviewItemsSlice.getState().init(projectId);
    return () => { release(); };
  }, [projectId]);
  const items = useReviewItemsSlice((s) => s.items);
  const gateItem = useMemo(
    () =>
      items.find(
        (it) =>
          it.run_id === artifact.runId &&
          it.kind === 'decision' &&
          it.status === 'pending' &&
          // Recognize BOTH mint paths: the programmatic runner stamps the
          // 'gate:human-step:approve-ideas' source, while the default ORCHESTRATED
          // planner mints via cyboflow_report_finding (source 'agent:<label>'), so
          // its gate is only discoverable via the parsed payload discriminant.
          (it.source === GATE_SOURCE_APPROVE_IDEAS ||
            (it.payload !== null && it.payload.kind === 'decision' && it.payload.gate === 'approve-ideas')),
      ) ?? null,
    [items, artifact.runId],
  );
  const readOnly = gateItem === null;

  const [verdicts, setVerdicts] = useState<IdeaVerdictMap>({});
  const { resolve, error: resolveError } = useReviewItemActions();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const setVerdict = (ref: string, verdict: IdeaVerdict): void => {
    setVerdicts((prev) => ({ ...prev, [ref]: verdict }));
  };

  // Bulk verdict fill (Approve all / Deny all): overwrites every row's verdict
  // in one click — Submit stays the single explicit confirmation step, so a
  // stray bulk click is always reversible before anything is recorded.
  const setAllVerdicts = (verdict: IdeaVerdict): void => {
    const next: IdeaVerdictMap = {};
    for (const idea of ideas) next[idea.ref] = verdict;
    setVerdicts(next);
  };

  // Spec viewing (orthogonal to verdicts — works read-only and gated). The
  // artifact payload's rows carry only a display ref, not an opaque entity
  // id, so a click resolves the ref against the live project backlog. An
  // incrementing token guards against a slow first fetch clobbering a faster
  // later one when the user clicks another row before the first resolves.
  const [specIdea, setSpecIdea] = useState<BacklogTaskItem | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const specRequestToken = useRef(0);

  const openSpec = (ref: string): void => {
    setSpecError(null);
    const token = ++specRequestToken.current;
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        if (specRequestToken.current !== token) return; // superseded by a later click
        const idea = rows.find((t) => t.type === 'idea' && t.ref === ref) ?? null;
        if (idea) {
          setSpecIdea(idea);
        } else {
          setSpecError(`Couldn't load the spec for ${ref}.`);
        }
      })
      .catch(() => {
        if (specRequestToken.current !== token) return;
        setSpecError(`Couldn't load the spec for ${ref}.`);
      });
  };

  const approvedCount = ideas.filter((idea) => verdicts[idea.ref] === 'approve').length;
  const deniedCount = ideas.filter((idea) => verdicts[idea.ref] === 'deny').length;
  const undecidedCount = ideas.length - approvedCount - deniedCount;

  const onSubmit = (): void => {
    if (submitting || undecidedCount > 0 || !gateItem) return;
    // Cross-check the map against the gate's authoritative batch (defense in
    // depth — the server re-validates this same coverage authoritatively on
    // reviewItems.resolve). A mismatch here means the artifact's rows and the
    // live gate have drifted (e.g. a stale tab); refuse to submit rather than
    // let the server's rejection surface as an opaque error.
    const requiredRefs = gateIdeaRefs(gateItem.payload) ?? ideas.map((idea) => idea.ref);
    const covers =
      requiredRefs.every((ref) => ref in verdicts) &&
      Object.keys(verdicts).every((ref) => requiredRefs.includes(ref));
    if (!covers) {
      setSubmitError('This batch no longer matches the pending approval gate — reopen the tab.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    resolve(projectId, gateItem.id, { verdicts, surface: ARTIFACT_APPROVE_IDEAS_SURFACE }).then((result) => {
      setSubmitting(false);
      // The hook stores the server's real message (e.g. "blocked: resolve the
      // pending size guards first") in its own error state; the alert below
      // prefers it over this generic fallback.
      if (result === null) setSubmitError('Failed to submit decisions.');
    });
  };

  return (
    <Shell testid="artifact-approve-ideas">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · approve ideas"
        meta={artifact.stepOrigin ?? undefined}
      />
      {ideas.length === 0 ? (
        <StateRow testid="artifact-approve-ideas-empty" color={MUTED} text="No ideas to review." />
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, padding: '16px 20px 12px' }}>
            {readOnly && (
              <div
                data-testid="approve-ideas-no-gate-note"
                style={{ fontSize: '11px', color: MUTED, marginBottom: 14, fontStyle: 'italic' }}
              >
                No pending approval gate for this run.
              </div>
            )}
            {ideas.map((idea) => {
              const ideaId = refToId[idea.ref];
              const chipStatus = ideaId ? latestBatchStatus(feedbackBatches, ideaId) : null;
              return (
                <IdeaVerdictRow
                  key={idea.ref}
                  idea={idea}
                  verdict={verdicts[idea.ref] ?? null}
                  readOnly={readOnly}
                  onSetVerdict={(verdict) => setVerdict(idea.ref, verdict)}
                  onOpenSpec={() => openSpec(idea.ref)}
                  chip={<FeedbackChip status={chipStatus} />}
                />
              );
            })}
            {specError && (
              <span data-testid="approve-ideas-spec-error" style={{ fontSize: '10px', color: VERDICT_FAIL }}>
                {specError}
              </span>
            )}
          </div>
          {gateItem && (
            <div
              data-testid="approve-ideas-footer"
              style={{
                position: 'sticky',
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 20px',
                borderTop: `1px solid ${HAIRLINE}`,
                background: 'var(--color-bg-secondary)',
              }}
            >
              <span data-testid="approve-ideas-counts" style={{ fontSize: '11px', color: MUTED, fontWeight: 600 }}>
                {`${approvedCount} approved · ${deniedCount} denied · ${undecidedCount} undecided`}
              </span>
              <div style={{ display: 'flex', border: `1px solid ${HAIRLINE}`, borderRadius: 3, overflow: 'hidden' }}>
                <button
                  type="button"
                  data-testid="approve-ideas-approve-all"
                  disabled={submitting}
                  onClick={() => setAllVerdicts('approve')}
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '4px 10px',
                    border: 'none',
                    background: 'var(--color-surface-primary)',
                    color: VERDICT_PASS,
                    cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  Approve all
                </button>
                <button
                  type="button"
                  data-testid="approve-ideas-deny-all"
                  disabled={submitting}
                  onClick={() => setAllVerdicts('deny')}
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '4px 10px',
                    border: 'none',
                    borderLeft: `1px solid ${HAIRLINE}`,
                    background: 'var(--color-surface-primary)',
                    color: VERDICT_FAIL,
                    cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  Deny all
                </button>
              </div>
              <span style={{ flex: 1 }} />
              {(resolveError ?? submitError) && (
                <span data-testid="approve-ideas-submit-error" style={{ fontSize: '10px', color: VERDICT_FAIL }}>
                  {resolveError ?? submitError}
                </span>
              )}
              <button
                type="button"
                data-testid="approve-ideas-submit"
                disabled={submitting || undecidedCount > 0}
                onClick={onSubmit}
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '.02em',
                  color: 'var(--color-surface-primary)',
                  background: INK,
                  border: `1px solid ${INK}`,
                  borderRadius: 3,
                  padding: '5px 14px',
                  cursor: submitting || undecidedCount > 0 ? 'default' : 'pointer',
                  opacity: submitting || undecidedCount > 0 ? 0.5 : 1,
                }}
              >
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          )}
        </div>
      )}
      <TaskDetailModal task={specIdea} onClose={() => setSpecIdea(null)} />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// approve-designs — the human-facing half of the approve-designs BATCH gate,
// the design-approval sibling of approve-ideas (see block above). One row per
// idea's architecture design in the batch (from the artifact's payload_json,
// re-shaped fail-soft), a tri-state Approve/Deny control per row, and a sticky
// footer with the live counts + a single atomic Submit. The pending
// `gate:human-step:approve-designs` decision review item for this run is
// looked up client-side from the ALREADY-WIRED reviewItemsSlice (no new
// subscription). Submit posts the complete verdict map via reviewItems.resolve
// — the server re-validates coverage against the gate's DecisionPayload.
// designRefs authoritatively (this template's rows are a display convenience
// only). When the batch has designs but no pending gate (already resolved / a
// stale tab), the rows render read-only with an explanatory note instead of
// the footer.
// ---------------------------------------------------------------------------

/**
 * Tolerant parse of the `approve-designs` payload_json into row data. Mirrors
 * parseApproveIdeasIdeas above: a malformed/missing payload yields an empty
 * array rather than throwing, and a malformed individual design entry is
 * dropped rather than poisoning the whole batch.
 */
function parseApproveDesignsDesigns(payloadJson: string | null): ApproveDesignsArtifactPayload['designs'] {
  if (!payloadJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const designs = (parsed as Record<string, unknown>).designs;
  if (!Array.isArray(designs)) return [];
  const rows: ApproveDesignsArtifactPayload['designs'] = [];
  for (const entry of designs) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.ref !== 'string' || typeof e.title !== 'string') continue;
    rows.push({
      ref: e.ref,
      title: e.title,
      scope: typeof e.scope === 'string' ? e.scope : null,
      summary: typeof e.summary === 'string' ? e.summary : null,
    });
  }
  return rows;
}

const GATE_SOURCE_APPROVE_DESIGNS = 'gate:human-step:approve-designs';

// TASK-222: a stable surface id, mirroring ARTIFACT_GATE_SURFACE above — stamped
// into payload_json (`resolvedSurface`) so a post-mortem can tell this per-idea
// verdict grid apart from the queue/session cards and the decomposed-stories tab.
const ARTIFACT_APPROVE_DESIGNS_SURFACE = 'artifact:approve-designs';

/**
 * The gate's authoritative batch ref list (`DecisionPayload.designRefs`), when
 * the review item carries one. Mirrors gateIdeaRefs above — falls back to null
 * so the caller can fall back to the artifact payload's own rows (a gate
 * minted before `designRefs` was added, or one whose payload failed to parse,
 * must not make the template unusable).
 */
function gateDesignRefs(payload: ReviewItem['payload']): string[] | null {
  if (payload && payload.kind === 'decision' && Array.isArray(payload.designRefs)) {
    return payload.designRefs;
  }
  return null;
}

/**
 * One design row: ref/title/scope/summary + the segmented Approve/Deny
 * control. Cloned from IdeaVerdictRow rather than reused — that component
 * hardcodes 'approve-ideas' testids and the approve-ideas accent color, so it
 * is not generic across gates. The text block is itself a button — clicking
 * it opens the owning idea's full markdown spec (its '## Architecture design'
 * section lives in the same idea body) in TaskDetailModal. The Approve/Deny
 * control is a sibling, not a descendant, so its clicks never bubble into
 * onOpenSpec.
 */
function DesignVerdictRow({
  design,
  verdict,
  readOnly,
  onSetVerdict,
  onOpenSpec,
  chip,
}: {
  design: ApproveDesignsArtifactPayload['designs'][number];
  verdict: IdeaVerdict | null;
  readOnly: boolean;
  onSetVerdict: (verdict: IdeaVerdict) => void;
  onOpenSpec: () => void;
  /** The "changes requested" feedback chip (IDEA-033) — null when the idea has no feedback batches. */
  chip?: ReactElement | null;
}): ReactElement {
  const buttonStyle = (active: boolean, activeColor: string): CSSProperties => ({
    fontSize: '10.5px',
    fontWeight: 700,
    padding: '4px 12px',
    border: 'none',
    background: active ? activeColor : 'var(--color-surface-primary)',
    color: active ? 'var(--color-surface-primary)' : INK,
    cursor: readOnly ? 'default' : 'pointer',
    opacity: readOnly && !active ? 0.5 : 1,
  });

  return (
    <div
      data-testid="approve-designs-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        border: `1px solid ${HAIRLINE}`,
        background: 'var(--color-surface-primary)',
        padding: '10px 14px',
        marginBottom: 8,
      }}
    >
      <button
        type="button"
        data-testid={`approve-designs-open-spec-${design.ref}`}
        onClick={onOpenSpec}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'none',
          border: 'none',
          padding: 0,
          textAlign: 'left',
          font: 'inherit',
          cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: '9px', fontWeight: 700, letterSpacing: '.04em', color: ARTIFACT_COLORS['approve-designs'] }}>
            {design.ref}
          </span>
          {design.scope && (
            <span style={{ fontSize: '8px', fontWeight: 700, color: FAINT, border: `1px solid ${SOFT}`, borderRadius: 2, padding: '0 4px' }}>
              {design.scope}
            </span>
          )}
          <span style={{ fontSize: '9px', color: FAINT }}>View spec →</span>
          {chip}
        </div>
        <div style={{ fontSize: '12px', fontWeight: 600, color: INK, marginTop: 2 }}>{design.title}</div>
        {design.summary && <div style={{ fontSize: '10.5px', color: MUTED, marginTop: 3, lineHeight: 1.4 }}>{design.summary}</div>}
      </button>
      <div
        data-testid={`approve-designs-verdict-${design.ref}`}
        style={{ display: 'flex', border: `1px solid ${HAIRLINE}`, borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}
      >
        <button
          type="button"
          data-testid={`approve-designs-approve-${design.ref}`}
          aria-pressed={verdict === 'approve'}
          disabled={readOnly}
          onClick={() => onSetVerdict('approve')}
          style={buttonStyle(verdict === 'approve', VERDICT_PASS)}
        >
          Approve
        </button>
        <button
          type="button"
          data-testid={`approve-designs-deny-${design.ref}`}
          aria-pressed={verdict === 'deny'}
          disabled={readOnly}
          onClick={() => onSetVerdict('deny')}
          style={{ ...buttonStyle(verdict === 'deny', VERDICT_FAIL), borderLeft: `1px solid ${HAIRLINE}` }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function ApproveDesignsBody({ artifact, projectId }: { artifact: Artifact; projectId: number }): ReactElement {
  const accent = ARTIFACT_COLORS['approve-designs'];
  const designs = useMemo(() => parseApproveDesignsDesigns(artifact.payloadJson), [artifact.payloadJson]);

  // "Changes requested" chips (IDEA-033): ONE feedback.list call for the whole
  // run (not per-row) via the run-scoped useFeedback. The artifact payload's
  // rows carry only a display ref, while feedback batches key on the idea's
  // opaque id — so a one-time ref->id resolution (mirroring openSpec's lookup
  // below) lets each row find its own chip.
  const { batches: feedbackBatches } = useFeedback(projectId, artifact.runId);
  const hasFeedbackBatches = feedbackBatches.length > 0;
  const [refToId, setRefToId] = useState<Record<string, string>>({});
  useEffect(() => {
    // Only pay for the ref->id resolution once this run actually has feedback
    // batches to show chips for — the common case (no feedback yet) skips the
    // extra tasks.list call entirely.
    if (!hasFeedbackBatches) return;
    let cancelled = false;
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const row of rows) {
          if (row.type === 'idea') map[row.ref] = row.id;
        }
        setRefToId(map);
      })
      .catch(() => {
        // Best-effort — a failed resolution just means no chips render.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, hasFeedbackBatches]);

  // Reuse the already-wired project-scoped review_items inbox (refcounted) —
  // no new subscription. Filter client-side to THIS run's pending batch gate.
  useEffect(() => {
    const release = useReviewItemsSlice.getState().init(projectId);
    return () => { release(); };
  }, [projectId]);
  const items = useReviewItemsSlice((s) => s.items);
  const gateItem = useMemo(
    () =>
      items.find(
        (it) =>
          it.run_id === artifact.runId &&
          it.kind === 'decision' &&
          it.status === 'pending' &&
          // Recognize BOTH mint paths: the programmatic runner stamps the
          // 'gate:human-step:approve-designs' source, while the default
          // ORCHESTRATED planner mints via cyboflow_report_finding (source
          // 'agent:<label>'), so its gate is only discoverable via the parsed
          // payload discriminant.
          (it.source === GATE_SOURCE_APPROVE_DESIGNS ||
            (it.payload !== null && it.payload.kind === 'decision' && it.payload.gate === 'approve-designs')),
      ) ?? null,
    [items, artifact.runId],
  );
  const readOnly = gateItem === null;

  const [verdicts, setVerdicts] = useState<IdeaVerdictMap>({});
  const { resolve, error: resolveError } = useReviewItemActions();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const setVerdict = (ref: string, verdict: IdeaVerdict): void => {
    setVerdicts((prev) => ({ ...prev, [ref]: verdict }));
  };

  // Bulk verdict fill (Approve all / Deny all): overwrites every row's verdict
  // in one click — Submit stays the single explicit confirmation step, so a
  // stray bulk click is always reversible before anything is recorded.
  const setAllVerdicts = (verdict: IdeaVerdict): void => {
    const next: IdeaVerdictMap = {};
    for (const design of designs) next[design.ref] = verdict;
    setVerdicts(next);
  };

  // Spec viewing (orthogonal to verdicts — works read-only and gated). The
  // artifact payload's rows carry only a display ref, not an opaque entity
  // id, so a click resolves the ref against the live project backlog. An
  // incrementing token guards against a slow first fetch clobbering a faster
  // later one when the user clicks another row before the first resolves.
  const [specIdea, setSpecIdea] = useState<BacklogTaskItem | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);
  const specRequestToken = useRef(0);

  const openSpec = (ref: string): void => {
    setSpecError(null);
    const token = ++specRequestToken.current;
    trpc.cyboflow.tasks.list
      .query({ projectId })
      .then((rows) => {
        if (specRequestToken.current !== token) return; // superseded by a later click
        const idea = rows.find((t) => t.type === 'idea' && t.ref === ref) ?? null;
        if (idea) {
          setSpecIdea(idea);
        } else {
          setSpecError(`Couldn't load the spec for ${ref}.`);
        }
      })
      .catch(() => {
        if (specRequestToken.current !== token) return;
        setSpecError(`Couldn't load the spec for ${ref}.`);
      });
  };

  const approvedCount = designs.filter((design) => verdicts[design.ref] === 'approve').length;
  const deniedCount = designs.filter((design) => verdicts[design.ref] === 'deny').length;
  const undecidedCount = designs.length - approvedCount - deniedCount;

  const onSubmit = (): void => {
    if (submitting || undecidedCount > 0 || !gateItem) return;
    // Cross-check the map against the gate's authoritative batch (defense in
    // depth — the server re-validates this same coverage authoritatively on
    // reviewItems.resolve). A mismatch here means the artifact's rows and the
    // live gate have drifted (e.g. a stale tab); refuse to submit rather than
    // let the server's rejection surface as an opaque error.
    const requiredRefs = gateDesignRefs(gateItem.payload) ?? designs.map((design) => design.ref);
    const covers =
      requiredRefs.every((ref) => ref in verdicts) &&
      Object.keys(verdicts).every((ref) => requiredRefs.includes(ref));
    if (!covers) {
      setSubmitError('This batch no longer matches the pending approval gate — reopen the tab.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    resolve(projectId, gateItem.id, { verdicts, surface: ARTIFACT_APPROVE_DESIGNS_SURFACE }).then((result) => {
      setSubmitting(false);
      // The hook stores the server's real message (e.g. "blocked: resolve the
      // pending size guards first") in its own error state; the alert below
      // prefers it over this generic fallback.
      if (result === null) setSubmitError('Failed to submit decisions.');
    });
  };

  return (
    <Shell testid="artifact-approve-designs">
      <ArtifactHeader
        artifact={artifact}
        projectId={projectId}
        accent={accent}
        eyebrow="Artifact · approve designs"
        meta={artifact.stepOrigin ?? undefined}
      />
      {designs.length === 0 ? (
        <StateRow testid="artifact-approve-designs-empty" color={MUTED} text="No designs to review." />
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, padding: '16px 20px 12px' }}>
            {readOnly && (
              <div
                data-testid="approve-designs-no-gate-note"
                style={{ fontSize: '11px', color: MUTED, marginBottom: 14, fontStyle: 'italic' }}
              >
                No pending approval gate for this run.
              </div>
            )}
            {designs.map((design) => {
              const ideaId = refToId[design.ref];
              const chipStatus = ideaId ? latestBatchStatus(feedbackBatches, ideaId) : null;
              return (
                <DesignVerdictRow
                  key={design.ref}
                  design={design}
                  verdict={verdicts[design.ref] ?? null}
                  readOnly={readOnly}
                  onSetVerdict={(verdict) => setVerdict(design.ref, verdict)}
                  onOpenSpec={() => openSpec(design.ref)}
                  chip={<FeedbackChip status={chipStatus} />}
                />
              );
            })}
            {specError && (
              <span data-testid="approve-designs-spec-error" style={{ fontSize: '10px', color: VERDICT_FAIL }}>
                {specError}
              </span>
            )}
          </div>
          {gateItem && (
            <div
              data-testid="approve-designs-footer"
              style={{
                position: 'sticky',
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 20px',
                borderTop: `1px solid ${HAIRLINE}`,
                background: 'var(--color-bg-secondary)',
              }}
            >
              <span data-testid="approve-designs-counts" style={{ fontSize: '11px', color: MUTED, fontWeight: 600 }}>
                {`${approvedCount} approved · ${deniedCount} denied · ${undecidedCount} undecided`}
              </span>
              <div style={{ display: 'flex', border: `1px solid ${HAIRLINE}`, borderRadius: 3, overflow: 'hidden' }}>
                <button
                  type="button"
                  data-testid="approve-designs-approve-all"
                  disabled={submitting}
                  onClick={() => setAllVerdicts('approve')}
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '4px 10px',
                    border: 'none',
                    background: 'var(--color-surface-primary)',
                    color: VERDICT_PASS,
                    cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  Approve all
                </button>
                <button
                  type="button"
                  data-testid="approve-designs-deny-all"
                  disabled={submitting}
                  onClick={() => setAllVerdicts('deny')}
                  style={{
                    fontSize: '10px',
                    fontWeight: 700,
                    padding: '4px 10px',
                    border: 'none',
                    borderLeft: `1px solid ${HAIRLINE}`,
                    background: 'var(--color-surface-primary)',
                    color: VERDICT_FAIL,
                    cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting ? 0.5 : 1,
                  }}
                >
                  Deny all
                </button>
              </div>
              <span style={{ flex: 1 }} />
              {(resolveError ?? submitError) && (
                <span data-testid="approve-designs-submit-error" style={{ fontSize: '10px', color: VERDICT_FAIL }}>
                  {resolveError ?? submitError}
                </span>
              )}
              <button
                type="button"
                data-testid="approve-designs-submit"
                disabled={submitting || undecidedCount > 0}
                onClick={onSubmit}
                style={{
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '.02em',
                  color: 'var(--color-surface-primary)',
                  background: INK,
                  border: `1px solid ${INK}`,
                  borderRadius: 3,
                  padding: '5px 14px',
                  cursor: submitting || undecidedCount > 0 ? 'default' : 'pointer',
                  opacity: submitting || undecidedCount > 0 ? 0.5 : 1,
                }}
              >
                {submitting ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          )}
        </div>
      )}
      <TaskDetailModal task={specIdea} onClose={() => setSpecIdea(null)} />
    </Shell>
  );
}

export function ArtifactTabRenderer({ artifact, projectId }: ArtifactTabRendererProps): ReactElement {
  switch (artifact.atype) {
    case 'idea-spec':
      return <IdeaSpecBody artifact={artifact} projectId={projectId} />;
    case 'arch-design':
      return <ArchDesignBody artifact={artifact} projectId={projectId} />;
    case 'idea-summary':
      return <IdeaSummaryBody artifact={artifact} projectId={projectId} />;
    case 'compound-recommendations':
      return <RecommendationsBody artifact={artifact} projectId={projectId} />;
    case 'verify-runbook':
      return <VerifyRunbookBody artifact={artifact} projectId={projectId} />;
    case 'adversarial-review':
      return <AdversarialReviewBody artifact={artifact} projectId={projectId} />;
    case 'eval-report':
      return <EvalReportBody artifact={artifact} projectId={projectId} />;
    case 'project-brief':
      return <ProjectBriefBody artifact={artifact} projectId={projectId} />;
    case 'decomposed-stories':
      return <DecomposedStoriesBody artifact={artifact} projectId={projectId} />;
    case 'screenshots':
      return <ScreenshotsBody artifact={artifact} projectId={projectId} />;
    case 'ui-prototype':
    case 'generic':
    case 'interactive-prototype':
      return <CanvasBody artifact={artifact} projectId={projectId} />;
    case 'approve-ideas':
      return <ApproveIdeasBody artifact={artifact} projectId={projectId} />;
    case 'approve-designs':
      return <ApproveDesignsBody artifact={artifact} projectId={projectId} />;
    default: {
      // Exhaustive guard — ArtifactType is a closed union; this never executes.
      // Falls back to the canvas (generic) view if a new atype is ever added.
      void (artifact.atype satisfies never);
      return <CanvasBody artifact={{ ...artifact, atype: 'generic' }} projectId={projectId} />;
    }
  }
}
