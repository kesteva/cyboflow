/**
 * Unit tests for SessionContext / SessionProvider.
 *
 * Verifies:
 *   - No session renders the "No session selected" placeholder (unchanged
 *     behavior from before the useMemo fix).
 *   - The provider value is memoized: a parent re-render with referentially
 *     stable props does NOT re-render a consumer (the bug this fix closes —
 *     a fresh value object every render used to re-render every consumer).
 *   - A prop that actually changes (e.g. isMerging) still propagates.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { memo, useState } from 'react';
import { SessionProvider, useSession } from '../SessionContext';
import type { Session } from '../../types/session';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'tester-mctest',
    worktreePath: '/repo/.cyboflow/worktrees/quick-1',
    prompt: '',
    status: 'running',
    createdAt: new Date().toISOString(),
    output: [],
    jsonMessages: [],
    ...overrides,
  } as Session;
}

// React.memo'd so a re-render of Harness alone (unchanged renderSpy prop)
// does NOT force this to re-execute — the only remaining trigger is the
// SessionContext value itself changing. This isolates what the useMemo fix
// actually protects: ordinary prop-drilling re-renders were never the bug.
const Consumer = memo(function Consumer({ renderSpy }: { renderSpy: () => void }) {
  renderSpy();
  const ctx = useSession();
  return <div data-testid="merging">{String(ctx?.isMerging)}</div>;
});

describe('SessionProvider', () => {
  it('renders the "No session selected" placeholder when session is null', () => {
    render(
      <SessionProvider session={null}>
        <div>children</div>
      </SessionProvider>,
    );
    expect(screen.getByText('No session selected')).toBeInTheDocument();
    expect(screen.queryByText('children')).not.toBeInTheDocument();
  });

  it('does not re-render consumers when the provider re-renders with unchanged props', () => {
    const session = makeSession();
    const renderSpy = vi.fn();

    function Harness() {
      const [, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((t) => t + 1)}>bump</button>
          <SessionProvider session={session} isMerging={false}>
            <Consumer renderSpy={renderSpy} />
          </SessionProvider>
        </div>
      );
    }

    render(<Harness />);
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // Re-render the parent (Harness) with the SAME session/isMerging props —
    // before the useMemo fix, SessionProvider built a fresh context value
    // every render, so the consumer would render again here too.
    fireEvent.click(screen.getByText('bump'));
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('still propagates a prop that actually changes', () => {
    const session = makeSession();

    function Harness() {
      const [isMerging, setIsMerging] = useState(false);
      return (
        <div>
          <button onClick={() => setIsMerging(true)}>merge</button>
          <SessionProvider session={session} isMerging={isMerging}>
            <Consumer renderSpy={() => undefined} />
          </SessionProvider>
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId('merging')).toHaveTextContent('false');

    fireEvent.click(screen.getByText('merge'));
    expect(screen.getByTestId('merging')).toHaveTextContent('true');
  });
});
