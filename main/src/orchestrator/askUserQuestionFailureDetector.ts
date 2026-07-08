/**
 * AskUserQuestionFailureDetector — watches a single flow-run's typed
 * ClaudeStreamEvent stream for an `AskUserQuestion` gate that FAILED at the SDK
 * control-channel layer, so the orchestrator can synthesize a durable review
 * gate instead of letting the run silently false-complete.
 *
 * WHY THIS EXISTS
 * ---------------
 * On the SDK substrate the AskUserQuestion gate is serviced by a `can_use_tool`
 * control round-trip over the query's stdin. That channel intermittently drops
 * under load ("Stream closed"): the CLI reports the tool call back as an error
 * tool_result (`Tool permission request failed: Error: Stream closed`) WITHOUT
 * ever invoking our PreToolUse hook. The agent, seeing the error, degrades to a
 * free-text question and ends its turn. The run then drains to `awaiting_review`
 * and renders as "Workflow complete" — the human decision is stranded and every
 * nudge re-hits the same drop. See streamingPromptInput.ts for the (partial)
 * stdin-keepalive fix; this detector is the durable safety net for when it fails
 * mid-run anyway. Diagnosed 2026-07-07 from a real ship run.
 *
 * DETECTION
 * ---------
 *   (a) `assistant` events: a `tool_use` block named 'AskUserQuestion' records
 *       its block id as pending, keyed to its `questions` input payload.
 *   (b) `user` events: a `tool_result` whose tool_use_id is pending, whose
 *       `is_error` is true, and whose flattened text matches the gate-failure
 *       signature yields `onFailure(questions)` — exactly once per tool call.
 *
 * A pending id that comes back as a SUCCESSFUL tool_result is cleared silently
 * (the gate worked; nothing to recover). Everything is fail-soft: handleEvent
 * never throws (a malformed event logs a WARN and is dropped).
 */
import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ToolResultBlock,
  UserEvent,
} from '../../../shared/types/claudeStream';
import type { QuestionPayload } from '../../../shared/types/questions';
import type { LoggerLike } from './types';

/**
 * Matches the CLI's error tool_result text when the `can_use_tool` control
 * round-trip for a gate fails. The observed string is
 * `Tool permission request failed: Error: Stream closed`; we match either the
 * generic permission-request-failure prefix OR the "stream closed" cause so a
 * minor wording change on either side still trips the recovery path.
 */
const GATE_FAILURE_SIGNATURE = /stream closed|tool permission request failed/i;

export interface AskUserQuestionFailureDetectorOptions {
  /**
   * Fired once when a pending AskUserQuestion tool call comes back as a
   * gate-failure error tool_result. `questions` is the exact payload the agent
   * asked (captured from the tool_use input) so the caller can re-offer it.
   */
  onFailure: (questions: QuestionPayload[]) => void;
  logger?: Pick<LoggerLike, 'warn'>;
}

export class AskUserQuestionFailureDetector {
  /**
   * tool_use block id → the questions payload it asked, for AskUserQuestion
   * calls awaiting their tool_result.
   */
  private readonly pending = new Map<string, QuestionPayload[]>();

  /**
   * Fire onFailure AT MOST ONCE per detector (i.e. per spawn/turn). An agent
   * facing a dropped gate retries AskUserQuestion several times in the SAME turn
   * (6× in the diagnosed run); one recovery gate per turn is enough — it blocks
   * the run, so the next turn (if any) gets a fresh detector.
   */
  private fired = false;

  constructor(private readonly opts: AskUserQuestionFailureDetectorOptions) {}

  /** Feed one typed stream event through the detector. Never throws. */
  handleEvent(event: ClaudeStreamEvent): void {
    try {
      // The catch-all UnknownStreamEvent discriminates on `kind`, not `type`
      // (see claudeStream.ts) — it carries no tool_use/tool_result blocks, so
      // skip it before the type switch.
      if ('kind' in event) return;
      if (event.type === 'assistant') {
        this.handleAssistant(event);
      } else if (event.type === 'user') {
        this.handleUser(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[askUserQuestionFailureDetector] event handling failed: ${message}`);
    }
  }

  /** (a) Remember every AskUserQuestion tool_use block id + its questions. */
  private handleAssistant(event: AssistantEvent): void {
    for (const block of event.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue;
      const questions = extractQuestions(block.input);
      // Even with no parseable questions we track the id so a failure can still
      // synthesize an (option-less) recovery gate rather than false-completing.
      this.pending.set(block.id, questions);
    }
  }

  /** (b) On the matching tool_result: fire onFailure for a gate-failure error. */
  private handleUser(event: UserEvent): void {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      if (!this.pending.has(block.tool_use_id)) continue;

      const questions = this.pending.get(block.tool_use_id) ?? [];
      // A tool_use gets exactly one tool_result — clear on receipt so a
      // success (or a non-matching error) cannot leak a pending entry or
      // double-fire.
      this.pending.delete(block.tool_use_id);

      if (block.is_error !== true) continue; // gate succeeded — nothing to recover.
      const text = flattenToolResultContent(block.content);
      if (!GATE_FAILURE_SIGNATURE.test(text)) continue; // some other tool error.
      if (this.fired) continue; // one recovery gate per turn (see `fired`).

      this.fired = true;
      this.opts.onFailure(questions);
    }
  }
}

/**
 * Narrow the SDK AskUserQuestion tool_use input to QuestionPayload[]. The wire
 * shape is `{ questions: QuestionPayload[] }`; anything malformed yields `[]`
 * (the recovery gate then carries no options — still better than a lost gate).
 */
function extractQuestions(input: Record<string, unknown>): QuestionPayload[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is QuestionPayload =>
      typeof q === 'object' && q !== null && typeof (q as QuestionPayload).question === 'string',
  );
}

/**
 * Flatten a ToolResultBlock's content to plain text — sometimes a plain string,
 * sometimes an array of `{ type, text }` objects (claudeStream.ts). Mirrors the
 * helper in dynamicWorkflowDetector.ts.
 */
function flattenToolResultContent(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}
