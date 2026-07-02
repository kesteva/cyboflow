/**
 * Foundation contract tests for the agent foundation modules (agent-overrides
 * epic). Locks:
 *  1. The catalogue parses EXACTLY the 15 canonical builtins from the bundled
 *     `.md` files, each with name === `cyboflow-<basename>`, a CLI-tool subset,
 *     and a non-empty description.
 *  2. The sorted catalogue keys deep-equal the sorted CANONICAL_AGENT_KEYS.
 *  3. renderAgentMarkdown round-trips through parseBundledAgent — a colon-bearing
 *     description stays YAML-safe and parses back identically.
 *  4. validateAgentDraft enforces the forbidden-writer / forbidden-tool /
 *     empty-description / invalid-key rules.
 *  5. ensureResultSection appends a `## Result` stub only when absent.
 */
import { describe, it, expect } from 'vitest';
import {
  loadBuiltInAgents,
  catalogueMatchesCanonical,
} from '../agentCatalogue';
import { parseBundledAgent } from '../bundledAgentParser';
import { renderAgentMarkdown } from '../agentMarkdown';
import {
  validateAgentDraft,
  ensureResultSection,
  AgentOverrideError,
  type AgentDraft,
} from '../agentValidation';
import { CANONICAL_AGENT_KEYS } from '../../../../../shared/types/agentIdentity';
import { CLI_TOOLS, type CliTool } from '../../../../../shared/types/cliTools';

const cliToolSet = new Set<string>(CLI_TOOLS);

describe('loadBuiltInAgents', () => {
  it('parses exactly the 15 canonical builtins', () => {
    const catalogue = loadBuiltInAgents();
    expect(catalogue.size).toBe(15);
    expect(catalogueMatchesCanonical(catalogue)).toBe(true);
  });

  it('every entry: frontmatter name === cyboflow-<basename>, tools ⊆ CLI_TOOLS, description non-empty', () => {
    const catalogue = loadBuiltInAgents();
    for (const [key, agent] of catalogue) {
      expect(agent.name, `${key} frontmatter name`).toBe(`cyboflow-${key}`);
      expect(agent.agentKey).toBe(key);
      expect(agent.description.trim().length, `${key} description`).toBeGreaterThan(0);
      expect(agent.systemPrompt.trim().length, `${key} body`).toBeGreaterThan(0);
      expect(agent.tools.length, `${key} tools`).toBeGreaterThan(0);
      for (const tool of agent.tools) {
        expect(cliToolSet.has(tool), `${key} tool ${tool}`).toBe(true);
      }
    }
  });

  it('sorted catalogue keys deep-equal sorted CANONICAL_AGENT_KEYS', () => {
    const keys = [...loadBuiltInAgents().keys()].sort();
    expect(keys).toEqual([...CANONICAL_AGENT_KEYS].sort());
  });
});

describe('renderAgentMarkdown ↔ parseBundledAgent round-trip', () => {
  it('round-trips a colon-bearing description YAML-safely', () => {
    const tools: CliTool[] = ['Read', 'Edit', 'Bash'];
    const md = renderAgentMarkdown({
      agentKey: 'implement',
      description: 'Implements a task: scoped to its acceptance criteria.',
      tools,
      enabledMcps: [],
      systemPrompt: 'You are the implement subagent.\n\n## Result\nDone.',
    });
    const parsed = parseBundledAgent(md);
    expect(parsed.name).toBe('cyboflow-implement');
    // The colon-bearing description survives the YAML quote/unquote round-trip.
    expect(parsed.description).toBe('Implements a task: scoped to its acceptance criteria.');
    expect(parsed.tools).toEqual(tools);
    // render emits the canonical "---\n\n<body>" spacer; parse returns the body with
    // that leading separator newline, so compare on trimmed content.
    expect(parsed.body.trim()).toBe('You are the implement subagent.\n\n## Result\nDone.');
  });

  it('appends mcp__<server>__* wildcards to the tools line for enabledMcps', () => {
    const md = renderAgentMarkdown({
      agentKey: 'implement',
      description: 'Implements a task.',
      tools: ['Read', 'Bash'],
      enabledMcps: ['playwright', 'fal-ai'],
      systemPrompt: 'You are the implement subagent.\n\n## Result\nDone.',
    });
    expect(md).toContain('tools: Read, Bash, mcp__playwright__*, mcp__fal-ai__*');
  });

  it('round-trips every bundled builtin name/description/tools through render→parse', () => {
    // Note: the bundled `.md` files carry a blank line after the closing fence, so
    // the parsed body begins with a leading "\n"; renderAgentMarkdown re-emits the
    // canonical "---\n\n<body>" spacer, so the body is NOT byte-identical for those
    // builtins (verbatim preservation is the job of BuiltInAgent.rawContent, not
    // render→parse). The metadata fields ARE stable, which is what we assert here.
    for (const agent of loadBuiltInAgents().values()) {
      const md = renderAgentMarkdown({
        agentKey: agent.agentKey,
        description: agent.description,
        tools: agent.tools,
        enabledMcps: [],
        systemPrompt: agent.systemPrompt,
      });
      const parsed = parseBundledAgent(md);
      expect(parsed.name).toBe(`cyboflow-${agent.agentKey}`);
      expect(parsed.description).toBe(agent.description);
      expect(parsed.tools).toEqual(agent.tools);
      expect(parsed.body.trim()).toBe(agent.systemPrompt.trim());
    }
  });
});

describe('validateAgentDraft', () => {
  const base: AgentDraft = {
    agentKey: 'my-agent',
    name: 'cyboflow-my-agent',
    role: null,
    description: 'A valid description.',
    systemPrompt: 'You are an agent.\n\n## Result\nOK.',
    tools: ['Read', 'Bash'],
    enabledMcps: [],
    isCustom: true,
  };

  const expectCode = (draft: AgentDraft, code: string): void => {
    try {
      validateAgentDraft(draft);
      throw new Error('expected validateAgentDraft to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentOverrideError);
      expect((err as AgentOverrideError).code).toBe(code);
    }
  };

  it('accepts a valid draft', () => {
    expect(() => validateAgentDraft(base)).not.toThrow();
  });

  it('forbidden_writer_call when cyboflow_ is in the description', () => {
    expectCode({ ...base, description: 'calls cyboflow_update_task' }, 'forbidden_writer_call');
  });

  it('forbidden_writer_call when cyboflow_ is in the system prompt body', () => {
    expectCode(
      { ...base, systemPrompt: 'Use cyboflow_create_idea then stop.' },
      'forbidden_writer_call',
    );
  });

  it('forbidden_tool for a non-CLI tool', () => {
    expectCode({ ...base, tools: ['Read', 'Task'] as unknown as CliTool[] }, 'forbidden_tool');
  });

  it('empty_description for a blank description', () => {
    expectCode({ ...base, description: '   ' }, 'empty_description');
  });

  it('empty_tools for no tools', () => {
    expectCode({ ...base, tools: [] }, 'empty_tools');
  });

  it('invalid_key for a non-kebab key', () => {
    expectCode({ ...base, agentKey: 'My_Agent' }, 'invalid_key');
  });

  it('frontmatter_in_body when the prompt starts with ---', () => {
    expectCode({ ...base, systemPrompt: '---\nname: x\n---\n' }, 'frontmatter_in_body');
  });

  it('accepts valid MCP server names', () => {
    expect(() =>
      validateAgentDraft({ ...base, enabledMcps: ['playwright', 'fal-ai', 'context7'] }),
    ).not.toThrow();
  });

  it('invalid_mcp for a malformed server name', () => {
    expectCode({ ...base, enabledMcps: ['bad name!'] }, 'invalid_mcp');
  });

  it('invalid_mcp for the single-writer cyboflow server', () => {
    expectCode({ ...base, enabledMcps: ['cyboflow'] }, 'invalid_mcp');
  });

  it('invalid_mcp for a cyboflow_-prefixed server', () => {
    expectCode({ ...base, enabledMcps: ['cyboflow_update_task'] }, 'invalid_mcp');
  });
});

describe('ensureResultSection', () => {
  it('appends a ## Result stub only when absent', () => {
    const without = 'You are an agent.';
    const appended = ensureResultSection(without);
    expect(appended).toContain('## Result');
    expect(appended.startsWith(without)).toBe(true);
  });

  it('leaves a prompt that already has a Result section unchanged', () => {
    const withResult = 'You are an agent.\n\n## Result\nReturn a summary.';
    expect(ensureResultSection(withResult)).toBe(withResult);
  });
});
