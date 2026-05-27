/**
 * AskUserQuestionCard — renders one Question gate as an interactive card.
 *
 * Renders all questions in a single Question record. Each question has:
 *  - A chip-style header Pill (truncated to 12 chars with ellipsis when longer)
 *  - A radio group (single-select) or checkbox group (multi-select)
 *  - Per-option label, optional description, optional collapsible MarkdownPreview
 *  - An implicit "Other" choice with a sibling free-text input
 *
 * Submit builds answers keyed by question.question (full text), sends them via
 * trpc.cyboflow.questions.answer.mutate, and calls onAnswered() on success.
 *
 * This component ships building blocks only — wiring into RunChatView /
 * RunBottomPane is TASK-761.
 *
 * ## Multi-sub-question keying
 *
 * The `otherText` bus in questionStore is keyed by `questionId` only (not by
 * sub-question index). When the bus slot for this card's `item.id` is defined,
 * every sub-question's Other input is pre-filled with the same bus value
 * (uniform distribution). The user can override per-sub-question by typing
 * into a specific input — local edits win for that sub-question while other
 * sub-questions keep showing the bus value. Rationale: the bottom-bar
 * ChatInput writes a single text blob with no sub-question context; uniform
 * distribution is the only correctness-preserving default. Future enhancement
 * (not in this task): extend the bus to `Record<string, Record<number, string>>`
 * keyed by `(questionId, subIndex)` if the multi-sub-question case becomes
 * user-visible. This file is the bus is question-level reader.
 */
import React, { useState } from 'react';
import { Pill } from '../ui/Pill';
import { Button } from '../ui/Button';
import { MarkdownPreview } from '../MarkdownPreview';
import { trpc } from '../../trpc/client';
import { useQuestionStore } from '../../stores/questionStore';
import type { Question, QuestionPayload } from '../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AskUserQuestionCardProps {
  item: Question;
  /** Called once after a successful submit mutation. Optional. */
  onAnswered?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxLen characters and append an ellipsis if longer. */
function truncateHeader(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…'; // U+2026 HORIZONTAL ELLIPSIS
}

// ---------------------------------------------------------------------------
// Per-question sub-component
// ---------------------------------------------------------------------------

interface QuestionFieldsetProps {
  qp: QuestionPayload;
  questionIndex: number;
  /** Single-select: selected option label | null. Multi-select: Set of labels. */
  selection: string | null | Set<string>;
  otherSelected: boolean;
  otherText: string;
  onSingleChange: (label: string) => void;
  onMultiChange: (label: string, checked: boolean) => void;
  onOtherToggle: (checked: boolean) => void;
  onOtherText: (text: string) => void;
}

function QuestionFieldset({
  qp,
  questionIndex,
  selection,
  otherSelected,
  otherText,
  onSingleChange,
  onMultiChange,
  onOtherToggle,
  onOtherText,
}: QuestionFieldsetProps): React.ReactElement {
  // Track which options have their preview panel open
  const [openPreviews, setOpenPreviews] = useState<Set<number>>(new Set());

  function togglePreview(optionIndex: number): void {
    setOpenPreviews((prev) => {
      const next = new Set(prev);
      if (next.has(optionIndex)) {
        next.delete(optionIndex);
      } else {
        next.add(optionIndex);
      }
      return next;
    });
  }

  const inputType = qp.multiSelect ? 'checkbox' : 'radio';
  const groupName = `question-${questionIndex}`;
  const truncated = truncateHeader(qp.header, 12);

  return (
    <fieldset className="mb-4 last:mb-0">
      <legend className="mb-2">
        <Pill variant="default" size="sm" disabled>
          {truncated}
        </Pill>
        <span className="sr-only">{qp.question}</span>
      </legend>

      <p className="text-sm text-text-secondary mb-2">{qp.question}</p>

      <div className="space-y-2">
        {qp.options.map((option, optionIndex) => {
          const inputId = `${groupName}-option-${optionIndex}`;
          const previewId = `${groupName}-preview-${optionIndex}`;

          let isChecked: boolean;
          if (qp.multiSelect) {
            isChecked = selection instanceof Set && selection.has(option.label);
          } else {
            isChecked = selection === option.label;
          }

          return (
            <div key={option.label} className="space-y-1">
              <div className="flex items-start gap-2">
                <input
                  type={inputType}
                  id={inputId}
                  name={groupName}
                  value={option.label}
                  checked={isChecked}
                  onChange={(e) => {
                    if (qp.multiSelect) {
                      onMultiChange(option.label, e.target.checked);
                    } else {
                      onSingleChange(option.label);
                    }
                  }}
                  className="mt-1 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <label htmlFor={inputId} className="text-sm text-text-primary cursor-pointer">
                    {option.label}
                  </label>
                  {option.description != null && option.description !== '' && (
                    <p className="text-xs text-text-muted mt-0.5">{option.description}</p>
                  )}
                  {option.preview != null && option.preview !== '' && (
                    <div className="mt-1">
                      <button
                        type="button"
                        className="text-xs text-interactive hover:text-interactive-hover underline"
                        aria-expanded={openPreviews.has(optionIndex)}
                        aria-controls={previewId}
                        onClick={() => { togglePreview(optionIndex); }}
                      >
                        {openPreviews.has(optionIndex) ? 'Hide preview' : 'Show preview'}
                      </button>
                      {openPreviews.has(optionIndex) && (
                        <div
                          id={previewId}
                          role="region"
                          aria-label={`Preview for ${option.label}`}
                          className="mt-2 p-2 bg-bg-tertiary rounded text-sm"
                        >
                          <MarkdownPreview content={option.preview} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {/* Implicit "Other" choice */}
        <div className="flex items-start gap-2">
          <input
            type={inputType}
            id={`${groupName}-other`}
            name={groupName}
            value="__other__"
            checked={otherSelected}
            onChange={(e) => {
              onOtherToggle(e.target.checked);
            }}
            className="mt-1 flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <label htmlFor={`${groupName}-other`} className="text-sm text-text-primary cursor-pointer">
              Other
            </label>
            <input
              type="text"
              placeholder="Describe your answer…"
              disabled={!otherSelected}
              value={otherText}
              onChange={(e) => { onOtherText(e.target.value); }}
              className="mt-1 w-full text-sm px-2 py-1 border border-border-primary rounded bg-bg-primary text-text-primary placeholder:text-text-muted disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Other free-text answer"
            />
          </div>
        </div>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function AskUserQuestionCard({ item, onAnswered }: AskUserQuestionCardProps): React.ReactElement {
  const questionCount = item.questions.length;

  // Subscribe to the otherText bus slot for THIS question id. ChatInput
  // (bottom-bar in workflow-question mode) writes here via setOtherText.
  const busOtherText = useQuestionStore((s) => s.otherText[item.id]);
  const clearOtherText = useQuestionStore((s) => s.clearOtherText);

  // Per-question selections: index → single label (string|null) or multi label set
  const [selections, setSelections] = useState<Array<string | null | Set<string>>>(() =>
    item.questions.map((qp) => (qp.multiSelect ? new Set<string>() : null)),
  );

  // Per-question "Other" state
  const [otherSelected, setOtherSelected] = useState<boolean[]>(() =>
    Array.from({ length: questionCount }, () => false),
  );
  const [otherText, setOtherText] = useState<string[]>(() =>
    Array.from({ length: questionCount }, () => ''),
  );

  // Per-sub-question "has the user typed here?" flag. When false, the input
  // mirrors the bus value; when true, the local state wins.
  const [otherTextLocalDirty, setOtherTextLocalDirty] = useState<boolean[]>(() =>
    Array.from({ length: questionCount }, () => false),
  );

  const [busy, setBusy] = useState(false);

  // ---------------------------------------------------------------------------
  // Effective Other text — prefers bus value unless the user has locally edited
  // ---------------------------------------------------------------------------

  function effectiveOtherText(index: number): string {
    if (otherTextLocalDirty[index]) return otherText[index];
    return busOtherText ?? otherText[index];
  }

  // ---------------------------------------------------------------------------
  // Completeness check — submit disabled until every question has a valid answer
  // ---------------------------------------------------------------------------

  function isQuestionComplete(index: number): boolean {
    const qp = item.questions[index];
    const sel = selections[index];
    const other = otherSelected[index];
    const text = effectiveOtherText(index);

    if (other) {
      // Other is selected — free-text must be non-empty
      return text.trim().length > 0;
    }

    if (qp.multiSelect) {
      return sel instanceof Set && sel.size > 0;
    }

    return typeof sel === 'string' && sel.length > 0;
  }

  const isComplete = Array.from({ length: questionCount }, (_, i) => i).every(isQuestionComplete);

  // ---------------------------------------------------------------------------
  // Reducers for per-question state
  // ---------------------------------------------------------------------------

  function handleSingleChange(questionIndex: number, label: string): void {
    setSelections((prev) => {
      const next = [...prev];
      next[questionIndex] = label;
      return next;
    });
    // Deselect "Other" when a concrete option is chosen
    setOtherSelected((prev) => {
      const next = [...prev];
      next[questionIndex] = false;
      return next;
    });
  }

  function handleMultiChange(questionIndex: number, label: string, checked: boolean): void {
    setSelections((prev) => {
      const next = [...prev];
      const current = prev[questionIndex];
      const set = current instanceof Set ? new Set(current) : new Set<string>();
      if (checked) {
        set.add(label);
      } else {
        set.delete(label);
      }
      next[questionIndex] = set;
      return next;
    });
  }

  function handleOtherToggle(questionIndex: number, checked: boolean): void {
    setOtherSelected((prev) => {
      const next = [...prev];
      next[questionIndex] = checked;
      return next;
    });
    if (!checked) {
      // Clear the free-text when deselecting Other
      setOtherText((prev) => {
        const next = [...prev];
        next[questionIndex] = '';
        return next;
      });
      setOtherTextLocalDirty((prev) => {
        if (!prev[questionIndex]) return prev;
        const next = [...prev];
        next[questionIndex] = false;
        return next;
      });
    }
    if (!item.questions[questionIndex].multiSelect && checked) {
      // Single-select: deselect any concrete option when Other is selected
      setSelections((prev) => {
        const next = [...prev];
        next[questionIndex] = null;
        return next;
      });
    }
  }

  function handleOtherText(questionIndex: number, text: string): void {
    setOtherText((prev) => {
      const next = [...prev];
      next[questionIndex] = text;
      return next;
    });
    setOtherTextLocalDirty((prev) => {
      if (prev[questionIndex]) return prev;
      const next = [...prev];
      next[questionIndex] = true;
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!isComplete || busy) return;

    // Build answers keyed by the full question text
    const answers: Record<string, string> = {};
    for (let i = 0; i < questionCount; i++) {
      const qp = item.questions[i];
      if (otherSelected[i]) {
        answers[qp.question] = effectiveOtherText(i).trim();
      } else if (qp.multiSelect) {
        const set = selections[i];
        const labels = set instanceof Set ? Array.from(set) : [];
        answers[qp.question] = labels.join(',');
      } else {
        answers[qp.question] = (selections[i] as string) ?? '';
      }
    }

    setBusy(true);
    void trpc.cyboflow.questions.answer
      .mutate({ questionId: item.id, answers })
      .then(() => {
        clearOtherText(item.id);
        onAnswered?.();
      })
      .catch(() => {
        // mutation error: leave card visible, do not call onAnswered
      })
      .finally(() => {
        setBusy(false);
      });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      role="listitem"
      data-question-id={item.id}
      className="px-4 py-3 border-b border-border-primary"
    >
      <div className="mb-3">
        <span className="text-xs text-text-muted">{item.workflowName}</span>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="space-y-4">
          {item.questions.map((qp, index) => (
            <QuestionFieldset
              key={`${item.id}-q-${index}`}
              qp={qp}
              questionIndex={index}
              selection={selections[index]}
              otherSelected={otherSelected[index]}
              otherText={effectiveOtherText(index)}
              onSingleChange={(label) => { handleSingleChange(index, label); }}
              onMultiChange={(label, checked) => { handleMultiChange(index, label, checked); }}
              onOtherToggle={(checked) => { handleOtherToggle(index, checked); }}
              onOtherText={(text) => { handleOtherText(index, text); }}
            />
          ))}
        </div>

        <div className="mt-4">
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !isComplete}
          >
            Submit answer
          </Button>
        </div>
      </form>
    </div>
  );
}
