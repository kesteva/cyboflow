import { describe, expect, it } from 'vitest';
import { renderWorkflowPromptForRuntime } from '../workflowPromptRenderer';
import type { WorkflowPrompt } from '../workflowPromptReader';

const BASE_PROMPT: WorkflowPrompt = {
  prompt: 'Shared workflow body.',
  systemPromptAppend: 'Report every step.',
};

describe('renderWorkflowPromptForRuntime', () => {
  it('leaves Claude prompts byte-identical', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'claude',
      runtime: 'claude-sdk',
    });

    expect(rendered).toBe(BASE_PROMPT);
  });

  it('wraps Codex prompts with a provider adapter while preserving the shared body', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'launch',
    });

    expect(rendered.prompt).toContain('# Runtime adapter: Codex');
    expect(rendered.prompt).toContain('same Cyboflow workflow semantics');
    expect(rendered.prompt).toContain('If this Codex runtime exposes a native delegation mechanism');
    expect(rendered.prompt.endsWith(BASE_PROMPT.prompt)).toBe(true);
    expect(rendered.systemPromptAppend).toBe(BASE_PROMPT.systemPromptAppend);
  });

  it('keeps the database, step-reporting, and human-gate contracts explicit for Codex', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'programmatic-step',
    });

    expect(rendered.prompt).toContain('cyboflow_*');
    expect(rendered.prompt).toContain('cyboflow_report_step');
    expect(rendered.prompt).toContain('Human gates remain host-owned gates');
    expect(rendered.prompt).toContain('cyboflow_request_user_input');
    expect(rendered.prompt).toContain('This MCP call blocks until the human answers');
    expect(rendered.prompt).toContain('Cyboflow database remains the single source of truth');
  });

  it('does not wrap Codex nudge or resume turns because the thread already has the launch prompt', () => {
    expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'nudge',
    })).toBe(BASE_PROMPT);
    expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'resume',
    })).toBe(BASE_PROMPT);
  });
});
