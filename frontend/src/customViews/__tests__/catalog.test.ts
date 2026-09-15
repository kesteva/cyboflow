/**
 * CATALOG — the registry's invariants (docs/proposals/CUSTOM-VIEWS.md §5.1).
 *
 * Two of these are load-bearing rather than cosmetic:
 *
 *   - Every canonical section id has an entry, and every SECTION entry is a
 *     singleton. `ViewSurface`'s "pull the node out of the sections map" lookup
 *     is only total because a section id can appear at most once in a layout.
 *   - Every SPEC entry's `settings` is the shared spec's own settings array,
 *     not a re-typed copy — the inspector and the server-side runner must read
 *     one list, or a knob can exist in the UI that the runner cannot resolve.
 */
import { describe, it, expect } from 'vitest';
import { CATALOG_WIDGET_SPECS } from '../../../../shared/customViews/catalogSpecs';
import {
  CATALOG,
  OVERVIEW_SECTION_ORDER,
  QUEUE_SECTION_ORDER,
  catalogEntriesFor,
  catalogEntry,
  isSectionEntry,
  sectionOrderFor,
} from '../catalog';

describe('CATALOG', () => {
  it('has an entry for every canonical section id on both surfaces', () => {
    for (const id of [...QUEUE_SECTION_ORDER, ...OVERVIEW_SECTION_ORDER]) {
      const entry = catalogEntry(id);
      expect(entry, id).not.toBeNull();
      expect(isSectionEntry(entry!), id).toBe(true);
    }
  });

  it('marks every section entry a singleton and pins it to its own surface', () => {
    for (const id of QUEUE_SECTION_ORDER) {
      expect(CATALOG[id].singleton).toBe(true);
      expect(CATALOG[id].surface).toBe('review-queue');
    }
    for (const id of OVERVIEW_SECTION_ORDER) {
      expect(CATALOG[id].singleton).toBe(true);
      expect(CATALOG[id].surface).toBe('project-overview');
    }
  });

  it('carries no spec on a section entry — the page owns that data', () => {
    for (const id of QUEUE_SECTION_ORDER) {
      expect(CATALOG[id].spec).toBeUndefined();
    }
  });

  it('wraps every shared catalog spec, deriving settings from the spec itself', () => {
    for (const [id, spec] of Object.entries(CATALOG_WIDGET_SPECS)) {
      const entry = CATALOG[id];
      expect(entry, id).toBeDefined();
      expect(entry.spec, id).toBe(spec);
      expect(entry.settings, id).toEqual(spec.settings ?? []);
      expect(entry.surface, id).toBe('any');
      expect(entry.singleton, id).toBe(false);
    }
  });

  it('returns null for an unknown id rather than throwing', () => {
    expect(catalogEntry('queue.does-not-exist')).toBeNull();
  });

  it('lists a surface as its own sections in page order, then the spec widgets', () => {
    const entries = catalogEntriesFor('project-overview');
    expect(entries.slice(0, 3).map((e) => e.id)).toEqual([...OVERVIEW_SECTION_ORDER]);
    expect(entries.slice(3).every((e) => e.spec !== undefined)).toBe(true);
    // No section from the other surface leaks into the library.
    expect(entries.some((e) => e.id.startsWith('queue.'))).toBe(false);
  });

  it('resolves the canonical order per surface', () => {
    expect(sectionOrderFor('review-queue')).toEqual(QUEUE_SECTION_ORDER);
    expect(sectionOrderFor('project-overview')).toEqual(OVERVIEW_SECTION_ORDER);
  });
});
