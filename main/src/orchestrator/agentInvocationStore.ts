/**
 * Provider-neutral persistence for concrete workflow agent turns.
 *
 * Invocation rows are append-only. The sole mutation is a one-time capture of
 * the provider-owned external session id after startup. The DatabaseLike
 * dependency keeps this module independent of Electron and better-sqlite3.
 */
import { randomUUID } from 'node:crypto';
import type { AgentProvider, WorkflowAgentRuntime } from '../../../shared/types/agentRuntime';
import type { DatabaseLike } from './types';

export interface CreateAgentInvocationInput {
  runId: string;
  stepId?: string | null;
  provider: AgentProvider;
  runtime: WorkflowAgentRuntime;
  model?: string | null;
  /** Optional stable id for callers that already own invocation identity. */
  agentInvocationId?: string;
}

export interface AgentResumeTarget {
  provider: AgentProvider;
  runtime: WorkflowAgentRuntime;
  externalSessionId: string;
}

interface ResumeTargetRow {
  provider: AgentProvider;
  runtime: WorkflowAgentRuntime;
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
           (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime, model)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agentInvocationId,
        input.runId,
        input.stepId ?? null,
        input.provider,
        input.runtime,
        input.model ?? null,
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
