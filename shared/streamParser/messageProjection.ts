/**
 * MessageProjection — main-process streaming projection of ClaudeStreamEvents
 * into UnifiedMessage shapes consumed by the renderer.
 *
 * Ported from:
 *   frontend/src/components/panels/ai/transformers/ClaudeMessageTransformer.ts
 *
 * Key design shift: the old transformer ran 3 passes over a batch array.
 * This implementation is STREAMING — one event in, zero-or-more messages out.
 * Per-run state that the old code maintained across passes
 * (toolResults, parentToolMap, allToolCalls) lives on the MessageProjection
 * instance and is updated incrementally.
 *
 * Usage:
 *   const projection = new MessageProjection(runId);
 *   for (const event of events) {
 *     const result = projection.project(event);
 *     if (result !== null) emitToRenderer(result);
 *   }
 */

import type { ClaudeStreamEvent, SystemInitEvent, SystemCompactBoundaryEvent, SystemTaskStartedEvent, SystemTaskUpdatedEvent, SystemTaskNotificationEvent, AssistantEvent, UserEvent, ResultEvent, TextBlock } from '../types/claudeStream';
import type { UnifiedMessage, MessageSegment, ToolCall, ToolResult } from '../types/unifiedMessage';
import { isAgentDispatchToolName } from '../types/agentIdentity';
import { isFailedTaskStatus } from './taskLifecycle';
import type { ILogger } from './types';

/**
 * Classify a background task from its `task_started.task_type`.
 *
 * Observed values (raw_events): `local_bash` (a backgrounded shell command),
 * `local_agent` (an Agent-tool subagent), `in_process_teammate` (a teammate
 * agent). Anything unrecognised — including a missing task_started — stays
 * undefined so the renderer falls back to a neutral label rather than guessing.
 */
function resolveTaskKind(
  taskType: string | undefined,
  subagentType: string | undefined,
): 'agent' | 'command' | undefined {
  if (taskType === 'local_agent' || taskType === 'in_process_teammate') return 'agent';
  if (taskType === 'local_bash') return 'command';
  // `task_type` is absent from some observed `task_started` shapes (the fake-SDK
  // builders model exactly that case). A `subagent_type` is only ever carried by
  // an Agent dispatch, so treat it as sufficient evidence rather than falling
  // back to the neutral label with the answer already in hand.
  if (subagentType !== undefined) return 'agent';
  return undefined;
}

export class MessageProjection {
  private readonly runId: string;
  private readonly logger: Pick<ILogger, 'warn'> | undefined;

  // Instance state — mirrors the 3-pass accumulators in the old transformer.
  private messageIdCounter = 0;
  /** Map from tool_use_id → ToolResult (collected from user/tool_result blocks). */
  private toolResults = new Map<string, ToolResult>();
  /** Map from tool_use_id (child) → parent_tool_use_id (parent). */
  private parentToolMap = new Map<string, string>();
  /** Map from tool_use_id → ToolCall (built when we see assistant/tool_use blocks). */
  private allToolCalls = new Map<string, ToolCall>();
  /**
   * Map from assistant `message.id` → the first UnifiedMessage emitted for it.
   *
   * Partial-message streaming (SDK `--include-partial-messages`) emits ONE
   * `assistant` event per completed content block — a single logical message
   * (thinking + text + N tool_use blocks) arrives as N separate events that all
   * carry the same `message.id`. Without coalescing, project() would emit N
   * UnifiedMessages sharing one id, which the renderer keys on → React
   * "two children with the same key" warnings and duplicate bubbles. We keep the
   * first-emitted message here and append later blocks' segments to it in place,
   * returning null for the follow-up events.
   */
  private emittedAssistantMessages = new Map<string, UnifiedMessage>();
  /**
   * Map from background `task_id` → the identity fields carried ONLY by its
   * `task_started` event. The terminal `task_notification` has no `task_type` /
   * `subagent_type`, so without this the projection cannot tell an Agent-tool
   * subagent's report from a backgrounded `local_bash` command's output.
   */
  private backgroundTasks = new Map<string, { taskType?: string; subagentType?: string; description?: string }>();

  constructor(runId: string, logger?: Pick<ILogger, 'warn'>) {
    this.runId = runId;
    this.logger = logger;
  }

  /**
   * Project one ClaudeStreamEvent to zero, one, or multiple UnifiedMessages.
   *
   * Returns:
   *   - null          : event carries no renderable content (e.g. stream_event delta)
   *   - UnifiedMessage: event maps to exactly one renderable message
   *
   * NOTE: In the old batch transformer, tool-result correlation required a
   * separate first pass before building tool-call messages. In the streaming
   * model we cannot look ahead, so tool_result information is stored when user
   * events arrive and THEN we retroactively update the stored ToolCall's result
   * and status. Callers that want live updates should re-render when they
   * receive updated ToolCall data.
   */
  project(event: ClaudeStreamEvent): UnifiedMessage | null {
    // UnknownStreamEvent uses `kind` instead of `type`.
    if ('kind' in event && event.kind === '__unknown__') {
      return null;
    }

    // stream_event deltas are partial — absorb without emitting.
    if ('type' in event && event.type === 'stream_event') {
      return null;
    }

    try {
      if (!('type' in event)) return null;

      switch (event.type) {
        case 'system': {
          const sysEvent = event as SystemInitEvent | SystemCompactBoundaryEvent | SystemTaskStartedEvent | SystemTaskUpdatedEvent | SystemTaskNotificationEvent;
          return this.projectSystemEvent(sysEvent);
        }
        case 'assistant': {
          return this.projectAssistantEvent(event as AssistantEvent);
        }
        case 'user': {
          return this.projectUserEvent(event as UserEvent);
        }
        case 'result': {
          return this.projectResultEvent(event as ResultEvent);
        }
        default:
          return null;
      }
    } catch (err) {
      this.logger?.warn(
        `[MessageProjection] runId=${this.runId} unexpected error projecting event: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // System events
  // ---------------------------------------------------------------------------

  private projectSystemEvent(
    event: SystemInitEvent | SystemCompactBoundaryEvent | SystemTaskStartedEvent | SystemTaskUpdatedEvent | SystemTaskNotificationEvent,
  ): UnifiedMessage | null {
    const subtype = event.subtype;

    // A background task began. Not rendered, but its IDENTITY is recorded so the
    // terminal task_notification (which carries no type fields) can be attributed
    // correctly — `local_bash` background commands share this lifecycle with
    // Agent-tool subagents and are in fact the MAJORITY of background tasks, so
    // labelling every notification "sub-agent" would be wrong more often than right.
    if (subtype === 'task_started') {
      const started = event as SystemTaskStartedEvent;
      this.backgroundTasks.set(started.task_id, {
        taskType: started.task_type,
        subagentType: started.subagent_type,
        description: started.description,
      });
      return null;
    }

    // A background task settled. `summary` is the task's FINAL REPORT, and for a
    // backgrounded Agent-tool subagent it is the ONLY copy on the parent stream —
    // the dispatching tool's `tool_result` is just the spawn ack, and the
    // sub-agent's own narration is suppressed as internal (projectAssistantEvent).
    // Render it as a system message so the report stays visible.
    if (subtype === 'task_notification') {
      const task = event as SystemTaskNotificationEvent;

      // `summary` is optional on the wire. A silent drop is fine for a completed
      // task with nothing to report, but a FAILED/STOPPED one must still surface —
      // the notification is the only terminal signal the user gets, so fall back to
      // a status line rather than swallowing the failure.
      return this.projectSettledTask(task.task_id, task.status, task.summary?.trim(), {
        outputFile: task.output_file,
        // The dispatching tool_use, so a renderer can attribute the report to
        // the Agent call it came from.
        parentToolId: task.tool_use_id,
        tokens: task.usage?.total_tokens,
        duration: task.usage?.duration_ms,
      });
    }

    // A `task_updated` patch whose status is terminal ALSO settles the task —
    // trackBackgroundTasks retires the turn-boundary hold on exactly this signal,
    // and a task can settle this way with no notification ever arriving (observed
    // in the live DB). Surface only FAILURES: a clean completion here carries no
    // summary, so there is nothing to show, but a failure would otherwise vanish.
    if (subtype === 'task_updated') {
      const updated = event as SystemTaskUpdatedEvent;
      const status = updated.patch['status'];
      if (typeof status !== 'string' || !isFailedTaskStatus(status)) return null;
      return this.projectSettledTask(updated.task_id, status, undefined, {});
    }

    if (subtype === 'init') {
      const init = event as SystemInitEvent;
      return {
        id: `system_init_msg_${++this.messageIdCounter}`,
        role: 'system',
        timestamp: new Date().toISOString(),
        segments: [{
          type: 'system_info',
          info: {
            cwd: init.cwd,
            model: init.model,
            tools: init.tools,
            mcp_servers: init.mcp_servers,
            permissionMode: init.permissionMode,
            session_id: init.session_id,
          }
        }],
        metadata: {
          systemSubtype: 'init',
          sessionInfo: init as unknown as Record<string, unknown>,
        }
      };
    }

    if (subtype === 'compact_boundary') {
      const compact = event as SystemCompactBoundaryEvent;
      return {
        id: `context_compacted_msg_${++this.messageIdCounter}`,
        role: 'system',
        timestamp: new Date().toISOString(),
        segments: [
          { type: 'system_info', info: {} }
        ],
        metadata: {
          systemSubtype: 'context_compacted',
          // compactTrigger / preTokens: camelCase forward-compat (FIND-SPRINT-026-5).
          // No current renderer consumer reads these — RichOutputView.tsx:842 dispatches
          // on systemSubtype only. When a renderer surfaces compact details, read from
          // here (not the wire-layer snake_case fields on compact_metadata).
          compactTrigger: compact.compact_metadata.trigger,
          preTokens: compact.compact_metadata.pre_tokens,
        }
      };
    }

    return null;
  }

  /**
   * Build the system message for a settled background task, from either terminal
   * path (`task_notification` or a terminal `task_updated` patch).
   *
   * Returns null only when there is genuinely nothing to show: a CLEAN completion
   * with no summary. A failure always yields a message.
   */
  private projectSettledTask(
    taskId: string,
    status: string,
    summary: string | undefined,
    extra: { outputFile?: string; parentToolId?: string; tokens?: number; duration?: number },
  ): UnifiedMessage | null {
    const started = this.backgroundTasks.get(taskId);
    const content = summary
      ?? (isFailedTaskStatus(status)
        ? [`Task ${status}.`, started?.description].filter(Boolean).join(' ')
        : undefined);
    if (!content) return null;

    return {
      id: `task_notification_msg_${++this.messageIdCounter}`,
      role: 'system',
      timestamp: new Date().toISOString(),
      segments: [{ type: 'text', content }],
      metadata: {
        systemSubtype: 'task_complete',
        taskId,
        taskStatus: status,
        // 'agent' | 'command' | undefined when no task_started was seen (a
        // truncated/resumed stream) — the renderer must stay neutral then.
        taskKind: resolveTaskKind(started?.taskType, started?.subagentType),
        subagentType: started?.subagentType,
        taskDescription: started?.description,
        ...extra,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Assistant events
  // ---------------------------------------------------------------------------

  private projectAssistantEvent(event: AssistantEvent): UnifiedMessage | null {
    const segments: MessageSegment[] = [];
    const content = event.message.content;

    // Step 1: collect tool_use blocks into allToolCalls so we can reference them.
    for (const block of content) {
      if (block.type === 'tool_use') {
        const isSubAgent = isAgentDispatchToolName(block.name);
        const toolCall: ToolCall = {
          id: block.id,
          name: block.name,
          input: block.input,
          status: this.toolResults.has(block.id) ? 'success' : 'pending',
          result: this.toolResults.get(block.id),
          isSubAgent,
          subAgentType: isSubAgent && block.input && typeof block.input === 'object' && 'subagent_type' in block.input
            ? String(block.input.subagent_type)
            : undefined,
          parentToolId: this.parentToolMap.get(block.id),
          childToolCalls: [],
        };
        this.allToolCalls.set(block.id, toolCall);
      }
    }

    // Handle parent_tool_use_id — sub-agent assistant messages that are nested
    // under a parent tool. Record their tool_use blocks as children.
    if (event.parent_tool_use_id) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          this.parentToolMap.set(block.id, event.parent_tool_use_id);
          // Update the toolCall we just created to reflect parentToolId.
          const existing = this.allToolCalls.get(block.id);
          if (existing) {
            existing.parentToolId = event.parent_tool_use_id;
          }
        }
      }
    }

    // Build parent-child relationships for the tool calls we just added.
    for (const block of content) {
      if (block.type === 'tool_use') {
        const toolCall = this.allToolCalls.get(block.id);
        if (toolCall?.parentToolId) {
          const parentTool = this.allToolCalls.get(toolCall.parentToolId);
          if (parentTool?.childToolCalls && !parentTool.childToolCalls.some(c => c.id === toolCall.id)) {
            parentTool.childToolCalls.push(toolCall);
          }
        }
      }
    }

    // Step 2: build segments from content blocks.
    //
    // A parented assistant event is a SUB-AGENT's own turn, forwarded by the SDK
    // nested under the dispatching tool_use. Its narration ("Let me check…",
    // "I have completed a thorough review…") is internal to the sub-agent, never
    // a turn in THIS chat — emitting it produced top-level assistant bubbles from
    // the sub-agent in the parent transcript (DB-confirmed: 587 parented
    // assistant/text events in July alone). Sub-agent `tool_use` blocks are
    // already suppressed here and re-attached to the parent's `childToolCalls`
    // below; `text`/`thinking` simply never got the same guard. The user-event
    // side has carried the mirror image of this guard since 2026-06-22 (Step 3 of
    // projectUserEvent).
    //
    // The sub-agent's tool calls still render nested. Its FINAL REPORT does NOT
    // come from the dispatching tool's `tool_result` — SDK >=0.3.201 backgrounds
    // Agent-tool dispatches, so that result is only the spawn ack ("Async agent
    // launched successfully…") and nothing patches it when the task settles. The
    // report arrives separately as a `system`/`task_notification` event, which
    // projectSystemEvent renders as a system message.
    const isSubAgentTurn = Boolean(event.parent_tool_use_id);
    for (const block of content) {
      if (block.type === 'text' && !isSubAgentTurn && block.text.trim()) {
        segments.push({ type: 'text', content: block.text.trim() });
      } else if (block.type === 'thinking' && !isSubAgentTurn) {
        const thinkingContent = block.thinking.trim();
        if (thinkingContent) {
          segments.push({ type: 'thinking', content: thinkingContent });
        }
      } else if (block.type === 'tool_use') {
        const toolCall = this.allToolCalls.get(block.id);
        // Only add top-level tools (those without parents).
        if (toolCall && !toolCall.parentToolId) {
          segments.push({ type: 'tool_call', tool: toolCall });
        }
      }
    }

    if (segments.length === 0) return null;

    // The SDK's structured cause (SDKAssistantMessageError, e.g.
    // 'authentication_failed') rides on a synthetic error message as a bare
    // string. Surface it on metadata so a consumer can act on the CODE (the
    // chat's sign-in card) instead of pattern-matching the prose.
    const assistantError = typeof event.error === 'string' ? event.error : undefined;

    // Detect synthetic error messages (model === '<synthetic>'). A structured
    // error code is authoritative; the text sniff covers CLIs that omit it.
    const isSyntheticError = event.message.model === '<synthetic>' && (
      assistantError !== undefined ||
      segments.some(seg => seg.type === 'text' && (
        seg.content.includes('Prompt is too long') ||
        seg.content.includes('API Error') ||
        seg.content.includes('error')
      ))
    );

    const usage = event.message.usage;
    const tokens = usage
      ? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))
      : undefined;

    // Coalesce partial-streamed blocks of the same logical message (see
    // `emittedAssistantMessages`). On a repeat `message.id`, append the new
    // segments to the message we already emitted and return null so callers
    // (the reconstruction helpers) don't push a duplicate-keyed entry.
    //
    // CONTRACT: both consumers push the returned object via `{ ...projected }`,
    // a shallow copy that preserves the `segments` array + `metadata` object
    // references — so mutating those in place here is visible in the pushed
    // copy. Do NOT reassign `existing.segments`/`existing.metadata`; mutate them.
    const messageId = event.message.id;
    if (messageId) {
      const existing = this.emittedAssistantMessages.get(messageId);
      if (existing) {
        existing.segments.push(...segments);
        if (tokens && tokens > 0 && existing.metadata) {
          existing.metadata.tokens = tokens;
        }
        return null;
      }
    }

    const message: UnifiedMessage = {
      id: messageId || `assistant_msg_${++this.messageIdCounter}`,
      role: isSyntheticError ? 'system' : 'assistant',
      timestamp: new Date().toISOString(),
      segments,
      metadata: {
        agent: 'claude',
        model: event.message.model,
        tokens: tokens && tokens > 0 ? tokens : undefined,
        systemSubtype: isSyntheticError ? 'error' : undefined,
        ...(assistantError !== undefined ? { assistantError } : {}),
      }
    };

    if (messageId) {
      this.emittedAssistantMessages.set(messageId, message);
    }

    return message;
  }

  // ---------------------------------------------------------------------------
  // User events
  // ---------------------------------------------------------------------------

  private projectUserEvent(event: UserEvent): UnifiedMessage | null {
    const content = event.message.content;

    // Step 1: collect tool_result blocks for future tool-call correlation.
    for (const block of content) {
      if (block.type === 'tool_result') {
        const toolResult: ToolResult = {
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
          isError: block.is_error ?? false,
        };
        this.toolResults.set(block.tool_use_id, toolResult);

        // Retroactively update any already-stored ToolCall.
        const existing = this.allToolCalls.get(block.tool_use_id);
        if (existing) {
          existing.result = toolResult;
          existing.status = block.is_error ? 'error' : 'success';
        }
      }
    }

    // Step 2: handle parent_tool_use_id for sub-agent user messages.
    if (event.parent_tool_use_id) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          this.parentToolMap.set(block.tool_use_id, event.parent_tool_use_id);
        }
      }
    }

    // Step 3: render a user-text turn ONLY for a TOP-LEVEL (parentless) user event —
    // the on-demand monitor's injected conversation turns. A user event carrying a
    // `parent_tool_use_id` is a SUB-AGENT's INPUT PROMPT (the Task tool's prompt,
    // echoed by the SDK nested under its tool_use) — internal plumbing, never a chat
    // turn. Rendering those leaked giant agent prompts ("You are implementing
    // TASK-002…", "You are the sprint dependency-analyzer…") into the Chat pane as
    // "You" bubbles (smoke 2026-06-22). The parent guard restores the pre-widening
    // null behavior for agent prompts while still surfacing the monitor's parentless
    // turns. (DB-confirmed: every leaked prompt was parented; only the monitor's
    // injected turn was parentless.)
    if (!event.parent_tool_use_id) {
      const userText = content
        .filter((block): block is TextBlock => block.type === 'text')
        .map(block => block.text.trim())
        .filter(text => text.length > 0)
        .join('\n');

      if (userText.length > 0) {
        return {
          id: `user_msg_${++this.messageIdCounter}`,
          role: 'user',
          timestamp: new Date().toISOString(),
          segments: [{ type: 'text', content: userText }],
          metadata: {},
        };
      }
    }

    // User events carrying only tool_result blocks are internal plumbing —
    // the old transformer returned null for these (they're shown inline in the
    // tool_call segment of the corresponding assistant message).
    // Return null to match the old transformer's behavior.
    return null;
  }

  // ---------------------------------------------------------------------------
  // Result events
  // ---------------------------------------------------------------------------

  private projectResultEvent(event: ResultEvent): UnifiedMessage | null {
    if (event.is_error && event.result) {
      return {
        id: `error_msg_${++this.messageIdCounter}`,
        role: 'system',
        timestamp: new Date().toISOString(),
        segments: [{
          type: 'text',
          content: `Error: ${event.result}`
        }],
        metadata: {
          systemSubtype: 'error',
          duration: event.duration_ms,
          cost: event.total_cost_usd,
        }
      };
    }

    return null;
  }
}
