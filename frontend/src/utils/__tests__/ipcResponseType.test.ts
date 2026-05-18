/**
 * Type-level regression tests for IPCResponse<T = unknown>.
 *
 * These tests confirm that the `unknown` default on IPCResponse<T> forces
 * callers to narrow `.data` before assigning it to a typed variable, preventing
 * the class of silent regressions that shipped with the crystalDirectory →
 * cyboflowDirectory IPC rename (SPRINT-014 / TASK-562).
 *
 * Vitest's `expectTypeOf` runs at test-time as type assertions — if the
 * IPCResponse declaration is ever reverted to `T = any`, the `not.toBeAny()`
 * lines below will start failing.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { IPCResponse, GitErrorResponse } from '../api';

describe('IPCResponse<T = unknown> type contract', () => {
  it('data field is `unknown` when no type arg is supplied', () => {
    // Bare IPCResponse — T defaults to unknown, so data should be unknown | undefined.
    type DataField = IPCResponse['data'];
    expectTypeOf<DataField>().not.toBeAny();
    expectTypeOf<DataField>().toEqualTypeOf<unknown>();
  });

  it('data field is the supplied type when an explicit type arg is passed', () => {
    type DataField = IPCResponse<{ id: string }>['data'];
    expectTypeOf<DataField>().toEqualTypeOf<{ id: string } | undefined>();
  });

  it('narrowed data is assignable to the concrete type after success + defined check', () => {
    // Simulate the narrowing pattern used after `if (result.success && result.data)`.
    const response: IPCResponse<{ id: string }> = { success: true, data: { id: 'x' } };
    if (response.success && response.data !== undefined) {
      const data = response.data;
      // After narrowing, data must be the concrete type — not `unknown`.
      expectTypeOf(data).toEqualTypeOf<{ id: string }>();
    }
  });

  it('GitErrorResponse data field is unknown (not any)', () => {
    // GitErrorResponse extends IPCResponse<unknown> — verify the data field has not
    // drifted back to `any`.
    type GitData = GitErrorResponse['data'];
    expectTypeOf<GitData>().not.toBeAny();
    expectTypeOf<GitData>().toEqualTypeOf<unknown>();
  });
});
