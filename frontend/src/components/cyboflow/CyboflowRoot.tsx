/**
 * CyboflowRoot — top-level Cyboflow view.
 *
 * Layout:
 *   header row     — thin bar with a "Choose workflow" button
 *   main content   — empty-state CTA when activeRunId is null, RunView otherwise
 *   Modal overlay  — WorkflowPicker mounted inside Modal; opened from the
 *                    header button or the empty-state CTA
 */
import { useState } from 'react';
import { WorkflowPicker } from './WorkflowPicker';
import { RunView } from './RunView';
import { Modal } from '../ui/Modal';
import { useCyboflowStore } from '../../stores/cyboflowStore';

interface CyboflowRootProps {
  projectId: number | null;
}

export function CyboflowRoot({ projectId }: CyboflowRootProps) {
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  return (
    <div className="flex h-full flex-col">
      {/* Thin top header row */}
      <div className="flex items-center gap-2 border-b border-border-primary px-4 py-2">
        <button
          onClick={() => setIsPickerOpen(true)}
          className="rounded bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
          data-testid="open-workflow-picker"
        >
          Choose workflow
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-auto p-4">
        {activeRunId !== null ? (
          <RunView />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-text-secondary">Choose a workflow to start</p>
            <button
              onClick={() => setIsPickerOpen(true)}
              className="rounded bg-interactive px-4 py-2 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover"
              data-testid="open-workflow-picker-cta"
            >
              Choose a workflow
            </button>
          </div>
        )}
      </div>

      {/* WorkflowPicker modal — only rendered when projectId is a number */}
      {projectId !== null && (
        <Modal
          isOpen={isPickerOpen}
          onClose={() => setIsPickerOpen(false)}
          size="md"
        >
          <div className="p-6">
            <WorkflowPicker
              projectId={projectId}
              onWorkflowStarted={() => setIsPickerOpen(false)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
