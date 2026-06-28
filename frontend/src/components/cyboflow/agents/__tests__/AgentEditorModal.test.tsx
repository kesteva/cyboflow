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
import type { McpEntry } from '../../../../../../shared/types/integrations';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const BUILTIN_KEY = 'implement';

/** A built-in agent bound to a step in one workflow AND dispatched by prose in another. */
const BUILTIN_ENTRY: AgentEntry = {
  agentKey: BUILTIN_KEY,
  // Production agents.* always return the prefixed name (`cyboflow-<key>`); the
  // editor de-prefixes it for DISPLAY. Use the realistic shape here.
  name: 'cyboflow-implement',
  role: 'sprint',
  description: 'Implements one task at a time.',
  systemPrompt: 'You are the implementer. Make the smallest diff that satisfies the criteria.',
  tools: ['Read', 'Edit', 'Write', 'Bash'],
  model: null,
  enabledMcps: [],
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
  name: 'cyboflow-research',
  role: 'planner',
  usage: { workflowCount: 0, usedBy: [], dispatchedBy: ['planner'] },
};

/** A CUSTOM agent (is_custom=1) — edited in place via updateCustom. */
const CUSTOM_ENTRY: AgentEntry = {
  ...BUILTIN_ENTRY,
  agentKey: 'my-helper',
  name: 'cyboflow-my-helper',
  source: 'custom',
  isCustom: true,
  isOverridden: true,
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
        createCustom: { mutate: vi.fn() },
        updateCustom: { mutate: vi.fn() },
      },
      mcps: {
        list: { query: vi.fn() },
      },
    },
  },
}));

/** Two CLI-configured MCP servers the editor's "MCP access" grid offers. */
const MCP_CATALOGUE: McpEntry[] = [
  { name: 'peekaboo', transport: 'stdio', url: null, command: 'peekaboo', args: [], scope: 'global' },
  { name: 'playwright', transport: 'http', url: 'http://localhost', command: null, args: [], scope: 'global' },
];

import { AgentEditorModal } from '../AgentEditorModal';
import { trpc } from '../../../../trpc/client';
import { CLI_TOOLS } from '../agentEditorTokens';

const mockGet = vi.mocked(trpc.cyboflow.agents.get.query);
const mockUpsert = vi.mocked(trpc.cyboflow.agents.upsertOverride.mutate);
const mockReset = vi.mocked(trpc.cyboflow.agents.resetOverride.mutate);
const mockDuplicate = vi.mocked(trpc.cyboflow.agents.duplicate.mutate);
const mockCreate = vi.mocked(trpc.cyboflow.agents.createCustom.mutate);
const mockUpdateCustom = vi.mocked(trpc.cyboflow.agents.updateCustom.mutate);
const mockMcpsList = vi.mocked(trpc.cyboflow.mcps.list.query);

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(structuredClone(BUILTIN_ENTRY));
  mockUpsert.mockResolvedValue(structuredClone(BUILTIN_ENTRY));
  mockReset.mockResolvedValue(structuredClone(BUILTIN_ENTRY));
  mockDuplicate.mockResolvedValue({ ...structuredClone(BUILTIN_ENTRY), agentKey: 'implement-copy', name: 'implement-copy', isCustom: true });
  mockCreate.mockResolvedValue({ ...structuredClone(BUILTIN_ENTRY), agentKey: 'my-helper', name: 'My Helper', isCustom: true });
  mockUpdateCustom.mockResolvedValue(structuredClone(CUSTOM_ENTRY));
  mockMcpsList.mockResolvedValue(structuredClone(MCP_CATALOGUE));
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

  it('shows the BARE key in the read-only name field, not the cyboflow- prefix', async () => {
    // The server returns name = 'cyboflow-implement'; the read-only field strips
    // the prefix so it matches the de-prefixed title + gallery card.
    await renderModal();
    const nameInput = screen.getByTestId('agent-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('implement');
    expect(nameInput.value).not.toContain('cyboflow-');
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

describe('AgentEditorModal — MCP access', () => {
  it('offers the CLI MCP catalogue (deduped) and persists a selected server via upsertOverride', async () => {
    const { onSaved } = await renderModal();

    // The grid appears once mcps.list resolves; both catalogue servers render
    // unchecked for a built-in with no grants.
    const peekaboo = await screen.findByTestId('agent-mcp-switch-peekaboo');
    expect(peekaboo).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('agent-mcp-switch-playwright')).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(peekaboo);
    });
    await waitFor(() => expect(peekaboo).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('agent-mcps-count')).toHaveTextContent('1 enabled');

    const saveBtn = screen.getByTestId('agent-editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].enabledMcps).toEqual(['peekaboo']);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(BUILTIN_KEY));
  });

  it('round-trips an existing grant on reopen (shows the granted server checked)', async () => {
    const granted: AgentEntry = { ...structuredClone(BUILTIN_ENTRY), enabledMcps: ['peekaboo'] };
    await renderModal({ entry: granted });

    const peekaboo = await screen.findByTestId('agent-mcp-switch-peekaboo');
    expect(peekaboo).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('agent-mcp-switch-playwright')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('agent-mcps-count')).toHaveTextContent('1 enabled');

    // Seeded, not dirty → Save stays disabled until something changes.
    expect(screen.getByTestId('agent-editor-save-button')).toBeDisabled();
  });
});

describe('AgentEditorModal — absent legacy affordances', () => {
  it('has NO {{var}} chips and NO retry-loopback block', async () => {
    await renderModal();
    const root = screen.getByTestId('agent-editor-modal');
    expect(root.textContent ?? '').not.toContain('{{');
    // No retry stepper / loopback controls.
    expect(screen.queryByTestId('agent-retry-stepper')).toBeNull();
    expect(screen.queryByTestId('agent-loopback')).toBeNull();
  });
});

describe('AgentEditorModal — model picker', () => {
  it('seeds the picker from entry.model and the stat shows the inherit sentinel by default', async () => {
    await renderModal(); // BUILTIN_ENTRY.model === null
    const select = screen.getByTestId('agent-model-select') as HTMLSelectElement;
    expect(select.value).toBe(''); // '' = inherit
    expect(screen.getByTestId('agent-stats')).toHaveTextContent('inherits run model');
  });

  it('seeds a pinned model and echoes its label in the live stat', async () => {
    const pinned: AgentEntry = {
      ...BUILTIN_ENTRY,
      model: 'sonnet',
      stats: { ...BUILTIN_ENTRY.stats, model: 'Sonnet 5' },
    };
    await renderModal({ entry: pinned });
    expect((screen.getByTestId('agent-model-select') as HTMLSelectElement).value).toBe('sonnet');
    expect(screen.getByTestId('agent-stats')).toHaveTextContent('Sonnet 5');
  });

  it('changing the model marks dirty and sends the alias through upsertOverride', async () => {
    const { onSaved } = await renderModal();
    const select = screen.getByTestId('agent-model-select');
    fireEvent.change(select, { target: { value: 'haiku' } });

    const saveBtn = screen.getByTestId('agent-editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    // The live stat echoes the new draft model before saving.
    expect(screen.getByTestId('agent-stats')).toHaveTextContent('Haiku 4.5');

    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].model).toBe('haiku');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(BUILTIN_KEY));
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

describe('AgentEditorModal — create (new custom agent)', () => {
  it('opens a blank form without calling agents.get and without wedging on Loading', async () => {
    // Regression: "New agent" opens with an empty agentKey. Calling agents.get
    // with it failed the agentKey regex and stuck the modal on "Loading agent…".
    await renderModal({ mode: 'create', agentKey: '' });

    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByText('Loading agent…')).not.toBeInTheDocument();
    // Name is editable for a brand-new custom; Duplicate + usage are hidden.
    expect(screen.getByTestId('agent-name-input')).not.toHaveAttribute('readonly');
    expect(screen.queryByTestId('agent-editor-duplicate-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-usage-inspector')).not.toBeInTheDocument();
  });

  it('Save mints a custom via createCustom (not upsertOverride) once name + description + a tool are set', async () => {
    const { onSaved, onClose } = await renderModal({ mode: 'create', agentKey: '' });
    const saveBtn = screen.getByTestId('agent-editor-save-button');
    expect(saveBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId('agent-name-input'), { target: { value: 'My Helper' } });
    fireEvent.change(screen.getByTestId('agent-description-input'), {
      target: { value: 'Helps with things.' },
    });
    // Still disabled until ≥1 tool is enabled (server toolsSchema.min(1)).
    expect(saveBtn).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId(`agent-tool-switch-${CLI_TOOLS[0]}`));
    });

    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const arg = mockCreate.mock.calls[0][0];
    expect(arg.projectId).toBe(PROJECT_ID);
    expect(arg.name).toBe('My Helper');
    expect(arg.description).toBe('Helps with things.');
    expect(arg.tools).toEqual([CLI_TOOLS[0]]);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('my-helper'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('AgentEditorModal — custom edit', () => {
  it('routes a custom-agent edit through updateCustom (NOT upsertOverride), with no name (key immutable)', async () => {
    const { onSaved } = await renderModal({ entry: CUSTOM_ENTRY, agentKey: 'my-helper' });

    // The name field is read-only for an existing agent (key immutable).
    expect(screen.getByTestId('agent-name-input')).toHaveAttribute('readonly');

    fireEvent.change(screen.getByTestId('agent-description-input'), {
      target: { value: 'Edited custom description.' },
    });
    const saveBtn = screen.getByTestId('agent-editor-save-button');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockUpdateCustom).toHaveBeenCalledTimes(1);
    const arg = mockUpdateCustom.mock.calls[0][0];
    expect(arg.projectId).toBe(PROJECT_ID);
    expect(arg.agentKey).toBe('my-helper');
    expect(arg.description).toBe('Edited custom description.');
    // The key is immutable, so the rename-capable `name` field is NOT sent.
    expect(arg).not.toHaveProperty('name');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('my-helper'));
  });
});
