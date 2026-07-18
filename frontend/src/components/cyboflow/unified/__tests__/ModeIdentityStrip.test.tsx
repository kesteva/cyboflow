import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModeIdentityStrip } from '../ModeIdentityStrip';

describe('ModeIdentityStrip — mode label branch', () => {
  it('renders "quick session" for mode=quick', () => {
    render(<ModeIdentityStrip name="Claude" transport="sdk" mode="quick" running={false} />);
    expect(screen.getByTestId('chat-mode-identity')).toHaveTextContent('quick session');
  });

  it('renders "flow run" for mode=flow', () => {
    render(<ModeIdentityStrip name="Sprint" transport="sdk" mode="flow" running={false} />);
    expect(screen.getByTestId('chat-mode-identity')).toHaveTextContent('flow run');
  });

  it('renders "agent thread" for mode=agent (S1.2 ChatMode union widening)', () => {
    render(<ModeIdentityStrip name="cyboflow agent" transport="sdk" mode="agent" running={false} />);
    const strip = screen.getByTestId('chat-mode-identity');
    expect(strip).toHaveTextContent('agent thread');
    expect(strip).not.toHaveTextContent('flow run');
    expect(strip).not.toHaveTextContent('quick session');
  });
});
