/**
 * TrackerWizardModal — connect-wizard tests.
 *
 * Same harness as IntegrationsSettings.test.tsx (render the real component over
 * a module mock of its dependency), with every `cyboflow.tracker.wizard*` probe
 * stubbed so the six steps can be walked without a provider.
 *
 * The fixture maps a workspace of three groups onto two cyboflow projects — two
 * groups sharing one project, one group on its own — because that is the shape
 * every rev-4 behaviour keys off: the push-target radio, the per-scope state
 * tables, the per-project reconcile previews, and the routing of a link decision
 * to the one mapping whose issue set holds it.
 *
 * Coverage: the Step-0 gate; the Map step (group rows, N:1 push-target radio);
 * per-mapping issue probes; one states probe per distinct scope key; one
 * reconcile probe per target project; the sequential per-mapping connect
 * payloads; and a partial failure that keeps the modal open and retries only
 * the row that failed.
 *
 * Plus ADD-MAPPING MODE (`sourceConnection` set), whose whole point is that no
 * key is asked for or sent a second time: Step 0 is absent rather than
 * pre-answered, every probe names the connection, and `connect` carries
 * `sourceConnectionId`.
 *
 * Its Map step is a mapping EDITOR, so the tests below drive it as one: linked
 * rows on top with an Unlink that only stages, the mappable list underneath
 * holding exactly what no kept sibling covers, unlink-before-connect ordering at
 * submit, and the unlink-only run that jumps straight to Review. The
 * sibling-aware answers ride on the same data — the push target a kept sibling
 * holds is never claimed (and a staged unlink releases it), and scope overlap is
 * computed against the kept siblings in both directions.
 *
 * Plus WORKSPACE-ROW MODE (beads on a fresh connect), where the Map step is a
 * per-PROJECT surface rather than one account's group list: no Step 0 at all,
 * one row per cyboflow project probing its OWN repository, and per-row
 * credentials carried from that probe through Initialize, the folder picker and
 * `connect`. The assertions doing the real work are the ones about WHOSE
 * credentials each call carries — a row answering for another row's repository
 * is the failure this whole shape exists to prevent.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TrackerConnectionSummary,
  TrackerCredentialsInput,
  TrackerFieldOptions,
  TrackerGroupTree,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerSourceSelection,
  TrackerState,
} from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        wizardValidate: { mutate: vi.fn() },
        wizardPickWorkspace: { mutate: vi.fn() },
        wizardInitWorkspace: { mutate: vi.fn() },
        wizardGroups: { mutate: vi.fn() },
        wizardIssues: { mutate: vi.fn() },
        wizardStates: { mutate: vi.fn() },
        wizardFieldOptions: { mutate: vi.fn() },
        reconcilePreview: { mutate: vi.fn() },
        connect: { mutate: vi.fn() },
        disconnect: { mutate: vi.fn() },
        mappings: { query: vi.fn() },
      },
    },
  },
}));

// The Map step's project list comes over IPC, not tRPC — same module-mock pattern.
vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: vi.fn() } },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerWizardModal } from './TrackerWizardModal';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';

const mockValidate = vi.mocked(trpc.cyboflow.tracker.wizardValidate.mutate);
const mockPickWorkspace = vi.mocked(trpc.cyboflow.tracker.wizardPickWorkspace.mutate);
const mockInitWorkspace = vi.mocked(trpc.cyboflow.tracker.wizardInitWorkspace.mutate);
const mockGroups = vi.mocked(trpc.cyboflow.tracker.wizardGroups.mutate);
const mockIssues = vi.mocked(trpc.cyboflow.tracker.wizardIssues.mutate);
const mockStates = vi.mocked(trpc.cyboflow.tracker.wizardStates.mutate);
const mockFieldOptions = vi.mocked(trpc.cyboflow.tracker.wizardFieldOptions.mutate);
const mockReconcile = vi.mocked(trpc.cyboflow.tracker.reconcilePreview.mutate);
const mockConnect = vi.mocked(trpc.cyboflow.tracker.connect.mutate);
const mockDisconnect = vi.mocked(trpc.cyboflow.tracker.disconnect.mutate);
const mockMappings = vi.mocked(trpc.cyboflow.tracker.mappings.query);
const mockProjectsGetAll = vi.mocked(API.projects.getAll);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECTS = [
  {
    id: 7,
    name: 'Cyboflow',
    path: '/dev/cyboflow',
    active: true,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 9,
    name: 'Website',
    path: '/dev/website',
    active: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
];

/**
 * Two Linear projects under the SAME team (so they share a state scope) plus a
 * whole-team group under a second team.
 */
const GROUPS: TrackerGroupTree = {
  sections: [
    {
      label: 'Projects',
      groups: [
        {
          id: 'proj-alpha',
          name: 'Alpha',
          key: 'COR',
          sourceLabel: 'Core · Alpha',
          selection: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
          stateScopeKey: 'core',
        },
        {
          id: 'proj-beta',
          name: 'Beta',
          key: 'COR',
          sourceLabel: 'Core · Beta',
          selection: { containerId: 'core', narrowId: 'beta', narrowKind: 'project' },
          stateScopeKey: 'core',
        },
      ],
    },
    {
      label: 'Whole teams',
      groups: [
        {
          id: 'team-core',
          name: 'Core',
          key: 'COR',
          sourceLabel: 'Core · all open issues',
          selection: { containerId: 'core', narrowId: 'all', narrowKind: 'all' },
          stateScopeKey: 'core',
        },
        {
          id: 'team-plat',
          name: 'Platform',
          key: 'PLT',
          sourceLabel: 'Platform · all open issues',
          selection: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
          stateScopeKey: 'plat',
        },
      ],
    },
  ],
};

/**
 * What every beads repository answers with: one section, one group, and the
 * SAME adapter-side id whatever the repository (`beadsAdapter.listGroups`) —
 * which is exactly why the wizard has to namespace it per project row.
 */
function beadsTree(prefix: string): TrackerGroupTree {
  return {
    sections: [
      {
        label: 'Workspace',
        groups: [
          {
            id: 'workspace',
            name: prefix,
            key: prefix,
            sourceLabel: prefix,
            selection: { containerId: 'workspace', narrowId: 'all', narrowKind: 'all' },
            stateScopeKey: 'workspace',
          },
        ],
      },
    ],
  };
}

/** The two keyless failures the wizard must tell apart, in `bd`'s own wording. */
const NO_WORKSPACE = new Error('[beads] no beads database found — run `bd init` in this repo');
const NO_CLI = new Error(
  '[beads] `bd` was not found on PATH — install beads and re-detect this connection.',
);

function makeIssue(overrides: Partial<TrackerIssue> & Pick<TrackerIssue, 'externalId'>): TrackerIssue {
  return {
    identifier: 'CORE-1',
    title: 'An issue',
    description: null,
    url: 'https://linear.app/x/CORE-1',
    stateId: 'todo',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T09:00:00.000Z',
    archivedAt: null,
    priority: null,
    category: null,
    recoveryClientKey: null,
    ...overrides,
  };
}

const ALPHA_ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-1',
    identifier: 'CORE-138',
    title: 'Token budget alerts',
    stateId: 'todo',
    assignee: { id: 'jk', name: 'Jaya Kesteva', initials: 'JK' },
    estimate: 3,
  }),
];

const BETA_ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-2',
    identifier: 'CORE-118',
    title: 'Diff gutter spacing',
    stateId: 'inprog',
    assignee: { id: 'mr', name: 'Mira Rao', initials: 'MR' },
  }),
];

const PLAT_ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-3',
    identifier: 'PLT-9',
    title: 'Ship the installer',
    stateId: 'todo',
    assignee: { id: 'jk', name: 'Jaya Kesteva', initials: 'JK' },
  }),
];

const ISSUES_BY_CONTAINER: Record<string, Record<string, TrackerIssue[]>> = {
  core: { alpha: ALPHA_ISSUES, beta: BETA_ISSUES },
  plat: { all: PLAT_ISSUES },
};

const CORE_STATES: TrackerState[] = [
  { id: 'triage', name: 'Triage', color: null, group: 'triage' },
  { id: 'backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'inprog', name: 'In Progress', color: null, group: 'started' },
  { id: 'done', name: 'Done', color: null, group: 'completed' },
  { id: 'cancel', name: 'Canceled', color: null, group: 'cancelled' },
];

const PLAT_STATES: TrackerState[] = [
  { id: 'plat-todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'plat-done', name: 'Shipped', color: null, group: 'completed' },
];

/**
 * The mapping tables' vocabulary — one fetch per wizard run, not per scope
 * (unlike states). Linear has no category concept, so `categories` is null
 * and the seed's category `toProvider` is all-null.
 */
const FIELD_OPTIONS: TrackerFieldOptions = {
  priorities: ['0', '1', '2', '3', '4'],
  categories: null,
  defaultPriorityMapping: {
    toProvider: { P0: '1', P1: '2', P2: '3', P3: '3', P4: '4', P5: '4', P6: '0' },
    toLocal: { '0': 'P6', '1': 'P0', '2': 'P1', '3': 'P2', '4': 'P4' },
  },
  defaultCategoryMapping: {
    toProvider: { feature: null, bug: null, chore: null },
    toLocal: {},
  },
};

/** The Cyboflow project's pre-existing backlog; its one suggestion is a Beta issue. */
const RECONCILE_7: TrackerReconcileItem[] = [
  {
    entityType: 'idea',
    entityId: 'idea-4',
    ref: 'IDEA-004',
    title: 'Diff gutter spacing',
    suggestedExternalId: 'iss-2',
  },
  {
    entityType: 'task',
    entityId: 'task-7',
    ref: 'TASK-007',
    title: 'Refactor executor retry loop',
    suggestedExternalId: null,
  },
];

const RECONCILE_9: TrackerReconcileItem[] = [
  {
    entityType: 'idea',
    entityId: 'idea-9',
    ref: 'IDEA-009',
    title: 'Website backlog item',
    suggestedExternalId: null,
  },
];

/**
 * The connection add-mapping mode extends: one live mapping of the whole
 * Platform team into Cyboflow, on the authorization every probe then reuses.
 */
const SOURCE_CONNECTION: TrackerConnectionSummary = {
  id: 'conn-src',
  projectId: 7,
  provider: 'linear',
  status: 'active',
  workspaceName: 'Acme',
  actorLabel: 'J. Kesteva',
  baseUrl: null,
  sourceLabel: 'Platform · all open issues',
  sourceScope: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
  selectionMode: 'all',
  statusSyncMode: 'auto',
  pullMode: 'auto',
  pushMode: 'auto',
  contentSyncMode: 'off',
  archiveSyncMode: 'off',
  priorityMapping: {
    toProvider: { P0: '1', P1: '2', P2: '3', P3: '3', P4: '4', P5: '4', P6: '0' },
    toLocal: { '0': 'P6', '1': 'P0', '2': 'P1', '3': 'P2', '4': 'P4' },
  },
  categoryMapping: { toProvider: { feature: null, bug: null, chore: null }, toLocal: {} },
  mirrorSubissues: true,
  conflictMode: 'auto',
  pushTarget: true,
  stateMapping: {},
  lastSyncAt: null,
  lastSyncLog: [],
  linkedCount: 4,
  openConflictCount: 0,
};

/** A sibling on the SAME authorization, mapping Alpha into the Website project. */
const ALPHA_SIBLING: TrackerConnectionSummary = {
  ...SOURCE_CONNECTION,
  id: 'conn-alpha',
  projectId: 9,
  sourceLabel: 'Core · Alpha',
  sourceScope: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
  pushTarget: false,
};

/** A sibling covering the WHOLE Core team, into the Website project. */
const CORE_TEAM_SIBLING: TrackerConnectionSummary = {
  ...SOURCE_CONNECTION,
  id: 'conn-core',
  projectId: 9,
  sourceLabel: 'Core · all open issues',
  sourceScope: { containerId: 'core', narrowId: 'all', narrowKind: 'all' },
  pushTarget: false,
};

/** The one overlap sentence both directions share, parameterised by group name. */
function overlapText(name: string): string {
  return `Issues in ${name} are covered by both mappings — each imports once, under whichever mapping syncs it first.`;
}

const onClose = vi.fn();
const onConnected = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockValidate.mockResolvedValue({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
  });
  mockGroups.mockResolvedValue(GROUPS);
  // Issues + states are answered from the SELECTION, since the wizard fires one
  // call per mapping and a call-index stub would encode probe order as fact.
  mockIssues.mockImplementation(
    ({ selection }: { selection: TrackerSourceSelection }): Promise<TrackerIssue[]> =>
      Promise.resolve(ISSUES_BY_CONTAINER[selection.containerId]?.[selection.narrowId] ?? []),
  );
  mockStates.mockImplementation(
    ({ selection }: { selection: TrackerSourceSelection }): Promise<TrackerState[]> =>
      Promise.resolve(selection.containerId === 'core' ? CORE_STATES : PLAT_STATES),
  );
  mockFieldOptions.mockResolvedValue(FIELD_OPTIONS);
  mockReconcile.mockImplementation(
    ({ projectId }: { projectId: number }): Promise<TrackerReconcileItem[]> =>
      Promise.resolve(projectId === 7 ? RECONCILE_7 : RECONCILE_9),
  );
  mockConnect.mockResolvedValue({ connectionId: 'conn-1' });
  mockDisconnect.mockResolvedValue({ ok: true });
  // The live siblings of the source connection — itself alone by default, which
  // is what a connection with one mapping actually reports.
  mockMappings.mockResolvedValue([SOURCE_CONNECTION]);
  mockProjectsGetAll.mockResolvedValue({ success: true, data: PROJECTS });
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function renderWizard(): void {
  render(
    <TrackerWizardModal
      isOpen
      provider="linear"
      projectId={7}
      onClose={onClose}
      onConnected={onConnected}
    />,
  );
}

/**
 * Open the wizard in add-mapping mode and wait until the Map step is usable:
 * BOTH async reads (the group tree and the project list) have to land before a
 * select can be changed — a `fireEvent.change` to a value whose <option> has not
 * rendered yet is silently a no-op.
 */
function renderAddMapping(): void {
  render(
    <TrackerWizardModal
      isOpen
      provider="linear"
      projectId={7}
      sourceConnection={SOURCE_CONNECTION}
      onClose={onClose}
      onConnected={onConnected}
    />,
  );
}

async function openAddMapping(readyGroup = 'Alpha'): Promise<void> {
  renderAddMapping();
  // `readyGroup` names a group the fixture leaves MAPPABLE — a linked scope has
  // no select at all, so a test whose siblings cover Alpha waits on another one.
  await screen.findByLabelText(`Cyboflow project for ${readyGroup}`);
  await screen.findAllByRole('option', { name: 'Cyboflow (Active)' });
}

/** Paste a key, authorize, and land on the Map step. */
async function authorize(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'lin_api_x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
  await screen.findByTestId('tracker-authorized-card');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Map Linear onto cyboflow projects');
}

function mapGroup(groupName: string, projectId: number): void {
  fireEvent.change(screen.getByLabelText(`Cyboflow project for ${groupName}`), {
    target: { value: String(projectId) },
  });
}

/**
 * Stage a linked mapping for unlink. Local only — nothing is disconnected until
 * Submit, and the group it covered drops into the mappable list immediately.
 */
function unlinkSibling(connectionId: string): void {
  fireEvent.click(screen.getByTestId(`tracker-unlink-${connectionId}`));
}

/** The default fixture mapping: Alpha + Beta → Cyboflow (7), Platform → Website (9). */
function mapDefaults(): void {
  mapGroup('Alpha', 7);
  mapGroup('Beta', 7);
  mapGroup('Platform', 9);
}

/**
 * Walk forward `count` steps (from step `from`) through the Continue/Review
 * button, settling on the rail's `aria-current` rather than the button itself
 * (the clicked node is unmounted mid-transition and keeps its stale attributes).
 */
async function advance(count: number, from = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const label = screen.queryByRole('button', { name: 'Continue' }) !== null ? 'Continue' : 'Review';
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(screen.getByTestId(`tracker-step-${from + i + 1}`)).toHaveAttribute(
        'aria-current',
        'step',
      ),
    );
  }
}

describe('TrackerWizardModal — Step 0 gate', () => {
  it('locks every later step until the key validates', async () => {
    renderWizard();

    for (const index of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`tracker-step-${index}`)).toBeDisabled();
    }
    // Nothing to authorize with yet.
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'lin_api_x' } });
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeEnabled();

    // A rail click before validating is inert — no probe fires, step 0 stays.
    fireEvent.click(screen.getByTestId('tracker-step-1'));
    expect(mockGroups).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(await screen.findByText('Authorized as J. Kesteva')).toBeInTheDocument();
    expect(screen.getByText('workspace Acme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Map Linear onto cyboflow projects')).toBeInTheDocument();
    expect(mockGroups).toHaveBeenCalledTimes(1);
  });

  it('retires the validated identity when the key is edited', async () => {
    renderWizard();
    await authorize();

    fireEvent.click(screen.getByTestId('tracker-step-0'));
    fireEvent.change(await screen.findByLabelText('Personal API key'), {
      target: { value: 'lin_other' },
    });

    await waitFor(() =>
      expect(screen.queryByTestId('tracker-authorized-card')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('tracker-step-1')).toBeDisabled();
  });

  it('surfaces a rejected key instead of advancing', async () => {
    mockValidate.mockRejectedValue(new Error('The tracker rejected these credentials.'));
    renderWizard();

    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The tracker rejected these credentials.',
    );
    expect(screen.getByTestId('tracker-step-1')).toBeDisabled();
  });
});

describe('TrackerWizardModal — Map step', () => {
  it('renders every section and blocks Continue until something is mapped', async () => {
    renderWizard();
    await authorize();

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Whole teams')).toBeInTheDocument();
    for (const name of ['Alpha', 'Beta', 'Platform']) {
      expect(screen.getByLabelText(`Cyboflow project for ${name}`)).toHaveValue('');
    }
    // The active project is marked in every select.
    expect(
      within(screen.getByLabelText('Cyboflow project for Alpha')).getByRole('option', {
        name: 'Cyboflow (Active)',
      }),
    ).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    mapGroup('Alpha', 7);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('renders the full project dropdown for a non-workspace-bound provider', async () => {
    renderWizard();
    await authorize();

    const select = screen.getByLabelText('Cyboflow project for Alpha');
    expect(
      within(select).getByRole('option', { name: "— Don't import" }),
    ).toBeInTheDocument();
    expect(within(select).getAllByRole('option')).toHaveLength(1 + PROJECTS.length);
    // A keyed provider keeps its Step 0 and its group list — the per-project
    // workspace rows belong to workspace-bound providers alone.
    expect(screen.getByTestId('tracker-step-0')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^tracker-workspace-row-/)).toHaveLength(0);
  });

  it('offers a push-target radio only where two groups share one project', async () => {
    renderWizard();
    await authorize();

    mapGroup('Platform', 9);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    mapGroup('Alpha', 7);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    mapGroup('Beta', 7);
    expect(screen.getByText('New cyboflow ideas in Cyboflow push to:')).toBeInTheDocument();
    // The first mapped group of the cluster is the default pusher.
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Beta' })).not.toBeChecked();
    // Website has a single mapping, so it gets no cluster of its own.
    expect(screen.queryByText('New cyboflow ideas in Website push to:')).not.toBeInTheDocument();
  });

  it('warns when a whole-team mapping subsumes a mapped project under it', async () => {
    renderWizard();
    await authorize();

    mapGroup('Alpha', 7);
    const warning =
      'Issues in Alpha are covered by both mappings — each imports once, under whichever mapping syncs it first.';
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    // Platform is a different team, so it subsumes nothing.
    mapGroup('Platform', 9);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    // The whole Core team does subsume Alpha — including across projects, since
    // the engine's guard is keyed by external id, not by target project.
    mapGroup('Core', 9);
    expect(screen.getByText(warning)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cyboflow project for Core'), {
      target: { value: '' },
    });
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });
});

describe('TrackerWizardModal — Tasks step', () => {
  it('fetches issues per mapping and unions the assignee roster', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(1); // → Tasks

    expect(mockIssues).toHaveBeenCalledTimes(3);
    for (const selection of [
      { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
      { containerId: 'core', narrowId: 'beta', narrowKind: 'project' },
      { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
    ]) {
      expect(mockIssues).toHaveBeenCalledWith({
        credentials: { provider: 'linear', apiKey: 'lin_api_x' },
        selection,
      });
    }

    // Rows are grouped per mapping, each under its target project.
    expect(
      within(screen.getByTestId('tracker-issues-proj-alpha')).getByText('Token budget alerts'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-issues-team-plat')).getByText('Ship the installer'),
    ).toBeInTheDocument();
    expect(screen.getByText('Platform → Website')).toBeInTheDocument();
    expect(screen.getByText('3 issues will sync')).toBeInTheDocument();

    // One roster across all three mappings, deduped by assignee id — Jaya is
    // assigned in two different mappings and appears once, with both counted.
    fireEvent.click(screen.getByRole('button', { name: 'By assignee' }));
    expect(screen.getByRole('button', { name: /Jaya Kesteva/ })).toHaveTextContent('JKJaya Kesteva2');
    expect(screen.getByRole('button', { name: /Mira Rao/ })).toHaveTextContent('MRMira Rao1');
  });

  it('blocks by-assignee with nobody picked and manual with nothing ticked', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(1); // → Tasks

    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'By assignee' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Jaya Kesteva/ }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /CORE-118/ }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(screen.getByText('1 issues will sync')).toBeInTheDocument();
  });
});

describe('TrackerWizardModal — States step', () => {
  it('fetches one table per distinct state scope, not per mapping', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    // Three mappings, two scopes: Alpha and Beta share the Core team's states.
    expect(mockStates).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('tracker-state-scope-core')).toBeInTheDocument();
    expect(screen.getByTestId('tracker-state-scope-plat')).toBeInTheDocument();
    expect(screen.getByText('Alpha, Beta')).toBeInTheDocument();

    // Each table is seeded from its own canonical groups, and the labels carry
    // the scope because "Todo" exists in both.
    expect(screen.getByLabelText('Cyboflow state for Todo in Alpha, Beta')).toHaveValue('ready');
    expect(screen.getByLabelText('Cyboflow state for Shipped in Platform')).toHaveValue('done');

    // Direction / mirroring / conflict mode stay global, rendered once.
    expect(screen.getAllByRole('group', { name: 'Sync task status' })).toHaveLength(1);
    expect(
      screen.getByRole('switch', { name: 'Mirror task breakdowns as sub-issues' }),
    ).toBeChecked();
  });

  it('drops both tables when a mapping changes', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States
    expect(mockStates).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('tracker-step-1'));
    await screen.findByText('Map Linear onto cyboflow projects');
    mapGroup('Beta', 9);

    // The rail clamps back to Map, so States is re-probed on the way forward.
    await waitFor(() => expect(screen.getByTestId('tracker-step-3')).toBeDisabled());
    await advance(2);
    expect(mockStates).toHaveBeenCalledTimes(4);
  });
});

describe('TrackerWizardModal — priority/category mapping + content modes', () => {
  it('seeds the priority table from the default mapping, one fetch for the whole run', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    // Selection-free, unlike wizardStates: ONE call for the run, not per group.
    expect(mockFieldOptions).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Linear priority for P0')).toHaveValue('1');
    expect(screen.getByLabelText('Linear priority for P2')).toHaveValue('3');
    expect(screen.getByLabelText('Linear priority for P6')).toHaveValue('0');
  });

  it('lets a priority row be edited', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    fireEvent.change(screen.getByLabelText('Linear priority for P0'), { target: { value: '2' } });
    expect(screen.getByLabelText('Linear priority for P0')).toHaveValue('2');
    // Choosing the explicit "not sent" option clears it to null.
    fireEvent.change(screen.getByLabelText('Linear priority for P1'), { target: { value: '' } });
    expect(screen.getByLabelText('Linear priority for P1')).toHaveValue('');
  });

  it('renders no category table for a provider with no issue type, only a caption', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    expect(screen.queryByTestId('tracker-category-mapping')).not.toBeInTheDocument();
    expect(
      screen.getByText('Linear has no issue type — category stays local.'),
    ).toBeInTheDocument();
  });

  it('the content/archive controls default to Off and expose all three states', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    const contentGroup = screen.getByRole('group', { name: 'Push task fields to Linear' });
    expect(within(contentGroup).getByRole('button', { name: 'Off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(contentGroup).getByRole('button', { name: 'Auto' }));
    expect(within(contentGroup).getByRole('button', { name: 'Auto' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const archiveGroup = screen.getByRole('group', { name: 'Archive in Linear' });
    expect(within(archiveGroup).getByRole('button', { name: 'Off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(archiveGroup).getByRole('button', { name: 'Manual' }));
    expect(within(archiveGroup).getByRole('button', { name: 'Manual' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('submits the edited priority mapping and the chosen modes on connect', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    fireEvent.change(screen.getByLabelText('Linear priority for P0'), { target: { value: '2' } });
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Push task fields to Linear' })).getByRole('button', {
        name: 'Auto',
      }),
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Archive in Linear' })).getByRole('button', {
        name: 'Manual',
      }),
    );

    await advance(2, 3); // → Reconcile → Review
    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 3 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        contentSyncMode: 'auto',
        archiveSyncMode: 'manual',
        priorityMapping: {
          toProvider: { ...FIELD_OPTIONS.defaultPriorityMapping.toProvider, P0: '2' },
        },
      }),
    );
    // Every mapping in the run carries the SAME global modes/mapping.
    expect(mockConnect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ contentSyncMode: 'auto', archiveSyncMode: 'manual' }),
    );
  });
});

describe('TrackerWizardModal — Dart category mapping', () => {
  it('renders the category table only for a provider with an issue type, seeded from the default mapping', async () => {
    const dartFieldOptions: TrackerFieldOptions = {
      ...FIELD_OPTIONS,
      categories: ['Task', 'Bug'],
      defaultCategoryMapping: {
        toProvider: { feature: null, bug: 'Bug', chore: null },
        toLocal: { bug: 'bug' },
      },
    };
    mockFieldOptions.mockResolvedValue(dartFieldOptions);

    render(
      <TrackerWizardModal
        isOpen
        provider="dart"
        projectId={7}
        onClose={onClose}
        onConnected={onConnected}
      />,
    );
    fireEvent.change(screen.getByLabelText('Personal authentication token'), {
      target: { value: 'dsa_x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    await screen.findByTestId('tracker-authorized-card');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('Map Dart onto cyboflow projects');

    mapDefaults();
    await advance(2); // → Tasks → States

    // No "unsupported" caption where the provider DOES model an issue type.
    expect(screen.queryByTestId('tracker-category-unsupported')).not.toBeInTheDocument();
    const categoryTable = screen.getByTestId('tracker-category-mapping');
    expect(within(categoryTable).getByLabelText('Dart type for bug')).toHaveValue('Bug');
    expect(within(categoryTable).getByLabelText('Dart type for feature')).toHaveValue('');

    fireEvent.change(within(categoryTable).getByLabelText('Dart type for feature'), {
      target: { value: 'Task' },
    });
    expect(within(categoryTable).getByLabelText('Dart type for feature')).toHaveValue('Task');
  });
});

describe('TrackerWizardModal — Reconcile step', () => {
  it('previews each target project once and groups the rows under it', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(3); // → Tasks → States → Reconcile

    expect(mockReconcile).toHaveBeenCalledTimes(2);
    expect(mockReconcile).toHaveBeenCalledWith({
      projectId: 7,
      issues: [...ALPHA_ISSUES, ...BETA_ISSUES],
    });
    expect(mockReconcile).toHaveBeenCalledWith({ projectId: 9, issues: PLAT_ISSUES });

    expect(
      within(screen.getByTestId('tracker-reconcile-7')).getByText('Diff gutter spacing'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-reconcile-9')).getByText('Website backlog item'),
    ).toBeInTheDocument();

    // A suggested row starts on Link, pre-filled; the rest start on Keep.
    const suggested = screen.getByRole('group', { name: 'Action for IDEA-004' });
    expect(within(suggested).getByRole('button', { name: 'Link' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Merge IDEA-004 into')).toHaveValue('iss-2');
    expect(screen.getByText(/2 kept/)).toBeInTheDocument();
  });
});

describe('TrackerWizardModal — Review + connect', () => {
  it('connects each mapping sequentially with its own source, states and decisions', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    // Beta pushes for Cyboflow instead of Alpha, so Alpha lands pushTarget=false.
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    await advance(4); // → Tasks → States → Reconcile → Review

    expect(await screen.findByText('Review the connections')).toBeInTheDocument();
    expect(screen.getByText('Core · Alpha → Cyboflow')).toBeInTheDocument();
    expect(screen.getByText('Platform · all open issues → Website')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 3 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    const CORE_MAPPING = {
      triage: 'dont',
      backlog: 'idea',
      todo: 'ready',
      inprog: 'ready',
      done: 'done',
      cancel: 'wontdo',
    };

    // Alpha: the project's first mapping, so it carries the non-link decision —
    // but not the link, whose issue belongs to Beta.
    expect(mockConnect).toHaveBeenNthCalledWith(1, {
      projectId: 7,
      credentials: { provider: 'linear', apiKey: 'lin_api_x' },
      source: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
      sourceLabel: 'Core · Alpha',
      selectionMode: 'all',
      selectionJson: null,
      stateMapping: CORE_MAPPING,
      statusSyncMode: 'auto',
      pullMode: 'auto',
      pushMode: 'auto',
      contentSyncMode: 'off',
      archiveSyncMode: 'off',
      // The seed's own toProvider table, unedited — Linear has no category
      // concept, so categoryMapping is omitted entirely (no table rendered).
      priorityMapping: { toProvider: FIELD_OPTIONS.defaultPriorityMapping.toProvider },
      mirrorSubissues: true,
      conflictMode: 'auto',
      reconcile: [{ entityType: 'task', entityId: 'task-7', action: 'keep' }],
      pushTarget: false,
    });

    // Beta: same scope table, the chosen pusher, and the owner of the link.
    expect(mockConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: 7,
        source: { containerId: 'core', narrowId: 'beta', narrowKind: 'project' },
        sourceLabel: 'Core · Beta',
        stateMapping: CORE_MAPPING,
        pushTarget: true,
        reconcile: [
          {
            entityType: 'idea',
            entityId: 'idea-4',
            action: 'link',
            linkExternalId: 'iss-2',
            linkIdentifier: 'CORE-118',
            linkUrl: 'https://linear.app/x/CORE-1',
          },
        ],
      }),
    );

    // Platform: its own project, its own state table, sole pusher there.
    expect(mockConnect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        projectId: 9,
        source: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
        stateMapping: { 'plat-todo': 'ready', 'plat-done': 'done' },
        pushTarget: true,
        reconcile: [{ entityType: 'idea', entityId: 'idea-9', action: 'keep' }],
      }),
    );

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives each mapping its OWN manual picks in selectionJson', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(1); // → Tasks

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    fireEvent.click(screen.getByRole('button', { name: /CORE-138/ }));
    fireEvent.click(screen.getByRole('button', { name: /PLT-9/ }));

    await advance(3, 2); // → States → Reconcile → Review
    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 2 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ selectionMode: 'manual', selectionJson: { issueIds: ['iss-1'] } }),
    );
    // Beta contributed nothing to the manual pick, so its list is empty.
    expect(mockConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ selectionJson: { issueIds: [] } }),
    );
    expect(mockConnect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ selectionJson: { issueIds: ['iss-3'] } }),
    );
  });

  it('keeps the modal open on a partial failure and retries only the failed mapping', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(4); // → … → Review

    mockConnect
      .mockResolvedValueOnce({ connectionId: 'conn-a' })
      .mockRejectedValueOnce(new Error('Linear returned 500.'))
      .mockResolvedValueOnce({ connectionId: 'conn-c' });

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 3 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    // The modal stays open with the failure attributed to its own row.
    expect(onClose).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId('tracker-mapping-proj-beta')).getByText('Linear returned 500.'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-mapping-proj-alpha')).getByText('Connected'),
    ).toBeInTheDocument();

    mockConnect.mockResolvedValue({ connectionId: 'conn-b' });
    fireEvent.click(await screen.findByRole('button', { name: /Retry 1 failed/ }));

    // Only Beta is re-sent; the two that succeeded are filtered out client-side.
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(4));
    expect(mockConnect).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ sourceLabel: 'Core · Beta' }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TrackerWizardModal — add-mapping mode', () => {
  it('opens on Map with no Connect step and never re-asks for the key', async () => {
    await openAddMapping();

    // Step 0 is ABSENT, not disabled: the run has no authorize step to reach.
    expect(screen.queryByTestId('tracker-step-0')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Personal API key')).not.toBeInTheDocument();
    expect(mockValidate).not.toHaveBeenCalled();

    // Map is step 1 of the five that remain, and it is where the wizard landed.
    expect(screen.getByTestId('tracker-step-1')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Map Linear onto cyboflow projects')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    // Nothing sits behind Map, so Back is not offered.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    // The group tree came from the connection, and the header attributes the
    // run to the identity it inherited rather than one it probed.
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(mockGroups).toHaveBeenCalledWith({ connectionId: 'conn-src' });
    expect(screen.getByText('/ Add a Linear mapping')).toBeInTheDocument();
    expect(screen.getByText('/ Acme · J. Kesteva')).toBeInTheDocument();
  });

  it('names the connection on every probe instead of carrying credentials', async () => {
    await openAddMapping();
    mapGroup('Alpha', 9);
    // Platform is linked, so it has no select until this run releases it.
    unlinkSibling('conn-src');
    mapGroup('Platform', 9);
    await advance(2); // → Tasks → States

    expect(mockIssues).toHaveBeenCalledWith({
      connectionId: 'conn-src',
      selection: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
    });
    expect(mockStates).toHaveBeenCalledWith({
      connectionId: 'conn-src',
      selection: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
    });

    // The point of the mode: no probe on any step carries a key.
    const probeInputs: unknown[] = [
      ...mockGroups.mock.calls,
      ...mockIssues.mock.calls,
      ...mockStates.mock.calls,
    ].map((call) => call[0]);
    expect(probeInputs).toHaveLength(5);
    for (const input of probeInputs) {
      expect(input).not.toHaveProperty('credentials');
    }
  });

  it('connects with sourceConnectionId and no credentials key', async () => {
    await openAddMapping();
    mapGroup('Alpha', 9);
    await advance(4); // → Tasks → States → Reconcile → Review

    // The inherited authorization is stated on Review, since no "Authorized as
    // …" card was ever shown in this mode.
    expect(screen.getByText('Reusing the key authorized as J. Kesteva')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 1 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));

    const payload = mockConnect.mock.calls[0][0];
    expect(payload).not.toHaveProperty('credentials');
    expect(payload).toMatchObject({
      projectId: 9,
      sourceConnectionId: 'conn-src',
      source: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
      sourceLabel: 'Core · Alpha',
      pushTarget: true,
    });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});

/**
 * The Map step is a MAPPING EDITOR: what the connection already covers is listed
 * first with an Unlink, and only what it does not cover is offered a project
 * select. Unlinking is staged — nothing is disconnected until Submit — and it
 * moves the group straight into the mappable list below.
 */
describe('TrackerWizardModal — add-mapping mode · linked rows', () => {
  it('lists the live mappings on top, with no select of their own', async () => {
    mockMappings.mockResolvedValue([SOURCE_CONNECTION, ALPHA_SIBLING]);
    await openAddMapping('Beta');

    expect(mockMappings).toHaveBeenCalledWith({ connectionId: 'conn-src' });
    const platRow = await screen.findByTestId('tracker-linked-conn-src');
    // Named by the tree's group name, pointed at its cyboflow project, and the
    // armed row says so.
    expect(within(platRow).getByText('Platform → Cyboflow')).toBeInTheDocument();
    expect(within(platRow).getByText('Pushes')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-linked-conn-alpha')).getByText('Alpha → Website'),
    ).toBeInTheDocument();

    // A linked scope is not mappable — that is what keeps one group out of two
    // projects — while everything uncovered still is.
    expect(screen.queryByLabelText('Cyboflow project for Platform')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Cyboflow project for Alpha')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cyboflow project for Beta')).toBeInTheDocument();
    expect(screen.getByLabelText('Cyboflow project for Core')).toBeInTheDocument();

    // Nothing to submit yet: a run has to map or unlink something first.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('moves an unlinked group into the mappable list without disconnecting anything', async () => {
    await openAddMapping();
    await screen.findByTestId('tracker-linked-conn-src');

    unlinkSibling('conn-src');

    // The staging is local — the row is gone from Linked, the group has a select,
    // and the server has not been told a thing.
    expect(screen.queryByTestId('tracker-linked-conn-src')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Cyboflow project for Platform')).toHaveValue('');
    expect(mockDisconnect).not.toHaveBeenCalled();
    // A staged unlink is itself a change, so the run can go on.
    expect(screen.getByRole('button', { name: 'Review' })).toBeEnabled();
  });
});

/**
 * `connect` claims the push target across wizard runs — main demotes every other
 * armed row of the (project, provider) pair unless the payload says
 * `pushTarget: false`. The wizard's own cluster only knows THIS run's mappings,
 * so a run that adds a group to an already-pushing project has to read the
 * connection's live siblings or it silently takes over their filing.
 */
describe('TrackerWizardModal — add-mapping mode · push target', () => {
  it('declines the push target a live sibling already holds', async () => {
    // The default siblings: conn-src maps Platform into Cyboflow (7) and pushes.
    // This run keeps that row and adds a second mapping into the same project —
    // the shape where a naive cluster default would silently claim over it.
    await openAddMapping();
    mapGroup('Alpha', 7);

    // No radio — this run makes no push-target choice for that project. It says
    // who keeps filing instead of implying the choice is being made here.
    expect(await screen.findByTestId('tracker-push-incumbent-7')).toHaveTextContent(
      'New cyboflow ideas in Cyboflow keep pushing through Platform · all open issues.',
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText('New cyboflow ideas in Cyboflow push to:')).not.toBeInTheDocument();

    await advance(4); // → Tasks → States → Reconcile → Review

    // Review agrees with the payload: the row claims nothing.
    expect(
      within(screen.getByTestId('tracker-mapping-proj-alpha')).queryByText('Push target'),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 1 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: 7, pushTarget: false }),
    );
  });

  it('declines it for EVERY mapping into that project, cluster or not', async () => {
    await openAddMapping();
    mapGroup('Alpha', 7);
    mapGroup('Beta', 7);

    // Two groups share the project, but the pusher is not this run's to pick.
    await screen.findByTestId('tracker-push-incumbent-7');
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    await advance(4);
    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 2 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    for (const call of mockConnect.mock.calls) {
      expect(call[0]).toMatchObject({ projectId: 7, pushTarget: false });
    }
  });

  it('claims it once the incumbent is staged for unlink', async () => {
    // A staged unlink is already gone as far as the run is concerned: its
    // disconnect runs first, and main hands the flag on from there — so the new
    // mapping claims normally instead of deferring to a row about to retire.
    await openAddMapping();
    await screen.findByTestId('tracker-linked-conn-src');
    unlinkSibling('conn-src');
    mapGroup('Alpha', 7);

    expect(screen.queryByTestId('tracker-push-incumbent-7')).not.toBeInTheDocument();
    await advance(4);
    expect(
      within(screen.getByTestId('tracker-mapping-proj-alpha')).getByText('Push target'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Unlink 1 · connect & sync 1 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: 7, pushTarget: true }),
    );
  });

  it('keeps the radio where the run genuinely decides — a project with no pusher', async () => {
    await openAddMapping();
    mapGroup('Alpha', 9);
    mapGroup('Beta', 9);

    // Website has no live mapping of its own, so the cluster is this run's call.
    expect(screen.queryByTestId('tracker-push-incumbent-9')).not.toBeInTheDocument();
    expect(screen.getByText('New cyboflow ideas in Website push to:')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));

    await advance(4);
    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 2 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));
    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sourceLabel: 'Core · Alpha', pushTarget: false }),
    );
    expect(mockConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sourceLabel: 'Core · Beta', pushTarget: true }),
    );
  });
});

describe('TrackerWizardModal — add-mapping mode · failed groups probe', () => {
  it('offers a Retry that re-drives the probe instead of stranding the step', async () => {
    mockGroups.mockRejectedValueOnce(new Error('Linear returned 500.'));
    renderAddMapping();

    expect(await screen.findByRole('alert')).toHaveTextContent('Linear returned 500.');
    // Nothing is mapped, so Continue — the only other caller of the group probe
    // — is blocked; without the card the step's only live control is Close.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    const retryCard = await screen.findByTestId('tracker-groups-retry');
    expect(within(retryCard).getByText('Linear did not return its groups.')).toBeInTheDocument();

    // A rail click wipes the error banner; the affordance keys off the missing
    // tree, so it survives that and still describes the state.
    fireEvent.click(screen.getByTestId('tracker-step-1'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('tracker-groups-retry')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Cyboflow project for Alpha')).toBeInTheDocument();
    expect(mockGroups).toHaveBeenCalledTimes(2);
    expect(mockGroups).toHaveBeenLastCalledWith({ connectionId: 'conn-src' });
    expect(screen.queryByTestId('tracker-groups-retry')).not.toBeInTheDocument();
  });

  it('does not offer it while the mount probe is still in flight', async () => {
    let resolveGroups: (tree: TrackerGroupTree) => void = () => undefined;
    mockGroups.mockImplementationOnce(
      () =>
        new Promise<TrackerGroupTree>((resolve) => {
          resolveGroups = resolve;
        }),
    );
    renderAddMapping();

    // An empty tree mid-fetch is not a failure, and must not be described as one.
    expect(screen.queryByTestId('tracker-groups-retry')).not.toBeInTheDocument();
    resolveGroups(GROUPS);
    await screen.findByLabelText('Cyboflow project for Alpha');
    expect(screen.queryByTestId('tracker-groups-retry')).not.toBeInTheDocument();
  });
});

/**
 * The overlap warning exists so the cross-scope skip is not discovered after the
 * first sync. In add-mapping mode the run owns only part of the connection's
 * mappings, so the subsuming half can sit on either side of the seam.
 */
describe('TrackerWizardModal — add-mapping mode · overlap with live siblings', () => {
  it('warns when a live whole-team sibling covers a group mapped here', async () => {
    mockMappings.mockResolvedValue([CORE_TEAM_SIBLING]);
    await openAddMapping();

    mapGroup('Alpha', 7);
    expect(await screen.findByText(overlapText('Alpha'))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cyboflow project for Alpha'), {
      target: { value: '' },
    });
    expect(screen.queryByText(overlapText('Alpha'))).not.toBeInTheDocument();
  });

  it('warns in the reverse direction — a whole team mapped over a narrowed sibling', async () => {
    mockMappings.mockResolvedValue([SOURCE_CONNECTION, ALPHA_SIBLING]);
    await openAddMapping('Beta');
    await screen.findByTestId('tracker-linked-conn-alpha');

    // Beta shares Alpha's container but not its narrow — nothing subsumes it.
    mapGroup('Beta', 9);
    expect(screen.queryByText(overlapText('Beta'))).not.toBeInTheDocument();

    // The whole Core team does subsume the sibling that holds Alpha.
    mapGroup('Core', 9);
    expect(screen.getByText(overlapText('Core'))).toBeInTheDocument();
  });

  it('stops warning about a sibling this run unlinks', async () => {
    // The sibling covers the whole Core team, so mapping Alpha under it overlaps
    // — until the run stages that sibling's unlink, after which it covers
    // nothing: it is disconnected before the new mapping ever syncs.
    mockMappings.mockResolvedValue([CORE_TEAM_SIBLING]);
    await openAddMapping();
    mapGroup('Alpha', 7);
    expect(await screen.findByText(overlapText('Alpha'))).toBeInTheDocument();

    unlinkSibling('conn-core');
    expect(screen.queryByText(overlapText('Alpha'))).not.toBeInTheDocument();
    // And the group it covered is mappable now.
    expect(screen.getByLabelText('Cyboflow project for Core')).toBeInTheDocument();
  });
});

/**
 * Submit applies the run in ONE order, and it is load-bearing: every staged
 * disconnect runs before the connects, because a retired row stops claiming its
 * issues (so the new mapping imports them) and main promotes a surviving push
 * target as part of retiring it.
 */
describe('TrackerWizardModal — add-mapping mode · submit', () => {
  it('disconnects the old mapping before connecting the new pair', async () => {
    mockMappings.mockResolvedValue([SOURCE_CONNECTION, ALPHA_SIBLING]);
    await openAddMapping('Beta');
    await screen.findByTestId('tracker-linked-conn-alpha');

    // Move Alpha from Website to Cyboflow: unlink the old row, map the freed
    // group somewhere else. conn-src stays live, so it carries the key.
    unlinkSibling('conn-alpha');
    mapGroup('Alpha', 7);
    await advance(4);

    expect(
      within(screen.getByTestId('tracker-unlink-row-conn-alpha')).getByText(
        'Unlink Alpha from Website',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Unlink 1 · connect & sync 1 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));

    expect(mockDisconnect).toHaveBeenCalledWith({ connectionId: 'conn-alpha' });
    expect(mockDisconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockConnect.mock.invocationCallOrder[0],
    );
    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: 7, sourceConnectionId: 'conn-src' }),
    );
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('runs an unlink-only run straight to Review and connects nothing', async () => {
    await openAddMapping();
    await screen.findByTestId('tracker-linked-conn-src');
    unlinkSibling('conn-src');

    // Tasks/States/Reconcile describe mapped groups; this run has none, so the
    // rail shows them as unreachable and Continue reads Review.
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() =>
      expect(screen.getByTestId('tracker-step-5')).toHaveAttribute('aria-current', 'step'),
    );
    for (const index of [2, 3, 4]) {
      expect(screen.getByTestId(`tracker-step-${index}`)).toBeDisabled();
    }
    expect(mockIssues).not.toHaveBeenCalled();
    expect(mockStates).not.toHaveBeenCalled();
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(screen.getByText('Review the unlinks')).toBeInTheDocument();

    // Back from Review returns to Map, not to the steps it skipped.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(screen.getByTestId('tracker-step-1')).toHaveAttribute('aria-current', 'step'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByText('Review the unlinks');

    fireEvent.click(screen.getByRole('button', { name: 'Unlink 1 mapping' }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
    expect(mockDisconnect).toHaveBeenCalledWith({ connectionId: 'conn-src' });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Continue blocked while the run changes nothing', async () => {
    await openAddMapping();
    await screen.findByTestId('tracker-linked-conn-src');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('holds the connects back when a staged disconnect fails, and retries both', async () => {
    mockMappings.mockResolvedValue([SOURCE_CONNECTION, ALPHA_SIBLING]);
    mockDisconnect.mockRejectedValueOnce(new Error('Linear returned 500.'));
    await openAddMapping('Beta');
    await screen.findByTestId('tracker-linked-conn-alpha');

    unlinkSibling('conn-alpha');
    mapGroup('Alpha', 7);
    await advance(4);
    fireEvent.click(screen.getByRole('button', { name: /Unlink 1 · connect & sync 1 issues/ }));

    // The row it should have retired is still live, so connecting over it would
    // import nothing — the connect stays Pending until the unlink lands.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('tracker-unlink-row-conn-alpha')).getByText(
          'Linear returned 500.',
        ),
      ).toBeInTheDocument(),
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId('tracker-mapping-proj-alpha')).getByText('Pending'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /Retry 1 failed/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(mockDisconnect).toHaveBeenCalledTimes(2);
    expect(mockDisconnect.mock.invocationCallOrder[1]).toBeLessThan(
      mockConnect.mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
  });

  it('unlinks the key’s own row LAST when nothing else can carry it', async () => {
    // Only one sibling exists, and the run retires it while creating a new
    // mapping: `connect` resolves its key from that row, and `disconnect` clears
    // it — so this one disconnect has to wait for the connects.
    await openAddMapping();
    await screen.findByTestId('tracker-linked-conn-src');
    unlinkSibling('conn-src');
    mapGroup('Platform', 9);
    await advance(4);

    expect(screen.getByTestId('tracker-unlink-list')).toHaveTextContent(
      'Platform is unlinked last — its stored key is what authorizes the new mappings.',
    );

    fireEvent.click(screen.getByRole('button', { name: /Unlink 1 · connect & sync 1 issues/ }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledTimes(1));
    expect(mockConnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockDisconnect.mock.invocationCallOrder[0],
    );
    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ projectId: 9, sourceConnectionId: 'conn-src' }),
    );
  });
});


// ---------------------------------------------------------------------------
// WORKSPACE-ROW MODE (beads, fresh connect) — the Map step IS the per-project
// surface, and there is no Step 0 in front of it
// ---------------------------------------------------------------------------

/**
 * A workspace-bound provider has no account to authorize into: one workspace per
 * repository, found by probing that repository. So the wizard opens on Map and
 * that step lists every cyboflow project, each row answering for its own repo.
 *
 * What these pin down is the thing a wrong answer costs: a row must probe,
 * initialize and connect with ITS OWN credentials — its project id, plus the
 * folder token when it was pointed elsewhere — because a row that borrows
 * another's would silently bind the wrong repository to the wrong project. The
 * rest (the folder is display text only, `bd` missing is one fact about the
 * machine, an already-connected project is never probed) hangs off that.
 */
describe('TrackerWizardModal — beads workspace rows', () => {
  /** What each project's repository answers, by project id. An Error rejects. */
  let repoAnswers: Record<number, string | Error>;
  /** What a picked folder answers, by the token main minted for it. */
  let tokenAnswers: Record<string, string | Error>;

  beforeEach(() => {
    repoAnswers = { 7: 'cf', 9: 'web' };
    tokenAnswers = {};
    // Answered from the CREDENTIALS, since the wizard fires one call per row and
    // a call-index stub would encode probe order — which is concurrent — as fact.
    mockGroups.mockImplementation(
      (input: { credentials?: TrackerCredentialsInput }): Promise<TrackerGroupTree> => {
        const credentials = input.credentials;
        // A fresh workspace-bound run has no connection to name, so a probe with
        // no credentials at all would be the bug, not a fixture case.
        if (credentials === undefined) return Promise.reject(new Error('probe carried no credentials'));
        const token = credentials.workspaceDirToken;
        const answer =
          token !== undefined ? tokenAnswers[token] : repoAnswers[credentials.projectId ?? -1];
        if (answer === undefined) return Promise.reject(NO_WORKSPACE);
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(beadsTree(answer));
      },
    );
    // Nothing pre-existing in either backlog; this suite is about the rows.
    mockReconcile.mockResolvedValue([]);
  });

  function renderBeads(connected: number[] = []): void {
    render(
      <TrackerWizardModal
        isOpen
        provider="beads"
        projectId={7}
        connectedProjectIds={connected}
        onClose={onClose}
        onConnected={onConnected}
      />,
    );
  }

  /** Open the wizard and wait until every row's mount probe has settled. */
  async function openRows(connected: number[] = []): Promise<void> {
    renderBeads(connected);
    await screen.findByTestId('tracker-workspace-row-7');
    await waitFor(() => expect(screen.queryAllByText('Checking…')).toHaveLength(0));
  }

  it('opens on Map with one row per project, the active one first, and no Connect step', async () => {
    await openRows();

    // Step 0 is ABSENT, not disabled — there is nothing to authorize against.
    expect(screen.queryByTestId('tracker-step-0')).not.toBeInTheDocument();
    expect(mockValidate).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-step-1')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    const rows = screen.getAllByTestId(/^tracker-workspace-row-/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'tracker-workspace-row-7',
      'tracker-workspace-row-9',
    ]);
    // Each row names the folder it is about to check — the commonest failure is
    // a repository the user was not thinking about.
    expect(within(rows[0]).getByText('/dev/cyboflow')).toBeInTheDocument();
    expect(within(rows[1]).getByText('/dev/website')).toBeInTheDocument();

    // One probe per row, each carrying that row's own project and no path.
    expect(mockGroups).toHaveBeenCalledTimes(2);
    expect(mockGroups).toHaveBeenCalledWith({ credentials: { provider: 'beads', projectId: 7 } });
    expect(mockGroups).toHaveBeenCalledWith({ credentials: { provider: 'beads', projectId: 9 } });
  });

  it('seeds Sync for the active project alone, into that row’s own project', async () => {
    await openRows();

    expect(screen.getByTestId('tracker-row-sync-7')).toHaveValue('7');
    expect(screen.getByTestId('tracker-row-sync-9')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    // Two options, and the sync target is the ROW's project — never another.
    const website = screen.getByTestId('tracker-row-sync-9');
    expect(within(website).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Sync into Website',
      "Don't sync",
    ]);
    expect(within(website).getByRole('option', { name: 'Sync into Website' })).toHaveValue('9');
  });

  it('blocks Continue once every row is set to Don’t sync', async () => {
    await openRows();

    fireEvent.change(screen.getByTestId('tracker-row-sync-7'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('initializes a row with that row’s credentials, then re-probes it', async () => {
    repoAnswers = { 7: 'cf', 9: NO_WORKSPACE };
    await openRows();

    // No workspace, so no sync choice yet — an offer to create one instead.
    expect(screen.queryByTestId('tracker-row-sync-9')).not.toBeInTheDocument();
    expect(screen.getByTestId('tracker-row-init-9')).toBeEnabled();
    // The disclosure is the caption for that offer: local --stealth is what
    // the button runs, shared tracking is routed to the terminal.
    expect(screen.getByText(/initializes Beads locally/)).toBeInTheDocument();
    expect(screen.getByText(/shared, git-enabled tracking/)).toBeInTheDocument();

    mockInitWorkspace.mockResolvedValue(undefined);
    repoAnswers[9] = 'web';
    fireEvent.click(screen.getByTestId('tracker-row-init-9'));

    await screen.findByTestId('tracker-row-sync-9');
    expect(mockInitWorkspace).toHaveBeenCalledWith({
      credentials: { provider: 'beads', projectId: 9 },
    });
    // Only that row moved, and the re-probe does not seed a non-active row.
    expect(screen.getByTestId('tracker-row-sync-9')).toHaveValue('');
    expect(screen.getByTestId('tracker-row-sync-7')).toHaveValue('7');
  });

  it('renders the init disclosure once for the whole list, not per row', async () => {
    repoAnswers = { 7: NO_WORKSPACE, 9: NO_WORKSPACE };
    await openRows();

    // Two rows offering Initialize, one caption underneath them — the text is
    // about what `bd init` does, which is the same fact for every repository.
    expect(screen.getByTestId('tracker-row-init-7')).toBeInTheDocument();
    expect(screen.getByTestId('tracker-row-init-9')).toBeInTheDocument();
    expect(screen.getAllByText(/initializes Beads locally/)).toHaveLength(1);
  });

  it('reports a refused init on the row and does not re-probe', async () => {
    repoAnswers = { 7: 'cf', 9: NO_WORKSPACE };
    await openRows();
    mockGroups.mockClear();
    mockInitWorkspace.mockRejectedValue(
      new Error('[beads] Error: This workspace is already initialized'),
    );

    fireEvent.click(screen.getByTestId('tracker-row-init-9'));

    const row = screen.getByTestId('tracker-workspace-row-9');
    await waitFor(() =>
      expect(within(row).getByRole('alert')).toHaveTextContent('already initialized'),
    );
    // A refused init has nothing new to find, and the offer stays put.
    expect(mockGroups).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-row-init-9')).toBeInTheDocument();
  });

  it('carries a per-row picked folder into that row’s probe and its init', async () => {
    repoAnswers = { 7: 'cf', 9: NO_WORKSPACE };
    await openRows();

    mockPickWorkspace.mockResolvedValue({ token: 'tok-9', path: '/dev/monorepo/packages/api' });
    tokenAnswers['tok-9'] = NO_WORKSPACE;
    fireEvent.click(screen.getByTestId('tracker-row-pick-9'));

    // A TOKEN and the row's project id — never a path, which the renderer only
    // ever holds as the display text below.
    await waitFor(() =>
      expect(mockGroups).toHaveBeenCalledWith({
        credentials: { provider: 'beads', projectId: 9, workspaceDirToken: 'tok-9' },
      }),
    );
    const row = screen.getByTestId('tracker-workspace-row-9');
    expect(within(row).getByText(/\/dev\/monorepo\/packages\/api/)).toBeInTheDocument();

    mockInitWorkspace.mockResolvedValue(undefined);
    tokenAnswers['tok-9'] = 'api';
    fireEvent.click(await screen.findByTestId('tracker-row-init-9'));
    await screen.findByTestId('tracker-row-sync-9');

    expect(mockInitWorkspace).toHaveBeenCalledWith({
      credentials: { provider: 'beads', projectId: 9, workspaceDirToken: 'tok-9' },
    });
    // The pick is that ROW's, so no other row's call ever carries the token.
    for (const call of mockGroups.mock.calls) {
      const credentials = call[0].credentials;
      if (credentials?.workspaceDirToken !== undefined) expect(credentials.projectId).toBe(9);
    }
  });

  it('changes nothing when a row’s folder dialog is cancelled', async () => {
    repoAnswers = { 7: 'cf', 9: NO_WORKSPACE };
    await openRows();
    mockGroups.mockClear();
    mockPickWorkspace.mockResolvedValue(null);

    fireEvent.click(screen.getByTestId('tracker-row-pick-9'));

    await waitFor(() => expect(mockPickWorkspace).toHaveBeenCalledWith({ provider: 'beads' }));
    // Declining a dialog is not an instruction to re-probe anything.
    expect(mockGroups).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId('tracker-workspace-row-9')).getByText('/dev/website'),
    ).toBeInTheDocument();
  });

  it('goes back to the repo folder when a row’s pick is reset', async () => {
    repoAnswers = { 7: 'cf', 9: NO_WORKSPACE };
    tokenAnswers['tok-9'] = NO_WORKSPACE;
    mockPickWorkspace.mockResolvedValue({ token: 'tok-9', path: '/dev/monorepo/packages/api' });
    await openRows();

    fireEvent.click(screen.getByTestId('tracker-row-pick-9'));
    const reset = await screen.findByTestId('tracker-row-use-repo-9');
    mockGroups.mockClear();
    fireEvent.click(reset);

    await waitFor(() =>
      expect(mockGroups).toHaveBeenCalledWith({ credentials: { provider: 'beads', projectId: 9 } }),
    );
    expect(screen.queryByTestId('tracker-row-use-repo-9')).not.toBeInTheDocument();
  });

  it('renders an already-connected project inert and never probes it', async () => {
    await openRows([9]);

    expect(screen.getByTestId('tracker-row-connected-9')).toHaveTextContent('Connected');
    expect(screen.queryByTestId('tracker-row-sync-9')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tracker-row-detect-9')).not.toBeInTheDocument();
    // The catalog already holds that answer — probing it would spend a spawn.
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(mockGroups).toHaveBeenCalledWith({ credentials: { provider: 'beads', projectId: 7 } });
  });

  it('states a missing `bd` once above the list, and offers those rows nothing', async () => {
    repoAnswers = { 7: NO_CLI, 9: NO_CLI };
    await openRows();

    // Machine-wide, so one banner rather than a copy per repository.
    expect(screen.getAllByTestId('tracker-missing-cli')).toHaveLength(1);
    expect(screen.getByTestId('tracker-missing-cli')).toHaveTextContent('was not found on PATH');
    for (const pid of [7, 9]) {
      expect(screen.queryByTestId(`tracker-row-init-${pid}`)).not.toBeInTheDocument();
      expect(screen.queryByTestId(`tracker-row-detect-${pid}`)).not.toBeInTheDocument();
    }
    // Nothing to initialize with, so the init disclosure is not shown either.
    expect(screen.queryByText(/initializes Beads locally/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('shows an unclassified failure verbatim with a Detect and no Initialize', async () => {
    repoAnswers = { 7: new Error('[beads] bd: database is locked'), 9: 'web' };
    await openRows();

    const row = screen.getByTestId('tracker-workspace-row-7');
    expect(within(row).getByText('[beads] bd: database is locked')).toBeInTheDocument();
    // There is no workspace to create here — only re-probing can move it.
    expect(screen.queryByTestId('tracker-row-init-7')).not.toBeInTheDocument();

    repoAnswers[7] = 'cf';
    fireEvent.click(screen.getByTestId('tracker-row-detect-7'));

    await screen.findByTestId('tracker-row-sync-7');
    // The hand re-probe seeds the active row exactly as the mount sweep would.
    expect(screen.getByTestId('tracker-row-sync-7')).toHaveValue('7');
  });

  it('connects every synced row with its OWN credentials and its own project', async () => {
    await openRows();
    fireEvent.change(screen.getByTestId('tracker-row-sync-9'), { target: { value: '9' } });
    await advance(4); // → Tasks → States → Reconcile → Review

    // Two repositories, one state table: bd's vocabulary is the tool's, not the
    // workspace's, so both rows report the same scope key.
    expect(mockStates).toHaveBeenCalledTimes(1);
    expect(mockIssues).toHaveBeenCalledWith({
      credentials: { provider: 'beads', projectId: 9 },
      selection: { containerId: 'workspace', narrowId: 'all', narrowKind: 'all' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 0 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(2));

    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: 7,
        credentials: { provider: 'beads', projectId: 7 },
        sourceLabel: 'cf',
      }),
    );
    expect(mockConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: 9,
        credentials: { provider: 'beads', projectId: 9 },
        sourceLabel: 'web',
      }),
    );
    // A fresh run reuses no authorization, so nothing names a connection.
    for (const call of mockConnect.mock.calls) {
      expect(call[0]).not.toHaveProperty('sourceConnectionId');
    }
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/**
 * ADD-MAPPING MODE for beads is a DIFFERENT question — extend one existing
 * connection's authorization — so it keeps the single bound-workspace row it
 * always had rather than the per-project surface above.
 */
describe('TrackerWizardModal — beads add-mapping mode', () => {
  const BEADS_CONNECTION: TrackerConnectionSummary = {
    ...SOURCE_CONNECTION,
    provider: 'beads',
    workspaceName: 'cf',
    sourceLabel: 'cf',
    sourceScope: { containerId: 'workspace', narrowId: 'all', narrowKind: 'all' },
  };

  function renderBeadsAddMapping(): void {
    render(
      <TrackerWizardModal
        isOpen
        provider="beads"
        projectId={7}
        sourceConnection={BEADS_CONNECTION}
        onClose={onClose}
        onConnected={onConnected}
      />,
    );
  }

  it('probes the connection, not the projects, and lists its one linked row', async () => {
    mockGroups.mockResolvedValue(beadsTree('cf'));
    mockMappings.mockResolvedValue([BEADS_CONNECTION]);
    renderBeadsAddMapping();

    const linked = await screen.findByTestId('tracker-linked-conn-src');
    expect(within(linked).getByText('cf → Cyboflow')).toBeInTheDocument();
    // Not the per-project row surface: this mode extends ONE workspace's
    // authorization, and the connection already says which workspace that is.
    expect(screen.queryByTestId('tracker-workspace-row-7')).not.toBeInTheDocument();
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(mockGroups).toHaveBeenCalledWith({ connectionId: 'conn-src' });
  });

  it('still seeds Sync on the bound row when no sibling covers it yet', async () => {
    mockGroups.mockResolvedValue(beadsTree('cf'));
    // A legacy row with no recorded scope covers nothing, so the group stays
    // mappable — and a workspace-bound row is sync/don't-sync, pre-answered.
    mockMappings.mockResolvedValue([{ ...BEADS_CONNECTION, sourceScope: null }]);
    renderBeadsAddMapping();

    const select = await screen.findByLabelText('Sync cf into this project');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Sync into Cyboflow',
      "Don't sync",
    ]);
    expect(select).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
