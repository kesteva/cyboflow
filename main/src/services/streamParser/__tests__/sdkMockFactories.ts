/**
 * Shared factory functions for constructing typed SDK-wire-format mock objects
 * used in stream-parser tests.
 *
 * Every factory:
 *   - Returns a fully-typed value conforming to the corresponding interface in
 *     `shared/types/claudeStream.ts`.
 *   - Accepts an optional `Partial<T>` overrides bag for per-test customization.
 *   - Uses literal field values sourced from the deleted fixture JSON files
 *     (recovered from git history at TASK-594 migration time).
 *
 * These factories replace the on-disk fixture pattern so that no test file
 * under __tests__/ needs to read from disk.
 */

import type {
  SystemInitEvent,
  SystemApiRetryEvent,
  SystemCompactEvent,
  SystemCompactBoundaryEvent,
  AssistantEvent,
  UserEvent,
  ResultEvent,
  StreamEvent,
} from '../../../../../shared/types/claudeStream';

// ---------------------------------------------------------------------------
// System variants
// ---------------------------------------------------------------------------

export function systemInit(overrides: Partial<SystemInitEvent> = {}): SystemInitEvent {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    cwd: '/Users/dev/projects/myapp',
    model: 'claude-opus-4-5',
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    mcp_servers: [],
    permissionMode: 'bypassPermissions',
    apiKeySource: 'ANTHROPIC_API_KEY',
    claude_code_version: '1.0.0',
    ...overrides,
  };
}

export function systemApiRetry(overrides: Partial<SystemApiRetryEvent> = {}): SystemApiRetryEvent {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 5,
    retry_delay_ms: 2000,
    error_status: 529,
    error: {
      category: 'rate_limit',
      message: 'Rate limit exceeded. Please retry after 2 seconds.',
    },
    ...overrides,
  };
}

export function systemCompact(overrides: Partial<SystemCompactEvent> = {}): SystemCompactEvent {
  return {
    type: 'system',
    subtype: 'compact',
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    summary: 'Context was compacted. Previous conversation summarized to free context window space.',
    ...overrides,
  };
}

export function systemCompactBoundary(
  overrides: Partial<SystemCompactBoundaryEvent> = {},
): SystemCompactBoundaryEvent {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    compact_metadata: {
      trigger: 'auto',
      pre_tokens: 90000,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Assistant variant
// ---------------------------------------------------------------------------

export function assistant(overrides: Partial<AssistantEvent> = {}): AssistantEvent {
  return {
    type: 'assistant',
    message: {
      id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
      model: 'claude-opus-4-5',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: "I'll help you with that. Let me run a command to check the current state.",
        },
        {
          type: 'tool_use',
          id: 'toolu_01A09q90qw90lq917835lq9',
          name: 'Bash',
          input: {
            command: 'ls -la',
            description: 'List files in current directory',
          },
        },
      ],
      usage: {
        input_tokens: 1024,
        output_tokens: 87,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// User variants (string content vs. array content)
// ---------------------------------------------------------------------------

export function userStringContent(overrides: Partial<UserEvent> = {}): UserEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_01A09q90qw90lq917835lq9',
          content:
            'total 48\ndrwxr-xr-x  12 dev  staff   384 Jan  1 12:00 .\ndrwxr-xr-x   5 dev  staff   160 Jan  1 11:00 ..\n-rw-r--r--   1 dev  staff  1234 Jan  1 12:00 README.md',
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      durationMs: 42,
      numFiles: 0,
      truncated: false,
    },
    parent_tool_use_id: 'toolu_01A09q90qw90lq917835lq9',
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

export function userArrayContent(overrides: Partial<UserEvent> = {}): UserEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_02B10r01rz01mr028946mr0',
          content: [
            {
              type: 'text',
              text: 'File written successfully to /Users/dev/projects/myapp/src/index.ts',
            },
          ],
          is_error: false,
        },
      ],
    },
    tool_use_result: {
      filenames: ['/Users/dev/projects/myapp/src/index.ts'],
      durationMs: 15,
      numFiles: 1,
      truncated: false,
    },
    parent_tool_use_id: 'toolu_02B10r01rz01mr028946mr0',
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Result variants
// ---------------------------------------------------------------------------

export function resultSuccess(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 12543,
    num_turns: 3,
    result: 'Task completed successfully. Listed files and confirmed directory structure.',
    total_cost_usd: 0.0234,
    usage: {
      input_tokens: 3200,
      output_tokens: 412,
    },
    modelUsage: {
      'claude-opus-4-5': {
        input_tokens: 3200,
        output_tokens: 412,
      },
    },
    permission_denials: [],
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

export function resultErrorMaxTurns(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: 'result',
    subtype: 'error_max_turns',
    is_error: true,
    duration_ms: 45210,
    num_turns: 10,
    result: 'Reached maximum number of turns (10) without completing the task.',
    total_cost_usd: 0.1234,
    usage: {
      input_tokens: 12000,
      output_tokens: 1800,
    },
    modelUsage: {
      'claude-opus-4-5': {
        input_tokens: 12000,
        output_tokens: 1800,
      },
    },
    permission_denials: [],
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

export function resultErrorMaxBudgetUsd(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: 'result',
    subtype: 'error_max_budget_usd',
    is_error: true,
    duration_ms: 28900,
    num_turns: 6,
    result: 'Exceeded maximum budget of $0.50 USD. Session terminated to prevent further charges.',
    total_cost_usd: 0.5023,
    usage: {
      input_tokens: 8500,
      output_tokens: 1100,
    },
    modelUsage: {
      'claude-opus-4-5': {
        input_tokens: 8500,
        output_tokens: 1100,
      },
    },
    permission_denials: [],
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

export function resultErrorDuringExecution(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    duration_ms: 5678,
    num_turns: 2,
    result: 'An unrecoverable error occurred during execution: Connection to API lost unexpectedly.',
    total_cost_usd: 0.0089,
    usage: {
      input_tokens: 1200,
      output_tokens: 95,
    },
    modelUsage: {
      'claude-opus-4-5': {
        input_tokens: 1200,
        output_tokens: 95,
      },
    },
    permission_denials: [],
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

export function resultErrorMaxStructuredOutputRetries(
  overrides: Partial<ResultEvent> = {},
): ResultEvent {
  return {
    type: 'result',
    subtype: 'error_max_structured_output_retries',
    is_error: true,
    duration_ms: 4321,
    num_turns: 1,
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StreamEvent variant
// ---------------------------------------------------------------------------

export function streamEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: "I'll help you with that.",
      },
    },
    session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    ...overrides,
  };
}
