/**
 * TaskDetailModal — full-detail overlay for a single backlog task.
 *
 * Opened from a clickable task card in the 'decomposed-stories' artifact body
 * (ArtifactTabRenderer → TaskGrid) AND from the "open root idea" back-link on an
 * epic/task card (Backlog/TaskCard). It shows the task's ref, title, priority,
 * and one-line summary in a warm-paper header, then renders the full markdown
 * `body` via the app's MarkdownPreview (react-markdown — never raw HTML). When
 * the body is null/empty it shows a graceful "No additional detail" state.
 *
 * Idea decomposition + internal navigation: when an IDEA opens, its spawned
 * children (epics + direct tasks, nested under `idea.children` by
 * selectIdeaDecomposition) are listed under a "Decomposed into" section so a
 * decomposed idea — off the board, reachable only via its children — stays
 * inspectable. Clicking a child drills into that child's detail within the same
 * modal (a back-link returns to the idea). `active` tracks the entity currently
 * shown and resets to the prop `task` whenever a new task opens.
 *
 * It wraps the shared ui/Modal (portal to document.body, Escape + overlay-click
 * close, body-scroll lock). The inline hexes mirror the warm-paper palette used
 * across ArtifactTabRenderer (STORIES accent, hairlines, font sizes); the M7
 * polish pass tokenizes them.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { Modal } from '../ui/Modal';
import { MarkdownPreview } from '../MarkdownPreview';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';

const HAIRLINE = 'var(--color-border-primary)';
const SOFT = 'var(--color-border-tertiary)';
const FAINT = 'var(--color-text-tertiary)';
const MUTED = 'var(--color-text-secondary)';
const INK = 'var(--color-text-primary)';
const STORIES = 'var(--color-phase-refine)';

interface TaskDetailModalProps {
  /** The task to detail, or null when the modal is closed. */
  task: BacklogTaskItem | null;
  onClose: () => void;
}

export function TaskDetailModal({ task, onClose }: TaskDetailModalProps): ReactElement | null {
  // Internal navigation: the entity currently shown. It seeds from the prop
  // `task` and resets whenever a different task opens (or the modal closes), so
  // drilling into an idea's child never leaks across opens.
  const [active, setActive] = useState<BacklogTaskItem | null>(task);
  useEffect(() => {
    setActive(task);
  }, [task]);

  if (!task || !active) return null;

  const body = active.body?.trim() ?? '';
  // A decomposed idea is OFF the board but stays navigable: list its spawned
  // epics + direct tasks (selectIdeaDecomposition nests both under
  // idea.children). Only ideas carry this list — epics/tasks render plainly.
  const decompositionChildren = active.type === 'idea' ? active.children ?? [] : [];
  // True once the user has drilled from the originating idea into one of its
  // children — surfaces a back-link to return to the idea.
  const drilledIntoChild = active.id !== task.id;

  return (
    <Modal isOpen onClose={onClose} size="lg" showCloseButton>
      <div data-testid="task-detail-modal" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Back-link — only while drilled into a child of the originating idea. */}
        {drilledIntoChild && (
          <button
            type="button"
            onClick={() => setActive(task)}
            data-testid="task-detail-back"
            style={{
              alignSelf: 'flex-start',
              margin: '14px 24px 0',
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              color: MUTED,
            }}
          >
            ← Back to {task.ref}
          </button>
        )}

        {/* Header — ref + priority chip, then title + summary. */}
        <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${HAIRLINE}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: STORIES, letterSpacing: '.04em' }}>
              {active.ref}
            </span>
            {active.priority && (
              <span
                data-testid="task-detail-priority"
                style={{
                  fontSize: '9px',
                  fontWeight: 700,
                  color: FAINT,
                  border: `1px solid ${SOFT}`,
                  borderRadius: 2,
                  padding: '1px 5px',
                }}
              >
                {active.priority}
              </span>
            )}
          </div>
          <h2
            data-testid="task-detail-title"
            style={{ fontSize: '18px', fontWeight: 700, lineHeight: 1.3, color: INK, margin: 0 }}
          >
            {active.title}
          </h2>
          {active.summary && (
            <div data-testid="task-detail-summary" style={{ fontSize: '12px', color: MUTED, marginTop: 6, lineHeight: 1.45 }}>
              {active.summary}
            </div>
          )}
        </div>

        {/* Body — full markdown, or a graceful empty state. */}
        <div data-testid="task-detail-body" style={{ padding: '16px 24px 24px', overflow: 'auto' }}>
          {body ? (
            <MarkdownPreview content={body} />
          ) : (
            <div
              data-testid="task-detail-nobody"
              style={{ fontSize: '12px', color: FAINT, fontStyle: 'italic' }}
            >
              No additional detail.
            </div>
          )}
        </div>

        {/* Decomposition children (idea only) — the idea's spawned epics + direct
            tasks, each a button that drills into its detail in this modal. */}
        {decompositionChildren.length > 0 && (
          <div
            data-testid="task-detail-children"
            style={{ padding: '14px 24px 22px', borderTop: `1px solid ${HAIRLINE}` }}
          >
            <div style={{ fontSize: '9px', fontWeight: 700, color: FAINT, letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 10 }}>
              Decomposed into
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {decompositionChildren.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => setActive(child)}
                    data-testid="task-detail-child"
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      width: '100%',
                      textAlign: 'left',
                      background: 'none',
                      border: `1px solid ${SOFT}`,
                      borderRadius: 4,
                      padding: '7px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: '9px', fontWeight: 700, color: STORIES, letterSpacing: '.04em', flexShrink: 0 }}>
                      {child.ref}
                    </span>
                    <span style={{ fontSize: '8.5px', fontWeight: 700, color: FAINT, letterSpacing: '.05em', textTransform: 'uppercase', flexShrink: 0 }}>
                      {child.type}
                    </span>
                    <span style={{ fontSize: '12px', color: INK, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {child.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
