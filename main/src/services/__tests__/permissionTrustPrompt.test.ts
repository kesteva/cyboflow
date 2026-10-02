import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../database/models';
import type { StreamEnvelope } from '../../../../shared/types/claudeStream';
import {
  PermissionTrustPrompter,
  withRunStartedTrustPrompt,
  type PermissionTrustPromptDeps,
} from '../permissionTrustPrompt';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Repo',
    path: '/tmp/repo',
    active: false,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    permission_trust: null,
    ...overrides,
  } as Project;
}

/** In-memory project table + controllable dialog for the prompter. */
function makeDeps(projects: Project[], response = 0) {
  const table = new Map(projects.map((p) => [p.id, { ...p }]));
  let resolveDialog: ((r: { response: number }) => void) | null = null;
  const deps = {
    getProject: vi.fn((id: number) => table.get(id)),
    updateProject: vi.fn((id: number, updates: { permission_trust: 'trusted' | 'untrusted' }) => {
      const row = table.get(id);
      if (row) table.set(id, { ...row, ...updates });
    }),
    getMainWindow: vi.fn(() => null),
    showMessageBox: vi.fn(
      () =>
        new Promise<{ response: number }>((resolve) => {
          resolveDialog = resolve;
        }),
    ),
    containsAllowRules: vi.fn(() => true),
  } satisfies PermissionTrustPromptDeps;
  return {
    deps,
    table,
    answer: (r = response) => resolveDialog?.({ response: r }),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('PermissionTrustPrompter (launch-time trigger)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('prompts at the first launch in an undecided project and persists "trusted" on accept', async () => {
    const { deps, table, answer } = makeDeps([makeProject()]);
    const prompter = new PermissionTrustPrompter(deps);

    const pending = prompter.maybePromptForProject(1);
    await flush();
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
    answer(0);
    await pending;

    expect(deps.updateProject).toHaveBeenCalledWith(1, { permission_trust: 'trusted' });
    expect(table.get(1)?.permission_trust).toBe('trusted');
  });

  it('persists "untrusted" when the user declines (the default button)', async () => {
    const { deps, answer } = makeDeps([makeProject()]);
    const prompter = new PermissionTrustPrompter(deps);

    const pending = prompter.maybePromptForProject(1);
    await flush();
    answer(1);
    await pending;

    expect(deps.updateProject).toHaveBeenCalledWith(1, { permission_trust: 'untrusted' });
  });

  it('fires at most once per project, even for concurrent launches before the user answers', async () => {
    const { deps, answer } = makeDeps([makeProject()]);
    const prompter = new PermissionTrustPrompter(deps);

    const first = prompter.maybePromptForProject(1);
    const second = prompter.maybePromptForProject(1);
    await flush();
    await second;
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);

    answer(1);
    await first;
    await prompter.maybePromptForProject(1);
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
    expect(deps.updateProject).toHaveBeenCalledTimes(1);
  });

  it('shares the guard with the projects:create trigger (maybePrompt)', async () => {
    const project = makeProject();
    const { deps } = makeDeps([project]);
    const prompter = new PermissionTrustPrompter(deps);

    void prompter.maybePrompt(project);
    await flush();
    await prompter.maybePromptForProject(project.id);
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('never prompts a project whose trust is already decided', async () => {
    const { deps } = makeDeps([
      makeProject({ id: 1, permission_trust: 'trusted' }),
      makeProject({ id: 2, permission_trust: 'untrusted' }),
    ]);
    const prompter = new PermissionTrustPrompter(deps);

    await prompter.maybePromptForProject(1);
    await prompter.maybePromptForProject(2);
    expect(deps.showMessageBox).not.toHaveBeenCalled();
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('skips the dialog (and leaves trust NULL) when the repo ships no allow rules', async () => {
    const { deps } = makeDeps([makeProject()]);
    deps.containsAllowRules.mockReturnValue(false);
    const prompter = new PermissionTrustPrompter(deps);

    await prompter.maybePromptForProject(1);
    expect(deps.containsAllowRules).toHaveBeenCalledWith('/tmp/repo');
    expect(deps.showMessageBox).not.toHaveBeenCalled();
    expect(deps.updateProject).not.toHaveBeenCalled();
  });

  it('is a no-op for an unknown or missing project id', async () => {
    const { deps } = makeDeps([]);
    const prompter = new PermissionTrustPrompter(deps);

    await prompter.maybePromptForProject(undefined);
    await prompter.maybePromptForProject(99);
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });

  it('fails soft when the dialog throws', async () => {
    const { deps } = makeDeps([makeProject()]);
    deps.showMessageBox.mockRejectedValue(new Error('no window'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const prompter = new PermissionTrustPrompter(deps);

    await expect(prompter.maybePromptForProject(1)).resolves.toBeUndefined();
    expect(deps.updateProject).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('withRunStartedTrustPrompt', () => {
  const envelope = (type: 'run_started' | 'result'): StreamEnvelope =>
    ({ type, payload: { type, runId: 'run-1' }, timestamp: '2026-01-01T00:00:00Z' }) as unknown as StreamEnvelope;

  it('forwards every event and triggers the prompt for the run project on run_started only', async () => {
    const { deps } = makeDeps([makeProject({ id: 7 })]);
    const prompter = new PermissionTrustPrompter(deps);
    const inner = { publish: vi.fn() };
    const getRunProjectId = vi.fn(() => 7);
    const wrapped = withRunStartedTrustPrompt(inner, prompter, getRunProjectId);

    wrapped.publish('run-1', envelope('result'));
    expect(getRunProjectId).not.toHaveBeenCalled();

    wrapped.publish('run-1', envelope('run_started'));
    await flush();
    expect(inner.publish).toHaveBeenCalledTimes(2);
    expect(getRunProjectId).toHaveBeenCalledWith('run-1');
    expect(deps.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('still publishes when the run lookup throws', () => {
    const { deps } = makeDeps([]);
    const prompter = new PermissionTrustPrompter(deps);
    const inner = { publish: vi.fn() };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = withRunStartedTrustPrompt(inner, prompter, () => {
      throw new Error('db gone');
    });

    expect(() => wrapped.publish('run-1', envelope('run_started'))).not.toThrow();
    expect(inner.publish).toHaveBeenCalledTimes(1);
    expect(deps.showMessageBox).not.toHaveBeenCalled();
  });
});
