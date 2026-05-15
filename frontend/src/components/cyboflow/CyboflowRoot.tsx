/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   aside (w-80) — WorkflowPicker
 *   main  (flex-1) — RunView
 */
import { WorkflowPicker } from './WorkflowPicker';
import { RunView } from './RunView';

interface CyboflowRootProps {
  projectId: number;
}

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  return (
    <div className="flex h-full">
      <aside className="w-80 border-r border-border-primary p-4">
        <WorkflowPicker projectId={projectId} />
      </aside>
      <main className="flex-1 overflow-auto p-4">
        <RunView />
      </main>
    </div>
  );
}
