import React, { useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidRenderer } from './MermaidRenderer';

interface CodeComponentProps extends React.HTMLAttributes<HTMLElement> {
  node?: unknown;
  className?: string;
  children?: React.ReactNode;
}

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  id?: string;
}

// Hoisted to module scope so the plugin array + components map keep a STABLE
// identity across renders. Recreating either inline (as the prior version did)
// gives ReactMarkdown a fresh `components`/`remarkPlugins` reference every
// render, defeating its internal memoization and forcing a full re-parse of the
// content on every parent render — the transcript re-parsed ALL markdown on
// every live refetch. With these constant, an unchanged `content` never
// re-parses (see the `useMemo` + `React.memo` below).
const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS: Components = {
  code({ node, className, children, ...props }: CodeComponentProps) {
    const match = /language-(\w+)/.exec(className || '');
    const language = match ? match[1] : '';
    const codeString = String(children).replace(/\n$/, '');

    // Check if this is an inline code element
    const inline = !className || !className.includes('language-');

    if (!inline && language === 'mermaid') {
      // Key + id are derived from the chart text (deterministic) so the diagram
      // re-renders only when its source changes — no monotonic counter/Date.now
      // in the render path, which would break memoization identity.
      return (
        <MermaidRenderer
          key={`mermaid-${codeString.substring(0, 20)}`}
          chart={codeString}
          id="markdown-preview"
        />
      );
    }

    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  // Style other markdown elements
  h1: ({ children }) => <h1 className="text-3xl font-bold mt-6 mb-4 text-text-primary">{children}</h1>,
  h2: ({ children }) => <h2 className="text-2xl font-bold mt-5 mb-3 text-text-primary">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xl font-bold mt-4 mb-2 text-text-primary">{children}</h3>,
  h4: ({ children }) => <h4 className="text-lg font-bold mt-3 mb-2 text-text-primary">{children}</h4>,
  p: ({ children }) => <p className="mb-4 text-text-primary">{children}</p>,
  ul: ({ children }) => <ul className="list-disc mb-4 ml-6 text-text-primary">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal mb-4 ml-6 text-text-primary">{children}</ol>,
  li: ({ children }) => <li className="mb-2 text-text-primary">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-border-secondary pl-4 italic my-4 text-text-tertiary">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto mb-4">
      <table className="min-w-full border-collapse border border-border-primary">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border-primary px-4 py-2 bg-surface-secondary font-semibold text-left text-text-primary">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border-primary px-4 py-2 text-text-primary">
      {children}
    </td>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-interactive-on-dark" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  hr: () => <hr className="my-6 border-border-primary" />,
};

const MarkdownPreviewComponent: React.FC<MarkdownPreviewProps> = ({ content, className = '' }) => {
  // Parse markdown only when the content string (or wrapper className) actually
  // changes. Combined with the module-level constants above and the React.memo
  // wrapper, this keeps an unchanged content string from ever re-invoking
  // ReactMarkdown — even when an ancestor re-renders for an unrelated reason.
  return useMemo(
    () => (
      <div className={`markdown-preview ${className}`}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </div>
    ),
    [content, className],
  );
};

export const MarkdownPreview = React.memo(MarkdownPreviewComponent);
MarkdownPreview.displayName = 'MarkdownPreview';
