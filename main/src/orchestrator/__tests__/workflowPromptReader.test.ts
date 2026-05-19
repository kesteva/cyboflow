/**
 * Unit tests for workflowPromptReader.ts
 *
 * Behaviors covered (per TASK-641 test_strategy):
 * 1. returns trimmed body below frontmatter as `prompt`
 * 2. extracts `system_prompt_append` when present
 * 3. returns empty `systemPromptAppend` when key is absent
 * 4. throws WorkflowPromptReadError on missing file (with .cause ENOENT and path in message)
 * 5. throws WorkflowPromptReadError on empty body (message matches /empty/i)
 * 6. handles file without any frontmatter (full trimmed content as prompt, systemPromptAppend='')
 * 7. handles CRLF line endings in the frontmatter delimiter
 *
 * Tests use withTempDir for filesystem isolation (auto-cleanup on exit).
 * No mocking — the helper runs end-to-end against real temp files.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { readWorkflowPrompt, WorkflowPromptReadError } from '../workflowPromptReader';
import { withTempDir } from '../../__test_fixtures__/tmp';

describe('readWorkflowPrompt', () => {
  // -------------------------------------------------------------------------
  // Case 1: returns trimmed body below frontmatter as `prompt`
  // -------------------------------------------------------------------------
  it('returns body below frontmatter as prompt', async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      writeFileSync(filePath, '---\ntitle: Test\n---\nHello workflow body.');
      const result = readWorkflowPrompt(filePath);
      expect(result.prompt).toBe('Hello workflow body.');
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: extracts system_prompt_append when present
  // -------------------------------------------------------------------------
  it('extracts system_prompt_append when present', async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      writeFileSync(
        filePath,
        '---\nsystem_prompt_append: "Be terse."\n---\nDo the thing.',
      );
      const result = readWorkflowPrompt(filePath);
      expect(result.systemPromptAppend).toBe('Be terse.');
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: returns empty systemPromptAppend when key is absent
  // -------------------------------------------------------------------------
  it('returns empty systemPromptAppend when key is absent', async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      writeFileSync(filePath, '---\ntitle: No append key\n---\nDo the thing.');
      const result = readWorkflowPrompt(filePath);
      expect(result.systemPromptAppend).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: throws WorkflowPromptReadError on missing file
  //         — .cause is ENOENT, message includes the path
  // -------------------------------------------------------------------------
  it('throws WorkflowPromptReadError on missing file with cause and path in message', () => {
    const missingPath = '/tmp/__cyboflow_nonexistent_wpr_test_/workflow.md';
    expect(() => readWorkflowPrompt(missingPath)).toThrow(WorkflowPromptReadError);
    let thrown: WorkflowPromptReadError | undefined;
    try {
      readWorkflowPrompt(missingPath);
    } catch (err) {
      thrown = err as WorkflowPromptReadError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain(missingPath);
    expect(thrown!.cause).toBeDefined();
    expect((thrown!.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  // -------------------------------------------------------------------------
  // Case 5: throws WorkflowPromptReadError on empty body (matches /empty/i)
  // -------------------------------------------------------------------------
  it('throws WorkflowPromptReadError with empty-mentioning message on whitespace-only body', async () => {
    await withTempDir('wpr-test-', async (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      // Frontmatter only, body is whitespace
      writeFileSync(filePath, '---\ntitle: Only frontmatter\n---\n   \n\t\n');
      expect(() => readWorkflowPrompt(filePath)).toThrow(WorkflowPromptReadError);
      expect(() => readWorkflowPrompt(filePath)).toThrow(/empty/i);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: handles file without any frontmatter
  //         — full trimmed content as prompt, systemPromptAppend = ''
  // -------------------------------------------------------------------------
  it('handles file without any frontmatter delimiter', async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      writeFileSync(filePath, 'Just a prompt.');
      const result = readWorkflowPrompt(filePath);
      expect(result.prompt).toBe('Just a prompt.');
      expect(result.systemPromptAppend).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Case 7: handles CRLF line endings in the frontmatter delimiter
  // -------------------------------------------------------------------------
  it('handles CRLF line endings in frontmatter delimiter', async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      // Build file with CRLF line endings throughout
      const content = '---\r\nsystem_prompt_append: "Crisp."\r\ntitle: CRLF test\r\n---\r\nCRLF body content.';
      writeFileSync(filePath, content, 'utf-8');
      const result = readWorkflowPrompt(filePath);
      expect(result.prompt).toBe('CRLF body content.');
      expect(result.systemPromptAppend).toBe('Crisp.');
    });
  });

  // -------------------------------------------------------------------------
  // Case 8: single-quoted frontmatter value strips surrounding quotes
  //         (mirrors the double-quote behaviour tested in case 2)
  // -------------------------------------------------------------------------
  it("strips single quotes from frontmatter values", async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      writeFileSync(filePath, "---\nsystem_prompt_append: 'Be brief.'\n---\nDo the thing.");
      const result = readWorkflowPrompt(filePath);
      expect(result.systemPromptAppend).toBe('Be brief.');
    });
  });

  // -------------------------------------------------------------------------
  // Case 9: body containing `---` sequences NOT at start of file are
  //         preserved as-is — the regex is anchored to `^` so internal
  //         horizontal-rule markers in markdown content are not treated as
  //         a second frontmatter delimiter.
  // -------------------------------------------------------------------------
  it('preserves --- inside the body that are not at the start of the file', async () => {
    await withTempDir('wpr-test-', (tmpDir) => {
      const filePath = join(tmpDir, 'workflow.md');
      writeFileSync(
        filePath,
        '---\ntitle: Test\n---\nFirst paragraph.\n\n---\n\nSecond section.',
      );
      const result = readWorkflowPrompt(filePath);
      expect(result.prompt).toBe('First paragraph.\n\n---\n\nSecond section.');
      expect(result.systemPromptAppend).toBe('');
    });
  });
});
