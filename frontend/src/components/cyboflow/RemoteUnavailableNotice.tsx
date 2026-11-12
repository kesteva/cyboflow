/**
 * The empty state a local-only surface shows for a session on a remote environment (M2): "Not available on remote
 * environments", plus an optional pointer at what to use instead.
 */
import type { ReactElement } from 'react';
import { REMOTE_UNAVAILABLE_MESSAGE } from '../../../../shared/types/remoteEnvironment';

export interface RemoteUnavailableNoticeProps {
  /** A second line, e.g. where to go instead. */
  hint?: string;
  testId?: string;
}

export function RemoteUnavailableNotice({ hint, testId = 'remote-unavailable' }: RemoteUnavailableNoticeProps): ReactElement {
  return (
    <div data-testid={testId} className="p-4 text-sm text-text-secondary">
      <p>{REMOTE_UNAVAILABLE_MESSAGE}</p>
      {hint ? <p className="mt-1 text-text-tertiary">{hint}</p> : null}
    </div>
  );
}
