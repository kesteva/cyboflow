/**
 * integration.setup.ts — the Tier-3 (mocked-SDK integration) setup file.
 *
 * Loaded AFTER `main/src/test/setup.ts` (which mocks electron / sentry / aptabase)
 * by `vitest.config.integration.ts`. Two jobs:
 *
 *  1. Install a DEFENSIVE module mock of `@anthropic-ai/claude-agent-sdk` whose
 *     `query()` THROWS. Tier-3 drives the SDK through DEPENDENCY INJECTION — the
 *     `headlessRun` harness passes a `fakeSdk` scenario as `options.query` and never
 *     calls the imported `query`. So this mock is a safety net: if a future test path
 *     ever reaches the real `query()` (a forgotten fake), it fails LOUDLY instead of
 *     spawning a live `claude`. `vi.importActual` preserves every other real export,
 *     so type/value imports elsewhere still resolve. (Deviation from the plan, which
 *     assumed the real `ClaudeCodeManager` — whose only seam is a module mock; the
 *     M5-based harness injects instead, so the mock is defensive, not load-bearing.)
 *
 *  2. Reset every process-wide singleton in `afterEach`. Tier-3 runs under
 *     `poolOptions.forks.singleFork` (these singletons force serialization), so a
 *     missed reset would bleed state across scenario files. Enumerated from a
 *     `grep _resetForTesting` over main/src.
 */
import { afterEach, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk',
  );
  return {
    ...actual,
    query: () => {
      throw new Error(
        '[integration] real @anthropic-ai/claude-agent-sdk query() was called — Tier-3 tests ' +
          'must inject a fakeSdk scenario via headlessRun.startRun (options.query), never the real SDK.',
      );
    },
  };
});

import { ApprovalRouter } from '../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../orchestrator/questionRouter';
import { ReviewItemRouter } from '../../orchestrator/reviewItemRouter';
import { TaskChangeRouter } from '../../orchestrator/taskChangeRouter';
import { AgentOverrideRouter } from '../../orchestrator/agentOverrideRouter';
import { ArtifactRouter } from '../../orchestrator/artifactRouter';
import { SprintLaneStore } from '../../orchestrator/sprintLaneStore';
import { StepResultStore } from '../../orchestrator/stepResultStore';
import { HumanStepManager } from '../../orchestrator/humanStepManager';
import { ModelAvailabilityService } from '../../services/modelAvailabilityService';
import { MonitorRegistry } from '../../orchestrator/programmatic/monitor';
import { DynamicWorkflowTracker } from '../../orchestrator/dynamicWorkflows/dynamicWorkflowTracker';

afterEach(() => {
  ApprovalRouter._resetForTesting();
  QuestionRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  TaskChangeRouter._resetForTesting();
  AgentOverrideRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  SprintLaneStore._resetForTesting();
  StepResultStore._resetForTesting();
  HumanStepManager._resetForTesting();
  ModelAvailabilityService._resetForTesting();
  MonitorRegistry._resetForTesting();
  DynamicWorkflowTracker._resetForTesting();
});
