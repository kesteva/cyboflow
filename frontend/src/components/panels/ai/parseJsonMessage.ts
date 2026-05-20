import type { ClaudeJsonMessage } from '../../../types/session';

/**
 * Renderer-side shape for raw JSON messages displayed in MessagesView.
 * Mirrors the local type previously declared inline in MessagesView.tsx.
 */
export interface JSONMessage {
  type: 'json';
  data: string;
  timestamp: string;
}

/**
 * Renderer-side shape for user-prompt messages displayed in RichOutputView.
 * Mirrors the local type previously declared inline in RichOutputView.tsx.
 */
export interface UserPromptMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
  timestamp: string;
}

/**
 * Renderer-side shape for session_info messages.
 */
export interface SessionInfo {
  type: 'session_info';
  initial_prompt?: string;
  claude_command?: string;
  worktree_path?: string;
  model?: string;
  permission_mode?: string;
  approval_policy?: string;
  timestamp: string;
}

/**
 * Adapter converting a raw ClaudeJsonMessage from the IPC boundary into the
 * renderer-side discriminated union. Returns null for messages that cannot
 * be classified (caller decides to drop or log).
 *
 * The runtime sniffing here previously lived as inline `if (msgData && ...)`
 * blocks inside MessagesView.tsx and RichOutputView.tsx. Centralising it here
 * removes the `as unknown as` double-casts at the consumer sites.
 */
export function parseJsonMessage(
  raw: ClaudeJsonMessage,
): JSONMessage | UserPromptMessage | SessionInfo | null {
  // Try to extract the structured payload. ClaudeJsonMessage may carry a
  // stringified payload via the IPC bridge (legacy code path) or a parsed
  // object (newer path); accept both.
  let payload: unknown = raw;
  const rawAny = raw as unknown as { data?: unknown };
  if (typeof rawAny.data === 'string') {
    try { payload = JSON.parse(rawAny.data); } catch { payload = rawAny.data; }
  } else if (rawAny.data !== undefined) {
    payload = rawAny.data;
  }

  // session_info discriminator
  if (
    payload && typeof payload === 'object' && 'type' in (payload as Record<string, unknown>)
    && (payload as { type: unknown }).type === 'session_info'
  ) {
    return payload as SessionInfo;
  }

  // user prompt discriminator (nested message.content array of text segments)
  if (
    raw.type === 'user'
    && raw.message
    && typeof raw.message === 'object'
    && Array.isArray((raw.message as { content?: unknown }).content)
  ) {
    return raw as unknown as UserPromptMessage; // shape-validated above
  }

  // Default: treat as a JSON-stringifiable line for MessagesView
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : '';
  const data = typeof rawAny.data === 'string'
    ? rawAny.data
    : JSON.stringify(payload);
  if (!timestamp && typeof rawAny.data !== 'string') {
    // Drop messages with no usable timestamp AND no usable data — caller may
    // choose to log; we return null to signal "skip".
    return null;
  }
  return { type: 'json', data, timestamp };
}

/**
 * Array variant: maps over a list, dropping nulls. Pure convenience.
 */
export function parseJsonMessages(
  raws: ClaudeJsonMessage[],
): Array<JSONMessage | UserPromptMessage | SessionInfo> {
  const out: Array<JSONMessage | UserPromptMessage | SessionInfo> = [];
  for (const raw of raws) {
    const parsed = parseJsonMessage(raw);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
