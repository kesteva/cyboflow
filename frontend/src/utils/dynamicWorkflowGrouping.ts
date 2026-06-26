/**
 * dynamicWorkflowGrouping — best-effort bucketing of a dynamic workflow's live
 * agents into its declared phase plan.
 *
 * The agent-runtime journal cyboflow tails carries NO phase attribution (only
 * {type, key, agentId} lifecycle lines), so the only on-disk thread from an
 * agent back to a stage is the agent's own prompt excerpt. This helper matches
 * each agent to a phase by looking for the phase TITLE as a whole word in that
 * excerpt (the canonical workflow pattern labels/prompts agents after their
 * stage — "review:…", "Adversarially verify: …", "synthesize from…").
 *
 * Bucketing is DELIBERATELY all-or-nothing: it returns `phased` only when EVERY
 * agent maps to EXACTLY one phase. If any agent is unmatched, ambiguous (matches
 * ≥2 phases), or has no excerpt yet, the whole workflow falls back to `flat` — a
 * partially-bucketed list would imply a phase attribution we cannot honestly
 * make. A phase with zero matched agents is fine (a stage not yet reached).
 */
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowPhase,
} from '../../../shared/types/dynamicWorkflows';

/** Derived live status of a phase bucket. */
export type PhaseBucketStatus = 'done' | 'running' | 'pending';

/** One phase with the agents attributed to it (stable first-seen order). */
export interface PhaseBucket {
  phaseIndex: number;
  title: string;
  detail?: string;
  agents: DynamicWorkflowAgent[];
  status: PhaseBucketStatus;
}

/** Grouping outcome: confidently phased, or fall back to a flat agent list. */
export type AgentGrouping =
  | { mode: 'phased'; buckets: PhaseBucket[] }
  | { mode: 'flat' };

/** Escape a phase title for use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word, case-insensitive matcher for a phase title, or null when the
 * title is empty / whitespace (which makes the whole workflow unbucketable).
 */
function phaseTitleMatcher(title: string): RegExp | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i');
}

/** Derive a bucket's status from its agents (empty bucket = not yet reached). */
function deriveStatus(agents: readonly DynamicWorkflowAgent[]): PhaseBucketStatus {
  if (agents.length === 0) return 'pending';
  if (agents.some((a) => a.status === 'running')) return 'running';
  return 'done';
}

/**
 * Attribute `agents` to `phases`. Returns `{mode:'flat'}` unless every agent
 * maps to exactly one phase (see module doc for the all-or-nothing rationale).
 */
export function groupAgentsByPhase(
  agents: readonly DynamicWorkflowAgent[],
  phases: readonly DynamicWorkflowPhase[],
): AgentGrouping {
  // Need at least two named phases and at least one agent to bother grouping.
  if (phases.length < 2 || agents.length === 0) return { mode: 'flat' };

  const matchers = phases.map((p) => phaseTitleMatcher(p.title));
  if (matchers.some((m) => m === null)) return { mode: 'flat' };

  // Assign each agent to exactly one phase, or bail to flat.
  const assignment = new Array<number>(agents.length);
  for (let i = 0; i < agents.length; i++) {
    const excerpt = agents[i].promptExcerpt;
    if (excerpt === undefined || excerpt.length === 0) return { mode: 'flat' };
    let matchedPhase = -1;
    for (let p = 0; p < matchers.length; p++) {
      if ((matchers[p] as RegExp).test(excerpt)) {
        if (matchedPhase !== -1) return { mode: 'flat' }; // ambiguous → flat
        matchedPhase = p;
      }
    }
    if (matchedPhase === -1) return { mode: 'flat' }; // unrecognized → flat
    assignment[i] = matchedPhase;
  }

  const grouped: DynamicWorkflowAgent[][] = phases.map(() => []);
  agents.forEach((agent, i) => grouped[assignment[i]].push(agent));

  const buckets: PhaseBucket[] = phases.map((phase, idx) => ({
    phaseIndex: idx,
    title: phase.title,
    detail: phase.detail,
    agents: grouped[idx],
    status: deriveStatus(grouped[idx]),
  }));

  return { mode: 'phased', buckets };
}
