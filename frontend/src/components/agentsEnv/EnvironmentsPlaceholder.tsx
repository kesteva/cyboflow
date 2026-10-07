import { Server } from 'lucide-react';
import { EmptyWell } from '../landing/QueuePrimitives';

/** The Environments tab is a placeholder in this build: no data, no tRPC. */
export function EnvironmentsPlaceholder(): React.JSX.Element {
  return (
    <div className="p-7">
      <EmptyWell
        testId="environments-placeholder"
        icon={<Server className="h-5 w-5 text-text-tertiary" />}
        title="Environments are on the way"
        body="Run sessions and workflows on other machines — SSH hosts, sandboxes and cloud VMs — and see them here. Not available in this build yet."
      />
    </div>
  );
}
