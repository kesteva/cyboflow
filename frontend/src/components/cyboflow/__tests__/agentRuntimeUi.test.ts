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

  it('blocks both Codex runtimes from workflow launches in v1', () => {
    expect(isWorkflowAgentRuntime('codex-sdk')).toBe(true);
    expect(isWorkflowRuntimeSupported('codex-sdk')).toBe(false);
    expect(workflowRuntimeForLaunch('codex-sdk')).toBeNull();
    expect(workflowRuntimeForLaunch('codex-pty')).toBeNull();
  });

  it('preserves Codex PTY for quick sessions while keeping Codex SDK unavailable', () => {
    expect(quickSessionRuntimeForLaunch('codex-pty')).toBe('codex-pty');
    expect(quickSessionRuntimeForLaunch('codex-sdk')).toBeNull();
  });
});
