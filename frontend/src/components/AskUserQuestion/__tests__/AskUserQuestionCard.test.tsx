/**
 * AskUserQuestionCard component tests (TASK-760).
 *
 * Tests:
 *   1. Header rendered as Pill, truncated to 12 chars with ellipsis when longer
 *   2. Single-select question renders radio group
 *   3. Multi-select question renders checkbox group
 *   4. Option label, description, and preview toggle (initially collapsed)
 *   5. Other option enables free-text input
 *   6. Submit disabled until all questions answered; enabled when complete
 *   7. Submit calls trpc.cyboflow.questions.answer.mutate with correct payload
 *   8. onAnswered called once on successful submit
 *   9. Submit failure does not call onAnswered
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Question } from '../../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Hoisted tRPC mock — vi.hoisted() ensures the reference is ready when the
// vi.mock factory runs (factories are hoisted before module evaluation).
// ---------------------------------------------------------------------------

const { mockAnswerMutate } = vi.hoisted(() => ({
  mockAnswerMutate: vi.fn<(input: { questionId: string; answers: Record<string, string> }) => Promise<{ success: true }>>(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      questions: {
        answer: {
          mutate: mockAnswerMutate,
        },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Import component under test (after mock setup)
// ---------------------------------------------------------------------------

import { AskUserQuestionCard } from '../AskUserQuestionCard';
import { useQuestionStore } from '../../../stores/questionStore';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Returns a Question with:
 *   questions[0]: single-select "What color?" (Color) with options Red, Blue
 *   questions[1]: multi-select "Browsers?" (Browsers) with options Chrome, Firefox
 *   questions[1] option Chrome has a preview markdown string
 */
function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: overrides.id ?? 'q-1',
    runId: overrides.runId ?? 'run-1',
    workflowName: overrides.workflowName ?? 'Test Workflow',
    toolUseId: overrides.toolUseId ?? 'tool-use-1',
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    answeredAt: overrides.answeredAt ?? null,
    answerJson: overrides.answerJson ?? null,
    questions: overrides.questions ?? [
      {
        question: 'What color?',
        header: 'Color',
        multiSelect: false,
        options: [
          { label: 'Red' },
          { label: 'Blue' },
        ],
      },
      {
        question: 'Browsers?',
        header: 'Browsers',
        multiSelect: true,
        options: [
          { label: 'Chrome', description: 'Google Chrome', preview: '# Chrome\nFast browser.' },
          { label: 'Firefox', description: 'Mozilla Firefox' },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const mockSaveImages = vi.fn<(sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>) => Promise<string[]>>();

beforeEach(() => {
  mockAnswerMutate.mockReset();
  mockAnswerMutate.mockResolvedValue({ success: true });
  mockSaveImages.mockReset();
  mockSaveImages.mockResolvedValue(['/abs/artifacts/run-1/shot.png']);
  // Stub the saveImages IPC used by the attach-image answer flow.
  (window as unknown as { electronAPI: { sessions: { saveImages: typeof mockSaveImages } } }).electronAPI = {
    sessions: { saveImages: mockSaveImages },
  };
  // Reset questionStore to clean state so bus values don't bleed between tests.
  useQuestionStore.setState({ queue: [], connectionStatus: 'idle', otherText: {} });
});

// ---------------------------------------------------------------------------
// 1. Header truncation
// ---------------------------------------------------------------------------

describe('renders header as Pill truncated to 12 chars', () => {
  it('truncates a header longer than 12 chars', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'ABCDEFGHIJKLMNO', // 15 chars
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    // Should show first 12 chars + ellipsis (U+2026)
    expect(screen.getByText('ABCDEFGHIJKL…')).toBeInTheDocument();
  });

  it('does not truncate a header of exactly 12 chars', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'Precise?',
          header: '123456789012', // exactly 12
          multiSelect: false,
          options: [{ label: 'Yes' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);
    expect(screen.getByText('123456789012')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Single-select renders radio group
// ---------------------------------------------------------------------------

describe('single-select renders radio group', () => {
  it('renders radio inputs sharing the same name', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    const radios = screen.getAllByRole('radio');
    // 2 options + 1 implicit Other = 3 radio inputs
    expect(radios).toHaveLength(3);
    // All share the same name
    const names = new Set(radios.map((r) => (r as HTMLInputElement).name));
    expect(names.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-select renders checkbox group
// ---------------------------------------------------------------------------

describe('multi-select renders checkbox group', () => {
  it('renders checkbox inputs for multi-select questions', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'Browsers?',
          header: 'Browsers',
          multiSelect: true,
          options: [{ label: 'Chrome' }, { label: 'Firefox' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    const checkboxes = screen.getAllByRole('checkbox');
    // 2 options + 1 implicit Other = 3 checkboxes
    expect(checkboxes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Option label, description, and preview toggle
// ---------------------------------------------------------------------------

describe('renders option label, description, and preview toggle', () => {
  it('renders label and description text', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'Browsers?',
          header: 'Browsers',
          multiSelect: true,
          options: [
            { label: 'Chrome', description: 'Google Chrome', preview: '# Chrome\nFast browser.' },
            { label: 'Firefox', description: 'Mozilla Firefox' },
          ],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    expect(screen.getByText('Chrome')).toBeInTheDocument();
    expect(screen.getByText('Google Chrome')).toBeInTheDocument();
    expect(screen.getByText('Firefox')).toBeInTheDocument();
    expect(screen.getByText('Mozilla Firefox')).toBeInTheDocument();
  });

  it('preview is initially collapsed (not in DOM)', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'Browsers?',
          header: 'Browsers',
          multiSelect: true,
          options: [
            { label: 'Chrome', preview: '# Chrome\nFast browser.' },
          ],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    // The preview region should not be in the DOM initially
    expect(screen.queryByRole('region', { name: /Preview for Chrome/i })).not.toBeInTheDocument();
    // The toggle button should be visible
    expect(screen.getByText('Show preview')).toBeInTheDocument();
  });

  it('clicking Show preview mounts the MarkdownPreview region', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'Browsers?',
          header: 'Browsers',
          multiSelect: true,
          options: [
            { label: 'Chrome', preview: '# Chrome\nFast browser.' },
          ],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    const toggleBtn = screen.getByText('Show preview');
    fireEvent.click(toggleBtn);

    // After clicking, the region should be in the DOM
    expect(screen.getByRole('region', { name: /Preview for Chrome/i })).toBeInTheDocument();
    // Button text toggles
    expect(screen.getByText('Hide preview')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Other option enables free-text input
// ---------------------------------------------------------------------------

describe('Other option enables free-text input', () => {
  it('text input is disabled until Other is selected', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    const textInput = screen.getByRole('textbox', { name: /other free-text/i });
    expect(textInput).toBeDisabled();

    // Select the Other radio
    const otherRadio = screen.getByRole('radio', { name: /Other/i });
    fireEvent.click(otherRadio);

    expect(textInput).not.toBeDisabled();
  });

  it('typed value is captured and not empty after typing', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    const otherRadio = screen.getByRole('radio', { name: /Other/i });
    fireEvent.click(otherRadio);

    const textInput = screen.getByRole('textbox', { name: /other free-text/i });
    fireEvent.change(textInput, { target: { value: 'Purple' } });

    expect((textInput as HTMLInputElement).value).toBe('Purple');
  });
});

// ---------------------------------------------------------------------------
// 6. Submit disabled until all answered
// ---------------------------------------------------------------------------

describe('submit disabled until all answered', () => {
  it('is disabled initially', () => {
    render(<AskUserQuestionCard item={makeQuestion()} />);
    expect(screen.getByRole('button', { name: /submit answer/i })).toBeDisabled();
  });

  it('remains disabled with partial answers (only first question answered)', () => {
    render(<AskUserQuestionCard item={makeQuestion()} />);

    // Answer only the first question (single-select)
    fireEvent.click(screen.getAllByRole('radio', { name: /Red/i })[0]);

    expect(screen.getByRole('button', { name: /submit answer/i })).toBeDisabled();
  });

  it('becomes enabled when all questions have valid selections', () => {
    render(<AskUserQuestionCard item={makeQuestion()} />);

    // Answer question 0: single-select "Red"
    fireEvent.click(screen.getByRole('radio', { name: /Red/i }));
    // Answer question 1: multi-select "Chrome"
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Chrome/i })[0]);

    expect(screen.getByRole('button', { name: /submit answer/i })).not.toBeDisabled();
  });

  it('Other with empty free-text keeps submit disabled', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    // Select Other but leave free-text empty
    fireEvent.click(screen.getByRole('radio', { name: /Other/i }));

    expect(screen.getByRole('button', { name: /submit answer/i })).toBeDisabled();
  });

  it('Other with non-empty free-text enables submit', () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    fireEvent.click(screen.getByRole('radio', { name: /Other/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /other free-text/i }), {
      target: { value: 'Purple' },
    });

    expect(screen.getByRole('button', { name: /submit answer/i })).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 7. Submit calls trpc.cyboflow.questions.answer.mutate with answers keyed by question text
// ---------------------------------------------------------------------------

describe('submit calls trpc.cyboflow.questions.answer.mutate with answers keyed by question text', () => {
  it('sends correct payload for single-select and multi-select', async () => {
    render(<AskUserQuestionCard item={makeQuestion()} />);

    // Answer question 0: single-select "Red" (keyed by "What color?")
    fireEvent.click(screen.getByRole('radio', { name: /Red/i }));
    // Answer question 1: multi-select "Chrome" + "Firefox" (keyed by "Browsers?")
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Chrome/i })[0]);
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Firefox/i })[0]);

    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => {
      expect(mockAnswerMutate).toHaveBeenCalledTimes(1);
      expect(mockAnswerMutate).toHaveBeenCalledWith({
        questionId: 'q-1',
        answers: {
          'What color?': 'Red',
          'Browsers?': 'Chrome,Firefox',
        },
      });
    });
  });

  it('sends Other free-text as the answer value', async () => {
    const item = makeQuestion({
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    fireEvent.click(screen.getByRole('radio', { name: /Other/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /other free-text/i }), {
      target: { value: 'Purple' },
    });

    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => {
      expect(mockAnswerMutate).toHaveBeenCalledWith({
        questionId: 'q-1',
        answers: { 'What color?': 'Purple' },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 8. onAnswered called once on successful submit
// ---------------------------------------------------------------------------

describe('onAnswered called once on successful submit', () => {
  it('calls onAnswered exactly once after mutate resolves', async () => {
    const onAnswered = vi.fn();
    mockAnswerMutate.mockResolvedValue({ success: true });

    render(<AskUserQuestionCard item={makeQuestion()} onAnswered={onAnswered} />);

    // Provide full answers
    fireEvent.click(screen.getByRole('radio', { name: /Red/i }));
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Chrome/i })[0]);

    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => {
      expect(onAnswered).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Submit failure does not call onAnswered
// ---------------------------------------------------------------------------

describe('submit failure does not call onAnswered', () => {
  it('does not call onAnswered when mutate rejects', async () => {
    const onAnswered = vi.fn();
    mockAnswerMutate.mockRejectedValue(new Error('network error'));

    render(<AskUserQuestionCard item={makeQuestion()} onAnswered={onAnswered} />);

    // Provide full answers
    fireEvent.click(screen.getByRole('radio', { name: /Red/i }));
    fireEvent.click(screen.getAllByRole('checkbox', { name: /Chrome/i })[0]);

    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    // Wait for mutation to settle
    await waitFor(() => {
      expect(mockAnswerMutate).toHaveBeenCalledTimes(1);
    });

    expect(onAnswered).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// otherText bus integration
// ---------------------------------------------------------------------------

describe('otherText bus integration', () => {
  it('reads otherText from questionStore and prefers bus over local state', async () => {
    const item = makeQuestion({
      id: 'q-1',
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
        {
          question: 'What size?',
          header: 'Size',
          multiSelect: false,
          options: [{ label: 'Large' }],
        },
      ],
    });

    render(<AskUserQuestionCard item={item} />);

    // Set bus value after render — simulates ChatInput typing
    await act(async () => {
      useQuestionStore.setState({ otherText: { 'q-1': 'from-bus' } });
    });

    // Both sub-question Other inputs should show the bus value
    const otherInputs = screen.getAllByRole('textbox', { name: /other free-text/i });
    expect(otherInputs).toHaveLength(2);
    expect((otherInputs[0] as HTMLInputElement).value).toBe('from-bus');
    expect((otherInputs[1] as HTMLInputElement).value).toBe('from-bus');
  });

  it('calls clearOtherText after successful submit', async () => {
    const item = makeQuestion({
      id: 'q-1',
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    // Pre-fill the bus so we can detect it being cleared
    useQuestionStore.setState({ otherText: { 'q-1': 'sentinel' } });

    render(<AskUserQuestionCard item={item} />);

    // Select Other and confirm the bus value is shown
    const otherRadio = screen.getByRole('radio', { name: /Other/i });
    fireEvent.click(otherRadio);

    // Wait for the submit button to become enabled (Other text from bus fills the field)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /submit answer/i })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => {
      expect(mockAnswerMutate).toHaveBeenCalledTimes(1);
    });

    // After successful submit, the bus slot for q-1 must be cleared
    await waitFor(() => {
      expect(useQuestionStore.getState().otherText['q-1']).toBeUndefined();
    });
  });

  it('falls back to local useState when bus slot is undefined', () => {
    const item = makeQuestion({
      id: 'q-1',
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });

    // No bus value set — otherText is already {} from beforeEach reset
    render(<AskUserQuestionCard item={item} />);

    const otherRadio = screen.getByRole('radio', { name: /Other/i });
    fireEvent.click(otherRadio);

    const textInput = screen.getByRole('textbox', { name: /other free-text/i });
    fireEvent.change(textInput, { target: { value: 'local-value' } });

    expect((textInput as HTMLInputElement).value).toBe('local-value');
  });

  it('local edit in one sub-question does not affect bus-prefilled sibling', async () => {
    const item = makeQuestion({
      id: 'q-1',
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
        {
          question: 'What size?',
          header: 'Size',
          multiSelect: false,
          options: [{ label: 'Large' }],
        },
      ],
    });

    // Set the bus to 'from-bus' before render
    useQuestionStore.setState({ otherText: { 'q-1': 'from-bus' } });

    render(<AskUserQuestionCard item={item} />);

    // Both inputs should start at 'from-bus'
    const otherInputs = screen.getAllByRole('textbox', { name: /other free-text/i });
    expect((otherInputs[0] as HTMLInputElement).value).toBe('from-bus');
    expect((otherInputs[1] as HTMLInputElement).value).toBe('from-bus');

    // Type into sub-question 0's Other input to create a local override
    fireEvent.change(otherInputs[0], { target: { value: 'override' } });

    // Sub-question 0 shows the local override
    expect((otherInputs[0] as HTMLInputElement).value).toBe('override');
    // Sub-question 1 still shows the bus value
    expect((otherInputs[1] as HTMLInputElement).value).toBe('from-bus');
  });
});

// ---------------------------------------------------------------------------
// Image attachment on the answer path
// ---------------------------------------------------------------------------

describe('image attachment on answer', () => {
  function singleQuestion(): Question {
    return makeQuestion({
      id: 'q-1',
      runId: 'run-1',
      questions: [
        {
          question: 'What color?',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red' }],
        },
      ],
    });
  }

  it('saves attached images and forwards their file paths as attachments', async () => {
    render(<AskUserQuestionCard item={singleQuestion()} />);

    // Provide a valid answer so submit is enabled.
    fireEvent.click(screen.getByRole('radio', { name: /Red/i }));

    // Attach an image via the hidden file input.
    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' });
    const input = screen.getByTestId('ask-question-image-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    // A thumbnail with a remove control should appear.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove shot\.png/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => {
      // saveImages is called with the runId as the namespacing id and the image payload.
      expect(mockSaveImages).toHaveBeenCalledWith('run-1', [
        { name: 'shot.png', dataUrl: expect.stringMatching(/^data:image\/png/), type: 'image/png' },
      ]);
    });

    await waitFor(() => {
      expect(mockAnswerMutate).toHaveBeenCalledWith({
        questionId: 'q-1',
        answers: { 'What color?': 'Red' },
        attachments: ['/abs/artifacts/run-1/shot.png'],
      });
    });
  });

  it('omits the attachments field when no image is attached', async () => {
    render(<AskUserQuestionCard item={singleQuestion()} />);

    fireEvent.click(screen.getByRole('radio', { name: /Red/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit answer/i }));

    await waitFor(() => {
      expect(mockAnswerMutate).toHaveBeenCalledWith({
        questionId: 'q-1',
        answers: { 'What color?': 'Red' },
      });
    });
    expect(mockSaveImages).not.toHaveBeenCalled();
  });

  it('removes an attached image when its remove button is clicked', async () => {
    render(<AskUserQuestionCard item={singleQuestion()} />);

    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' });
    const input = screen.getByTestId('ask-question-image-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    const removeBtn = await screen.findByRole('button', { name: /remove shot\.png/i });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /remove shot\.png/i })).toBeNull();
    });
  });
});
