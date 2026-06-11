/**
 * DynamicWorkflowDetector — watches a run's typed ClaudeStreamEvent stream for
 * Claude Code dynamic-workflow signals:
 *
 *   (a) `assistant` events: a `tool_use` block named 'Workflow' marks its block
 *       id as pending — the launch confirmation arrives in the matching
 *       tool_result.
 *   (b) `user` events: a `tool_result` whose tool_use_id is pending and whose
 *       flattened text contains the launch banner yields the launch info
 *       (taskId / wfRunId / transcriptDir / scriptPath) via onLaunch.
 *   (c) `user` events (all block text) AND the catch-all UnknownStreamEvent:
 *       in-stream `<task-notification>` blocks yield onNotification — the
 *       low-latency completion accelerator. The tracker filters to known
 *       taskIds, so every match is forwarded.
 *
 * Everything is fail-soft: handleEvent never throws (a malformed event logs a
 * WARN and is dropped).
 */
import * as path from 'node:path';
import type { AssistantEvent, ClaudeStreamEvent, ToolResultBlock, UserEvent } from '../../../../shared/types/claudeStream';
import type { LoggerLike } from '../types';

/** The fixed banner the Workflow tool prints in its launch tool_result. */
const LAUNCH_BANNER = 'Workflow launched in background';

/** Parsed launch info handed to the tracker. */
export interface DynamicWorkflowLaunchInfo {
  taskId: string;
  wfRunId: string;
  transcriptDir: string;
  scriptPath: string;
}

/** One in-stream `<task-notification>` occurrence. */
export interface DynamicWorkflowNotification {
  taskId: string;
  status: string;
}

export interface DynamicWorkflowDetectorOptions {
  onLaunch: (info: DynamicWorkflowLaunchInfo) => void;
  onNotification: (info: DynamicWorkflowNotification) => void;
  logger?: Pick<LoggerLike, 'warn'>;
}

export class DynamicWorkflowDetector {
  /** tool_use block ids of Workflow launches awaiting their tool_result. */
  private readonly pendingToolUseIds = new Set<string>();

  constructor(private readonly opts: DynamicWorkflowDetectorOptions) {}

  /** Feed one typed stream event through the detector. Never throws. */
  handleEvent(event: ClaudeStreamEvent): void {
    try {
      // The catch-all variant discriminates on `kind`, not `type` — handle it
      // before the type switch (see claudeStream.ts assertNever notes). A bare
      // `in` check (not a compound condition) so TS narrows the else branch too.
      if ('kind' in event) {
        // event is UnknownStreamEvent (kind === '__unknown__')
        this.scanNotifications(JSON.stringify(event.raw));
        return;
      }
      if (event.type === 'assistant') {
        this.handleAssistant(event);
      } else if (event.type === 'user') {
        this.handleUser(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[dynamicWorkflowDetector] event handling failed: ${message}`);
    }
  }

  /** (a) Remember every Workflow tool_use block id as pending. */
  private handleAssistant(event: AssistantEvent): void {
    for (const block of event.message.content) {
      if (block.type === 'tool_use' && block.name === 'Workflow') {
        this.pendingToolUseIds.add(block.id);
      }
    }
  }

  /** (b) + (c) Launch parse on pending tool_results; notification scan on all block text. */
  private handleUser(event: UserEvent): void {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      const text = flattenToolResultContent(block.content);
      this.scanNotifications(text);

      if (!this.pendingToolUseIds.has(block.tool_use_id)) continue;
      // A tool_use gets exactly one tool_result — clear the pending id on
      // receipt so a failed launch (error result) cannot leak set entries.
      this.pendingToolUseIds.delete(block.tool_use_id);

      if (!text.includes(LAUNCH_BANNER)) continue;
      const launch = parseLaunchText(text);
      if (launch === null) {
        this.opts.logger?.warn(
          `[dynamicWorkflowDetector] launch banner seen but fields unparseable for tool_use_id=${block.tool_use_id}`,
        );
        continue;
      }
      this.opts.onLaunch(launch);
    }
  }

  /** (c) Extract every `<task-notification>` block's task-id + status. */
  private scanNotifications(text: string): void {
    if (!text.includes('<task-notification>')) return;
    const blocks = text.split('<task-notification>').slice(1);
    for (const blockText of blocks) {
      const scoped = blockText.split('</task-notification>')[0];
      const taskId = scoped.match(/<task-id>(\S+?)<\/task-id>/)?.[1];
      const status = scoped.match(/<status>(\w+)<\/status>/)?.[1];
      if (taskId !== undefined && status !== undefined) {
        this.opts.onNotification({ taskId, status });
      }
    }
  }
}

/**
 * Flatten a ToolResultBlock's content to plain text — it is sometimes a plain
 * string and sometimes an array of `{ type, text }` objects (claudeStream.ts).
 * Array parts join with '\n' so the "rest of that line" regexes stay scoped.
 */
function flattenToolResultContent(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

/**
 * Regex out the launch fields from the tool_result text. When the explicit
 * `Run ID:` line is absent, the wfRunId is derived from the transcriptDir
 * basename (it is `.../subagents/workflows/wf_<id>`). Returns null when any
 * required field is missing.
 */
function parseLaunchText(text: string): DynamicWorkflowLaunchInfo | null {
  const taskId = text.match(/Task ID:\s*(\S+)/)?.[1];
  const transcriptDir = text.match(/Transcript dir:[ \t]*([^\n]+)/)?.[1]?.trim();
  const scriptPath = text.match(/Script file:[ \t]*([^\n]+)/)?.[1]?.trim();

  let wfRunId = text.match(/Run ID:\s*(wf_[A-Za-z0-9-]+)/)?.[1];
  if (wfRunId === undefined && transcriptDir !== undefined && transcriptDir !== '') {
    const base = path.basename(transcriptDir);
    if (/^wf_[A-Za-z0-9-]+$/.test(base)) wfRunId = base;
  }

  if (
    taskId === undefined ||
    transcriptDir === undefined || transcriptDir === '' ||
    scriptPath === undefined || scriptPath === '' ||
    wfRunId === undefined
  ) {
    return null;
  }
  return { taskId, wfRunId, transcriptDir, scriptPath };
}
