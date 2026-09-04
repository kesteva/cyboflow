import { describe, expect, it } from 'vitest';
import { parseAgyModelsStdout } from '../agyModelCatalog';

describe('parseAgyModelsStdout', () => {
  it('parses tab-separated models and ignores progress headers', () => {
    const raw = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;
    const models = parseAgyModelsStdout(raw);
    expect(models).toEqual([
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    ]);
  });

  it('handles empty and whitespace lines gracefully', () => {
    const raw = `
\t
gemini-3.7-flash-high\tGemini 3.7 Flash (High)

`;
    const models = parseAgyModelsStdout(raw);
    expect(models).toEqual([
      { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    ]);
  });
});
