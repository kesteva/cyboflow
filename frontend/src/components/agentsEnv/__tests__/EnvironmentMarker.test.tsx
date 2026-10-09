import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EnvironmentMarker } from '../EnvironmentMarker';
import { useHostsStore } from '../../../stores/hostsStore';
import { makeHost } from './fixtures';

afterEach(() => {
  act(() => useHostsStore.setState({ hosts: [] }));
});

describe('EnvironmentMarker', () => {
  it('renders nothing for null, undefined and local', () => {
    const { container, rerender } = render(<EnvironmentMarker hostId={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EnvironmentMarker hostId={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<EnvironmentMarker hostId="local" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the host label for a known host', () => {
    act(() => useHostsStore.setState({ hosts: [makeHost({ id: 'h2', label: 'Build box', lifecycleState: 'online' })] }));
    render(<EnvironmentMarker hostId="h2" />);
    expect(screen.getByTestId('environment-marker')).toHaveTextContent('Build box');
  });

  it('falls back to Remote for an unknown host', () => {
    render(<EnvironmentMarker hostId="gone" />);
    expect(screen.getByTestId('environment-marker')).toHaveTextContent('Remote');
  });

  it('uses the error tone for an unreachable host', () => {
    act(() => useHostsStore.setState({ hosts: [makeHost({ id: 'h2', lifecycleState: 'unreachable' })] }));
    render(<EnvironmentMarker hostId="h2" />);
    expect(screen.getByTestId('environment-marker').firstElementChild?.className).toContain('status-error');
  });
});
