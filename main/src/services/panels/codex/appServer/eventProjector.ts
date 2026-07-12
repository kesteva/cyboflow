import type {
  AgentAssistantMessageEvent,
  AgentResultEvent,
  AgentStreamEvent,
  AgentUnknownEvent,
  AgentUsage,
  AgentUserMessageEvent,
} from '../../../../../../shared/types/agentStream';
import type {
  TurnSessionError,
  TurnSessionEvent,
  TurnSessionItem,
} from './turnSession';

export interface TurnSessionEventProjectionContext {
  model: string;
  durationMs: number;
  usage?: AgentUsage;
}

const CODEX_EVENT_SOURCE = {
  provider: 'codex' as const,
  runtime: 'codex-sdk' as const,
};

function buildAssistantEvent(
  id: string,
  text: string,
  contentType: 'text' | 'thinking',
  threadId: string,
  model: string,
): AgentAssistantMessageEvent {
  return {
    type: 'agent_message',
    ...CODEX_EVENT_SOURCE,
    role: 'assistant',
    id,
    model,
    content: [{ type: contentType, text }],
    external_session_id: threadId,
  };
}

function buildToolProjection(input: {
  id: string;
  name: string;
  toolInput: Record<string, unknown>;
  result: string;
  isError: boolean;
  threadId: string;
  model: string;
}): [AgentAssistantMessageEvent, AgentUserMessageEvent] {
  return [
    {
      type: 'agent_message',
      ...CODEX_EVENT_SOURCE,
      role: 'assistant',
      id: `${input.id}:call`,
      model: input.model,
      content: [{
        type: 'tool_call',
        id: input.id,
        name: input.name,
        input: input.toolInput,
      }],
      external_session_id: input.threadId,
    },
    {
      type: 'agent_message',
      ...CODEX_EVENT_SOURCE,
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_call_id: input.id,
        content: input.result,
        is_error: input.isError,
      }],
      external_session_id: input.threadId,
    },
  ];
}

function buildResultEvent(input: {
  threadId: string;
  durationMs: number;
  isError: boolean;
  result?: string;
  usage?: AgentUsage;
}): AgentResultEvent {
  return {
    type: 'agent_result',
    ...CODEX_EVENT_SOURCE,
    subtype: input.isError ? 'error_during_execution' : 'success',
    is_error: input.isError,
    duration_ms: input.durationMs,
    num_turns: 1,
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    external_session_id: input.threadId,
  };
}

function buildUnknownEvent(raw: Record<string, unknown>): AgentUnknownEvent {
  return {
    type: 'agent_unknown',
    ...CODEX_EVENT_SOURCE,
    raw,
  };
}

function reasoningText(item: Extract<TurnSessionItem, { type: 'reasoning' }>): string {
  return [...item.summary, ...item.content].join('\n');
}

function userMessageText(item: Extract<TurnSessionItem, { type: 'userMessage' }>): string {
  return item.content.map((content) => {
    switch (content.type) {
      case 'text':
        return content.text;
      case 'image':
        return `[image: ${content.url}]`;
      case 'localImage':
        return `[local image: ${content.path}]`;
      case 'skill':
        return `[skill: ${content.name} (${content.path})]`;
      case 'mention':
        return `[mention: ${content.name} (${content.path})]`;
    }
  }).join('\n');
}

function rawTurnError(
  event: Extract<TurnSessionEvent, { type: 'turn.error' }>,
): Record<string, unknown> {
  return {
    type: event.type,
    threadId: event.threadId,
    turnId: event.turnId,
    error: event.error,
    willRetry: event.willRetry,
  };
}

/**
 * Preserve the provider payload alongside its human-facing wrapper. App-server
 * commonly reports a generic "Unhandled error" message while the actionable
 * usage/auth/rate-limit code and message live in codexErrorInfo.
 */
function formatTurnError(error: TurnSessionError): string {
  const details = [error.message];
  if (error.codexErrorInfo !== null) {
    details.push(`Codex provider error: ${JSON.stringify(error.codexErrorInfo)}`);
  }
  if (error.additionalDetails !== null && error.additionalDetails !== error.message) {
    details.push(`Codex provider details: ${error.additionalDetails}`);
  }
  return details.join('\n');
}

function rawCompletedItem(
  event: Extract<TurnSessionEvent, { type: 'item.completed' }>,
  item: Extract<TurnSessionItem, { type: 'raw' }>,
): Record<string, unknown> {
  return {
    type: event.type,
    threadId: event.threadId,
    turnId: event.turnId,
    completedAtMs: event.completedAtMs,
    itemType: item.itemType,
    item: item.item,
  };
}

function projectCompletedItem(
  event: Extract<TurnSessionEvent, { type: 'item.completed' }>,
  context: TurnSessionEventProjectionContext,
): AgentStreamEvent[] {
  const { item, threadId } = event;
  switch (item.type) {
    case 'userMessage': {
      const text = userMessageText(item);
      return text.trim().length === 0
        ? []
        : [{
            type: 'agent_message',
            ...CODEX_EVENT_SOURCE,
            role: 'user',
            content: [{ type: 'text', text }],
            external_session_id: threadId,
          }];
    }
    case 'agentMessage':
      return item.text.trim().length === 0
        ? []
        : [buildAssistantEvent(item.id, item.text, 'text', threadId, context.model)];
    case 'reasoning': {
      const text = reasoningText(item);
      return text.trim().length === 0
        ? []
        : [buildAssistantEvent(item.id, text, 'thinking', threadId, context.model)];
    }
    case 'commandExecution':
      return buildToolProjection({
        id: item.id,
        name: 'Bash',
        toolInput: {
          command: item.command,
          cwd: item.cwd,
          source: item.source,
          processId: item.processId,
          commandActions: item.commandActions,
        },
        result: JSON.stringify({
          status: item.status,
          output: item.aggregatedOutput,
          exitCode: item.exitCode,
          durationMs: item.durationMs,
        }, null, 2),
        isError: item.status === 'failed'
          || item.status === 'declined'
          || (item.exitCode !== null && item.exitCode !== 0),
        threadId,
        model: context.model,
      });
    case 'fileChange':
      return buildToolProjection({
        id: item.id,
        name: 'Edit',
        toolInput: { changes: item.changes },
        result: JSON.stringify({ status: item.status, changes: item.changes }, null, 2),
        isError: item.status === 'failed' || item.status === 'declined',
        threadId,
        model: context.model,
      });
    case 'mcpToolCall':
      return buildToolProjection({
        id: item.id,
        name: item.tool,
        toolInput: {
          server: item.server,
          arguments: item.arguments,
          appContext: item.appContext,
          ...(item.mcpAppResourceUri !== undefined
            ? { mcpAppResourceUri: item.mcpAppResourceUri }
            : {}),
          pluginId: item.pluginId,
        },
        result: JSON.stringify({
          status: item.status,
          result: item.result,
          error: item.error,
          durationMs: item.durationMs,
        }, null, 2),
        isError: item.status === 'failed' || item.error !== null,
        threadId,
        model: context.model,
      });
    case 'webSearch':
      return buildToolProjection({
        id: item.id,
        name: 'WebSearch',
        toolInput: { query: item.query, action: item.action },
        result: `Searched for ${item.query}`,
        isError: false,
        threadId,
        model: context.model,
      });
    case 'plan':
      return item.text.trim().length === 0
        ? []
        : [buildAssistantEvent(item.id, item.text, 'thinking', threadId, context.model)];
    case 'raw':
      return [buildUnknownEvent(rawCompletedItem(event, item))];
  }
}

function projectTurnError(
  event: Extract<TurnSessionEvent, { type: 'turn.error' }>,
  context: TurnSessionEventProjectionContext,
): AgentStreamEvent[] {
  const unknown = buildUnknownEvent(rawTurnError(event));
  if (event.willRetry) return [unknown];
  return [
    unknown,
    buildResultEvent({
      threadId: event.threadId,
      durationMs: context.durationMs,
      isError: true,
      result: formatTurnError(event.error),
      usage: context.usage,
    }),
  ];
}

function projectFailedTurn(
  threadId: string,
  error: TurnSessionError,
  durationMs: number,
  usage?: AgentUsage,
): AgentResultEvent {
  return buildResultEvent({
    threadId,
    durationMs,
    isError: true,
    result: formatTurnError(error),
    usage,
  });
}

export function projectTurnSessionEvent(
  event: TurnSessionEvent,
  context: TurnSessionEventProjectionContext,
): AgentStreamEvent[] {
  switch (event.type) {
    case 'thread.started':
    case 'turn.started':
    case 'thread.tokenUsage.updated':
    case 'item.started':
      return [];
    case 'item.completed':
      return projectCompletedItem(event, context);
    case 'turn.error':
      return projectTurnError(event, context);
    case 'turn.completed':
      return event.status === 'completed'
        ? [buildResultEvent({
            threadId: event.threadId,
            durationMs: context.durationMs,
            isError: false,
            usage: context.usage,
          })]
        : [buildResultEvent({
            threadId: event.threadId,
            durationMs: context.durationMs,
            isError: true,
            result: 'Codex turn interrupted',
            usage: context.usage,
          })];
    case 'turn.failed':
      return [projectFailedTurn(event.threadId, event.error, context.durationMs, context.usage)];
    case 'raw':
      return [buildUnknownEvent({ ...event.notification })];
  }
}
