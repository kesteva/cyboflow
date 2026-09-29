/**
 * Provider-neutral persistence for concrete workflow agent turns.
 *
 * Invocation rows are append-only. The sole mutation is a one-time capture of
 * the provider-owned external session id after startup. The DatabaseLike
 * dependency keeps this module independent of Electron and better-sqlite3.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentProvider,
  WorkflowRunStorableRuntime,
} from '../../../shared/types/agentRuntime';
import type { DatabaseLike } from './types';

export interface CreateAgentInvocationInput {
  runId: string;
  stepId?: string | null;
  provider: AgentProvider;
  runtime: WorkflowRunStorableRuntime;
  model?: string | null;
  /** Optional stable id for callers that already own invocation identity. */
  agentInvocationId?: string;
  /**
   * Owning chat panel, for turns driven per-panel rather than per-run. A quick
   * session's chat_run_id is SESSION-scoped (every chat panel shares it), so
   * without this a second chat panel's resume lookup returns the FIRST panel's
   * provider thread and the two conversations merge. Null/absent for workflow
   * runs and every pre-087 row — the run-scoped lookup ignores it.
   */
  panelId?: string | null;
}

export interface AgentResumeTarget {
  provider: AgentProvider;
  runtime: WorkflowRunStorableRuntime;
  externalSessionId: string;
}

interface ResumeTargetRow {
  provider: AgentProvider;
  runtime: WorkflowRunStorableRuntime;
  externalSessionId: string | null;
}

export type AgentInvocationIdFactory = () => string;

export class AgentInvocationStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly createId: AgentInvocationIdFactory = randomUUID,
  ) {}

  /** Append one invocation and return the identity used for later capture. */
  createInvocation(input: CreateAgentInvocationInput): string {
    const agentInvocationId = input.agentInvocationId ?? this.createId();
    if (agentInvocationId.trim() === '') {
      throw new Error('agentInvocationId must not be empty');
    }

    this.db
      .prepare(
        `INSERT INTO agent_invocations
           (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime, model, panel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentInvocationId,
        input.runId,
        input.stepId ?? null,
        input.provider,
        input.runtime,
        input.model ?? null,
        input.panelId ?? null,
      );
    return agentInvocationId;
  }

  /**
   * Capture a provider-owned session/thread id exactly once. Both run and
   * invocation identity participate in the guard so one live turn cannot stamp
   * another run's row.
   */
  captureExternalSessionId(
    runId: string,
    agentInvocationId: string,
    externalSessionId: string,
  ): boolean {
    if (externalSessionId.trim() === '') {
      throw new Error('externalSessionId must not be empty');
    }

    const result = this.db
      .prepare(
        `UPDATE agent_invocations
            SET external_session_id = ?
          WHERE run_id = ?
            AND agent_invocation_id = ?
            AND external_session_id IS NULL`,
      )
      .run(externalSessionId, runId, agentInvocationId);
    return result.changes === 1;
  }

  /**
   * Link a Codex turn to the invocation that ran it (migration 146), written
   * when `turn/start` returns. Stored notifications carry (thread, turn) but no
   * invocation id; this row maps them back. Idempotent.
   */
  recordCodexTurn(input: {
    agentInvocationId: string;
    runId: string;
    threadId: string;
    codexTurnId: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO codex_invocation_turns
           (agent_invocation_id, run_id, thread_id, codex_turn_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.agentInvocationId, input.runId, input.threadId, input.codexTurnId);
  }

  /**
   * Resolve the newest captured top-level invocation FOR ONE CHAT PANEL.
   *
   * A quick session's chat_run_id is SESSION-scoped: every chat panel resolves
   * the same run id, so `getLatestTopLevelResumeTarget(chat_run_id)` hands a
   * second chat panel the FIRST panel's provider thread and the two panels
   * replay one conversation. This filters to rows this panel actually wrote.
   *
   * Returns null when the panel has no captured invocation yet — a NEW panel
   * must start a FRESH provider thread, never inherit a sibling's. It also
   * deliberately does NOT fall back to the run-level lookup or to the legacy
   * workflow_runs.claude_session_id: both are session-scoped and inheriting them
   * is the exact bug this exists to prevent. Pre-087 rows carry panel_id NULL,
   * so the panel that owns them is identified by the caller (see the ownership
   * note at the codex-sdk turn seam), not by this query.
   */
  getLatestPanelResumeTarget(runId: string, panelId: string): AgentResumeTarget | null {
    let invocation: ResumeTargetRow | undefined;
    try {
      invocation = this.db
        .prepare(
          `SELECT agent_provider AS provider,
                  agent_runtime AS runtime,
                  external_session_id AS externalSessionId
             FROM agent_invocations
            WHERE run_id = ?
              AND panel_id = ?
              AND step_id IS NULL
              AND external_session_id IS NOT NULL
              AND trim(external_session_id) != ''
            ORDER BY id DESC
            LIMIT 1`,
        )
        .get(runId, panelId) as ResumeTargetRow | undefined;
    } catch (error) {
      // A pre-087 database (no panel_id column) or a pre-065 one (no table) has
      // nothing panel-scoped to return — fail soft to "no target", i.e. a fresh
      // thread, which is the safe direction.
      if (
        !(error instanceof Error) ||
        !/no such (table:\s*agent_invocations|column:\s*panel_id)/i.test(error.message)
      ) {
        throw error;
      }
      return null;
    }

    return invocation ? this.toResumeTarget(invocation) : null;
  }

  /**
   * Resolve the newest captured top-level invocation. Step invocations never
   * become a run-level resume target, and incomplete startup rows cannot hide
   * an older invocation whose provider session was captured successfully.
   *
   * The legacy workflow_runs.claude_session_id is considered only when no
   * top-level invocation exists, and only for a coherent Claude provider/runtime
   * pair. This also supports a pre-065 database during a rolling boot.
   */
  getLatestTopLevelResumeTarget(runId: string): AgentResumeTarget | null {
    let invocation: ResumeTargetRow | undefined;
    try {
      invocation = this.db
        .prepare(
          `SELECT agent_provider AS provider,
                  agent_runtime AS runtime,
                  external_session_id AS externalSessionId
             FROM agent_invocations
            WHERE run_id = ?
              AND step_id IS NULL
              AND external_session_id IS NOT NULL
              AND trim(external_session_id) != ''
            ORDER BY id DESC
            LIMIT 1`,
        )
        .get(runId) as ResumeTargetRow | undefined;
    } catch (error) {
      if (!(error instanceof Error) || !/no such table:\s*agent_invocations/i.test(error.message)) {
        throw error;
      }
    }

    if (invocation) {
      return this.toResumeTarget(invocation);
    }

    let legacy: ResumeTargetRow | undefined;
    try {
      legacy = this.db
        .prepare(
          `SELECT agent_provider AS provider,
                  agent_runtime AS runtime,
                  claude_session_id AS externalSessionId
             FROM workflow_runs
            WHERE id = ?`,
        )
        .get(runId) as ResumeTargetRow | undefined;
    } catch (error) {
      if (!(error instanceof Error) || !/no such column:\s*agent_(provider|runtime)/i.test(error.message)) {
        throw error;
      }
      const preProviderRow = this.db
        .prepare('SELECT claude_session_id AS externalSessionId FROM workflow_runs WHERE id = ?')
        .get(runId) as { externalSessionId: string | null } | undefined;
      legacy = preProviderRow
        ? { provider: 'claude', runtime: 'claude-sdk', ...preProviderRow }
        : undefined;
    }
    if (
      legacy?.provider !== 'claude' ||
      (legacy.runtime !== 'claude-sdk' && legacy.runtime !== 'claude-interactive')
    ) {
      return null;
    }
    return this.toResumeTarget(legacy);
  }

  private toResumeTarget(row: ResumeTargetRow): AgentResumeTarget | null {
    if (row.externalSessionId === null || row.externalSessionId.trim() === '') {
      return null;
    }
    return {
      provider: row.provider,
      runtime: row.runtime,
      externalSessionId: row.externalSessionId,
    };
  }
}
