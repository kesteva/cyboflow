import { describe, expect, it } from 'vitest';
import {
  isWorkflowAgentRuntime,
  isWorkflowRuntimeSupported,
} from '../../../../../shared/types/agentRuntime';
import {
  quickSessionRuntimeForLaunch,
  workflowRuntimeForLaunch,
} from '../agentRuntimeUi';

describe('agentRuntimeUi compatibility', () => {
  it('keeps Claude runtimes available for workflows', () => {
    expect(workflowRuntimeForLaunch('claude-sdk')).toBe('claude-sdk');
    expect(workflowRuntimeForLaunch('claude-interactive')).toBe('claude-interactive');
  });

  it('allows Codex SDK but blocks Codex PTY for workflow launches', () => {
    expect(isWorkflowAgentRuntime('codex-sdk')).toBe(true);
    expect(isWorkflowRuntimeSupported('codex-sdk')).toBe(true);
    expect(isWorkflowRuntimeSupported('codex-pty')).toBe(false);
    expect(isWorkflowRuntimeSupported('not-a-runtime')).toBe(false);
    expect(workflowRuntimeForLaunch('codex-sdk')).toBe('codex-sdk');
    expect(workflowRuntimeForLaunch('codex-pty')).toBeNull();
  });

  it('preserves both Codex runtimes for quick sessions', () => {
    expect(quickSessionRuntimeForLaunch('codex-pty')).toBe('codex-pty');
    expect(quickSessionRuntimeForLaunch('codex-sdk')).toBe('codex-sdk');
  });
});
