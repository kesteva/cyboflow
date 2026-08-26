/**
 * DartAdapter unit tests.
 *
 * Drives the adapter through an injected `fetchImpl` (see `scriptedFetch`) so
 * nothing touches the network — every route is matched by method + pathname
 * (+ optional query params) and the exact requests fired are captured for
 * assertion. Harness mirrors planeAdapter.test.ts.
 *
 * The emphasis is on what makes DART different from the other two providers
 * (see dartAdapter.ts's header), because that is where this adapter can be
 * wrong in ways the shared sync core cannot catch:
 *   - list responses OMIT the description, so listIssues must hydrate via
 *     GET /tasks/{id} — and a merge fed an un-hydrated null body would wipe a
 *     local one;
 *   - dartboards and statuses are addressed by TITLE, so a rename must fail
 *     LOUD rather than return an empty page the deletion sweep would act on;
 *   - one title can name a space AND a board at the same time ("Engineering"
 *     beside "Engineering/Sprint"), so group ids are namespaced and a
 *     container-scoped recovery reads the selection's narrowKind instead of
 *     guessing which of the two the title meant;
 *   - statuses carry no group, so inferStateGroup guesses from the name;
 *   - creates are not idempotent, so every create stamps the
 *     `cyboflow-sync: <clientKey>` recovery marker, which must be stripped from
 *     every description the adapter returns while its key is surfaced first on
 *     `recoveryClientKey`.
 */
import { describe, it, expect, vi } from 'vitest';
import { DartAdapter, inferStateGroup } from './dartAdapter';
import type { FetchLike } from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';
import type { TrackerSourceSelection } from '../../../../shared/types/trackerSync';

interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface RouteHandler {
  test: (method: string, pathname: string, params: URLSearchParams) => boolean;
  respond: (body: unknown, params: URLSearchParams) => { status: number; body?: unknown };
}

function mockResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function scriptedFetch(handlers: RouteHandler[]): { fetchImpl: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers, body });

    const { pathname, searchParams } = new URL(url);
    const handler = handlers.find((h) => h.test(method, pathname, searchParams));
    if (!handler) throw new Error(`scriptedFetch: unhandled request ${method} ${url}`);
    const { status, body: respBody } = handler.respond(body, searchParams);
    return mockResponse(respBody ?? {}, status);
  });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

const BOARD = 'Engineering/Sprint';
const SELECTION: TrackerSourceSelection = { containerId: BOARD, narrowId: 'all', narrowKind: 'all' };
/** An outbox client key, in the shape writeBack mints (randomUUID). */
const CLIENT_KEY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'; // gitleaks:allow — RFC 4122 example UUID, randomUUID-shaped fixture

const CONFIG = {
  dartboards: [BOARD, 'Design/Backlog'],
  statuses: ['To-do', 'Doing', 'Done', "Won't do"],
  // The probe workspace's real lists: priorities come back LOWERCASE here even
  // though task reads Title-case them, and none of the types is a category.
  types: ['Task', 'Subtask', 'Project', 'Milestone'],
  priorities: ['critical', 'high', 'medium', 'low'],
};

/** `GET /config` — needed by nearly every path. */
function configRoute(): RouteHandler {
  return {
    test: (m, p) => m === 'GET' && p.endsWith('/config'),
    respond: () => ({ status: 200, body: CONFIG }),
  };
}

/**
 * A workspace using the `"<Space>/<Board>"` convention: two boards under
 * Engineering, one under Design, one board outside any space. `/config` order is
 * what makes Engineering's FIRST board its default push target.
 */
const SPACE_CONFIG = {
  dartboards: [BOARD, 'Engineering/Backlog', 'Design/Board', 'Inbox'],
  statuses: CONFIG.statuses,
};

const SPACE_SELECTION: TrackerSourceSelection = {
  containerId: 'Engineering',
  narrowId: 'all',
  narrowKind: 'space',
  pushContainerId: BOARD,
};

function spaceConfigRoute(dartboards: string[] = SPACE_CONFIG.dartboards): RouteHandler {
  return {
    test: (m, p) => m === 'GET' && p.endsWith('/config'),
    respond: () => ({ status: 200, body: { ...SPACE_CONFIG, dartboards } }),
  };
}

/** `POST /tasks` echoing back what it was sent, with a server-minted id. */
function createRoute(): RouteHandler {
  return {
    test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
    respond: (body) => ({
      status: 200,
      body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
    }),
  };
}

/** `GET /tasks/list` returning one page of concise rows. */
function listRoute(rows: unknown[], assertParams?: (p: URLSearchParams) => void): RouteHandler {
  return {
    test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
    respond: (_b, params) => {
      assertParams?.(params);
      // Honour BOTH limit and offset — a stub that ignores limit hands back the
      // whole set on page one and would silently pass a broken pager.
      const offset = Number(params.get('offset') ?? '0');
      const limit = Number(params.get('limit') ?? String(rows.length));
      const page = rows.slice(offset, offset + limit);
      return {
        status: 200,
        body: { count: rows.length, next: offset + page.length < rows.length ? 'next' : null, results: page },
      };
    },
  };
}

/**
 * `GET /tasks/list` scoped by the `dartboard` param. A request carrying NO
 * dartboard gets EVERY row, exactly as the live endpoint would — which is what
 * makes an assertion on the returned union a mutation pin on the filter itself,
 * rather than on the fixture.
 */
function boardListRoute(
  byBoard: Record<string, Record<string, unknown>[]>,
  seen?: string[],
): RouteHandler {
  return {
    test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
    respond: (_b, params) => {
      const board = params.get('dartboard');
      seen?.push(board ?? '<unscoped>');
      const rows = board === null ? Object.values(byBoard).flat() : (byBoard[board] ?? []);
      const offset = Number(params.get('offset') ?? '0');
      const limit = Number(params.get('limit') ?? String(rows.length));
      const page = rows.slice(offset, offset + limit);
      return {
        status: 200,
        body: { count: rows.length, next: offset + page.length < rows.length ? 'next' : null, results: page },
      };
    },
  };
}

/** `GET /tasks/{id}` detail, keyed by id; an unknown id 404s. */
function makeDetailRoute(byId: Record<string, unknown | undefined>): RouteHandler {
  let lastPath = '';
  return {
    test: (m, p) => {
      const match = m === 'GET' && /\/tasks\/[^/]+$/.test(p) && !p.endsWith('/tasks/list');
      if (match) lastPath = p;
      return match;
    },
    respond: () => {
      const id = lastPath.slice(lastPath.lastIndexOf('/') + 1);
      const item = byId[id];
      return item === undefined ? { status: 404, body: { errors: ['Not found'] } } : { status: 200, body: { item } };
    },
  };
}

/** The body of the one `POST /tasks` in a captured call list. */
function postBody(calls: CapturedCall[]): unknown {
  const post = calls.find((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/tasks'));
  if (post === undefined) throw new Error('no POST /tasks was made');
  return post.body;
}

/** True for a `GET /tasks/{id}` detail call — NOT for `/tasks/list`. */
function isDetailCall(call: CapturedCall): boolean {
  const { pathname } = new URL(call.url);
  return /\/tasks\/[^/]+$/.test(pathname) && !pathname.endsWith('/tasks/list');
}

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'AbCdEfGhIjKl',
    htmlUrl: 'https://app.dartai.com/t/AbCdEfGhIjKl',
    title: 'Ship the thing',
    parentId: null,
    dartboard: BOARD,
    status: 'Doing',
    description: 'Body text',
    assignee: 'Krishna Kesteva',
    size: 3,
    updatedAt: '2026-08-16T10:00:00Z',
    ...over,
  };
}

/** The same task as `task()` minus the description — Dart's ConciseTask shape. */
function concise(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = task(over);
  delete row.description;
  return row;
}

// ---------------------------------------------------------------------------

describe('DartAdapter.validateCredentials', () => {
  it('binds identity to the Dart ACCOUNT, since the API exposes no workspace', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/me'),
        respond: () => ({
          status: 200,
          body: { isLoggedIn: true, user: { id: 'usr_1', name: 'Krishna Kesteva', email: 'k@example.com' } },
        }),
      },
    ]);
    const identity = await new DartAdapter({ apiKey: 'k', fetchImpl }).validateCredentials();
    expect(identity).toEqual({
      workspaceId: 'usr_1',
      workspaceName: 'k@example.com',
      actorLabel: 'Krishna Kesteva',
    });
    // Bearer auth, not Plane's X-API-Key header.
    expect(calls[0].headers.Authorization).toBe('Bearer k');
    expect(calls[0].url).toBe('https://app.dartai.com/api/v0/public/me');
  });

  it('treats a 200 with isLoggedIn:false as an AUTH failure, not a generic one', async () => {
    // Dart can answer "this token resolves to no session" without a 401; taking
    // the auth path is what pauses the connection instead of retrying forever.
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/me'),
        respond: () => ({ status: 200, body: { isLoggedIn: false, user: {} } }),
      },
    ]);
    await expect(new DartAdapter({ apiKey: 'k', fetchImpl }).validateCredentials()).rejects.toBeInstanceOf(
      TrackerAuthError,
    );
  });

  it('maps a 401 to TrackerAuthError', async () => {
    const { fetchImpl } = scriptedFetch([
      { test: (m, p) => m === 'GET' && p.endsWith('/me'), respond: () => ({ status: 401 }) },
    ]);
    await expect(new DartAdapter({ apiKey: 'bad', fetchImpl }).validateCredentials()).rejects.toBeInstanceOf(
      TrackerAuthError,
    );
  });
});

describe('DartAdapter.listFieldOptions', () => {
  it("returns the workspace's live priority and type lists off /config", async () => {
    const { fetchImpl, calls } = scriptedFetch([configRoute()]);
    const options = await new DartAdapter({ apiKey: 'k', fetchImpl }).listFieldOptions();
    expect(options).toEqual({
      priorities: ['critical', 'high', 'medium', 'low'],
      categories: ['Task', 'Subtask', 'Project', 'Milestone'],
    });
    expect(calls).toHaveLength(1);
  });

  it('carries both lists through the /config CACHE, not just the first response', async () => {
    // getConfig rebuilds a fresh literal from the response, so any key not
    // repeated in it is silently dropped for the rest of the pass. This calls a
    // DIFFERENT config-backed path first, so the values under test can only
    // come from the cached copy.
    const { fetchImpl, calls } = scriptedFetch([configRoute()]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    await adapter.listStates(SELECTION);
    const options = await adapter.listFieldOptions();
    expect(options.priorities).toEqual(['critical', 'high', 'medium', 'low']);
    expect(options.categories).toEqual(['Task', 'Subtask', 'Project', 'Milestone']);
    // One fetch total — the second read was served from the cache.
    expect(calls).toHaveLength(1);
  });

  it('reads a /config that omits either key as "nothing live to seed from"', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/config'),
        respond: () => ({ status: 200, body: { dartboards: [BOARD], statuses: ['To-do'] } }),
      },
    ]);
    const options = await new DartAdapter({ apiKey: 'k', fetchImpl }).listFieldOptions();
    expect(options).toEqual({ priorities: null, categories: null });
  });
});

describe('DartAdapter source discovery', () => {
  it('lists dartboards as containers whose id IS the title', async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    const tree = await new DartAdapter({ apiKey: 'k', fetchImpl }).listContainers();
    expect(tree.containerLabel).toBe('Dartboard');
    expect(tree.containers).toEqual([
      { id: BOARD, name: BOARD, key: null, openIssueCount: null },
      { id: 'Design/Backlog', name: 'Design/Backlog', key: null, openIssueCount: null },
    ]);
  });

  it('derives spaces from the dartboard-title prefix, pushing to the space’s first board', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/config'),
        respond: () => ({
          status: 200,
          body: {
            // Two boards under one space, plus a second space — /config order is
            // what makes the first board a stable push target.
            dartboards: [BOARD, 'Engineering/Backlog', 'Design/Backlog'],
            statuses: CONFIG.statuses,
          },
        }),
      },
    ]);

    const { sections } = await new DartAdapter({ apiKey: 'k', fetchImpl }).listGroups();

    expect(sections).toEqual([
      {
        label: 'Spaces',
        groups: [
          {
            id: 'space:Engineering',
            name: 'Engineering',
            key: null,
            sourceLabel: 'Engineering · whole space',
            selection: {
              containerId: 'Engineering',
              narrowId: 'all',
              narrowKind: 'space',
              // A create needs a concrete board; the space's first one is it.
              pushContainerId: BOARD,
            },
            // Dart statuses are workspace-wide, so every group shares a scope.
            stateScopeKey: 'workspace',
          },
          {
            id: 'space:Design',
            name: 'Design',
            key: null,
            sourceLabel: 'Design · whole space',
            selection: {
              containerId: 'Design',
              narrowId: 'all',
              narrowKind: 'space',
              pushContainerId: 'Design/Backlog',
            },
            stateScopeKey: 'workspace',
          },
        ],
      },
    ]);
  });

  it('falls back to per-board groups for titles with no space prefix, omitting the empty section', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/config'),
        respond: () => ({
          status: 200,
          // The '/' convention is observed, not enforced by Dart: a workspace
          // that ignores it must still be mappable.
          body: { dartboards: ['Tasks', 'Inbox'], statuses: CONFIG.statuses },
        }),
      },
    ]);

    const { sections } = await new DartAdapter({ apiKey: 'k', fetchImpl }).listGroups();

    expect(sections).toEqual([
      {
        label: 'Dartboards',
        groups: [
          {
            id: 'board:Tasks',
            name: 'Tasks',
            key: null,
            sourceLabel: 'Tasks',
            // The pre-rev-4 selection exactly: a plain dartboard scope.
            selection: { containerId: 'Tasks', narrowId: 'all', narrowKind: 'all' },
            stateScopeKey: 'workspace',
          },
          {
            id: 'board:Inbox',
            name: 'Inbox',
            key: null,
            sourceLabel: 'Inbox',
            selection: { containerId: 'Inbox', narrowId: 'all', narrowKind: 'all' },
            stateScopeKey: 'workspace',
          },
        ],
      },
    ]);
  });

  it('reads a LEADING slash as no space, not as an empty one', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/config'),
        respond: () => ({
          status: 200,
          body: { dartboards: ['/Odd', 'Engineering/Sprint'], statuses: CONFIG.statuses },
        }),
      },
    ]);

    const { sections } = await new DartAdapter({ apiKey: 'k', fetchImpl }).listGroups();

    expect(sections.map((s) => s.label)).toEqual(['Spaces', 'Dartboards']);
    expect(sections[0].groups.map((g) => g.id)).toEqual(['space:Engineering']);
    expect(sections[1].groups.map((g) => g.id)).toEqual(['board:/Odd']);
  });

  it('NAMESPACES group ids, so a board titled like a space is its own group', async () => {
    // The defect: both sections drew their id from the raw title, so a bare
    // board sharing a derived space's name minted two groups with ONE id — and
    // every wizard structure keyed on that id (the per-group project pick, the
    // push-target radio) conflated the two mappings.
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/config'),
        respond: () => ({
          status: 200,
          body: { dartboards: ['Engineering', 'Engineering/Sprint'], statuses: CONFIG.statuses },
        }),
      },
    ]);

    const { sections } = await new DartAdapter({ apiKey: 'k', fetchImpl }).listGroups();

    expect(sections.map((s) => s.label)).toEqual(['Spaces', 'Dartboards']);
    expect(sections[0].groups.map((g) => g.id)).toEqual(['space:Engineering']);
    expect(sections[1].groups.map((g) => g.id)).toEqual(['board:Engineering']);
    // Two groups, two ids, and the selections they carry are genuinely
    // different scopes — the space reads its member boards, the board reads
    // itself.
    expect(sections[0].groups[0].selection).toEqual({
      containerId: 'Engineering',
      narrowId: 'all',
      narrowKind: 'space',
      pushContainerId: 'Engineering/Sprint',
    });
    expect(sections[1].groups[0].selection).toEqual({
      containerId: 'Engineering',
      narrowId: 'all',
      narrowKind: 'all',
    });
  });

  it("offers only the whole-dartboard narrow, and it is the contract's 'all'", async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    const narrows = await new DartAdapter({ apiKey: 'k', fetchImpl }).listNarrows(BOARD);
    expect(narrows).toHaveLength(1);
    expect(narrows[0].id).toBe('all');
    expect(narrows[0].kind).toBe('all');
  });

  it('derives state groups from status NAMES, since Dart publishes none', async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    const states = await new DartAdapter({ apiKey: 'k', fetchImpl }).listStates(SELECTION);
    expect(states).toEqual([
      { id: 'To-do', name: 'To-do', color: null, group: 'unstarted' },
      { id: 'Doing', name: 'Doing', color: null, group: 'started' },
      { id: 'Done', name: 'Done', color: null, group: 'completed' },
      { id: "Won't do", name: "Won't do", color: null, group: 'cancelled' },
    ]);
  });

  it('caches /config across calls on one adapter instance', async () => {
    const { fetchImpl, calls } = scriptedFetch([configRoute()]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    await adapter.listContainers();
    await adapter.listStates(SELECTION);
    expect(calls.filter((c) => c.url.endsWith('/config'))).toHaveLength(1);
  });
});

describe('inferStateGroup', () => {
  it('checks cancelled BEFORE completed so a wont-do name is not claimed as done', () => {
    expect(inferStateGroup("Won't do")).toBe('cancelled');
    expect(inferStateGroup('Cancelled')).toBe('cancelled');
    expect(inferStateGroup('Duplicate')).toBe('cancelled');
    expect(inferStateGroup('Done')).toBe('completed');
    expect(inferStateGroup('Shipped')).toBe('completed');
  });

  it('recognizes the common in-flight and not-started names', () => {
    expect(inferStateGroup('In Progress')).toBe('started');
    expect(inferStateGroup('In Review')).toBe('started');
    expect(inferStateGroup('To-do')).toBe('unstarted');
    expect(inferStateGroup('Up next')).toBe('unstarted');
    expect(inferStateGroup('Triage')).toBe('triage');
    expect(inferStateGroup('Backlog')).toBe('backlog');
  });

  it("falls back to 'backlog' for a name it cannot place, rather than throwing", () => {
    // A guess only SEEDS the wizard's mapping defaults, which the user overrides
    // — so an unplaceable custom status must not break discovery.
    expect(inferStateGroup('Marinating')).toBe('backlog');
    expect(inferStateGroup('')).toBe('backlog');
  });
});

describe('DartAdapter.listIssues', () => {
  it('HYDRATES every row, because the list shape omits the description', async () => {
    const rows = [concise({ id: 'aaaaaaaaaaaa' }), concise({ id: 'bbbbbbbbbbbb' })];
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      listRoute(rows),
      makeDetailRoute({
        aaaaaaaaaaaa: task({ id: 'aaaaaaaaaaaa', description: 'First body' }),
        bbbbbbbbbbbb: task({ id: 'bbbbbbbbbbbb', description: 'Second body' }),
      }),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issues.map((i) => i.description)).toEqual(['First body', 'Second body']);
    // One detail fetch per listed task — the cost the hydration note documents.
    expect(calls.filter(isDetailCall)).toHaveLength(2);
  });

  it('maps the full TrackerIssue shape off a hydrated task', async () => {
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise()]),
      makeDetailRoute({ AbCdEfGhIjKl: task() }),
    ]);
    const [issue] = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issue).toEqual({
      externalId: 'AbCdEfGhIjKl',
      identifier: 'AbCdEfGhIjKl',
      title: 'Ship the thing',
      description: 'Body text',
      url: 'https://app.dartai.com/t/AbCdEfGhIjKl',
      stateId: 'Doing',
      assignee: { id: 'Krishna Kesteva', name: 'Krishna Kesteva', initials: 'KK' },
      estimate: 3,
      parentExternalId: null,
      updatedAt: '2026-08-16T10:00:00Z',
      archivedAt: null,
      // The fixture task carries neither key — Dart's omit-when-null shape —
      // and both read back as null.
      priority: null,
      category: null,
      recoveryClientKey: null,
    });
  });

  it('reads an ABSENT priority/type key as null — Dart omits null fields entirely', async () => {
    // MEASURED (probe D2/D8): clearing a priority makes the key VANISH from
    // every payload rather than come back as `priority: null`, so "absent" is
    // the only spelling of unset and the adapter must not confuse it with a
    // field it forgot to read.
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise()]),
      makeDetailRoute({ AbCdEfGhIjKl: task() }),
    ]);
    const [issue] = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issue.priority).toBeNull();
    expect(issue.category).toBeNull();
  });

  it("surfaces a present priority/type verbatim, in Dart's Title case", async () => {
    // Reads come back Title-cased while /config lists lowercase; the raw token
    // is passed through untouched and the mapping matches case-insensitively.
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise()]),
      makeDetailRoute({ AbCdEfGhIjKl: task({ priority: 'Critical', type: 'Bug' }) }),
    ]);
    const [issue] = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issue.priority).toBe('Critical');
    expect(issue.category).toBe('Bug');
  });

  it('drops a row whose detail fetch 404s rather than returning a null-bodied issue', async () => {
    // A half-populated issue would merge as "the remote body was cleared" and
    // wipe the local one — so a task deleted between list and hydrate is dropped.
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'aaaaaaaaaaaa' }), concise({ id: 'gonegonegone' })]),
      makeDetailRoute({ aaaaaaaaaaaa: task({ id: 'aaaaaaaaaaaa' }) }),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issues.map((i) => i.externalId)).toEqual(['aaaaaaaaaaaa']);
  });

  it('widens the server-side since bound but applies an INCLUSIVE one client-side', async () => {
    const since = '2026-08-16T10:00:00.000Z';
    let sentAfter: string | null = null;
    const rows = [
      concise({ id: 'onbound00000', updatedAt: since }),
      concise({ id: 'older0000000', updatedAt: '2026-08-16T09:59:59.500Z' }),
      concise({ id: 'newer0000000', updatedAt: '2026-08-16T10:00:01.000Z' }),
    ];
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute(rows, (p) => {
        sentAfter = p.get('updated_at_after');
      }),
      makeDetailRoute({
        onbound00000: task({ id: 'onbound00000', updatedAt: since }),
        older0000000: task({ id: 'older0000000', updatedAt: '2026-08-16T09:59:59.500Z' }),
        newer0000000: task({ id: 'newer0000000', updatedAt: '2026-08-16T10:00:01.000Z' }),
      }),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION, since);
    // Sent a second EARLIER, so the contract holds under gt or gte semantics...
    expect(sentAfter).toBe('2026-08-16T09:59:59.000Z');
    // ...and the exact inclusive bound is enforced here: the on-bound task is
    // KEPT, the one half a second older is dropped.
    expect(issues.map((i) => i.externalId).sort()).toEqual(['newer0000000', 'onbound00000']);
  });

  it('fails LOUD on EVERY dartboard-scoped path when the title no longer exists', async () => {
    // A renamed dartboard makes GET /tasks/list answer 200 with an EMPTY page
    // (measured against a live space, not assumed). Each path below reads that
    // emptiness as a different lie: listIssueIds hands the deletion sweep
    // "everything was deleted", and findIssueByClientKey hands the outbox
    // "the create never landed" — which requeues a create that may already
    // have committed. No POST route is scripted, so a create that reached the
    // network would fail as an unhandled request instead.
    const { fetchImpl } = scriptedFetch([configRoute(), listRoute([])]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    const stale: TrackerSourceSelection = { containerId: 'Renamed/Board', narrowId: 'all', narrowKind: 'all' };
    await expect(adapter.listIssues(stale)).rejects.toThrow(/no longer exists/i);
    await expect(adapter.listIssueIds(stale)).rejects.toThrow(/no longer exists/i);
    await expect(adapter.createIssue(stale, { title: 'T' }, CLIENT_KEY)).rejects.toThrow(/no longer exists/i);
    await expect(
      adapter.findIssueByClientKey({ containerId: 'Renamed/Board', parentExternalId: null }, CLIENT_KEY),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('guards the parent-scoped recovery arm with a point GET, never a /config round-trip', async () => {
    // parent_id addressing cannot be invalidated by a dartboard rename, so that
    // arm still must not pay for /config — but it CAN be invalidated by a
    // trashed parent, so the parent's own existence is confirmed first.
    const rows = [concise({ id: 'childchild00' })];
    const { fetchImpl, calls } = scriptedFetch([
      listRoute(rows),
      makeDetailRoute({
        parentparent: task({ id: 'parentparent' }),
        childchild00: task({ id: 'childchild00', description: `x\n\ncyboflow-sync: ${CLIENT_KEY}` }),
      }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: null, parentExternalId: 'parentparent' },
      CLIENT_KEY,
    );
    expect(found?.externalId).toBe('childchild00');
    expect(calls.some((c) => new URL(c.url).pathname.endsWith('/config'))).toBe(false);
    expect(calls.some((c) => new URL(c.url).pathname.endsWith('/tasks/parentparent'))).toBe(true);
  });

  it('fails LOUD when the recovery parent itself was trashed', async () => {
    // A trashed Dart task 404s on GET /tasks/{id} and is absent from listings,
    // so a parent_id filter naming it answers 200 with an EMPTY page — which the
    // outbox reads as "the create never landed" and requeues a create that may
    // already have committed. Same hazard class as the renamed dartboard, same
    // loud failure. No POST route is scripted, so a create that reached the
    // network would surface as an unhandled request instead.
    const { fetchImpl } = scriptedFetch([listRoute([]), makeDetailRoute({})]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
        { containerId: null, parentExternalId: 'goneparent00' },
        CLIENT_KEY,
      ),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('paginates to exhaustion via limit/offset', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => concise({ id: `id${String(i).padStart(10, '0')}` }));
    const detail: Record<string, unknown> = {};
    for (const r of rows) detail[r.id as string] = task({ id: r.id });
    const { fetchImpl, calls } = scriptedFetch([configRoute(), listRoute(rows), makeDetailRoute(detail)]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SELECTION);
    expect(ids).toHaveLength(250);
    const listCalls = calls.filter((c) => new URL(c.url).pathname.endsWith('/tasks/list'));
    expect(listCalls).toHaveLength(3);
    expect(new URL(listCalls[1].url).searchParams.get('offset')).toBe('100');
  });

  it('scopes BOTH list paths to the selected dartboard', async () => {
    // Without this, deleting `dartboard: selection.containerId` from either
    // list path still passes every other test in this file — while the live
    // adapter imports the WHOLE space into the connection and hands the
    // deletion sweep a superset id list.
    const seen: string[] = [];
    const rows = [concise({ id: 'scoped000000' })];
    const routes = (): RouteHandler[] => [
      configRoute(),
      listRoute(rows, (params) => seen.push(String(params.get('dartboard')))),
      makeDetailRoute({ scoped000000: task({ id: 'scoped000000' }) }),
    ];
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl: scriptedFetch(routes()).fetchImpl });
    await adapter.listIssues(SELECTION);
    await adapter.listIssueIds(SELECTION);
    expect(seen).toEqual([BOARD, BOARD]);
  });

  it('keeps paging on `count` when `next` is ABSENT — the schema allows that page', async () => {
    // count and results are REQUIRED in PaginatedConciseTaskList; next is
    // optional AND nullable. A server that simply omits `next` while count says
    // more rows exist is therefore schema-valid, and stopping there would hand
    // the deletion sweep a truncated id set.
    const rows = Array.from({ length: 250 }, (_, i) => concise({ id: `id${String(i).padStart(10, '0')}` }));
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          const offset = Number(params.get('offset') ?? '0');
          const limit = Number(params.get('limit') ?? '100');
          // NOTE: no `next` key at all, on any page.
          return { status: 200, body: { count: rows.length, results: rows.slice(offset, offset + limit) } };
        },
      },
    ]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SELECTION);
    expect(ids).toHaveLength(250);
  });

  it('stops on an over-reported `count` instead of spinning', async () => {
    // The empty-page guard is what keeps a lying count from looping forever.
    const rows = [concise({ id: 'onlyoneofthm' })];
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          const offset = Number(params.get('offset') ?? '0');
          return { status: 200, body: { count: 9999, results: rows.slice(offset, offset + 100) } };
        },
      },
    ]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SELECTION);
    expect(ids).toEqual(['onlyoneofthm']);
    expect(calls.filter((c) => new URL(c.url).pathname.endsWith('/tasks/list'))).toHaveLength(2);
  });

  it('does NOT hydrate for listIssueIds — the sweep only needs ids', async () => {
    const rows = [concise({ id: 'aaaaaaaaaaaa' }), concise({ id: 'bbbbbbbbbbbb' })];
    const { fetchImpl, calls } = scriptedFetch([configRoute(), listRoute(rows)]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SELECTION);
    expect(ids).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(calls.some(isDetailCall)).toBe(false);
  });
});

describe('DartAdapter space-scoped selections', () => {
  const sprintRows = [concise({ id: 'engsprint001' }), concise({ id: 'engsprint002' })];
  const backlogRows = [concise({ id: 'engbacklog01' })];
  const designRows = [concise({ id: 'designbrd001' })];
  const BY_BOARD: Record<string, Record<string, unknown>[]> = {
    [BOARD]: sprintRows,
    'Engineering/Backlog': backlogRows,
    'Design/Board': designRows,
    Inbox: [],
  };
  const DETAIL: Record<string, unknown> = Object.fromEntries(
    [...sprintRows, ...backlogRows, ...designRows].map((row) => [row.id, task({ id: row.id })]),
  );

  it('unions the member boards, one dartboard-scoped fetch each, in /config order', async () => {
    // Dropping the `dartboard` param from the fetch would hand back every row in
    // the workspace (the mock answers an unscoped list the way Dart does), so
    // the Design board's task appearing here is the mutation this pins.
    const seen: string[] = [];
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(),
      boardListRoute(BY_BOARD, seen),
      makeDetailRoute(DETAIL),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SPACE_SELECTION);
    expect(seen).toEqual([BOARD, 'Engineering/Backlog']);
    // Concatenation, not a merge: a Dart task carries exactly one dartboard, so
    // two member boards can never return the same task.
    expect(issues.map((i) => i.externalId)).toEqual(['engsprint001', 'engsprint002', 'engbacklog01']);
  });

  it('unions the member boards for listIssueIds too, still WITHOUT hydration', async () => {
    const seen: string[] = [];
    const { fetchImpl, calls } = scriptedFetch([spaceConfigRoute(), boardListRoute(BY_BOARD, seen)]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SPACE_SELECTION);
    expect(seen).toEqual([BOARD, 'Engineering/Backlog']);
    expect(ids).toEqual(['engsprint001', 'engsprint002', 'engbacklog01']);
    // The sweep stays cheap however many boards a space holds.
    expect(calls.some(isDetailCall)).toBe(false);
  });

  it('carries the since bound onto EVERY member board', async () => {
    const since = '2026-08-16T10:00:00.000Z';
    const sentAfter: (string | null)[] = [];
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          sentAfter.push(params.get('updated_at_after'));
          const rows = BY_BOARD[String(params.get('dartboard'))] ?? [];
          return { status: 200, body: { count: rows.length, next: null, results: rows } };
        },
      },
      makeDetailRoute(DETAIL),
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SPACE_SELECTION, since);
    expect(sentAfter).toEqual(['2026-08-16T09:59:59.000Z', '2026-08-16T09:59:59.000Z']);
  });

  it('fails LOUD on a space whose member boards are all gone, not with an empty page', async () => {
    // Same hazard as a renamed dartboard: a space is DERIVED from titles, so a
    // prefix nothing matches unions to zero rows — which listIssueIds would hand
    // the deletion sweep as "every task in this space was deleted remotely".
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(['Design/Board', 'Inbox']),
      boardListRoute(BY_BOARD),
      createRoute(),
    ]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    await expect(adapter.listIssues(SPACE_SELECTION)).rejects.toThrow(/no longer exists/i);
    await expect(adapter.listIssueIds(SPACE_SELECTION)).rejects.toThrow(/no longer exists/i);
    await expect(adapter.createIssue(SPACE_SELECTION, { title: 'T' }, CLIENT_KEY)).rejects.toThrow(
      /no longer exists/i,
    );
  });

  it('does not let one space claim another whose name it prefixes', async () => {
    const seen: string[] = [];
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(['Design/Board', 'DesignOps/Board']),
      boardListRoute({ 'Design/Board': designRows, 'DesignOps/Board': [concise({ id: 'opsboard0001' })] }, seen),
      makeDetailRoute(DETAIL),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues({
      containerId: 'Design',
      narrowId: 'all',
      narrowKind: 'space',
    });
    expect(seen).toEqual(['Design/Board']);
    expect(issues.map((i) => i.externalId)).toEqual(['designbrd001']);
  });

  it('files a create on the space selection pushContainerId', async () => {
    const { fetchImpl, calls } = scriptedFetch([spaceConfigRoute(), createRoute()]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      { ...SPACE_SELECTION, pushContainerId: 'Engineering/Backlog' },
      { title: 'New task' },
      CLIENT_KEY,
    );
    expect((postBody(calls) as { item: Record<string, unknown> }).item.dartboard).toBe('Engineering/Backlog');
  });

  it('refuses a pushContainerId that is no longer a member of the space', async () => {
    // The push target was persisted at connect time; a create filed on a board
    // this connection does not READ would sync outbound once and then never be
    // seen again. No POST route is scripted, so a create that reached the
    // network would fail as an unhandled request instead of passing quietly.
    const { fetchImpl } = scriptedFetch([spaceConfigRoute(), boardListRoute(BY_BOARD)]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
        { ...SPACE_SELECTION, pushContainerId: 'Design/Board' },
        { title: 'T' },
        CLIENT_KEY,
      ),
    ).rejects.toThrow(/not part of the Dart space/i);
  });

  it("falls back to the space's first board when the selection carries no push target", async () => {
    const { fetchImpl, calls } = scriptedFetch([spaceConfigRoute(), createRoute()]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      { containerId: 'Engineering', narrowId: 'all', narrowKind: 'space' },
      { title: 'T' },
      CLIENT_KEY,
    );
    expect((postBody(calls) as { item: Record<string, unknown> }).item.dartboard).toBe(BOARD);
  });

  it('scans EVERY member board for the recovery marker', async () => {
    // The outbox records a containerId with no narrowKind, so a space name
    // arrives here looking like a dartboard — and `dartboard=Engineering` matches
    // nothing, which the outbox would read as PROOF the create never landed.
    const seen: string[] = [];
    const marked = task({ id: 'engbacklog01', description: `Body\n\ncyboflow-sync: ${CLIENT_KEY}` });
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(),
      boardListRoute(BY_BOARD, seen),
      makeDetailRoute({ ...DETAIL, engbacklog01: marked }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: 'Engineering', parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found?.externalId).toBe('engbacklog01');
    expect(seen).not.toContain('Engineering');
    expect(new Set(seen)).toEqual(new Set([BOARD, 'Engineering/Backlog']));
  });

  /** A workspace where one bare board is titled exactly like a derived space. */
  const COLLIDING = ['Engineering', BOARD, 'Engineering/Backlog'];
  const COLLIDING_BY_BOARD: Record<string, Record<string, unknown>[]> = {
    Engineering: [concise({ id: 'bareboard001' })],
    [BOARD]: sprintRows,
    'Engineering/Backlog': backlogRows,
  };

  it('recovers on the selection narrowKind, never GUESSING between a space and a board of one title', async () => {
    // The defect: the recovery boards were guessed from the title alone, and a
    // bare board titled like the space wins that guess — so a space-scoped
    // create was hunted on one unrelated board, came back empty, and the outbox
    // read the empty result as PROOF the create never landed and filed it twice.
    const seen: string[] = [];
    const marked = task({ id: 'engbacklog01', description: `Body\n\ncyboflow-sync: ${CLIENT_KEY}` });
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(COLLIDING),
      boardListRoute(COLLIDING_BY_BOARD, seen),
      makeDetailRoute({ ...DETAIL, bareboard001: task({ id: 'bareboard001' }), engbacklog01: marked }),
    ]);

    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: 'Engineering', narrowKind: 'space', parentExternalId: null },
      CLIENT_KEY,
    );

    expect(found?.externalId).toBe('engbacklog01');
    expect(seen).not.toContain('Engineering');
    expect(new Set(seen)).toEqual(new Set([BOARD, 'Engineering/Backlog']));
  });

  it('keeps a plain-board recovery on that ONE board, and fails loud when the title is not a board', async () => {
    // The other half of the same authority: with a narrowKind the caller is
    // believed, so the same title under 'all' searches the bare BOARD and
    // nothing under the space that shares its name.
    const seen: string[] = [];
    const marked = task({ id: 'bareboard001', description: `Body\n\ncyboflow-sync: ${CLIENT_KEY}` });
    const { fetchImpl } = scriptedFetch([
      spaceConfigRoute(COLLIDING),
      boardListRoute(COLLIDING_BY_BOARD, seen),
      makeDetailRoute({ ...DETAIL, bareboard001: marked }),
    ]);

    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: 'Engineering', narrowKind: 'all', parentExternalId: null },
      CLIENT_KEY,
    );

    expect(found?.externalId).toBe('bareboard001');
    expect(new Set(seen)).toEqual(new Set(['Engineering']));

    // And a board scope naming a title that is only a SPACE prefix is the
    // renamed/deleted case — the kind rules out the space reading entirely.
    const { fetchImpl: noBareBoard } = scriptedFetch([spaceConfigRoute(), boardListRoute(BY_BOARD)]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl: noBareBoard }).findIssueByClientKey(
        { containerId: 'Engineering', narrowKind: 'all', parentExternalId: null },
        CLIENT_KEY,
      ),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('still fails LOUD in recovery for a title that is neither a board nor a space', async () => {
    const { fetchImpl } = scriptedFetch([spaceConfigRoute(), boardListRoute(BY_BOARD)]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
        { containerId: 'Renamed', parentExternalId: null },
        CLIENT_KEY,
      ),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('keeps a PLAIN board selection on that one board, siblings in its space included', async () => {
    // The pre-rev-4 behaviour, byte-identical: narrowKind 'all' names a
    // dartboard, never the space its title happens to sit under.
    const seen: string[] = [];
    const { fetchImpl, calls } = scriptedFetch([
      spaceConfigRoute(),
      boardListRoute(BY_BOARD, seen),
      makeDetailRoute(DETAIL),
      createRoute(),
    ]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    const issues = await adapter.listIssues(SELECTION);
    expect(issues.map((i) => i.externalId)).toEqual(['engsprint001', 'engsprint002']);
    expect(await adapter.listIssueIds(SELECTION)).toEqual(['engsprint001', 'engsprint002']);
    expect(seen).toEqual([BOARD, BOARD]);
    await adapter.createIssue(SELECTION, { title: 'T' }, CLIENT_KEY);
    expect((postBody(calls) as { item: Record<string, unknown> }).item.dartboard).toBe(BOARD);
  });
});

describe('DartAdapter.getIssue', () => {
  it('returns null on 404 so the sweep can tell "deleted" from "failed"', async () => {
    const { fetchImpl } = scriptedFetch([makeDetailRoute({})]);
    expect(await new DartAdapter({ apiKey: 'k', fetchImpl }).getIssue('missing00000')).toBeNull();
  });
});

describe('DartAdapter creates', () => {
  it('stamps the recovery marker into every create and enveloped as { item }', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => {
          const item = (body as { item: Record<string, unknown> }).item;
          return { status: 200, body: { item: task({ ...item, id: 'newnewnewnew' }) } };
        },
      },
    ]);
    const issue = await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      SELECTION,
      { title: 'New task', description: 'Do the work' },
      CLIENT_KEY,
    );
    expect(postBody(calls)).toEqual({
      item: {
        dartboard: BOARD,
        title: 'New task',
        description: `Do the work\n\ncyboflow-sync: ${CLIENT_KEY}`,
      },
    });
    // The marker is plumbing: stripped from the returned description, but its
    // key surfaced first so the inbound pass can recognize a lost create.
    expect(issue.description).toBe('Do the work');
    expect(issue.recoveryClientKey).toBe(CLIENT_KEY);
  });

  it('stamps the marker even on an EMPTY body — the absence proof depends on it', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      makeDetailRoute({ parentparent: task({ id: 'parentparent', dartboard: BOARD }) }),
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => ({
          status: 200,
          body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
        }),
      },
    ]);
    const issue = await new DartAdapter({ apiKey: 'k', fetchImpl }).createSubIssue(
      'parentparent',
      { title: 'Child' },
      CLIENT_KEY,
    );
    const sent = (postBody(calls) as { item: Record<string, unknown> }).item;
    expect(sent.description).toBe(`cyboflow-sync: ${CLIENT_KEY}`);
    expect(sent.parentId).toBe('parentparent');
    // A body that is NOTHING but the marker reads as an empty description.
    expect(issue.description).toBeNull();
  });

  it('files a sub-issue on the PARENT\'s dartboard, not the account default', async () => {
    // MEASURED against a live Dart space: a `parentId`-only create lands the
    // child on the API user's DEFAULT dartboard, which this connection's
    // dartboard-scoped listIssues/listIssueIds can never see. The parent's own
    // board must therefore be read and named explicitly.
    const { fetchImpl, calls } = scriptedFetch([
      makeDetailRoute({ parentparent: task({ id: 'parentparent', dartboard: 'Design/Backlog' }) }),
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => ({
          status: 200,
          body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
        }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createSubIssue(
      'parentparent',
      { title: 'Child' },
      CLIENT_KEY,
    );
    const sent = (postBody(calls) as { item: Record<string, unknown> }).item;
    expect(sent.dartboard).toBe('Design/Backlog');
    expect(sent.parentId).toBe('parentparent');
  });

  it('refuses to mirror under a parent that no longer exists, TERMINALLY', async () => {
    // 404 (not a null status) so the outbox drops the row instead of pinning it
    // on a retry that can never succeed.
    const { fetchImpl } = scriptedFetch([makeDetailRoute({})]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).createSubIssue('goneparentx0', { title: 'C' }, CLIENT_KEY),
    ).rejects.toMatchObject({ name: 'TrackerApiError', status: 404 });
  });

  it('passes the initial state through as the status title', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => ({
          status: 200,
          body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
        }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      SELECTION,
      { title: 'T', stateId: 'Doing' },
      CLIENT_KEY,
    );
    expect((postBody(calls) as { item: Record<string, unknown> }).item.status).toBe('Doing');
  });
});

describe('DartAdapter.updateIssueState', () => {
  it('PUTs the id inside the item as well as on the path', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'PUT' && /\/tasks\/[^/]+$/.test(p),
        respond: () => ({ status: 200, body: { item: task({ status: 'Done' }) } }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).updateIssueState('AbCdEfGhIjKl', 'Done');
    expect(new URL(calls[0].url).pathname).toBe('/api/v0/public/tasks/AbCdEfGhIjKl');
    expect(calls[0].body).toEqual({ item: { id: 'AbCdEfGhIjKl', status: 'Done' } });
  });
});

describe('DartAdapter.updateIssueContent', () => {
  it('PUTs only the patched keys, and returns the mapped post-write issue (the echo-suppression stamp source)', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'PUT' && /\/tasks\/[^/]+$/.test(p),
        respond: (body) => ({ status: 200, body: { item: task({ ...(body as { item: object }).item }) } }),
      },
    ]);
    const issue = await new DartAdapter({ apiKey: 'k', fetchImpl }).updateIssueContent('AbCdEfGhIjKl', {
      priority: 'High',
      category: 'Bug',
    });
    expect(calls[0].body).toEqual({
      item: { id: 'AbCdEfGhIjKl', priority: 'High', type: 'Bug' },
    });
    expect(issue?.priority).toBe('High');
    expect(issue?.category).toBe('Bug');
  });

  it('leaves an unpatched field alone — undefined never reaches the PUT body', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'PUT' && /\/tasks\/[^/]+$/.test(p),
        respond: (body) => ({ status: 200, body: { item: task({ ...(body as { item: object }).item }) } }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).updateIssueContent('AbCdEfGhIjKl', { title: 'New title' });
    expect(calls[0].body).toEqual({ item: { id: 'AbCdEfGhIjKl', title: 'New title' } });
  });

  it('sends description VERBATIM — the caller owns marker re-append, not this adapter', async () => {
    const bodyWithMarker = `New body\n\ncyboflow-sync: ${CLIENT_KEY}`;
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'PUT' && /\/tasks\/[^/]+$/.test(p),
        respond: (body) => ({ status: 200, body: { item: task({ ...(body as { item: object }).item }) } }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).updateIssueContent('AbCdEfGhIjKl', {
      description: bodyWithMarker,
    });
    expect((calls[0].body as { item: Record<string, unknown> }).item.description).toBe(bodyWithMarker);
  });

  it('sends null to CLEAR priority/category — Dart\'s own clearing value', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'PUT' && /\/tasks\/[^/]+$/.test(p),
        respond: () => ({ status: 200, body: { item: task() } }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).updateIssueContent('AbCdEfGhIjKl', {
      priority: null,
      category: null,
    });
    expect(calls[0].body).toEqual({ item: { id: 'AbCdEfGhIjKl', priority: null, type: null } });
  });

  it('drops the memoized copy of a task it just wrote to (invariant 10)', async () => {
    // Same shape as the updateIssueState cache test above: a fixed GET route,
    // so a cache hit and a cache miss return identical bodies — the only
    // observable difference is whether the SECOND getIssue reaches the
    // network at all.
    const { fetchImpl, calls } = scriptedFetch([
      makeDetailRoute({ AbCdEfGhIjKl: task() }),
      {
        test: (m, p) => m === 'PUT' && p.endsWith('/tasks/AbCdEfGhIjKl'),
        respond: () => ({ status: 200, body: { item: task({ status: 'Done' }) } }),
      },
    ]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });

    await adapter.getIssue('AbCdEfGhIjKl');
    await adapter.updateIssueContent('AbCdEfGhIjKl', { title: 'x' });
    await adapter.getIssue('AbCdEfGhIjKl');

    // Both getIssue calls reached the network — nothing served from a stale cache.
    expect(calls.filter((c) => c.method === 'GET' && isDetailCall(c))).toHaveLength(2);
  });
});

describe('DartAdapter.archiveIssue', () => {
  it('DELETEs /tasks/{id}', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'DELETE' && /\/tasks\/[^/]+$/.test(p),
        respond: () => ({ status: 200, body: { item: task() } }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).archiveIssue('AbCdEfGhIjKl');
    expect(calls[0].method).toBe('DELETE');
    expect(new URL(calls[0].url).pathname).toBe('/api/v0/public/tasks/AbCdEfGhIjKl');
  });

  it('resolves without error on a 404 — the twin was already trashed/deleted (probe D5)', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'DELETE' && /\/tasks\/[^/]+$/.test(p),
        respond: () => ({ status: 404, body: { errors: ['Task with ID … not found'] } }),
      },
    ]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).archiveIssue('AbCdEfGhIjKl'),
    ).resolves.toBeUndefined();
  });

  it('still fails loud on a genuine non-404 error', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'DELETE' && /\/tasks\/[^/]+$/.test(p),
        respond: () => ({ status: 500, body: {} }),
      },
    ]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).archiveIssue('AbCdEfGhIjKl'),
    ).rejects.toMatchObject({ name: 'TrackerApiError', status: 500 });
  });

  it('drops the memoized copy on archive too, even on the 404 idempotent path (invariant 10)', async () => {
    const byId: Record<string, unknown> = { AbCdEfGhIjKl: task() };
    const { fetchImpl } = scriptedFetch([
      makeDetailRoute(byId),
      {
        test: (m, p) => m === 'DELETE' && /\/tasks\/[^/]+$/.test(p),
        respond: () => {
          delete byId.AbCdEfGhIjKl;
          return { status: 404, body: {} };
        },
      },
    ]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });

    expect(await adapter.getIssue('AbCdEfGhIjKl')).not.toBeNull();
    await adapter.archiveIssue('AbCdEfGhIjKl');
    // A cached "present" copy would have hidden the trash from this pass's
    // own next read; the cache must be dropped even though the DELETE 404'd.
    expect(await adapter.getIssue('AbCdEfGhIjKl')).toBeNull();
  });
});

describe('DartAdapter creates — draft priority/category', () => {
  it('sends draft.priority/category in the item when present', async () => {
    const { fetchImpl, calls } = scriptedFetch([configRoute(), createRoute()]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      SELECTION,
      { title: 'T', priority: 'High', category: 'Bug' },
      CLIENT_KEY,
    );
    const sent = (postBody(calls) as { item: Record<string, unknown> }).item;
    expect(sent.priority).toBe('High');
    expect(sent.type).toBe('Bug');
  });

  it('omits priority/type entirely when the draft does not carry them', async () => {
    const { fetchImpl, calls } = scriptedFetch([configRoute(), createRoute()]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(SELECTION, { title: 'T' }, CLIENT_KEY);
    const sent = (postBody(calls) as { item: Record<string, unknown> }).item;
    expect(sent).not.toHaveProperty('priority');
    expect(sent).not.toHaveProperty('type');
  });
});

describe('DartAdapter.findIssueByClientKey', () => {
  const marked = task({ id: 'foundfoundfo', description: `Body\n\ncyboflow-sync: ${CLIENT_KEY}` });

  it('adopts the marked task via the server-side description fast path', async () => {
    let filterUsed: string | null = null;
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          filterUsed = params.get('description');
          return {
            status: 200,
            body: { count: 1, next: null, results: [concise({ id: 'foundfoundfo' })] },
          };
        },
      },
      makeDetailRoute({ foundfoundfo: marked }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(filterUsed).toBe(`cyboflow-sync: ${CLIENT_KEY}`);
    expect(found?.externalId).toBe('foundfoundfo');
    // The marker never reaches the mapped description.
    expect(found?.description).toBe('Body');
  });

  it('FALLS BACK to a full scan when the description filter matches nothing', async () => {
    // The filter's semantics (exact vs contains) are unspecified, so a miss must
    // cost time, never correctness — trusting it would duplicate a landed create.
    let sawFilteredCall = false;
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          if (params.get('description') !== null) {
            sawFilteredCall = true;
            // Simulate an EXACT-match filter: no hit despite the task existing.
            return { status: 200, body: { count: 0, next: null, results: [] } };
          }
          return {
            status: 200,
            body: { count: 1, next: null, results: [concise({ id: 'foundfoundfo' })] },
          };
        },
      },
      makeDetailRoute({ foundfoundfo: marked }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(sawFilteredCall).toBe(true);
    expect(found?.externalId).toBe('foundfoundfo');
  });

  it('adopts a task whose marker line Dart REFLOWED', async () => {
    // Dart normalizes stored markdown (it re-emits emphasis, reflows lists, and
    // linkifies dotted tokens), so the description that comes back is not always
    // the one that went out. A literal substring match on the marker treats a
    // reflowed line as "no such task" — which the outbox reads as proof the
    // create never landed, so it POSTs again and duplicates it. Parsing the key
    // is what keeps a mangled body recoverable.
    const reflowed = task({
      id: 'foundfoundfo',
      description: `Body\n\ncyboflow-sync:\n  ${CLIENT_KEY}`,
    });
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'foundfoundfo' })]),
      makeDetailRoute({ foundfoundfo: reflowed }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found?.externalId).toBe('foundfoundfo');
    // Recognized AND stripped — the two must stay in lockstep, or the marker
    // leaks into the local idea body.
    expect(found?.description).toBe('Body');
    expect(found?.recoveryClientKey).toBe(CLIENT_KEY);
  });

  it('does NOT adopt a task carrying a DIFFERENT key', async () => {
    // Loosening the whitespace must not loosen the identity: the UUID is the
    // whole proof, and adopting a sibling create would redirect every later
    // write-back onto it.
    const other = task({
      id: 'siblingsibs1',
      description: `cyboflow-sync: 11111111-2222-3333-4444-555555555555`,
    });
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'siblingsibs1' })]),
      makeDetailRoute({ siblingsibs1: other }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found).toBeNull();
  });

  it('returns null when nothing carries the key — the proof a retry is safe', async () => {
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'siblingsibs1' })]),
      makeDetailRoute({ siblingsibs1: task({ id: 'siblingsibs1', description: 'Unrelated' }) }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found).toBeNull();
  });

  it('does NOT adopt a same-title sibling that lacks the key', async () => {
    // Title is deliberately not a criterion: adopting the wrong task would
    // redirect every later write-back onto an unrelated one.
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'twintwintwin', title: 'Ship the thing' })]),
      makeDetailRoute({
        twintwintwin: task({ id: 'twintwintwin', title: 'Ship the thing', description: 'No marker here' }),
      }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found).toBeNull();
  });

  it('scopes to one parent via the server-side parent_id filter when given one', async () => {
    let sentParent: string | null = null;
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          sentParent = params.get('parent_id');
          return { status: 200, body: { count: 1, next: null, results: [concise({ id: 'foundfoundfo' })] } };
        },
      },
      // The parent must resolve: the arm confirms it exists before filtering.
      makeDetailRoute({ parentparent: task({ id: 'parentparent' }), foundfoundfo: marked }),
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: null, parentExternalId: 'parentparent' },
      CLIENT_KEY,
    );
    expect(sentParent).toBe('parentparent');
  });

  it('refuses a scope with neither a parent nor a dartboard', async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
        { containerId: null, parentExternalId: null },
        CLIENT_KEY,
      ),
    ).rejects.toBeInstanceOf(TrackerApiError);
  });
});

describe('DartAdapter recovery-scan cost bounds', () => {
  const marked = task({ id: 'foundfoundfo', description: `Body\n\ncyboflow-sync: ${CLIENT_KEY}` });

  /**
   * `GET /tasks/list` that HONOURS `updated_at_after` the way Dart does, so an
   * assertion on which tasks came back is a pin on the request the adapter
   * actually sent rather than on the fixture.
   */
  function sinceAwareListRoute(
    rows: Record<string, unknown>[],
    seen: { since: string | null | undefined }[],
  ): RouteHandler {
    return {
      test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
      respond: (_b, params) => {
        seen.push({ since: params.get('updated_at_after') });
        // The description fast path must MISS, so the fallback scan runs.
        if (params.get('description') !== null) {
          return { status: 200, body: { count: 0, next: null, results: [] } };
        }
        const after = params.get('updated_at_after');
        const kept =
          after === null
            ? rows
            : rows.filter((r) => Date.parse(String(r.updatedAt)) >= Date.parse(after));
        return { status: 200, body: { count: kept.length, next: null, results: kept } };
      },
    };
  }

  it('sends the caller’s time floor on the fallback scan, never fetching details for older tasks', async () => {
    // The floor is what turns "detail-fetch every task on the board" into
    // "detail-fetch the ones that could possibly be ours".
    const floor = '2026-08-15T00:00:00.000Z';
    const seen: { since: string | null | undefined }[] = [];
    const rows = [
      concise({ id: 'ancient00000', updatedAt: '2026-01-01T00:00:00Z' }),
      concise({ id: 'foundfoundfo', updatedAt: '2026-08-16T10:00:00Z' }),
    ];
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      sinceAwareListRoute(rows, seen),
      makeDetailRoute({ ancient00000: task({ id: 'ancient00000' }), foundfoundfo: marked }),
    ]);

    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null, updatedAfterIso: floor },
      CLIENT_KEY,
    );

    expect(found?.externalId).toBe('foundfoundfo');
    // The fast path is unbounded; only the fallback scan carries the floor.
    expect(seen).toEqual([{ since: null }, { since: floor }]);
    // The pre-floor task never cost a detail fetch.
    expect(calls.filter(isDetailCall).map((c) => new URL(c.url).pathname)).toEqual([
      '/api/v0/public/tasks/foundfoundfo',
    ]);
  });

  it('scans the WHOLE scope when no floor is given', async () => {
    const seen: { since: string | null | undefined }[] = [];
    const rows = [concise({ id: 'ancient00000', updatedAt: '2026-01-01T00:00:00Z' })];
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      sinceAwareListRoute(rows, seen),
      makeDetailRoute({
        ancient00000: task({ id: 'ancient00000', description: `x\n\ncyboflow-sync: ${CLIENT_KEY}` }),
      }),
    ]);

    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );

    // An omitted bound must never narrow anything: this task predates any
    // plausible floor and is still found.
    expect(found?.externalId).toBe('ancient00000');
    expect(seen).toEqual([{ since: null }, { since: null }]);
  });

  it('judges the scan in bounded batches, stopping at the batch that matches', async () => {
    // Sequentially, a miss on a large board is the whole board one GET at a
    // time. Batched, the in-flight ceiling is hydration's — and the scan still
    // stops at the first batch carrying the marker instead of walking on.
    const rows = Array.from({ length: 40 }, (_, i) => concise({ id: `scan${String(i).padStart(8, '0')}` }));
    const detail: Record<string, unknown> = {};
    for (const row of rows) detail[row.id as string] = task({ id: row.id });
    // The marker sits in the FIRST batch, at index 1.
    detail['scan00000001'] = task({ id: 'scan00000001', description: `x\n\ncyboflow-sync: ${CLIENT_KEY}` });
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      sinceAwareListRoute(rows, []),
      makeDetailRoute(detail),
    ]);

    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );

    expect(found?.externalId).toBe('scan00000001');
    // Exactly one batch of six, not forty — and not two, which is what dropping
    // the short-circuit would cost.
    expect(calls.filter(isDetailCall)).toHaveLength(6);
  });

  it('fetches a task detail ONCE per pass, and never remembers a 404', async () => {
    // One adapter instance IS one sync pass, and the recovery scan and the
    // hydration walk routinely want the same task. A remembered ABSENCE would be
    // a different thing entirely: absence is what this adapter reads as proof —
    // of a create that never landed, of a trashed parent — and trash state can
    // change under a pass.
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      makeDetailRoute({ AbCdEfGhIjKl: task() }),
    ]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });

    expect((await adapter.getIssue('AbCdEfGhIjKl'))?.externalId).toBe('AbCdEfGhIjKl');
    expect((await adapter.getIssue('AbCdEfGhIjKl'))?.externalId).toBe('AbCdEfGhIjKl');
    expect(calls.filter(isDetailCall)).toHaveLength(1);

    expect(await adapter.getIssue('missing00000')).toBeNull();
    expect(await adapter.getIssue('missing00000')).toBeNull();
    expect(calls.filter(isDetailCall)).toHaveLength(3);
  });

  it('drops the memoized copy of a task it just wrote to', async () => {
    // The drain writes state early in a pass and the inbound merge hydrates the
    // same board later in it. Serving the pre-write copy there would diff
    // against the baseline our own write just stamped and read as the remote
    // moving backwards.
    const { fetchImpl, calls } = scriptedFetch([
      makeDetailRoute({ AbCdEfGhIjKl: task() }),
      {
        test: (m, p) => m === 'PUT' && p.endsWith('/tasks/AbCdEfGhIjKl'),
        respond: () => ({ status: 200, body: { item: task({ status: 'Done' }) } }),
      },
    ]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });

    await adapter.getIssue('AbCdEfGhIjKl');
    await adapter.updateIssueState('AbCdEfGhIjKl', 'Done');
    await adapter.getIssue('AbCdEfGhIjKl');

    // Two reads, both of which reached the network (isDetailCall matches the
    // PUT's path too, so the method filter is what makes this a read count).
    expect(calls.filter((c) => c.method === 'GET' && isDetailCall(c))).toHaveLength(2);
  });
});

describe('DartAdapter transport failures', () => {
  it('surfaces a timeout as a NULL-status TrackerApiError, keeping it retryable', async () => {
    // outboxWorker only terminalizes a 4xx, so a null status takes the backoff
    // path — a timeout says nothing about whether the write is valid.
    const fetchImpl = (async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as FetchLike;
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl, requestTimeoutMs: 5 });
    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      name: 'TrackerApiError',
      status: null,
    });
    await expect(adapter.validateCredentials()).rejects.toThrow(/timed out after 5ms/);
  });

  it('maps a 5xx to a retryable TrackerApiError rather than an auth error', async () => {
    const { fetchImpl } = scriptedFetch([
      { test: (m, p) => m === 'GET' && p.endsWith('/config'), respond: () => ({ status: 503 }) },
    ]);
    const err = await new DartAdapter({ apiKey: 'k', fetchImpl }).listContainers().catch((e) => e);
    expect(err).toBeInstanceOf(TrackerApiError);
    expect(err).not.toBeInstanceOf(TrackerAuthError);
    expect(err.status).toBe(503);
  });
});
