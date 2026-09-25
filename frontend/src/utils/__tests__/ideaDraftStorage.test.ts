import { describe, it, expect, beforeEach } from 'vitest';
import type { IdeaAttachment } from '../../../../shared/types/tasks';
import {
  readDraft,
  writeDraft,
  clearDraft,
  isIdeaAttachmentArray,
  ADD_IDEA_MODAL_DRAFT_KEY,
} from '../ideaDraftStorage';

interface TestDraft {
  title: string;
  count: number;
}

function isTestDraft(v: unknown): v is TestDraft {
  if (typeof v !== 'object' || v === null) return false;
  const candidate = v as Record<string, unknown>;
  return typeof candidate.title === 'string' && typeof candidate.count === 'number';
}

const KEY = ADD_IDEA_MODAL_DRAFT_KEY;

describe('ideaDraftStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('readDraft / writeDraft / clearDraft', () => {
    it('returns null when nothing has been persisted', () => {
      expect(readDraft(KEY, isTestDraft)).toBeNull();
    });

    it('round-trips a valid draft', () => {
      const draft: TestDraft = { title: 'my idea', count: 3 };
      writeDraft(KEY, draft);
      expect(readDraft(KEY, isTestDraft)).toEqual(draft);
    });

    it('returns null for corrupt JSON in storage', () => {
      localStorage.setItem(KEY, '{not json');
      expect(readDraft(KEY, isTestDraft)).toBeNull();
    });

    it('returns null when the parsed value fails the validator', () => {
      localStorage.setItem(KEY, JSON.stringify({ title: 'ok', count: 'not-a-number' }));
      expect(readDraft(KEY, isTestDraft)).toBeNull();
    });

    it('clearDraft removes the key so a subsequent read returns null', () => {
      writeDraft(KEY, { title: 'my idea', count: 3 });
      expect(readDraft(KEY, isTestDraft)).not.toBeNull();
      clearDraft(KEY);
      expect(readDraft(KEY, isTestDraft)).toBeNull();
    });

    it('readDraft swallows a throwing getItem and returns null', () => {
      const originalGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = () => {
        throw new Error('security error');
      };
      try {
        expect(readDraft(KEY, isTestDraft)).toBeNull();
      } finally {
        Storage.prototype.getItem = originalGetItem;
      }
    });

    it('writeDraft swallows a throwing setItem without throwing', () => {
      const originalSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new Error('quota exceeded');
      };
      try {
        expect(() => writeDraft(KEY, { title: 'x', count: 1 })).not.toThrow();
      } finally {
        Storage.prototype.setItem = originalSetItem;
      }
    });

    it('clearDraft swallows a throwing removeItem without throwing', () => {
      const originalRemoveItem = Storage.prototype.removeItem;
      Storage.prototype.removeItem = () => {
        throw new Error('security error');
      };
      try {
        expect(() => clearDraft(KEY)).not.toThrow();
      } finally {
        Storage.prototype.removeItem = originalRemoveItem;
      }
    });
  });

  describe('isIdeaAttachmentArray', () => {
    const validAttachment: IdeaAttachment = {
      id: 'a1',
      name: 'file.png',
      path: '/tmp/file.png',
      type: 'image/png',
      size: 1024,
    };

    it('accepts a valid array of attachments', () => {
      expect(isIdeaAttachmentArray([validAttachment])).toBe(true);
    });

    it('accepts an empty array', () => {
      expect(isIdeaAttachmentArray([])).toBe(true);
    });

    it('rejects a non-array value', () => {
      expect(isIdeaAttachmentArray(validAttachment)).toBe(false);
      expect(isIdeaAttachmentArray(null)).toBe(false);
      expect(isIdeaAttachmentArray('nope')).toBe(false);
    });

    it('rejects an array with a malformed element missing a field', () => {
      const missingSize: Record<string, unknown> = { ...validAttachment };
      delete missingSize.size;
      expect(isIdeaAttachmentArray([missingSize])).toBe(false);
    });

    it('rejects an array with a malformed element with a wrong-typed field', () => {
      expect(isIdeaAttachmentArray([{ ...validAttachment, size: 'big' }])).toBe(false);
    });
  });
});
