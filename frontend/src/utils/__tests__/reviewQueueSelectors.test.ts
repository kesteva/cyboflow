import { describe, it, expect } from 'vitest';
import type { Approval } from '../../../../shared/types/approvals';
import {
  sortQueueOldestFirst,
  partitionBlockingItems,
  groupRepeatedApprovals,
  selectQueueView,
  payloadSignature,
} from '../reviewQueueSelectors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeApproval(overrides: Partial<Approval> & { id: string }): Approval {
  return {
    runId: 'run-1',
    workflowName: 'Test Workflow',
    toolName: 'Bash',
    payloadPreview: 'echo hello',
    rationale: null,
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...overrides,
  };
}

function isoAt(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

// ---------------------------------------------------------------------------
// payloadSignature
// ---------------------------------------------------------------------------

describe('payloadSignature', () => {
  it('trims, lowercases, and truncates to 100 chars', () => {
    const long = '  ' + 'A'.repeat(200) + '  ';
    const sig = payloadSignature(long);
    expect(sig).toHaveLength(100);
    expect(sig).toBe('a'.repeat(100));
  });

  it('returns the same value for semantically identical payloads', () => {
    expect(payloadSignature('  npm test  ')).toBe(payloadSignature('npm test'));
  });
});

// ---------------------------------------------------------------------------
// sortQueueOldestFirst
// ---------------------------------------------------------------------------

describe('sortQueueOldestFirst', () => {
  it('returns a new sorted array ascending by createdAt', () => {
    const a = makeApproval({ id: 'a', createdAt: '2026-05-11T10:00:00Z' });
    const b = makeApproval({ id: 'b', createdAt: '2026-05-11T09:00:00Z' });
    const c = makeApproval({ id: 'c', createdAt: '2026-05-11T08:00:00Z' });
    const input = [a, b, c];
    const result = sortQueueOldestFirst(input);
    expect(result.map(x => x.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the original array', () => {
    const a = makeApproval({ id: 'a', createdAt: '2026-05-11T10:00:00Z' });
    const b = makeApproval({ id: 'b', createdAt: '2026-05-11T09:00:00Z' });
    const original = [a, b];
    sortQueueOldestFirst(original);
    expect(original.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('handles single-item list', () => {
    const a = makeApproval({ id: 'a' });
    expect(sortQueueOldestFirst([a]).map(x => x.id)).toEqual(['a']);
  });

  it('handles empty list', () => {
    expect(sortQueueOldestFirst([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// partitionBlockingItems
// ---------------------------------------------------------------------------

describe('partitionBlockingItems', () => {
  it('places item 180001ms old in blocking bucket', () => {
    const now = Date.now();
    const old = makeApproval({ id: 'old', createdAt: new Date(now - 180_001).toISOString() });
    const { blocking, normal } = partitionBlockingItems([old], now);
    expect(blocking.map(x => x.id)).toContain('old');
    expect(normal).toHaveLength(0);
  });

  it('places item 179999ms old in normal bucket', () => {
    const now = Date.now();
    const fresh = makeApproval({ id: 'fresh', createdAt: new Date(now - 179_999).toISOString() });
    const { blocking, normal } = partitionBlockingItems([fresh], now);
    expect(normal.map(x => x.id)).toContain('fresh');
    expect(blocking).toHaveLength(0);
  });

  it('splits correctly at the 3-min boundary', () => {
    const now = Date.now();
    const old = makeApproval({ id: 'old', createdAt: new Date(now - 180_001).toISOString() });
    const fresh = makeApproval({ id: 'fresh', createdAt: new Date(now - 179_999).toISOString() });
    const { blocking, normal } = partitionBlockingItems([old, fresh], now);
    expect(blocking.map(x => x.id)).toEqual(['old']);
    expect(normal.map(x => x.id)).toEqual(['fresh']);
  });

  it('respects a custom threshold', () => {
    const now = Date.now();
    const item = makeApproval({ id: 'item', createdAt: new Date(now - 5_001).toISOString() });
    const { blocking } = partitionBlockingItems([item], now, 5_000);
    expect(blocking.map(x => x.id)).toContain('item');
  });

  it('all normal when all items are fresh', () => {
    const now = Date.now();
    const items = ['a', 'b', 'c'].map(id =>
      makeApproval({ id, createdAt: new Date(now - 60_000).toISOString() }),
    );
    const { blocking, normal } = partitionBlockingItems(items, now);
    expect(blocking).toHaveLength(0);
    expect(normal).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// groupRepeatedApprovals
// ---------------------------------------------------------------------------

describe('groupRepeatedApprovals', () => {
  it('returns empty array for empty input', () => {
    expect(groupRepeatedApprovals([])).toEqual([]);
  });

  it('returns single items as kind: single', () => {
    const a = makeApproval({ id: 'a' });
    const b = makeApproval({ id: 'b', toolName: 'Read' });
    const result = groupRepeatedApprovals([a, b]);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('single');
    expect(result[1].kind).toBe('single');
  });

  it('collapses 7 same-signature same-run items into one group with count 7', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      makeApproval({ id: `bash-${i}`, toolName: 'Bash', payloadPreview: 'npm test', runId: 'run-x' }),
    );
    const result = groupRepeatedApprovals(items);
    expect(result).toHaveLength(1);
    const group = result[0];
    expect(group.kind).toBe('group');
    if (group.kind === 'group') {
      expect(group.items).toHaveLength(7);
      expect(group.toolName).toBe('Bash');
    }
  });

  it('does not group items from different runs even if same signature', () => {
    const a = makeApproval({ id: 'a', runId: 'run-1', toolName: 'Bash', payloadPreview: 'npm test' });
    const b = makeApproval({ id: 'b', runId: 'run-2', toolName: 'Bash', payloadPreview: 'npm test' });
    const result = groupRepeatedApprovals([a, b]);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('single');
    expect(result[1].kind).toBe('single');
  });

  it('does not group items with different toolNames', () => {
    const a = makeApproval({ id: 'a', toolName: 'Bash', payloadPreview: 'npm test' });
    const b = makeApproval({ id: 'b', toolName: 'Read', payloadPreview: 'npm test' });
    const result = groupRepeatedApprovals([a, b]);
    expect(result).toHaveLength(2);
  });

  it('handles multiple separate groups in one pass', () => {
    const group1 = [
      makeApproval({ id: 'g1a', runId: 'run-1', toolName: 'Bash', payloadPreview: 'npm test' }),
      makeApproval({ id: 'g1b', runId: 'run-1', toolName: 'Bash', payloadPreview: 'npm test' }),
    ];
    const single = makeApproval({ id: 's', runId: 'run-1', toolName: 'Read', payloadPreview: 'foo' });
    const group2 = [
      makeApproval({ id: 'g2a', runId: 'run-1', toolName: 'Write', payloadPreview: 'bar' }),
      makeApproval({ id: 'g2b', runId: 'run-1', toolName: 'Write', payloadPreview: 'bar' }),
      makeApproval({ id: 'g2c', runId: 'run-1', toolName: 'Write', payloadPreview: 'bar' }),
    ];
    const result = groupRepeatedApprovals([...group1, single, ...group2]);
    expect(result).toHaveLength(3);
    expect(result[0].kind).toBe('group');
    expect(result[1].kind).toBe('single');
    expect(result[2].kind).toBe('group');
    if (result[0].kind === 'group') expect(result[0].items).toHaveLength(2);
    if (result[2].kind === 'group') expect(result[2].items).toHaveLength(3);
  });

  it('sets isBlocking to false on all items (callers override)', () => {
    const items = [
      makeApproval({ id: 'a' }),
      makeApproval({ id: 'b' }),
    ];
    const result = groupRepeatedApprovals(items);
    result.forEach(item => { expect(item.isBlocking).toBe(false); });
  });
});

// ---------------------------------------------------------------------------
// selectQueueView
// ---------------------------------------------------------------------------

describe('selectQueueView', () => {
  it('returns empty blocking and normal for empty input', () => {
    const { blocking, normal } = selectQueueView([], Date.now());
    expect(blocking).toHaveLength(0);
    expect(normal).toHaveLength(0);
  });

  it('puts blocking items first, normal items second — both oldest-first', () => {
    const now = Date.now();
    const blockingItem = makeApproval({
      id: 'block',
      toolName: 'Bash',
      payloadPreview: 'cmd-block',
      createdAt: new Date(now - 240_000).toISOString(), // 4 min old
    });
    const normal1 = makeApproval({
      id: 'n1',
      toolName: 'Read',
      payloadPreview: 'cmd-n1',
      createdAt: new Date(now - 60_000).toISOString(), // 1 min old
    });
    const normal2 = makeApproval({
      id: 'n2',
      toolName: 'Write',
      payloadPreview: 'cmd-n2',
      createdAt: new Date(now - 30_000).toISOString(), // 30 sec old
    });
    const { blocking, normal } = selectQueueView([normal2, blockingItem, normal1], now);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].kind).toBe('single');
    if (blocking[0].kind === 'single') {
      expect(blocking[0].approval.id).toBe('block');
      expect(blocking[0].isBlocking).toBe(true);
    }
    expect(normal.map(i => (i.kind === 'single' ? i.approval.id : i.items[0].id))).toEqual([
      'n1',
      'n2',
    ]);
    normal.forEach(i => { expect(i.isBlocking).toBe(false); });
  });

  it('applies grouping within each section', () => {
    const now = Date.now();
    const blockingItems = [
      makeApproval({ id: 'ba', runId: 'run-b', toolName: 'Bash', payloadPreview: 'x', createdAt: new Date(now - 240_000).toISOString() }),
      makeApproval({ id: 'bb', runId: 'run-b', toolName: 'Bash', payloadPreview: 'x', createdAt: new Date(now - 230_000).toISOString() }),
    ];
    const normalItems = [
      makeApproval({ id: 'na', runId: 'run-n', toolName: 'Read', payloadPreview: 'y', createdAt: new Date(now - 60_000).toISOString() }),
    ];
    const { blocking, normal } = selectQueueView([...blockingItems, ...normalItems], now);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].kind).toBe('group');
    if (blocking[0].kind === 'group') {
      expect(blocking[0].items).toHaveLength(2);
      expect(blocking[0].isBlocking).toBe(true);
    }
    expect(normal).toHaveLength(1);
    expect(normal[0].kind).toBe('single');
    expect(normal[0].isBlocking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// selectQueueView — sort order within sections
// ---------------------------------------------------------------------------

describe('selectQueueView sort ordering', () => {
  it('normal section is oldest-first within the section', () => {
    const now = Date.now();
    const items = [
      makeApproval({ id: 'newest', toolName: 'Bash',  payloadPreview: 'cmd-1', createdAt: isoAt(10_000) }),
      makeApproval({ id: 'oldest', toolName: 'Read',  payloadPreview: 'cmd-2', createdAt: isoAt(100_000) }),
      makeApproval({ id: 'middle', toolName: 'Write', payloadPreview: 'cmd-3', createdAt: isoAt(60_000) }),
    ];
    const { normal } = selectQueueView(items, now);
    const ids = normal.map(i => (i.kind === 'single' ? i.approval.id : i.items[0].id));
    expect(ids).toEqual(['oldest', 'middle', 'newest']);
  });
});
