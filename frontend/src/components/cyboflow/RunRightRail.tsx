/**
 * RunRightRail — fixed-width right rail in the CyboflowRoot two-column layout.
 *
 * Contains three tabs:
 *   - Workflow Progress (default selected) — placeholder for TASK-768
 *   - File Explorer — placeholder
 *   - Diff — placeholder
 */
import { useState } from 'react';

type TabId = 'workflow-progress' | 'file-explorer' | 'diff';

interface Tab {
  id: TabId;
  label: string;
  testid: string;
  panelTestid: string;
  placeholder: string;
}

const TABS: Tab[] = [
  {
    id: 'workflow-progress',
    label: 'Workflow Progress',
    testid: 'run-right-rail-tab-workflow-progress',
    panelTestid: 'run-right-rail-workflow-progress-placeholder',
    placeholder: 'Workflow Progress — coming soon',
  },
  {
    id: 'file-explorer',
    label: 'File Explorer',
    testid: 'run-right-rail-tab-file-explorer',
    panelTestid: 'run-right-rail-file-explorer-placeholder',
    placeholder: 'File Explorer — coming soon',
  },
  {
    id: 'diff',
    label: 'Diff',
    testid: 'run-right-rail-tab-diff',
    panelTestid: 'run-right-rail-diff-placeholder',
    placeholder: 'Diff — coming soon',
  },
];

export function RunRightRail() {
  const [activeTab, setActiveTab] = useState<TabId>('workflow-progress');

  const currentTab = TABS.find((t) => t.id === activeTab) ?? TABS[0];

  return (
    <aside
      data-testid="run-right-rail"
      className="w-[296px] shrink-0 flex flex-col border-l border-border-primary bg-bg-primary"
    >
      {/* Tab bar */}
      <div
        role="tablist"
        className="flex border-b border-border-primary"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              data-testid={tab.testid}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'flex-1 px-2 py-1.5 text-xs font-medium transition-colors',
                isActive
                  ? 'border-b-2 border-interactive text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div
        role="tabpanel"
        className="flex-1 overflow-y-auto"
      >
        <div
          data-testid={currentTab.panelTestid}
          className="p-4 text-sm text-text-secondary"
        >
          {currentTab.placeholder}
        </div>
      </div>
    </aside>
  );
}
