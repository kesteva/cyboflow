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
    expect(agentRunTargetLabel({ runtime: null, model: null, codexModel: null })).toBe(
      INHERIT_RUN_MODEL_LABEL,
    );
  });

  it('shows the Codex model for a Codex-pinned agent (the reported bug)', () => {
    expect(
      agentRunTargetLabel({ runtime: 'codex-sdk', model: null, codexModel: 'gpt-5.2-codex' }),
    ).toBe('gpt-5.2-codex');
  });

  it('falls back to the runtime label when Codex is pinned without a model', () => {
    expect(agentRunTargetLabel({ runtime: 'codex-sdk', model: null, codexModel: null })).toBe(
      'Codex SDK',
    );
    expect(agentRunTargetLabel({ runtime: 'codex-sdk', model: null, codexModel: '' })).toBe(
      'Codex SDK',
    );
  });

  it('shows the pinned Claude model under a Claude runtime', () => {
    expect(agentRunTargetLabel({ runtime: 'claude-sdk', model: 'sonnet', codexModel: null })).toBe(
      'Sonnet 5',
    );
  });

  it('falls back to the runtime label when a Claude runtime pins no model', () => {
    expect(agentRunTargetLabel({ runtime: 'claude-sdk', model: null, codexModel: null })).toBe(
      'Claude SDK',
    );
    expect(
      agentRunTargetLabel({ runtime: 'claude-interactive', model: null, codexModel: null }),
    ).toBe('Claude interactive');
  });

  it('still shows a legacy model-without-runtime pin', () => {
    // Pre-gating rows can carry a model with runtime NULL; the chip must not
    // hide the pin even though the editor no longer lets you create that state.
    expect(agentRunTargetLabel({ runtime: null, model: 'fable', codexModel: null })).toBe('Fable 5');
  });
});
