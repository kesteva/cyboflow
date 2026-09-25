/**
 * ideaDraftStorage — generic, key-parameterized localStorage helpers for
 * persisting in-progress idea/task drafts across a modal close/reopen.
 *
 * Mirrors the defensive try/catch idiom of recommendedActionDismissals.ts:
 * any localStorage access (unavailable, private-mode, corrupt JSON, or a
 * shape that fails the caller-supplied validator) degrades to a safe `null`
 * / no-op rather than throwing or returning partially-valid state.
 */

import type { IdeaAttachment } from '../../../shared/types/tasks';

/** Versioned draft key for AddIdeaModal. Bump the `.vN` suffix on shape changes. */
export const ADD_IDEA_MODAL_DRAFT_KEY = 'cyboflow.addIdeaModal.draft.v1';

/** Versioned draft key for NewTaskDialog. Bump the `.vN` suffix on shape changes. */
export const NEW_TASK_DIALOG_DRAFT_KEY = 'cyboflow.newTaskDialog.draft.v1';

/** Versioned draft key for IdeaPickerModal. Bump the `.vN` suffix on shape changes. */
export const IDEA_PICKER_MODAL_DRAFT_KEY = 'cyboflow.ideaPickerModal.draft.v1';

/**
 * Read and validate a persisted draft under `key`. Returns `null` on any
 * failure — missing key, inaccessible storage, corrupt JSON, or a parsed
 * value that fails `isValid` — never throws and never returns
 * partially-valid/garbage state.
 */
export function readDraft<T>(key: string, isValid: (v: unknown) => v is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Persist `draft` under `key`. Best-effort — a write failure (e.g. storage
 * quota, private mode) is swallowed rather than thrown.
 */
export function writeDraft<T>(key: string, draft: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Best-effort persistence — a draft that fails to save just means the
    // modal reopens empty, which is a safe fallback (not silent data loss).
  }
}

/**
 * Remove the persisted draft under `key`. Best-effort — a removal failure is
 * swallowed rather than thrown.
 */
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Best-effort — an unclearable draft just gets overwritten or fails
    // validation on the next read.
  }
}

/** True when `v` is a plain object shaped like an `IdeaAttachment`. */
function isIdeaAttachment(v: unknown): v is IdeaAttachment {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.size === 'number'
  );
}

/**
 * Type guard for a restored `IdeaAttachment[]` draft field — every element
 * must have `id`/`name`/`path`/`type` as strings and `size` as a number.
 * Shared by AddIdeaModal, NewTaskDialog, and IdeaPickerModal drafts.
 */
export function isIdeaAttachmentArray(v: unknown): v is IdeaAttachment[] {
  return Array.isArray(v) && v.every(isIdeaAttachment);
}
