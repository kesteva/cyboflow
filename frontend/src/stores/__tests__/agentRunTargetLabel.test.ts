/**
 * agentRunTargetLabel — the Agents-catalogue card chip label.
 *
 * Regression guard for the bug where a Codex-pinned agent rendered as
 * "inherits run model": the old chip read only the Claude `model` alias and
 * ignored `runtime`/`codexModel`, so pinning an agent to Codex left the card
 * visually unchanged.
 */
import { describe, expect, it } from 'vitest';
import { agentRunTargetLabel, INHERIT_RUN_MODEL_LABEL } from '../../../../shared/types/agents';

describe('agentRunTargetLabel', () => {
  it('shows the inherit sentinel when nothing is pinned', () => {
    expect(agentRunTargetLabel({ runtime: null, model: null, providerModel: null })).toBe(
      INHERIT_RUN_MODEL_LABEL,
    );
  });

  it('shows the Codex model for a Codex-pinned agent (the reported bug)', () => {
    expect(
      agentRunTargetLabel({ runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.2-codex' }),
    ).toBe('gpt-5.2-codex');
  });

  it('falls back to the runtime label when Codex is pinned without a model', () => {
    expect(agentRunTargetLabel({ runtime: 'codex-sdk', model: null, providerModel: null })).toBe(
      'Codex SDK',
    );
    expect(agentRunTargetLabel({ runtime: 'codex-sdk', model: null, providerModel: '' })).toBe(
      'Codex SDK',
    );
  });

  // The non-Claude arm is selected through the runtime→provider registry, not a
  // `=== 'codex-sdk'` test. With that literal, an OMP-pinned agent fell to the
  // CLAUDE arm and rendered "inherits run model" — the reported bug above,
  // reproduced exactly one provider later.
  it('shows the OMP model for an OMP-pinned agent', () => {
    expect(
      agentRunTargetLabel({
        runtime: 'omp-sdk',
        model: null,
        providerModel: 'anthropic/claude-haiku-4-5',
      }),
    ).toBe('anthropic/claude-haiku-4-5');
  });

  it('falls back to the runtime label when OMP is pinned without a model', () => {
    expect(agentRunTargetLabel({ runtime: 'omp-sdk', model: null, providerModel: null })).toBe('OMP');
  });

  it('never reports a non-Claude pin as inheriting the run model', () => {
    // The chip's whole reason for existing: a pinned agent must never look
    // unpinned, whichever provider it is pinned to.
    for (const runtime of ['codex-sdk', 'omp-sdk'] as const) {
      expect(
        agentRunTargetLabel({ runtime, model: null, providerModel: null }),
      ).not.toBe(INHERIT_RUN_MODEL_LABEL);
    }
  });

  it('shows the pinned Claude model under a Claude runtime', () => {
    expect(agentRunTargetLabel({ runtime: 'claude-sdk', model: 'sonnet', providerModel: null })).toBe(
      'Sonnet 5.5',
    );
  });

  it('falls back to the runtime label when a Claude runtime pins no model', () => {
    expect(agentRunTargetLabel({ runtime: 'claude-sdk', model: null, providerModel: null })).toBe(
      'Claude SDK',
    );
    expect(
      agentRunTargetLabel({ runtime: 'claude-interactive', model: null, providerModel: null }),
    ).toBe('Claude Interactive (CLI)');
  });

  it('still shows a legacy model-without-runtime pin', () => {
    // Pre-gating rows can carry a model with runtime NULL; the chip must not
    // hide the pin even though the editor no longer lets you create that state.
    expect(agentRunTargetLabel({ runtime: null, model: 'fable', providerModel: null })).toBe('Fable 5.1');
  });
});
