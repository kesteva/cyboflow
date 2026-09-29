import type { AppServerNotification } from './client';
import type {
  CollabAgentStatus,
  RawResponseCompletedNotification,
  SubAgentActivityKind,
  ThreadTokenUsageUpdatedNotification,
} from './protocol';
import { parseThreadTokenUsageUpdated, parseTokenUsageBreakdown } from './turnSession';

/**
 * Usage-relevant facts read from ANY thread's notifications — before
 * TurnSession's root-only filter, so collab descendants are visible. Everything
 * here is lenient: a malformed frame yields null and is simply not counted.
 */
export type CodexUsageSignal =
  | { kind: 'response'; notification: RawResponseCompletedNotification }
  | { kind: 'tokenUsage'; notification: ThreadTokenUsageUpdatedNotification }
  | {
      kind: 'spawn';
      threadId: string;
      turnId: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      model: string | null;
    }
  | { kind: 'spawnCall'; callId: string; agentType: string | null; model: string | null }
  | { kind: 'subAgentStarted'; threadId: string; turnId: string; agentThreadId: string; callId: string | null }
  | { kind: 'agentStates'; states: Array<{ threadId: string; terminal: boolean }> }
  | { kind: 'turnStarted'; threadId: string; turnId: string }
  | { kind: 'turnCompleted'; threadId: string; turnId: string }
  | { kind: 'threadIdle'; threadId: string }
  | { kind: 'threadActive'; threadId: string }
  | { kind: 'compaction'; threadId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TERMINAL_AGENT_STATUSES: ReadonlySet<CollabAgentStatus> = new Set<CollabAgentStatus>([
  'interrupted',
  'completed',
  'errored',
  'shutdown',
  'notFound',
]);

const TERMINAL_ACTIVITY_KINDS: ReadonlySet<SubAgentActivityKind> = new Set<SubAgentActivityKind>([
  'interrupted',
  'completed',
]);

export function parseRawResponseCompleted(params: unknown): RawResponseCompletedNotification | null {
  if (
    !isRecord(params)
    || typeof params.threadId !== 'string'
    || typeof params.turnId !== 'string'
    || typeof params.responseId !== 'string'
  ) {
    return null;
  }
  // A present-but-malformed usage is protocol drift: the response is not
  // counted (the tokenUsage fallback tops its request up instead).
  const usage = params.usage === null || params.usage === undefined
    ? null
    : parseTokenUsageBreakdown(params.usage);
  if (params.usage !== null && params.usage !== undefined && usage === null) return null;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    responseId: params.responseId,
    usage,
    usageMetadata: null,
  };
}

function readThreadAndTurn(params: Record<string, unknown>): { threadId: string; turnId: string } | null {
  return typeof params.threadId === 'string' && typeof params.turnId === 'string'
    ? { threadId: params.threadId, turnId: params.turnId }
    : null;
}

function parseItemSignals(params: unknown): CodexUsageSignal[] {
  if (!isRecord(params) || !isRecord(params.item)) return [];
  const scope = readThreadAndTurn(params);
  if (!scope) return [];
  const item = params.item;
  const signals: CodexUsageSignal[] = [];
  if (item.type === 'collabAgentToolCall') {
    if (item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds)) {
      const receiverThreadIds = item.receiverThreadIds.filter(
        (id): id is string => typeof id === 'string' && id !== '',
      );
      if (receiverThreadIds.length > 0) {
        signals.push({
          kind: 'spawn',
          ...scope,
          senderThreadId: typeof item.senderThreadId === 'string' ? item.senderThreadId : scope.threadId,
          receiverThreadIds,
          model: typeof item.model === 'string' && item.model !== '' ? item.model : null,
        });
      }
    }
    if (isRecord(item.agentsStates)) {
      const states: Array<{ threadId: string; terminal: boolean }> = [];
      for (const [threadId, state] of Object.entries(item.agentsStates)) {
        if (!isRecord(state) || typeof state.status !== 'string') continue;
        states.push({
          threadId,
          terminal: TERMINAL_AGENT_STATUSES.has(state.status as CollabAgentStatus),
        });
      }
      if (states.length > 0) signals.push({ kind: 'agentStates', states });
    }
  } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string') {
    if (item.kind === 'started') {
      signals.push({
        kind: 'subAgentStarted',
        ...scope,
        agentThreadId: item.agentThreadId,
        callId: typeof item.id === 'string' && item.id !== '' ? item.id : null,
      });
    } else if (typeof item.kind === 'string' && TERMINAL_ACTIVITY_KINDS.has(item.kind as SubAgentActivityKind)) {
      signals.push({ kind: 'agentStates', states: [{ threadId: item.agentThreadId, terminal: true }] });
    }
  } else if (item.type === 'contextCompaction') {
    signals.push({ kind: 'compaction', threadId: scope.threadId });
  }
  return signals;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A `spawn_agent` function call (0.156.1 native roles). Its `call_id` is the id
 * of the `subAgentActivity` started item that announces the child, and its
 * arguments name the role (`agent_type`) and any explicit `model` — the only
 * place the child's model is visible, since that item carries none.
 */
function parseSpawnCall(params: unknown): CodexUsageSignal[] {
  if (!isRecord(params) || !isRecord(params.item)) return [];
  const item = params.item;
  if (item.type !== 'function_call' || item.name !== 'spawn_agent') return [];
  const callId = nonEmptyString(item.call_id);
  if (callId === null || typeof item.arguments !== 'string') return [];
  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return [];
  }
  if (!isRecord(args)) return [];
  return [{ kind: 'spawnCall', callId, agentType: nonEmptyString(args.agent_type), model: nonEmptyString(args.model) }];
}

function parseTurnScope(params: unknown): { threadId: string; turnId: string } | null {
  if (!isRecord(params) || typeof params.threadId !== 'string' || !isRecord(params.turn)) return null;
  return typeof params.turn.id === 'string' ? { threadId: params.threadId, turnId: params.turn.id } : null;
}

/** Reads every usage-relevant signal from one app-server notification (usually none). */
export function parseCodexUsageSignals(notification: AppServerNotification): CodexUsageSignal[] {
  const params: unknown = notification.params;
  switch (notification.method) {
    case 'rawResponse/completed': {
      const parsed = parseRawResponseCompleted(params);
      return parsed ? [{ kind: 'response', notification: parsed }] : [];
    }
    case 'thread/tokenUsage/updated': {
      const parsed = parseThreadTokenUsageUpdated(params);
      return parsed ? [{ kind: 'tokenUsage', notification: parsed }] : [];
    }
    case 'item/started':
    case 'item/completed':
      return parseItemSignals(params);
    case 'rawResponseItem/completed':
      return parseSpawnCall(params);
    case 'turn/started': {
      const scope = parseTurnScope(params);
      return scope ? [{ kind: 'turnStarted', ...scope }] : [];
    }
    case 'turn/completed': {
      const scope = parseTurnScope(params);
      return scope ? [{ kind: 'turnCompleted', ...scope }] : [];
    }
    case 'thread/closed':
      return isRecord(params) && typeof params.threadId === 'string'
        ? [{ kind: 'threadIdle', threadId: params.threadId }]
        : [];
    case 'thread/status/changed': {
      if (!isRecord(params) || typeof params.threadId !== 'string' || !isRecord(params.status)) return [];
      return params.status.type === 'active'
        ? [{ kind: 'threadActive', threadId: params.threadId }]
        : [{ kind: 'threadIdle', threadId: params.threadId }];
    }
    case 'thread/compacted':
      return isRecord(params) && typeof params.threadId === 'string'
        ? [{ kind: 'compaction', threadId: params.threadId }]
        : [];
    default:
      return [];
  }
}
