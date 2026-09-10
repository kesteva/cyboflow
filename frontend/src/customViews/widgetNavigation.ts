/**
 * Routing for a widget action whose result is NAVIGATION rather than a proposal
 * (docs/proposals/CUSTOM-VIEWS.md §4.4 step 3, §5.3).
 *
 * `executeAction` returns `{ ok: true, navigation }` for the two kinds that
 * have no server side effect: `navigate` (the widget's own target vocabulary —
 * a page in the shell) and `open-session` (which the shared proposal executor
 * already treats as renderer-only). The navigation object is server-RESOLVED
 * (templates substituted from the matched row), but it arrives here as
 * `JsonValue`, so this module's whole job is to narrow it before dispatching:
 * an unrecognised shape navigates NOWHERE and says so, rather than throwing
 * inside a click handler.
 *
 * Session/run targets go through `agentRail/proposalNavigation.ts` — the same
 * helper the assistant's own open-session proposal uses, including its
 * activate-the-project-first step. Page targets go through `navigationStore`'s
 * existing openers; nothing new is invented here.
 */
import { navigateToProposalTarget } from '../components/agentRail/proposalNavigation';
import { useNavigationStore } from '../stores/navigationStore';
import type { AgentNavigationTarget } from '../../../shared/types/agentThread';

/** The page targets a widget's `navigate` action may name (§3.1's `WidgetAction`). */
const PAGE_TARGETS = ['backlog', 'insights', 'workflows', 'project-overview'] as const;
type PageTarget = (typeof PAGE_TARGETS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dispatch a resolved navigation payload. Returns `false` when the shape is not
 * one this build routes — the caller reports that inline instead of pretending
 * something happened.
 */
export function navigateFromWidget(navigation: unknown): boolean {
  if (!isRecord(navigation)) return false;
  const target = navigation.target;
  if (typeof target !== 'string') return false;

  if (target === 'run' && typeof navigation.runId === 'string') {
    navigateToProposalTarget(asAgentTarget(navigation));
    return true;
  }
  if (target === 'quick-session' && typeof navigation.sessionId === 'string') {
    navigateToProposalTarget(asAgentTarget(navigation));
    return true;
  }
  if ((PAGE_TARGETS as readonly string[]).includes(target)) {
    return openPage(target as PageTarget, navigation.projectId);
  }
  return false;
}

/** Narrow a validated record onto the rail's navigation contract. */
function asAgentTarget(navigation: Record<string, unknown>): AgentNavigationTarget {
  const projectId = typeof navigation.projectId === 'number' ? navigation.projectId : undefined;
  if (navigation.target === 'run') {
    return { target: 'run', runId: String(navigation.runId), ...(projectId !== undefined ? { projectId } : {}) };
  }
  return {
    target: 'quick-session',
    sessionId: String(navigation.sessionId),
    ...(typeof navigation.runId === 'string' ? { runId: navigation.runId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

function openPage(target: PageTarget, projectId: unknown): boolean {
  const nav = useNavigationStore.getState();
  if (typeof projectId === 'number') nav.setActiveProjectId(projectId);
  switch (target) {
    case 'backlog':
      nav.openBacklog();
      return true;
    case 'insights':
      nav.openInsights();
      return true;
    case 'workflows':
      nav.openWorkflows();
      return true;
    case 'project-overview':
      nav.openProjectOverview();
      return true;
    default:
      return false;
  }
}
