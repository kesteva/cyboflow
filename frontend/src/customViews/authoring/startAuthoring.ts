/**
 * startAuthoring — the "Create a custom widget" / "Edit with assistant"
 * kickoff (docs/proposals/CUSTOM-VIEWS.md §7.1).
 *
 * Ties three stores together for one call: `customViewsStore.openAuthoring`
 * (mints the session + places/marks the slot), `layoutStore` (expands the
 * agent rail when it's collapsed), and `agentThreadStore` (pre-fills the
 * composer with the two-question kickoff and stashes the machine-readable
 * `contextHint` envelope for the NEXT `sendMessage` — the user sends it,
 * nothing goes out silently).
 *
 * Takes the three stores' resolved state (`getState()`-shaped objects, not
 * the hooks themselves) rather than reaching for the hooks directly, so this
 * stays a plain function callers can unit-test against fakes instead of a
 * component that has to be rendered to exercise it.
 */
import type { CustomViewSurface } from '../../../../shared/types/customViews';
import type { OpenAuthoringArgs } from '../../stores/customViewsStore';

/** Human-readable surface names for the kickoff text — keep in sync with the header titles the two landing pages use. */
const SURFACE_LABELS: Record<CustomViewSurface, string> = {
  'review-queue': 'Review Queue',
  'project-overview': 'Project Overview',
};

interface StartAuthoringBase {
  surface: CustomViewSurface;
  /** The active view's name, or `'Default'` — goes verbatim into the contextHint envelope. */
  viewName: string;
  projectId: number | null;
}

export type StartAuthoringArgs =
  | (StartAuthoringBase & { mode: 'create'; at: number })
  | (StartAuthoringBase & { mode: 'edit'; instanceId: string; widgetId: string });

/** The slice of `customViewsStore` this needs. */
export interface StartAuthoringCustomViewsStore {
  openAuthoring: (args: OpenAuthoringArgs) => string;
}

/** The slice of `agentThreadStore` this needs. */
export interface StartAuthoringAgentThreadStore {
  setComposerDraft: (text: string | null) => void;
  setPendingContextHint: (hint: string | null) => void;
}

/** The slice of `layoutStore` this needs. */
export interface StartAuthoringLayoutStore {
  agentRailCollapsed: boolean;
  toggleAgentRail: () => void;
}

/** startAuthoring — see the module header. */
export function startAuthoring(
  customViews: StartAuthoringCustomViewsStore,
  agentThread: StartAuthoringAgentThreadStore,
  layout: StartAuthoringLayoutStore,
  args: StartAuthoringArgs,
): void {
  const sessionId =
    args.mode === 'create'
      ? customViews.openAuthoring({ surface: args.surface, mode: 'create', at: args.at })
      : customViews.openAuthoring({
          surface: args.surface,
          mode: 'edit',
          instanceId: args.instanceId,
          widgetId: args.widgetId,
        });

  if (layout.agentRailCollapsed) layout.toggleAgentRail();

  const surfaceLabel = SURFACE_LABELS[args.surface];
  agentThread.setComposerDraft(
    args.mode === 'create'
      ? `Build me a widget for the ${surfaceLabel} page.\nWhat it should show: \nWhat it should let me do: `
      : `Change this custom widget on the ${surfaceLabel} page.\nWhat it should show instead: \nWhat it should let me do: `,
  );

  const widgetIdLine = args.mode === 'edit' ? ` widgetId=${args.widgetId}` : '';
  agentThread.setPendingContextHint(
    `[custom-widget-session]\n` +
      `sessionId=${sessionId} surface=${args.surface} viewName="${args.viewName}" projectId=${args.projectId ?? 'null'}\n` +
      `mode=${args.mode}${widgetIdLine}`,
  );
}
