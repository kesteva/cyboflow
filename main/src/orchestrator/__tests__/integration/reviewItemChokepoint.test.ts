/**
 * Tier-2 chokepoint integration — review-queue writes through the REAL
 * ReviewItemRouter over a full-migration-chain DB.
 *
 * Scenario 2 (report finding → resolve): cyboflow_report_finding creates a
 * review_items(kind='finding') row via the chokepoint and emits a 'created'
 * ReviewItemChangedEvent; cyboflow_resolve_finding then flips it to resolved,
 * stamps the resolution + resolver, and emits a 'resolved' event. Both post-commit
 * emits are observed by subscribing to the router's per-project channel.
 *
 * report-finding is fire-and-forget (the run is never paused on the inbox): the
 * handler replies ok:true BEFORE the queued create commits, so the test awaits the
 * post-commit 'created' emit rather than assuming the row exists on reply.
 * Everything below the MCP handler is real — no SDK mock at this tier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { McpQueryHandler } from '../../mcpServer/mcpQueryHandler';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import {
  ReviewItemRouter,
  reviewItemChangeEvents,
  reviewItemProjectChannel,
} from '../../reviewItemRouter';
import { RESOLUTION_PREFIX_FIXED } from '../../../../../shared/types/reviews';
import type { ReviewItemChangedEvent } from '../../../../../shared/types/reviews';
import {
  createIntegrationDb,
  seedWorkflowRun,
  makeSocketDouble,
  parseLastWrite,
  type IntegrationDb,
} from './integrationHarness';

interface FindingRow {
  kind: string;
  status: string;
  blocking: number;
  title: string;
  body: string | null;
  severity: string | null;
  source: string | null;
  run_id: string | null;
  resolution: string | null;
  resolved_by: string | null;
}

function findingRow(db: Database.Database, id: string): FindingRow | undefined {
  return db
    .prepare(
      'SELECT kind, status, blocking, title, body, severity, source, run_id, resolution, resolved_by FROM review_items WHERE id = ?',
    )
    .get(id) as FindingRow | undefined;
}

describe('Tier-2 chokepoint — report finding + resolve (ReviewItemRouter)', () => {
  let fixture: IntegrationDb;
  let handler: McpQueryHandler;
  /** Every post-commit emit on project 1's channel, in order. */
  let emitted: ReviewItemChangedEvent[];

  beforeEach(() => {
    fixture = createIntegrationDb();
    ReviewItemRouter.initialize(dbAdapter(fixture.db));
    handler = new McpQueryHandler(dbAdapter(fixture.db));
    emitted = [];
    reviewItemChangeEvents.on(reviewItemProjectChannel(1), (e: ReviewItemChangedEvent) => {
      emitted.push(e);
    });
  });

  afterEach(() => {
    ReviewItemRouter._resetForTesting();
    reviewItemChangeEvents.removeAllListeners();
    fixture.cleanup();
  });

  /** Resolve once the router emits an event whose action matches. */
  function nextEmit(action: string): Promise<ReviewItemChangedEvent> {
    const existing = emitted.find((e) => e.action === action);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const onEvent = (e: ReviewItemChangedEvent): void => {
        if (e.action === action) {
          reviewItemChangeEvents.off(reviewItemProjectChannel(1), onEvent);
          resolve(e);
        }
      };
      reviewItemChangeEvents.on(reviewItemProjectChannel(1), onEvent);
    });
  }

  it('reports a finding (fire-and-forget create) then resolves it — row + emits reflect both writes', async () => {
    const { db } = fixture;
    seedWorkflowRun(db, {
      runId: 'run-find',
      workflowName: 'sprint',
      currentStepId: 'implement',
      stepsSnapshot: { implement: 'implement' },
    });

    // ── report finding ──────────────────────────────────────────────────────
    const reported = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-report-finding',
        requestId: 'rf-1',
        runId: 'run-find',
        title: 'Unbounded loop in parser',
        body: 'The tokenizer never advances on a malformed escape.',
        severity: 'warning',
        blocking: false,
      },
      reported.socket,
    );

    // The run is replied to IMMEDIATELY — the create has not necessarily committed.
    const reportRes = parseLastWrite(reported.writes);
    expect(reportRes.ok).toBe(true);
    expect(reportRes.data).toEqual({ accepted: true, kind: 'finding', blocking: false });

    // Await the post-commit 'created' emit (proves the queued chokepoint write landed).
    const createdEvent = await nextEmit('created');
    const reviewItemId = createdEvent.reviewItemId;
    expect(reviewItemId).toMatch(/^rvw_/);

    // The review_items row is a pending, non-blocking finding attributed to the agent.
    const row = findingRow(db, reviewItemId);
    expect(row).toBeDefined();
    expect(row!.kind).toBe('finding');
    expect(row!.status).toBe('pending');
    expect(row!.blocking).toBe(0);
    expect(row!.title).toBe('Unbounded loop in parser');
    expect(row!.body).toBe('The tokenizer never advances on a malformed escape.');
    expect(row!.severity).toBe('warning');
    expect(row!.run_id).toBe('run-find');
    expect(row!.source).toMatch(/^agent:/);
    expect(row!.resolution).toBeNull();

    // ── resolve finding ─────────────────────────────────────────────────────
    const resolved = makeSocketDouble();
    await handler.handleMessage(
      {
        type: 'mcp-resolve-finding',
        requestId: 'rv-1',
        runId: 'run-find',
        reviewItemId,
        resolutionKind: 'fixed',
        note: 'compound',
      },
      resolved.socket,
    );

    // resolve-finding is AWAITED — on reply the row is already committed resolved.
    const resolveRes = parseLastWrite(resolved.writes);
    expect(resolveRes.ok).toBe(true);
    expect(resolveRes.data).toEqual({ resolved: true, review_item_id: reviewItemId });

    const afterResolve = findingRow(db, reviewItemId);
    expect(afterResolve!.status).toBe('resolved');
    expect(afterResolve!.resolution).toBe(`${RESOLUTION_PREFIX_FIXED}compound`);
    expect(afterResolve!.resolved_by).toMatch(/^agent:/);

    // The router emitted BOTH post-commit lifecycle events on the project channel.
    const actionsFor = emitted.filter((e) => e.reviewItemId === reviewItemId).map((e) => e.action);
    expect(actionsFor).toEqual(['created', 'resolved']);
  });
});
