/**
 * The REAL persistent streaming chat session behind `StreamingChatBackend` (Stage
 * 3 supervisor chat). Sole `@anthropic-ai/claude-agent-sdk` importer for the chat
 * path — keeps `supervisorChat.ts` (session, registry, transcript) standalone-
 * typecheckable and fakeable.
 *
 * It drives a long-lived streaming-input `query()`: the prompt is an AsyncIterable
 * we feed (`send` → a user turn; `note` → a shouldQuery:false context message), and
 * the Query's output iterator is pumped for assistant text, fanned out to
 * subscribers. `close()` ends the input stream so the iterator drains and the
 * subprocess exits.
 *
 * ⚠️ NOT live-verifiable headlessly (a real long-lived Claude session). Reached
 * ONLY when the supervisor chat is started for an opted-in programmatic run, so the
 * risk is contained.
 */
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LoggerLike } from '../types';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';
import type { StreamingChatBackend, StreamingChatHandle } from './supervisorChat';

/** Extract plain text from an assistant message's content blocks. */
function assistantText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
      ? String((block as { text?: unknown }).text ?? '')
      : ''))
    .join('');
}

/**
 * A bounded async input queue feeding the SDK streaming prompt. `push` enqueues a
 * message (resolving a waiting `next()` or buffering); `end` terminates the
 * iterable so the SDK query drains.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private pending: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private ended = false;

  push(msg: SDKUserMessage): void {
    if (this.ended) return;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: msg, done: false });
    } else {
      this.buffer.push(msg);
    }
  }

  end(): void {
    this.ended = true;
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift() as SDKUserMessage;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.pending = resolve;
      });
      if (result.done) return;
      yield result.value;
    }
  }
}

function userMessage(text: string, shouldQuery: boolean): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    shouldQuery,
  };
}

export function makeSdkStreamingChatBackend(logger?: LoggerLike): StreamingChatBackend {
  return {
    open({ systemPrompt, cwd, model }): StreamingChatHandle {
      const input = new InputQueue();
      const abortController = new AbortController();
      const subscribers = new Set<(text: string) => void>();

      const q = query({
        prompt: input,
        options: {
          cwd,
          ...(model ? { model } : {}),
          systemPrompt,
          // Read-only inspection only — the supervisor observes + answers; it must
          // NOT edit the worktree (host code owns the workflow).
          allowedTools: ['Read', 'Grep', 'Glob'],
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          abortController,
        },
      });

      // Pump the output iterator for assistant text. Fail-soft: an SDK error ends
      // the pump (the session goes quiet) without throwing into the caller.
      void (async () => {
        try {
          for await (const msg of q) {
            if (msg.type === 'assistant') {
              const text = assistantText(msg.message);
              if (text.length > 0) for (const cb of subscribers) cb(text);
            }
          }
        } catch (err) {
          logger?.warn('[supervisorChatBackend] output pump ended with error', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return {
        send(text: string): void {
          input.push(userMessage(text, true));
        },
        note(text: string): void {
          input.push(userMessage(`(system note) ${text}`, false));
        },
        onAssistantText(cb: (text: string) => void): () => void {
          subscribers.add(cb);
          return () => subscribers.delete(cb);
        },
        async close(): Promise<void> {
          input.end();
          abortController.abort();
          subscribers.clear();
        },
      };
    },
  };
}
