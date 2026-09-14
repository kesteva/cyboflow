/**
 * BaseSelector — the comparison-base control for the session/run diff surface.
 *
 * A controlled, self-contained form-field-style row: closed it shows
 * `vs <label> · <ref>`; clicking it opens a rail-width dropdown with exactly
 * four entries (Branch point / <default> (local) / origin/<default> / Another
 * branch). Selecting an entry calls `onChange` with the resolved ref (or
 * `null` for "Branch point", the default).
 *
 * Data sources:
 *   - `trpc.cyboflow.sessionGit.getComparisonBases` (TASK-216) resolves
 *     branchPoint / defaultBranch / localDefault / originDefault server-side —
 *     this component never runs git itself and never triggers a fetch.
 *   - `API.projects.listBranches(projectId)` backs the "Another branch"
 *     filter, fetched lazily when that section is expanded (never on mount,
 *     never when `projectId` is null). Detached-HEAD placeholder rows (e.g.
 *     `(HEAD detached at abc123)`) are filtered out — they are not a
 *     selectable ref.
 *
 * This component takes no global-state dependency: sessionId/projectId/
 * selectedRef/onChange are all props, so a sibling task can mount it into
 * RunRightRail and wire persistence without touching this file.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChevronDown } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { API } from '../../utils/api';

/** Mirrors the `getComparisonBases` success payload (sessionGitOps.ts). */
interface ComparisonBases {
  branchPoint: { ref: string; shortSha: string } | null;
  defaultBranch: string | null;
  localDefault: { ref: string; behind: number } | null;
  originDefault: { ref: string; behind: number; fetchedAt: string | null } | null;
}

const EMPTY_BASES: ComparisonBases = {
  branchPoint: null,
  defaultBranch: null,
  localDefault: null,
  originDefault: null,
};

/** Matches the git-branch placeholder row for a detached HEAD — never a real ref. */
const DETACHED_HEAD_PATTERN = /^\(HEAD detached/;

export interface BaseSelectorProps {
  /** Needed to call getComparisonBases. null renders a disabled control. */
  sessionId: string | null;
  /** Needed for "Another branch". null disables that entry with a title. */
  projectId: string | null;
  /** null = "Branch point" (the default comparison base). */
  selectedRef: string | null;
  onChange: (ref: string | null) => void;
}

/** Human-readable freshness for the origin fetch timestamp. Best-effort only. */
function relativeFetchLabel(fetchedAt: string | null): string | null {
  if (!fetchedAt) return null;
  const then = new Date(fetchedAt).getTime();
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'fetched just now';
  if (minutes < 60) return `fetched ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `fetched ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `fetched ${days}d ago`;
}

/** The closed-state `<label>` / `<ref>` pair for the current selection. */
function closedState(
  selectedRef: string | null,
  bases: ComparisonBases,
): { label: string; ref: string | null } {
  if (selectedRef === null) {
    return { label: 'branch point', ref: bases.branchPoint?.shortSha ?? null };
  }
  if (bases.localDefault && selectedRef === bases.localDefault.ref) {
    return {
      label: bases.defaultBranch ? `${bases.defaultBranch} (local)` : selectedRef,
      ref: selectedRef,
    };
  }
  if (bases.originDefault && selectedRef === bases.originDefault.ref) {
    return {
      label: bases.defaultBranch ? `origin/${bases.defaultBranch}` : selectedRef,
      ref: selectedRef,
    };
  }
  return { label: selectedRef, ref: null };
}

/** Narrow an unknown branches-listing entry down to its name, if present. */
function branchName(entry: unknown): string | null {
  if (entry && typeof entry === 'object' && 'name' in entry) {
    const name = (entry as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

export function BaseSelector({
  sessionId,
  projectId,
  selectedRef,
  onChange,
}: BaseSelectorProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [bases, setBases] = useState<ComparisonBases>(EMPTY_BASES);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [branchFilter, setBranchFilter] = useState('');
  const [otherBranchOpen, setOtherBranchOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch the resolved comparison bases on mount / whenever sessionId changes.
  // Every leg degrades independently server-side, so a thrown promise (the
  // precondition-error path) or a `{ success: false }` envelope both just
  // leave the menu entries disabled rather than crashing this component.
  useEffect(() => {
    if (sessionId === null) {
      setBases(EMPTY_BASES);
      return;
    }
    let cancelled = false;
    trpc.cyboflow.sessionGit.getComparisonBases.query({ sessionId }).then(
      (result: { success: true; data: ComparisonBases } | { success: false; error: string }) => {
        if (cancelled) return;
        setBases(result.success ? result.data : EMPTY_BASES);
      },
      () => {
        if (cancelled) return;
        setBases(EMPTY_BASES);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Lazy branch fetch — only when "Another branch" is expanded, and never for
  // a session with no associated project. Fetched at most once per mount.
  const loadBranches = useCallback(() => {
    if (projectId === null || branchesLoaded) return;
    setBranchesLoaded(true);
    API.projects.listBranches(projectId).then(
      (res: { success: boolean; data?: unknown }) => {
        if (!res.success || !Array.isArray(res.data)) return;
        const names = res.data
          .map(branchName)
          .filter((n): n is string => n !== null)
          .filter((n) => !DETACHED_HEAD_PATTERN.test(n));
        setBranches(names);
      },
      () => {
        /* branches stay empty — the picker renders only the disabled state */
      },
    );
  }, [projectId, branchesLoaded]);

  // Click-outside closes the menu (and its "Another branch" sub-section).
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setOtherBranchOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  const { label: closedLabel, ref: closedRef } = closedState(selectedRef, bases);

  const filteredBranches = useMemo(() => {
    const needle = branchFilter.trim().toLowerCase();
    if (needle === '') return branches;
    return branches.filter((b) => b.toLowerCase().includes(needle));
  }, [branches, branchFilter]);

  const handleSelect = (ref: string | null): void => {
    onChange(ref);
    setOpen(false);
    setOtherBranchOpen(false);
  };

  const disabled = sessionId === null;
  const anotherBranchDisabled = projectId === null;
  const localDisabled = bases.defaultBranch === null || bases.localDefault === null;
  const originDisabled = bases.defaultBranch === null || bases.originDefault === null;

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        data-testid="base-selector-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={[
          'flex w-full min-w-0 items-center justify-between gap-2 rounded-sm border px-3 py-2 text-left',
          'bg-bg-primary text-sm font-medium text-text-secondary transition-colors',
          open ? 'border-interactive' : 'border-border-primary hover:border-border-secondary',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        ].join(' ')}
      >
        <span data-testid="base-selector-label" className="flex min-w-0 flex-1 items-baseline gap-1">
          <span data-testid="base-selector-vs-label" className="shrink-0 whitespace-nowrap">
            vs {closedLabel}
          </span>
          {closedRef !== null && (
            <>
              <span className="shrink-0">{' · '}</span>
              <span
                data-testid="base-selector-ref"
                title={closedRef}
                className="min-w-0 flex-1 truncate overflow-hidden text-ellipsis text-text-tertiary"
              >
                {closedRef}
              </span>
            </>
          )}
        </span>
        <ChevronDown
          className={[
            'h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      {open && (
        <div
          data-testid="base-selector-menu"
          className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-sm border border-border-primary bg-bg-primary shadow-md"
        >
          {/* Branch point */}
          <button
            type="button"
            data-testid="base-selector-option-branch-point"
            disabled={!bases.branchPoint}
            title={bases.branchPoint ? undefined : 'No branch point could be resolved'}
            onClick={() => handleSelect(null)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-text-secondary hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>Branch point</span>
            {bases.branchPoint && (
              <span className="text-text-tertiary">{bases.branchPoint.shortSha}</span>
            )}
          </button>

          {/* <defaultBranch> (local) */}
          <button
            type="button"
            data-testid="base-selector-option-local-default"
            disabled={localDisabled}
            title={
              bases.defaultBranch === null
                ? 'No default branch could be resolved'
                : bases.localDefault === null
                  ? 'No local copy of the default branch is available'
                  : undefined
            }
            onClick={() => bases.localDefault && handleSelect(bases.localDefault.ref)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-text-secondary hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>{bases.defaultBranch ? `${bases.defaultBranch} (local)` : 'Default branch (local)'}</span>
            {bases.localDefault && bases.localDefault.behind > 0 && (
              <span className="text-text-tertiary">−{bases.localDefault.behind} behind</span>
            )}
          </button>

          {/* origin/<defaultBranch> */}
          <button
            type="button"
            data-testid="base-selector-option-origin-default"
            disabled={originDisabled}
            title={
              bases.defaultBranch === null
                ? 'No default branch could be resolved'
                : bases.originDefault === null
                  ? 'No origin copy of the default branch is available'
                  : undefined
            }
            onClick={() => bases.originDefault && handleSelect(bases.originDefault.ref)}
            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-text-secondary hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>{bases.defaultBranch ? `origin/${bases.defaultBranch}` : 'origin/default branch'}</span>
            {bases.originDefault && (
              <span className="text-text-tertiary">
                {relativeFetchLabel(bases.originDefault.fetchedAt) ?? 'fetch time unknown'}
              </span>
            )}
          </button>

          {/* Another branch */}
          <div>
            <button
              type="button"
              data-testid="base-selector-option-another-branch"
              disabled={anotherBranchDisabled}
              title={anotherBranchDisabled ? 'No project is associated with this session' : undefined}
              onClick={() => {
                if (anotherBranchDisabled) return;
                const next = !otherBranchOpen;
                setOtherBranchOpen(next);
                if (next) loadBranches();
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-text-secondary hover:bg-bg-tertiary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>Another branch</span>
            </button>
            {otherBranchOpen && !anotherBranchDisabled && (
              <div data-testid="base-selector-another-branch-panel" className="border-t border-border-primary px-2 py-2">
                <input
                  type="text"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  placeholder="Filter branches"
                  data-testid="base-selector-branch-filter"
                  className="mb-1 w-full rounded-sm border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
                />
                <ul className="max-h-40 overflow-y-auto">
                  {filteredBranches.map((branch) => (
                    <li key={branch}>
                      <button
                        type="button"
                        data-testid="base-selector-branch-option"
                        onClick={() => handleSelect(branch)}
                        className="w-full truncate rounded-sm px-2 py-1 text-left text-sm text-text-secondary hover:bg-bg-tertiary"
                      >
                        {branch}
                      </button>
                    </li>
                  ))}
                  {filteredBranches.length === 0 && (
                    <li className="px-2 py-1 text-sm text-text-tertiary">No matching branches.</li>
                  )}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
