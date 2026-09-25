import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PROMPT_ENVELOPES,
  renderWorkflowPromptForRuntime,
} from '../workflowPromptRenderer';
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
    // The roles are registered as native Codex agent roles, so delegation names
    // them exactly — never a generic built-in that carries no role instructions.
    expect(rendered.prompt).toContain('agent_type: "cyboflow-code-review"');
    expect(rendered.prompt).toContain('Never substitute `worker`, `explorer`');
    // A role child inherits the cyboflow MCP server on Codex (a role file cannot
    // close it), so the write boundary is stated rather than assumed.
    expect(rendered.prompt).toContain('A delegate must not write Cyboflow state even though Codex gives it the `cyboflow_*` tools');
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

  /**
   * OMP DOES get an envelope, because the T1 step prompt is not
   * provider-neutral: it tells the step to delegate to its `cyboflow-<agent>`
   * role and asserts that role is installed in `.claude/agents/`, which is true
   * on Claude only. Without the envelope an OMP step resolves the prefix-stripped
   * name against its own roster and can adopt a same-named THIRD-PARTY agent.
   */
  it('prepends the OMP envelope to a programmatic-step prompt', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'omp',
      runtime: 'omp-sdk',
      executionModel: 'programmatic',
      turnKind: 'programmatic-step',
    });

    expect(rendered.prompt).toContain('# Runtime adapter: OMP');
    expect(rendered.prompt.endsWith(BASE_PROMPT.prompt)).toBe(true);
    expect(rendered.systemPromptAppend).toBe(BASE_PROMPT.systemPromptAppend);
  });

  /**
   * The envelope's whole job is to stop a step adopting a same-named agent from
   * the host environment — the exact failure that killed a real Compound run.
   */
  it('forbids resolving a cyboflow role against the host agent roster', () => {
    const envelope = PROVIDER_PROMPT_ENVELOPES.omp;

    expect(envelope).not.toBeNull();
    // The roles live in OMP's own project-agent root, delegated by exact name…
    expect(envelope).toContain('`.omp/agents/cyboflow-<role>.md`');
    expect(envelope).toContain('using the role\'s exact name as the agent');
    // …and nothing else that happens to answer to the name is ever adopted.
    expect(envelope).toContain('NEVER pass the role name with the `cyboflow-` prefix stripped');
    expect(envelope).toContain('NEVER substitute a bundled agent');
    expect(envelope).toContain('plugin cache');
  });

  /** A nudge / resume turn stays identity for OMP, same rule as Codex. */
  it('leaves an OMP nudge or resume turn unenveloped', () => {
    for (const turnKind of ['nudge', 'resume'] as const) {
      expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
        provider: 'omp',
        runtime: 'omp-sdk',
        turnKind,
      })).toBe(BASE_PROMPT);
    }
  });

  /**
   * pi gets an envelope for OMP's reason and two more of its own: it has no
   * delegation tool at all (eight registered tools, none of which spawns a
   * subagent) and NOTHING wires the cyboflow MCP server for the pi lane.
   */
  it('prepends the pi envelope to a programmatic-step prompt', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'pi',
      runtime: 'pi-sdk',
      executionModel: 'programmatic',
      turnKind: 'programmatic-step',
    });

    expect(rendered.prompt).toContain('# Runtime adapter: pi');
    expect(rendered.prompt.endsWith(BASE_PROMPT.prompt)).toBe(true);
    expect(rendered.systemPromptAppend).toBe(BASE_PROMPT.systemPromptAppend);
  });

  it('tells pi to do the role in-turn and never adopt a same-named agent', () => {
    const envelope = PROVIDER_PROMPT_ENVELOPES.pi;

    expect(envelope).not.toBeNull();
    expect(envelope, 'no delegation tool exists on pi').toContain(
      'There is no delegation tool on this runtime',
    );
    expect(envelope, 'the role is performed in-turn instead').toContain(
      "perform that role's work yourself, in this turn",
    );
    expect(envelope, 'never resolve a role against the host roster').toContain(
      'never adopt an agent that merely shares the role',
    );
    // The pi manager writes the run's role files where the workflow says they
    // are; pi reads the role's file instead of working from the name alone.
    expect(envelope, 'pi reads the role file cyboflow wrote').toContain(
      '`.claude/agents/cyboflow-<role>.md` in this worktree',
    );
    expect(envelope, 'the stale no-agent-files claim is gone').not.toContain(
      'installs no agent files',
    );
    expect(envelope, 'pi has no cyboflow MCP surface').toContain(
      'The `cyboflow_*` MCP tools are NOT available on this runtime',
    );
    expect(envelope, 'a gate is reported, never answered or skipped').toContain(
      'do NOT invent an answer and do NOT proceed past it',
    );
    // pi's glob tool is named `find`; a brief written from Claude habit would
    // otherwise send it looking for a tool that does not exist.
    expect(envelope, "pi's pattern-search tool is find, not glob").toContain(
      "pi's pattern-search tool is `find`, not `glob`",
    );
  });

  /** Same nudge/resume rule as Codex and OMP. */
  it('leaves a pi nudge or resume turn unenveloped', () => {
    for (const turnKind of ['nudge', 'resume'] as const) {
      expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
        provider: 'pi',
        runtime: 'pi-sdk',
        turnKind,
      })).toBe(BASE_PROMPT);
    }
  });

  /**
   * Every provider now carries an envelope except claude, whose bodies are
   * written for it. A new provider defaulting to `null` by copy-paste is the
   * failure this asserts against.
   */
  it('only claude renders identity', () => {
    expect(PROVIDER_PROMPT_ENVELOPES.claude).toBeNull();
    for (const provider of ['codex', 'omp', 'pi'] as const) {
      expect(PROVIDER_PROMPT_ENVELOPES[provider], provider).not.toBeNull();
    }
  });
});
