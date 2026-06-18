import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMetaStrip } from '../ChatMetaStrip';

describe('ChatMetaStrip', () => {
  it('renders folder + branch chips', () => {
    render(
      <ChatMetaStrip
        folderLabel="feature-x"
        folderTitle="/Users/me/worktrees/feature-x"
        branchName="feature/x"
        contextUsage={null}
      />,
    );
    const strip = screen.getByTestId('chat-meta-strip');
    expect(strip).toHaveTextContent('feature-x');
    expect(strip).toHaveTextContent('feature/x');
  });

  it('omits chips when folder/branch are null', () => {
    render(<ChatMetaStrip folderLabel={null} branchName={null} contextUsage={null} />);
    const strip = screen.getByTestId('chat-meta-strip');
    expect(strip).not.toHaveTextContent('feature');
    // Empty context state, no NaN%.
    expect(strip).toHaveTextContent('-- tokens · --% ctx');
  });

  it('renders a real context meter from the producer string', () => {
    render(
      <ChatMetaStrip folderLabel={null} branchName={null} contextUsage="54k/200k tokens (27%)" />,
    );
    const strip = screen.getByTestId('chat-meta-strip');
    expect(strip).toHaveTextContent('54k');
    expect(strip).toHaveTextContent('27% of 200k ctx');
  });
});
