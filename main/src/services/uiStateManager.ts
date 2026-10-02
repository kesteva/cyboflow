import { DatabaseService } from '../database/database';

class UIStateManager {
  private db: DatabaseService;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  getExpandedProjects(): number[] {
    const value = this.db.getUIState('treeView.expandedProjects');
    if (!value) return [];
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }

  saveExpandedProjects(projectIds: number[]): void {
    this.db.setUIState('treeView.expandedProjects', JSON.stringify(projectIds));
  }

  getExpandedState(): { expandedProjects: number[] } {
    return {
      expandedProjects: this.getExpandedProjects()
    };
  }

  clear(): void {
    this.db.deleteUIState('treeView.expandedProjects');
  }
}

export { UIStateManager };