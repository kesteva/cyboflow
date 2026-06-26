/**
 * TaskDetailModal — full-detail overlay for a single backlog task.
 *
 * Opened from a clickable task card in the 'decomposed-stories' artifact body
 * (ArtifactTabRenderer → TaskGrid). It shows the task's ref, title, priority,
 * and one-line summary in a warm-paper header, then renders the full markdown
 * `body` via the app's MarkdownPreview (react-markdown — never raw HTML). When
 * the body is null/empty it shows a graceful "No additional detail" state.
 *
 * It wraps the shared ui/Modal (portal to document.body, Escape + overlay-click
 * close, body-scroll lock). The inline hexes mirror the warm-paper palette used
 * across ArtifactTabRenderer (STORIES accent, hairlines, font sizes); the M7
 * polish pass tokenizes them.
 */
import type { ReactElement } from 'react';
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
  if (!task) return null;

  const body = task.body?.trim() ?? '';

  return (
    <Modal isOpen onClose={onClose} size="lg" showCloseButton>
      <div data-testid="task-detail-modal" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {/* Header — ref + priority chip, then title + summary. */}
        <div style={{ padding: '20px 24px 14px', borderBottom: `1px solid ${HAIRLINE}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ fontSize: '10px', fontWeight: 700, color: STORIES, letterSpacing: '.04em' }}>
              {task.ref}
            </span>
            {task.priority && (
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
                {task.priority}
              </span>
            )}
          </div>
          <h2
            data-testid="task-detail-title"
            style={{ fontSize: '18px', fontWeight: 700, lineHeight: 1.3, color: INK, margin: 0 }}
          >
            {task.title}
          </h2>
          {task.summary && (
            <div data-testid="task-detail-summary" style={{ fontSize: '12px', color: MUTED, marginTop: 6, lineHeight: 1.45 }}>
              {task.summary}
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
      </div>
    </Modal>
  );
}
