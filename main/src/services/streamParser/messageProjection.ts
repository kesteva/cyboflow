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

import type { ClaudeStreamEvent, SystemInitEvent, SystemCompactBoundaryEvent, AssistantEvent, UserEvent, ResultEvent } from '../../../../shared/types/claudeStream';
import type { UnifiedMessage, MessageSegment, ToolCall, ToolResult } from '../../../../shared/types/unifiedMessage';
import type { ILogger } from './types';

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
          const sysEvent = event as SystemInitEvent | SystemCompactBoundaryEvent;
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

  private projectSystemEvent(event: SystemInitEvent | SystemCompactBoundaryEvent): UnifiedMessage | null {
    const subtype = event.subtype;

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
          compact_trigger: compact.compact_metadata.trigger,
          pre_tokens: compact.compact_metadata.pre_tokens,
        }
      };
    }

    return null;
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
        const isSubAgent = block.name === 'Task';
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
    for (const block of content) {
      if (block.type === 'text' && block.text.trim()) {
        segments.push({ type: 'text', content: block.text.trim() });
      } else if (block.type === 'thinking') {
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

    // Detect synthetic error messages (model === '<synthetic>').
    const isSyntheticError = event.message.model === '<synthetic>' &&
      segments.some(seg => seg.type === 'text' && (
        seg.content.includes('Prompt is too long') ||
        seg.content.includes('API Error') ||
        seg.content.includes('error')
      ));

    const usage = event.message.usage;
    const tokens = usage
      ? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0))
      : undefined;

    return {
      id: event.message.id || `assistant_msg_${++this.messageIdCounter}`,
      role: isSyntheticError ? 'system' : 'assistant',
      timestamp: new Date().toISOString(),
      segments,
      metadata: {
        agent: 'claude',
        model: event.message.model,
        tokens: tokens && tokens > 0 ? tokens : undefined,
        systemSubtype: isSyntheticError ? 'error' : undefined,
      }
    };
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
