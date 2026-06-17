/**
 * AgentEditorModal tests (P3 — Agent editor modal).
 *
 * Behaviors verified (behavioral, not pixel-exact):
 *   1. A built-in edit seeds the form (system prompt + description + checked
 *      tools), the name + role are read-only, and the usage line shows
 *      bound/dispatched (never a bare "0 workflows").
 *   2. Save is disabled until a field changes, and fires upsertOverride exactly
 *      ONCE on a double-click (in-flight latch).
 *   3. "Reset to default" appears ONLY for an overridden built-in and calls
 *      resetOverride.
 *   4. The tools grid shows all 8 CLI_TOOLS with a live count and NO cyboflow_*
 *      tool.
 *   5. There is NO 3-model picker, NO {{var}} chips, NO retry-loopback block.
 *   6. The description field is present + required (empty disables Save).
 *   7. A dirty close prompts a confirm.
 *
 * tRPC mocking follows WorkflowEditorModal.test.tsx (file-local vi.mock of
 * '../../../trpc/client').
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentEntry } from '../../../../../../shared/types/agents';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const BUILTIN_KEY = 'implement';

/** A built-in agent bound to a step in one workflow AND dispatched by prose in another. */
const BUILTIN_ENTRY: AgentEntry = {
  agentKey: BUILTIN_KEY,
  name: 'implement',
  role: 'sprint',
  description: 'Implements one task at a time.',
  systemPrompt: 'You are the implementer. Make the smallest diff that satisfies the criteria.',
  tools: ['Read', 'Edit', 'Write', 'Bash'],
  source: 'builtin',
  isCustom: false,
  isOverridden: false,
  usage: {
    workflowCount: 1,
    usedBy: [{ workflowName: 'sprint', stepNames: ['Execute tasks'], phaseColor: '#c96442' }],
    dispatchedBy: ['planner'],
  },
  stats: {
    model: 'inherits run model',
    estPromptTokens: 24,
    costUsd: null,
    lastEditedAt: null,
    toolsEnabled: 4,
    toolsTotal: 8,
  },
};

/** An OVERRIDDEN built-in (Reset visible). */
const OVERRIDDEN_ENTRY: AgentEntry = {
  ...BUILTIN_ENTRY,
  source: 'builtin-override',
  isOverridden: true,
};

/** A step-unbound PROSE agent — usedBy empty but dispatchedBy populated. */
const PROSE_ENTRY: AgentEntry = {
  ...BUILTIN_ENTRY,
  agentKey: 'research',
  name: 'research',
  role: 'planner',
  usage: { workflowCount: 0, usedBy: [], dispatchedBy: ['planner'] },
};

// ---------------------------------------------------------------------------
// tRPC mock
// ---------------------------------------------------------------------------

vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      agents: {
        get: { query: vi.fn() },
        upsertOverride: { mutate: vi.fn() },
        resetOverride: { mutate: vi.fn() },
        duplicate: { mutate: vi.fn() },
      },
    },
  },
}));

import { AgentEditorModal } from '../AgentEditorModal';
import { trpc } from '../../../../trpc/client';
import { CLI_TOOLS } from '../agentEditorTokens';

const mockGet = vi.mocked(trpc.cyboflow.agents.get.query);
const mockUpsert = vi.mocked(trpc.cyboflow.agents.upsertOverride.mutate);
const mockReset = vi.mocked(trpc.cyboflow.agents.resetOverride.mutate);
const mockDuplicate = vi.mocked(trpc.cyboflow.agents.duplicate.mutate);

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(structuredClone(BUILTIN_ENTRY));
  mockUpsert.mockResolvedValue(structuredClone(BUILTIN_ENTRY));
  mockReset.mockResolvedValue(structuredClone(BUILTIN_ENTRY));
  mockDuplicate.mockResolvedValue({ ...structuredClone(BUILTIN_ENTRY), agentKey: 'implement-copy', name: 'implement-copy', isCustom: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderModal(
  overrides: Partial<{ entry: AgentEntry; mode: 'edit' | 'create'; agentKey: string }> = {},
) {
  const entry = overrides.entry ?? BUILTIN_ENTRY;
  mockGet.mockResolvedValue(structuredClone(entry));
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <AgentEditorModal
      isOpen
      projectId={PROJECT_ID}
      agentKey={overrides.agentKey ?? entry.agentKey}
      mode={overrides.mode ?? 'edit'}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  await screen.findByTestId('agent-editor-form');
  return { onSaved, onClose, entry };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentEditorModal — built-in edit', () => {
  it('seeds the form: system prompt, description, and checked tools', async () => {
    await renderModal();

    expect(mockGet).toHaveBeenCalledWith({ projectId: PROJECT_ID, agentKey: BUILTIN_KEY });
    expect(screen.getByTestId('agent-system-prompt')).toHaveValue(BUILTIN_ENTRY.systemPrompt);
    expect(screen.getByTestId('agent-description-input')).toHaveValue(BUILTIN_ENTRY.description);

    // The 4 enabled tools are checked; the others are not.
    for (const tool of CLI_TOOLS) {
      const sw = screen.getByTestId(`agent-tool-switch-${tool}`);
      const expected = BUILTIN_ENTRY.tools.includes(tool);
      expect(sw).toHaveAttribute('aria-checked', String(expected));
    }
  });

  it('renders name and role read-only for a built-in', async () => {
    await renderModal();
    expect(screen.getByTestId('agent-name-input')).toHaveAttribute('readonly');
    // The role chip is a static span, not an editable control.
    const chip = screen.getByTestId('agent-role-chip');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveTextContent('sprint');
  });

  it('usage line shows bound + dispatched (never a bare 0 workflows)', async () => {
    await renderModal();
    expect(screen.getByTestId('agent-usage-bound-sprint')).toBeInTheDocument();
    expect(screen.getByTestId('agent-usage-dispatched')).toHaveTextContent('Dispatched by: planner');
    // A step-unbound prose agent still shows a Dispatched-by line rather than 0.
  });

  it('a step-unbound prose agent shows Dispatched-by, not a bound list', async () => {
    await renderModal({ entry: PROSE_ENTRY, agentKey: PROSE_ENTRY.agentKey });
    expect(screen.getByTestId('agent-usage-no-bound')).toBeInTheDocument();
    expect(screen.getByTestId('agent-usage-dispatched')).toHaveTextContent('Dispatched by: planner');
  });

  it('Save is disabled until a field changes', async () => {
    await renderModal();
    const saveBtn = screen.getByTestId('agent-editor-save-button');
    expect(saveBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId('agent-system-prompt'), {
      target: { value: 'Edited prompt body.' },
    });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
  });

  it('Save fires upsertOverride exactly once on a double-click', async () => {
    const { onSaved } = await renderModal();

    fireEvent.change(screen.getByTestId('agent-description-input'), {
      target: { value: 'Edited description.' },
    });
    const saveBtn = screen.getByTestId('agent-editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(saveBtn);
      fireEvent.click(saveBtn);
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.projectId).toBe(PROJECT_ID);
    expect(arg.agentKey).toBe(BUILTIN_KEY);
    expect(arg.description).toBe('Edited description.');
    expect(arg.tools).toEqual(BUILTIN_ENTRY.tools);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(BUILTIN_KEY));
  });

  it('an empty description disables Save and shows a required error', async () => {
    await renderModal();
    fireEvent.change(screen.getByTestId('agent-system-prompt'), {
      target: { value: 'Edited body.' },
    });
    // Now blank the description — Save must disable and an error appear.
    fireEvent.change(screen.getByTestId('agent-description-input'), { target: { value: '   ' } });

    await waitFor(() =>
      expect(screen.getByTestId('agent-editor-save-button')).toBeDisabled(),
    );
    expect(screen.getByTestId('agent-description-error')).toBeInTheDocument();
  });

  it('rejects a description that references a cyboflow_ tool', async () => {
    await renderModal();
    fireEvent.change(screen.getByTestId('agent-description-input'), {
      target: { value: 'calls cyboflow_update_task' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('agent-description-error')).toHaveTextContent('cyboflow_'),
    );
    expect(screen.getByTestId('agent-editor-save-button')).toBeDisabled();
  });
});

describe('AgentEditorModal — Reset to default', () => {
  it('is hidden for a non-overridden built-in', async () => {
    await renderModal({ entry: BUILTIN_ENTRY });
    expect(screen.queryByTestId('agent-editor-reset-button')).toBeNull();
  });

  it('is shown for an overridden built-in and calls resetOverride', async () => {
    const { onSaved } = await renderModal({ entry: OVERRIDDEN_ENTRY });
    const resetBtn = screen.getByTestId('agent-editor-reset-button');
    await act(async () => {
      fireEvent.click(resetBtn);
    });
    expect(mockReset).toHaveBeenCalledWith({ projectId: PROJECT_ID, agentKey: BUILTIN_KEY });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(BUILTIN_KEY));
  });

  it('is hidden for a custom agent (no default to revert to)', async () => {
    const custom: AgentEntry = { ...BUILTIN_ENTRY, source: 'custom', isCustom: true, isOverridden: true };
    await renderModal({ entry: custom });
    expect(screen.queryByTestId('agent-editor-reset-button')).toBeNull();
  });
});

describe('AgentEditorModal — tools grid', () => {
  it('shows all 8 CLI_TOOLS with a live count and NO cyboflow_* tool', async () => {
    await renderModal();
    const grid = screen.getByTestId('agent-tools-grid');
    for (const tool of CLI_TOOLS) {
      expect(screen.getByTestId(`agent-tool-row-${tool}`)).toBeInTheDocument();
    }
    expect(grid.textContent ?? '').not.toMatch(/cyboflow_/);
    expect(screen.getByTestId('agent-tools-count')).toHaveTextContent('4 of 8 enabled');
  });

  it('toggling a tool updates the live count', async () => {
    await renderModal();
    // Enable a currently-off tool (Grep).
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-tool-switch-Grep'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('agent-tools-count')).toHaveTextContent('5 of 8 enabled'),
    );
  });
});

describe('AgentEditorModal — absent legacy affordances', () => {
  it('has NO 3-model picker, NO {{var}} chips, NO retry-loopback block', async () => {
    await renderModal();
    const root = screen.getByTestId('agent-editor-modal');
    // Model is read-only Stats text only — no clickable model option / picker.
    expect(screen.queryByTestId('agent-model-picker')).toBeNull();
    expect(root.textContent ?? '').not.toContain('{{');
    // No retry stepper / loopback controls.
    expect(screen.queryByTestId('agent-retry-stepper')).toBeNull();
    expect(screen.queryByTestId('agent-loopback')).toBeNull();
    // Model surfaces ONLY as a read-only stat.
    expect(screen.getByTestId('agent-stats')).toHaveTextContent('inherits run model');
  });
});

describe('AgentEditorModal — dirty-close guard', () => {
  it('prompts a confirm on close when dirty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onClose } = await renderModal();

    fireEvent.change(screen.getByTestId('agent-system-prompt'), {
      target: { value: 'dirty edit' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-editor-cancel-button'));
    });

    expect(confirmSpy).toHaveBeenCalled();
    // Confirm returned false → modal stays open.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without a prompt when clean', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { onClose } = await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-editor-cancel-button'));
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AgentEditorModal — duplicate', () => {
  it('opens a name dialog and calls duplicate, firing onSaved with the new key', async () => {
    const { onSaved } = await renderModal();
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-editor-duplicate-button'));
    });
    const nameInput = await screen.findByTestId('flow-name-input');
    fireEvent.change(nameInput, { target: { value: 'implement-copy' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('flow-name-confirm'));
    });
    expect(mockDuplicate).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      agentKey: BUILTIN_KEY,
      newName: 'implement-copy',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('implement-copy'));
  });
});
