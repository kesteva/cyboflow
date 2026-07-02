/**
 * PermissionDialog — the tool-permission prompt.
 *
 * Covers: null when no request; Allow with valid edited JSON forwards the parsed
 * override; Allow with BROKEN edited JSON falls back to the original input (no
 * throw); Deny (button + modal close) forwards the canonical deny message; the
 * high-risk badge is tool-scoped; the per-tool input preview blocks + >500-char
 * truncation; the Edit→Preview toggle preserves unedited input.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PermissionDialog } from '../PermissionDialog';

interface Req {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: number;
}

function makeRequest(over: Partial<Req> = {}): Req {
  return {
    id: 'req-1',
    sessionId: 'sess-1',
    toolName: 'Bash',
    input: { command: 'ls -la', description: 'list files' },
    timestamp: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('PermissionDialog', () => {
  it('renders nothing when there is no request', () => {
    const { container } = render(<PermissionDialog request={null} onRespond={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('Allow (no edit) forwards the original input verbatim', () => {
    const onRespond = vi.fn();
    render(<PermissionDialog request={makeRequest()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: /allow/i }));
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow', { command: 'ls -la', description: 'list files' });
  });

  it('Allow with valid edited JSON forwards the parsed override', () => {
    const onRespond = vi.fn();
    render(<PermissionDialog request={makeRequest()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{"command":"rm -rf tmp"}' } });
    fireEvent.click(screen.getByRole('button', { name: /allow/i }));
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow', { command: 'rm -rf tmp' });
  });

  it('Allow with BROKEN edited JSON falls back to the original input (no throw)', () => {
    // NOTE: current product behavior — a malformed edit silently reverts to the
    // ORIGINAL request.input rather than blocking the approval. Pinned as-is.
    const onRespond = vi.fn();
    render(<PermissionDialog request={makeRequest()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '{not valid json' } });
    fireEvent.click(screen.getByRole('button', { name: /allow/i }));
    expect(onRespond).toHaveBeenCalledWith('req-1', 'allow', { command: 'ls -la', description: 'list files' });
  });

  it('Deny forwards the canonical deny message', () => {
    const onRespond = vi.fn();
    render(<PermissionDialog request={makeRequest()} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onRespond).toHaveBeenCalledWith('req-1', 'deny', undefined, 'Permission denied by user');
  });

  it('shows the High Risk badge for Bash/Write/Edit but not for Read', () => {
    const { rerender } = render(<PermissionDialog request={makeRequest({ toolName: 'Bash' })} onRespond={vi.fn()} />);
    expect(screen.getByText('High Risk')).toBeInTheDocument();
    rerender(<PermissionDialog request={makeRequest({ toolName: 'Write', input: { file_path: '/x' } })} onRespond={vi.fn()} />);
    expect(screen.getByText('High Risk')).toBeInTheDocument();
    rerender(<PermissionDialog request={makeRequest({ toolName: 'Read', input: { file_path: '/x' } })} onRespond={vi.fn()} />);
    expect(screen.queryByText('High Risk')).toBeNull();
  });

  it('renders the Bash preview (command + description)', () => {
    render(<PermissionDialog request={makeRequest()} onRespond={vi.fn()} />);
    expect(screen.getByText('ls -la')).toBeInTheDocument();
    expect(screen.getByText('list files')).toBeInTheDocument();
  });

  it('truncates a >500-char Write content preview with an ellipsis', () => {
    const long = 'a'.repeat(600);
    render(
      <PermissionDialog
        request={makeRequest({ toolName: 'Write', input: { file_path: '/big.txt', content: long } })}
        onRespond={vi.fn()}
      />,
    );
    const preview = screen.getByText(/^a+\.\.\.$/);
    // 500 chars + the ellipsis.
    expect(preview.textContent).toHaveLength(503);
  });

  it('Edit→Preview toggle preserves the unedited input', () => {
    render(<PermissionDialog request={makeRequest()} onRespond={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    // Toggle back to Preview without editing.
    fireEvent.click(screen.getByRole('button', { name: /preview/i }));
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });
});
