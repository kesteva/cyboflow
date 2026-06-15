/**
 * WorkflowScriptWatcher — filesystem-based dynamic-workflow LAUNCH detection.
 *
 * Why this exists: the {@link DynamicWorkflowDetector} parses the launch from the
 * Workflow tool's `tool_result` in the conversation stream, which reaches the
 * tracker via the EventRouter. On the INTERACTIVE substrate those typed events
 * come from {@link TranscriptTailSource}, which discovers a top-level
 * `~/.claude/projects/<key>/<uuid>.jsonl` transcript. claude 2.1.177 changed that
 * layout — the session `<uuid>` is now a DIRECTORY (holding `workflows/` +
 * `subagents/`), with no discoverable top-level conversation `.jsonl` — so the
 * interactive EventRouter receives nothing and the stream-based detector never
 * fires. (See the "interactive transcript discovery" note: the broader structured
 * pipeline is affected too; this file fixes only launch detection.)
 *
 * The workflow ARTIFACTS, however, are still written to disk predictably:
 *   <key>/<uuid>/workflows/scripts/<name>-wf_<id>.js   (the persisted script)
 *   <key>/<uuid>/subagents/workflows/<wf_id>/journal.jsonl
 *   <key>/<uuid>/workflows/<wf_id>.json                (completion record)
 *
 * So we poll the session's project key dir for a new `*-wf_*.js` script and
 * synthesize the launch (wfRunId + scriptPath + transcriptDir) — substrate- and
 * banner-format-independent. The tracker dedupes by wfRunId, so a redundant
 * stream detection (SDK substrate, where the EventRouter still works) is harmless.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LoggerLike } from '../types';

/** A detected workflow launch, derived from the on-disk script path. */
export interface WorkflowScriptLaunch {
  /** The CLI's `wf_*` run id, parsed from the script filename. */
  wfRunId: string;
  /** Absolute path to the persisted `<name>-wf_<id>.js` script. */
  scriptPath: string;
  /** Directory holding the run's `journal.jsonl` (`<uuid>/subagents/workflows/<wf_id>`). */
  transcriptDir: string;
}

/** Poll cadence (ms) — mirrors {@link JournalTailer}'s default. */
const POLL_INTERVAL_MS = 1000;

/** `<name>-wf_<id>.js` → captures `wf_<id>`. */
const SCRIPT_RE = /-(wf_[A-Za-z0-9-]+)\.js$/;

export class WorkflowScriptWatcher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** wfRunIds already reported — onLaunch fires at most once per workflow. */
  private readonly seen = new Set<string>();

  constructor(
    /** `~/.claude/projects/<encodeCwd(worktreePath)>` — the session's project key dir. */
    private readonly keyDir: string,
    private readonly onLaunch: (info: WorkflowScriptLaunch) => void,
    private readonly logger?: Pick<LoggerLike, 'warn'>,
  ) {}

  /** Begin polling. An immediate scan catches a script already on disk. */
  start(): void {
    this.scan();
    this.timer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Scan every `<uuid>/workflows/scripts` dir under the key dir for new
   * `*-wf_*.js` scripts. Fail-soft: a missing key dir (claude has not created the
   * session dir yet) or scripts dir is simply skipped until a later tick.
   */
  private scan(): void {
    if (this.stopped) return;
    let sessionDirs: fs.Dirent[];
    try {
      sessionDirs = fs.readdirSync(this.keyDir, { withFileTypes: true });
    } catch {
      return; // key dir not created yet
    }

    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const sessionUuidPath = path.join(this.keyDir, entry.name);
      const scriptsDir = path.join(sessionUuidPath, 'workflows', 'scripts');
      let files: string[];
      try {
        files = fs.readdirSync(scriptsDir);
      } catch {
        continue; // no workflows launched under this session dir (yet)
      }
      for (const file of files) {
        const match = file.match(SCRIPT_RE);
        if (match === null) continue;
        const wfRunId = match[1];
        if (this.seen.has(wfRunId)) continue;
        this.seen.add(wfRunId);
        try {
          this.onLaunch({
            wfRunId,
            scriptPath: path.join(scriptsDir, file),
            transcriptDir: path.join(sessionUuidPath, 'subagents', 'workflows', wfRunId),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger?.warn(`[workflowScriptWatcher] onLaunch failed for ${wfRunId}: ${message}`);
        }
      }
    }
  }
}
