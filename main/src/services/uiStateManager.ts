import { DatabaseService } from '../database/database';

interface UIState {
  treeView: {
    expandedProjects: number[];
    expandedFolders: string[];
  };
}

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

  getExpandedFolders(): string[] {
    const value = this.db.getUIState('treeView.expandedFolders');
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

  saveExpandedFolders(folderIds: string[]): void {
    this.db.setUIState('treeView.expandedFolders', JSON.stringify(folderIds));
  }

  saveExpandedState(projectIds: number[], folderIds: string[]): void {
    this.saveExpandedProjects(projectIds);
    this.saveExpandedFolders(folderIds);
  }

  getExpandedState(): { expandedProjects: number[]; expandedFolders: string[] } {
    return {
      expandedProjects: this.getExpandedProjects(),
      expandedFolders: this.getExpandedFolders()
    };
  }

  clear(): void {
    this.db.deleteUIState('treeView.expandedProjects');
    this.db.deleteUIState('treeView.expandedFolders');
  }
}

export { UIStateManager };