/**
 * The validated concrete Claude model the verification engine falls back to.
 *
 * Two consumers, both wired in verifyComposition.ts:
 *  - VerificationAgentRunner's `claudeDefaultModel` — the model an UNPINNED
 *    visual-verify agent runs on when it inherits a non-Claude run's model (the
 *    Claude-namespace model rule, verification-agent-redesign §5.4).
 *  - the lane runbook bootstrap's drafting agent, which is Claude-only and takes
 *    this when its effective agent pins no usable model.
 */
export const DEFAULT_VERIFY_CLAUDE_MODEL = 'claude-opus-4-8';
