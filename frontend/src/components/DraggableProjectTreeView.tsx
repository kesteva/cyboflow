import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder as FolderIcon, FolderOpen, Plus, Settings, GripVertical, Archive, GitBranch, RefreshCw } from 'lucide-react';
import { useErrorStore } from '../stores/errorStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useCyboflowStore } from '../stores/cyboflowStore';
import ProjectSettings from './ProjectSettings';
import { EmptyState } from './EmptyState';
import { LoadingSpinner } from './LoadingSpinner';
import { API } from '../utils/api';
import { trpc } from '../trpc/client';
import type { WorkflowRunListRow } from '../../../shared/types/workflows';
import { debounce } from '../utils/debounce';
import { throttle } from '../utils/performanceUtils';
import type { Project, CreateProjectRequest } from '../types/project';
import type { Folder } from '../types/folder';
import { useContextMenu } from '../contexts/ContextMenuContext';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { Card } from './ui/Card';
import { formatDistanceToNow } from '../utils/timestampUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectWithRuns extends Project {
  /** Always-empty placeholder; kept so existing folder/drag logic compiles. */
  sessions: never[];
  folders: Folder[];
  runs: WorkflowRunListRow[];
}

interface DragState {
  type: 'project' | 'folder' | null;
  projectId: number | null;
  folderId: string | null;
  overType: 'project' | 'folder' | null;
  overProjectId: number | null;
  overFolderId: string | null;
}

/** No props — sort order is always newest-first by created_at DESC. */
export type DraggableProjectTreeViewProps = Record<string, never>;

// ---------------------------------------------------------------------------
// Status indicator helpers
// ---------------------------------------------------------------------------

const STATUS_DOT_CLASS: Record<string, string> = {
  queued: 'bg-text-tertiary',
  starting: 'bg-status-info animate-pulse',
  running: 'bg-status-success animate-pulse',
  awaiting_review: 'bg-status-warning animate-pulse',
  stuck: 'bg-status-error',
  completed: 'bg-status-neutral',
  failed: 'bg-status-error',
  canceled: 'bg-text-tertiary',
};

function statusDotClass(status: string): string {
  return STATUS_DOT_CLASS[status] ?? 'bg-text-tertiary';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DraggableProjectTreeView(_props: DraggableProjectTreeViewProps) {
  const [projectsWithRuns, setProjectsWithRuns] = useState<ProjectWithRuns[]>([]);
  const [archivedProjectsWithSessions] = useState<ProjectWithRuns[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [expandedArchivedProjects, setExpandedArchivedProjects] = useState<Set<number>>(new Set());
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingArchived, setIsLoadingArchived] = useState(false);
  const [showProjectSettings, setShowProjectSettings] = useState(false);
  const [selectedProjectForSettings, setSelectedProjectForSettings] = useState<Project | null>(null);
  const [showAddProjectDialog, setShowAddProjectDialog] = useState(false);
  const [newProject, setNewProject] = useState<CreateProjectRequest>({ name: '', path: '', buildScript: '', runScript: '' });
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [detectedBranchForNewProject, setDetectedBranchForNewProject] = useState<string | null>(null);
  const [showCreateFolderDialog, setShowCreateFolderDialog] = useState(false);
  const [refreshingProjects, setRefreshingProjects] = useState<Set<number>>(new Set());
  const [runningProjectId, setRunningProjectId] = useState<number | null>(null);
  const [closingProjectId, setClosingProjectId] = useState<number | null>(null);
  const [selectedProjectForFolder, setSelectedProjectForFolder] = useState<Project | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [parentFolderForCreate, setParentFolderForCreate] = useState<Folder | null>(null);

  // Folder rename state
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');

  // Drag state — session-based fields removed; project and folder DnD preserved.
  const [dragState, setDragState] = useState<DragState>({
    type: null,
    projectId: null,
    folderId: null,
    overType: null,
    overProjectId: null,
    overFolderId: null,
  });
  const dragCounter = useRef(0);

  const { showError } = useErrorStore();
  const activeProjectId = useNavigationStore((state) => state.activeProjectId);
  const { menuState, openMenu, closeMenu, isMenuOpen } = useContextMenu();

  // Performance monitoring
  const renderCountRef = useRef(0);
  const lastRenderTimeRef = useRef(Date.now());

  useEffect(() => {
    renderCountRef.current += 1;
    const now = Date.now();
    const timeSinceLastRender = now - lastRenderTimeRef.current;
    if (process.env.NODE_ENV === 'development' && timeSinceLastRender < 100) {
      // Rapid re-render detection — logging removed to reduce noise
    }
    lastRenderTimeRef.current = now;
  });

  // Debounced UI state save
  const saveUIState = useCallback(
    debounce(async (projectIds: number[], folderIds: string[]) => {
      try {
        await window.electronAPI?.uiState?.saveExpanded(projectIds, folderIds);
      } catch (error) {
        console.error('[DraggableProjectTreeView] Failed to save UI state:', error);
      }
    }, 500),
    [],
  );

  useEffect(() => {
    const projectIds = Array.from(expandedProjects);
    const folderIds = Array.from(expandedFolders);
    saveUIState(projectIds, folderIds);
  }, [expandedProjects, expandedFolders, saveUIState]);

  const handleFolderCreated = (folder: Folder) => {
    setProjectsWithRuns(prevProjects => {
      return prevProjects.map(project => {
        if (project.id === folder.projectId) {
          return {
            ...project,
            folders: [...(project.folders || []), folder],
          };
        }
        return project;
      });
    });
    setExpandedFolders(prev => new Set([...prev, folder.id]));
    if (folder.projectId) {
      setExpandedProjects(prev => new Set([...prev, folder.projectId]));
    }
  };

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadProjectsWithRuns = async () => {
    try {
      setIsLoading(true);
      const response = await API.projects.getAll();
      if (!response.success || !response.data) {
        return;
      }

      const projects = response.data as Project[];

      // Fetch runs for every project in parallel (newest first — server sorts DESC)
      const runsPerProject = await Promise.all(
        projects.map(p =>
          trpc.cyboflow.runs.list.query({ projectId: p.id }).catch(() => [] as WorkflowRunListRow[]),
        ),
      );

      const projectsWithRunsData: ProjectWithRuns[] = projects.map((p, i) => ({
        ...p,
        sessions: [] as never[],
        folders: [] as Folder[],
        runs: runsPerProject[i],
      }));

      setProjectsWithRuns(projectsWithRunsData);

      // Restore saved UI state or auto-expand
      let savedState = null;
      try {
        const stateResponse = await window.electronAPI?.uiState?.getExpanded();
        if (stateResponse?.success && stateResponse.data) {
          savedState = stateResponse.data;
        }
      } catch (_e) {
        console.error('[DraggableProjectTreeView] Failed to load saved UI state:', _e);
      }

      if (savedState?.expandedProjects && savedState?.expandedFolders) {
        setExpandedProjects(new Set(savedState.expandedProjects));
        setExpandedFolders(new Set(savedState.expandedFolders));
      } else {
        // Auto-expand projects that have runs
        const projectsToExpand = new Set<number>();
        projectsWithRunsData.forEach(p => {
          if (p.runs.length > 0) {
            projectsToExpand.add(p.id);
          }
        });
        setExpandedProjects(projectsToExpand);
        setExpandedFolders(new Set());
      }
    } catch (error) {
      console.error('Failed to load projects with runs:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Load folders separately and merge
  const loadFoldersForProjects = async (projects: ProjectWithRuns[]) => {
    try {
      const foldersPerProject = await Promise.all(
        projects.map(p =>
          window.electronAPI?.folders?.getByProject(p.id)
            .then(r => (r.success && r.data ? r.data : []))
            .catch(() => [] as Folder[]),
        ),
      );
      setProjectsWithRuns(prev =>
        prev.map((p, i) => ({
          ...p,
          folders: foldersPerProject[i] ?? [],
        })),
      );
    } catch (error) {
      console.error('[DraggableProjectTreeView] Failed to load folders:', error);
    }
  };

  useEffect(() => {
    // Initial data load
    const initialize = async () => {
      await loadProjectsWithRuns();
    };
    initialize();

    // Folder event listeners (session listeners removed)
    const handleFolderUpdated = (updatedFolder: Folder) => {
      setProjectsWithRuns(prevProjects =>
        prevProjects.map(project => {
          if (project.id === updatedFolder.projectId) {
            return {
              ...project,
              folders: project.folders.map(folder =>
                folder.id === updatedFolder.id ? updatedFolder : folder,
              ),
            };
          }
          return project;
        }),
      );
    };

    const handleFolderDeleted = (folderId: string) => {
      setProjectsWithRuns(prevProjects =>
        prevProjects.map(project => {
          const folderExists = project.folders?.some(f => f.id === folderId);
          if (folderExists) {
            return {
              ...project,
              folders: project.folders.filter(f => f.id !== folderId),
            };
          }
          return project;
        }),
      );
      setExpandedFolders(prev => {
        const newSet = new Set(prev);
        newSet.delete(folderId);
        return newSet;
      });
    };

    if (window.electronAPI?.events) {
      const unsubscribeFolderCreated = window.electronAPI.events.onFolderCreated(handleFolderCreated);
      const unsubscribeFolderUpdated = window.electronAPI.events.onFolderUpdated(handleFolderUpdated);
      const unsubscribeFolderDeleted = window.electronAPI.events.onFolderDeleted(handleFolderDeleted);

      const unsubscribeProjectUpdated = window.electronAPI.events.onProjectUpdated((updatedProject: Project) => {
        setProjectsWithRuns(prevProjects =>
          prevProjects.map(project => {
            if (project.id === updatedProject.id) {
              return {
                ...project,
                ...updatedProject,
                sessions: [] as never[],
                folders: project.folders,
                runs: project.runs,
              };
            }
            return project;
          }),
        );
        window.dispatchEvent(new CustomEvent('project-updated', { detail: updatedProject }));
      });

      return () => {
        unsubscribeFolderCreated();
        unsubscribeFolderUpdated();
        unsubscribeFolderDeleted();
        unsubscribeProjectUpdated();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load folders after projects are loaded
  useEffect(() => {
    if (projectsWithRuns.length > 0) {
      loadFoldersForProjects(projectsWithRuns);
    }
  }, [projectsWithRuns.length]);

  // Track running project scripts
  useEffect(() => {
    const checkRunningProject = async () => {
      try {
        const response = await window.electronAPI.projects.getRunningScript();
        if (response.success && response.data) {
          setRunningProjectId(response.data as number);
        }
      } catch (error) {
        console.error('Failed to check running project:', error);
      }
    };
    checkRunningProject();

    const handleProjectScriptChanged = (event: CustomEvent) => {
      const { projectId } = event.detail;
      setRunningProjectId(projectId);
      setClosingProjectId(null);
    };
    const handleProjectScriptClosing = (event: CustomEvent) => {
      const { projectId } = event.detail;
      setClosingProjectId(projectId);
    };
    const handlePanelEvent = (event: CustomEvent) => {
      const panelEvent = event.detail;
      if (panelEvent.type === 'process:ended' && panelEvent.source?.panelType === 'logs') {
        const sessionId = panelEvent.source.sessionId;
        if (sessionId && runningProjectId !== null) {
          const project = projectsWithRuns.find(p =>
            p.sessions.some((s: never) => (s as { id: string; isMainRepo?: boolean }).id === sessionId && (s as { id: string; isMainRepo?: boolean }).isMainRepo),
          );
          if (project && project.id === runningProjectId) {
            setRunningProjectId(null);
            setClosingProjectId(null);
          }
        }
      }
    };
    window.addEventListener('project-script-changed', handleProjectScriptChanged as EventListener);
    window.addEventListener('project-script-closing', handleProjectScriptClosing as EventListener);
    window.addEventListener('panel:event', handlePanelEvent as EventListener);
    return () => {
      window.removeEventListener('project-script-changed', handleProjectScriptChanged as EventListener);
      window.removeEventListener('project-script-closing', handleProjectScriptClosing as EventListener);
      window.removeEventListener('panel:event', handlePanelEvent as EventListener);
    };
  }, [runningProjectId, projectsWithRuns]);

  // ---------------------------------------------------------------------------
  // Toggle helpers
  // ---------------------------------------------------------------------------

  const toggleProject = useCallback((projectId: number, event?: React.MouseEvent) => {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    setExpandedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
        if (window.electronAPI?.git?.cancelStatusForProject) {
          window.electronAPI.git.cancelStatusForProject(projectId).catch(error => {
            console.error('[DraggableProjectTreeView] Failed to cancel git status:', error);
          });
        }
      } else {
        newSet.add(projectId);
      }
      return newSet;
    });
  }, []);

  const toggleFolder = useCallback((folderId: string, event?: React.MouseEvent) => {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderId)) {
        newSet.delete(folderId);
      } else {
        newSet.add(folderId);
      }
      return newSet;
    });
  }, []);

  const toggleArchivedProject = useCallback((projectId: number, event?: React.MouseEvent) => {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    setExpandedArchivedProjects(prev => {
      const newSet = new Set(prev);
      if (newSet.has(projectId)) {
        newSet.delete(projectId);
      } else {
        newSet.add(projectId);
      }
      return newSet;
    });
  }, []);

  const toggleArchivedSessions = useCallback(
    debounce(() => {
      setShowArchivedSessions(prev => {
        const newShowArchived = !prev;
        if (newShowArchived && archivedProjectsWithSessions.length === 0 && !isLoadingArchived) {
          // stub — archived sessions are a session concept; skipped in run-centric view
          setIsLoadingArchived(false);
        }
        return newShowArchived;
      });
    }, 300),
    [archivedProjectsWithSessions.length, isLoadingArchived],
  );

  // ---------------------------------------------------------------------------
  // Folder helpers
  // ---------------------------------------------------------------------------

  const handleStartFolderEdit = (folder: Folder) => {
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
  };

  const handleFolderContextMenu = (e: React.MouseEvent, folder: Folder, projectId: number) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu('folder', { ...folder, projectId }, { x: e.clientX, y: e.clientY });
  };

  const handleSaveFolderEdit = async () => {
    if (!editingFolderId || !editingFolderName.trim()) {
      setEditingFolderId(null);
      return;
    }
    try {
      const response = await API.folders.update(editingFolderId, { name: editingFolderName.trim() });
      if (response.success) {
        setProjectsWithRuns(prev => prev.map(project => ({
          ...project,
          folders: project.folders.map(folder =>
            folder.id === editingFolderId
              ? { ...folder, name: editingFolderName.trim() }
              : folder,
          ),
        })));
      } else {
        showError({ title: 'Failed to rename folder', error: response.error || 'Unknown error occurred' });
      }
    } catch (error: unknown) {
      showError({ title: 'Failed to rename folder', error: error instanceof Error ? error.message : 'Unknown error occurred' });
    } finally {
      setEditingFolderId(null);
      setEditingFolderName('');
    }
  };

  const handleCancelFolderEdit = () => {
    setEditingFolderId(null);
    setEditingFolderName('');
  };

  const buildFolderTree = useCallback((folders: Folder[]): Folder[] => {
    const folderMap = new Map<string, Folder>();
    const rootFolders: Folder[] = [];
    folders.forEach(folder => {
      folderMap.set(folder.id, { ...folder, children: [] });
    });
    folders.forEach(folder => {
      const currentFolder = folderMap.get(folder.id)!;
      if (folder.parentFolderId && folderMap.has(folder.parentFolderId)) {
        const parentFolder = folderMap.get(folder.parentFolderId)!;
        if (!parentFolder.children) parentFolder.children = [];
        parentFolder.children.push(currentFolder);
      } else {
        rootFolders.push(currentFolder);
      }
    });
    const sortFolders = (items: Folder[]) => {
      items.sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
      items.forEach(f => { if (f.children?.length) sortFolders(f.children); });
    };
    sortFolders(rootFolders);
    return rootFolders;
  }, []);

  const handleDeleteFolder = async (folder: Folder, projectId: number) => {
    const message = `Delete empty folder "${folder.name}"?`;
    const confirmed = window.confirm(message);
    if (!confirmed) return;
    try {
      const response = await API.folders.delete(folder.id);
      if (response.success) {
        setProjectsWithRuns(prev => prev.map(p => {
          if (p.id === projectId) {
            return { ...p, folders: p.folders?.filter(f => f.id !== folder.id) || [] };
          }
          return p;
        }));
        setExpandedFolders(prev => {
          const newSet = new Set(prev);
          newSet.delete(folder.id);
          return newSet;
        });
      } else {
        showError({ title: 'Failed to delete folder', error: response.error || 'Unknown error occurred' });
      }
    } catch (error: unknown) {
      showError({ title: 'Failed to delete folder', error: error instanceof Error ? error.message : 'Unknown error occurred' });
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName || !selectedProjectForFolder) return;
    try {
      const response = await API.folders.create(
        newFolderName,
        selectedProjectForFolder.id,
        parentFolderForCreate?.id || null,
      );
      if (response.success && response.data) {
        const newFolder = response.data;
        setProjectsWithRuns(prev => prev.map(project => {
          if (project.id === selectedProjectForFolder.id) {
            return { ...project, folders: [...(project.folders || []), newFolder] };
          }
          return project;
        }));
        if (parentFolderForCreate) {
          setExpandedFolders(prev => new Set([...prev, parentFolderForCreate.id]));
        }
        setShowCreateFolderDialog(false);
        setNewFolderName('');
        setSelectedProjectForFolder(null);
        setParentFolderForCreate(null);
      } else {
        showError({ title: 'Failed to Create Folder', error: response.error || 'Unknown error occurred' });
      }
    } catch (error: unknown) {
      showError({ title: 'Failed to Create Folder', error: error instanceof Error ? error.message : 'Unknown error occurred' });
    }
  };

  // ---------------------------------------------------------------------------
  // Project action handlers
  // ---------------------------------------------------------------------------

  const handleProjectClick = async (project: Project) => {
    const { navigateToProject } = useNavigationStore.getState();
    navigateToProject(project.id);
  };

  const handleRefreshProjectGitStatus = useCallback(
    throttle(async (project: Project, e: React.MouseEvent) => {
      e.stopPropagation();
      if (refreshingProjects.has(project.id)) return;
      setRefreshingProjects(prev => new Set([...prev, project.id]));
      try {
        const response = await window.electronAPI.invoke('projects:refresh-git-status', project.id);
        if (!response.success) throw new Error(response.error || 'Failed to refresh git status');
        if (response.data.backgroundRefresh) {
          setTimeout(() => {
            setRefreshingProjects(prev => { const n = new Set(prev); n.delete(project.id); return n; });
          }, 1500);
        } else {
          setRefreshingProjects(prev => { const n = new Set(prev); n.delete(project.id); return n; });
        }
      } catch (error: unknown) {
        showError({ title: 'Failed to refresh git status', error: error instanceof Error ? error.message : 'Unknown error occurred' });
        setRefreshingProjects(prev => { const n = new Set(prev); n.delete(project.id); return n; });
      }
    }, 5000),
    [refreshingProjects],
  );

  const handleRunProjectScript = useCallback(async (project: Project, e: React.MouseEvent) => {
    e.stopPropagation();
    if (closingProjectId === project.id) return;
    if (runningProjectId === project.id) {
      try {
        setClosingProjectId(project.id);
        const response = await window.electronAPI.projects.stopScript(project.id);
        if (!response.success) throw new Error(response.error || 'Failed to stop script');
        setClosingProjectId(null);
        setRunningProjectId(null);
      } catch (error: unknown) {
        console.error('Failed to stop project script:', error);
        setClosingProjectId(null);
        showError({ title: 'Failed to stop script', error: error instanceof Error ? error.message : 'Unknown error occurred' });
      }
      return;
    }
    try {
      const response = await window.electronAPI.projects.runScript(project.id);
      if (!response.success) {
        showError({ title: 'Failed to run script', error: response.error || 'Unknown error occurred' });
      }
    } catch (error: unknown) {
      showError({ title: 'Failed to run script', error: error instanceof Error ? error.message : 'Unknown error occurred' });
    }
  }, [showError, runningProjectId, closingProjectId]);

  // ---------------------------------------------------------------------------
  // Project creation
  // ---------------------------------------------------------------------------

  const detectCurrentBranch = async (path: string) => {
    if (!path) return;
    try {
      const response = await API.projects.detectBranch(path);
      if (response.success && response.data) {
        setDetectedBranchForNewProject(response.data);
      }
    } catch (_e) {
      setDetectedBranchForNewProject(null);
    }
  };

  const handleCreateProject = async () => {
    if (!newProject.name || !newProject.path) {
      setShowValidationErrors(true);
      return;
    }
    try {
      const response = await API.projects.create({ ...newProject, active: false });
      if (!response.success || !response.data) {
        showError({
          title: 'Failed to Create Project',
          error: response.error || 'An error occurred while creating the project.',
          details: response.details,
          command: response.command,
        });
        return;
      }
      setShowAddProjectDialog(false);
      setNewProject({ name: '', path: '', buildScript: '', runScript: '' });
      setDetectedBranchForNewProject(null);
      setShowValidationErrors(false);
      const newProjectWithRuns: ProjectWithRuns = { ...response.data, sessions: [] as never[], folders: [], runs: [] };
      setProjectsWithRuns(prev => [...prev, newProjectWithRuns]);
    } catch (error: unknown) {
      showError({ title: 'Failed to Create Project', error: error instanceof Error ? error.message : 'An error occurred while creating the project.' });
    }
  };

  // ---------------------------------------------------------------------------
  // Drag and drop — projects and folders only; run rows are NOT draggable
  // ---------------------------------------------------------------------------

  const handleProjectDragStart = (e: React.DragEvent, project: Project) => {
    e.stopPropagation();
    setDragState({
      type: 'project',
      projectId: project.id,
      folderId: null,
      overType: null,
      overProjectId: null,
      overFolderId: null,
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'project', id: project.id }));
  };

  const handleFolderDragStart = (e: React.DragEvent, folder: Folder, projectId: number) => {
    e.stopPropagation();
    setDragState({
      type: 'folder',
      projectId,
      folderId: folder.id,
      overType: null,
      overProjectId: null,
      overFolderId: null,
    });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'folder', id: folder.id, projectId }));
  };

  const handleDragEnd = () => {
    setDragState({
      type: null,
      projectId: null,
      folderId: null,
      overType: null,
      overProjectId: null,
      overFolderId: null,
    });
    dragCounter.current = 0;
  };

  const handleProjectDragOver = (e: React.DragEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragState.type === 'project' && dragState.projectId !== project.id) {
      setDragState(prev => ({ ...prev, overType: 'project', overProjectId: project.id, overFolderId: null }));
    } else if (dragState.type === 'folder' && dragState.projectId === project.id) {
      setDragState(prev => ({ ...prev, overType: 'project', overProjectId: project.id, overFolderId: null }));
    }
  };

  const handleFolderDragOver = (e: React.DragEvent, folder: Folder, projectId: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragState.type === 'folder' && dragState.folderId !== folder.id) {
      setDragState(prev => ({ ...prev, overType: 'folder', overProjectId: projectId, overFolderId: folder.id, }));
    }
  };

  const handleProjectDrop = async (e: React.DragEvent, targetProject: Project) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragState.type === 'project' && dragState.projectId && dragState.projectId !== targetProject.id) {
      const sourceIndex = projectsWithRuns.findIndex(p => p.id === dragState.projectId);
      const targetIndex = projectsWithRuns.findIndex(p => p.id === targetProject.id);
      if (sourceIndex !== -1 && targetIndex !== -1) {
        const newProjects = [...projectsWithRuns];
        const [removed] = newProjects.splice(sourceIndex, 1);
        newProjects.splice(targetIndex, 0, removed);
        const projectOrders = newProjects.map((p, index) => ({ id: p.id, displayOrder: index }));
        try {
          const response = await API.projects.reorder(projectOrders);
          if (response.success) {
            setProjectsWithRuns(newProjects);
          } else {
            showError({ title: 'Failed to reorder projects', error: response.error || 'Unknown error occurred' });
          }
        } catch (error: unknown) {
          showError({ title: 'Failed to reorder projects', error: error instanceof Error ? error.message : 'Unknown error occurred' });
        }
      }
    } else if (dragState.type === 'folder' && dragState.folderId) {
      try {
        const response = await API.folders.move(dragState.folderId, null);
        if (response.success) {
          setProjectsWithRuns(prev => prev.map(project => {
            if (project.id === targetProject.id) {
              return { ...project, folders: project.folders.map(f => f.id === dragState.folderId ? { ...f, parentFolderId: null } : f) };
            }
            return project;
          }));
        } else {
          showError({ title: 'Failed to move folder', error: response.error || 'Unknown error occurred' });
        }
      } catch (error: unknown) {
        showError({ title: 'Failed to move folder', error: error instanceof Error ? error.message : 'Unknown error occurred' });
      }
    }
    handleDragEnd();
  };

  const handleFolderDrop = async (e: React.DragEvent, folder: Folder, projectId: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragState.type === 'folder' && dragState.folderId && dragState.folderId !== folder.id) {
      try {
        const response = await API.folders.move(dragState.folderId, folder.id);
        if (response.success) {
          setProjectsWithRuns(prev => prev.map(project => {
            if (project.id === projectId) {
              return { ...project, folders: project.folders.map(f => f.id === dragState.folderId ? { ...f, parentFolderId: folder.id } : f) };
            }
            return project;
          }));
          setExpandedFolders(prev => new Set([...prev, folder.id]));
        } else {
          showError({ title: 'Failed to move folder', error: response.error || 'Unknown error occurred' });
        }
      } catch (error: unknown) {
        showError({ title: 'Failed to move folder', error: error instanceof Error ? error.message : 'Unknown error occurred' });
      }
    }
    handleDragEnd();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setDragState(prev => ({ ...prev, overType: null, overProjectId: null, overFolderId: null }));
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
  };

  // ---------------------------------------------------------------------------
  // Run row click
  // ---------------------------------------------------------------------------

  const handleRunClick = (run: WorkflowRunListRow) => {
    useCyboflowStore.getState().setActiveRun(run.id);
    useNavigationStore.getState().setActiveProjectId(run.project_id);
  };

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner text="Loading projects..." size="small" />
      </div>
    );
  }

  // Recursive folder renderer (no sessions inside folders; folders are kept for structure)
  const renderFolder = (folder: Folder, project: ProjectWithRuns, level: number = 0, isLastInLevel: boolean = false, parentPath: boolean[] = []) => {
    const isExpanded = expandedFolders.has(folder.id);
    const isDraggingOverFolder = dragState.overType === 'folder' && dragState.overFolderId === folder.id;
    const hasChildren = (folder.children && folder.children.length > 0);

    return (
      <div key={folder.id} className="relative" style={{ marginLeft: `${level * 16}px` }}>
        <div className="absolute inset-0 pointer-events-none">
          {parentPath.map((hasMoreSiblings, parentLevel) => (
            hasMoreSiblings && (
              <div
                key={parentLevel}
                className="absolute top-0 bottom-0 w-px bg-border-secondary"
                style={{ left: `${parentLevel * 16 + 8}px` }}
              />
            )
          ))}
          {level > 0 && !isLastInLevel && (
            <div
              className="absolute top-0 bottom-0 w-px bg-border-secondary"
              style={{ left: `${(level - 1) * 16 + 8}px` }}
            />
          )}
          {isExpanded && hasChildren && (
            <div
              className="absolute w-px bg-border-secondary"
              style={{ left: `${level * 16 + 8}px`, top: '24px', bottom: '0px' }}
            />
          )}
          {level > 0 && (
            <div
              className="absolute h-px bg-border-secondary"
              style={{ left: `${(level - 1) * 16 + 8}px`, right: `calc(100% - ${level * 16}px)`, top: '12px' }}
            />
          )}
        </div>
        <div
          className={`relative group/folder flex items-center space-x-1 py-1 rounded cursor-pointer transition-colors hover:bg-surface-hover ${isDraggingOverFolder ? 'bg-interactive/20' : ''}`}
          style={{ marginLeft: '0px', paddingLeft: '8px', paddingRight: '8px' }}
          draggable
          onDragStart={(e) => handleFolderDragStart(e, folder, project.id)}
          onDragOver={(e) => handleFolderDragOver(e, folder, project.id)}
          onDrop={(e) => handleFolderDrop(e, folder, project.id)}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onContextMenu={(e) => handleFolderContextMenu(e, folder, project.id)}
        >
          <div className="opacity-0 group-hover/folder:opacity-100 transition-opacity cursor-move">
            <GripVertical className="w-3 h-3 text-text-tertiary" />
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleFolder(folder.id, e); }}
            onMouseDown={(e) => e.stopPropagation()}
            className="p-0.5 hover:bg-surface-hover rounded transition-colors z-10"
            disabled={!hasChildren}
          >
            {hasChildren ? (
              isExpanded ? <ChevronDown className="w-3 h-3 text-text-tertiary" /> : <ChevronRight className="w-3 h-3 text-text-tertiary" />
            ) : (
              <div className="w-3 h-3" />
            )}
          </button>
          <div
            className="flex items-center space-x-2 flex-1 min-w-0"
            onDoubleClick={(e) => { e.stopPropagation(); handleStartFolderEdit(folder); }}
          >
            {isExpanded ? (
              <FolderOpen className="w-4 h-4 text-interactive flex-shrink-0" />
            ) : (
              <FolderIcon className="w-4 h-4 text-interactive flex-shrink-0" />
            )}
            {editingFolderId === folder.id ? (
              <input
                type="text"
                value={editingFolderName}
                onChange={(e) => setEditingFolderName(e.target.value)}
                onBlur={handleSaveFolderEdit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleSaveFolderEdit(); }
                  else if (e.key === 'Escape') { e.preventDefault(); handleCancelFolderEdit(); }
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
                className="flex-1 px-1 py-0 text-sm bg-surface-primary border border-interactive rounded focus:outline-none focus:ring-1 focus:ring-interactive"
              />
            ) : (
              <span className="text-sm text-text-primary truncate" title={folder.name}>
                {folder.name}
              </span>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedProjectForFolder(project);
              setParentFolderForCreate(folder);
              setShowCreateFolderDialog(true);
              setNewFolderName('');
            }}
            className="opacity-0 group-hover/folder:opacity-100 transition-opacity p-1 hover:bg-surface-hover rounded"
            title="Add subfolder"
          >
            <Plus className="w-3 h-3 text-text-tertiary" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); handleDeleteFolder(folder, project.id); }}
            className="opacity-0 group-hover/folder:opacity-100 transition-opacity p-1 rounded hover:bg-status-error/10"
            title="Delete folder"
          >
            <span className="text-status-error hover:text-status-error">🗑️</span>
          </button>
        </div>
        {isExpanded && hasChildren && (
          <div className="mt-1 space-y-1" style={{ marginLeft: '16px' }}>
            {(folder.children ?? []).map((childFolder, index, array) => {
              const isLastItem = index === array.length - 1;
              const childParentPath = [...parentPath, !isLastItem];
              return renderFolder(childFolder, project, level + 1, isLastItem, childParentPath);
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="space-y-1 px-2 pb-2">
        {projectsWithRuns.length === 0 ? (
          <EmptyState
            icon={FolderIcon}
            title="No Projects Yet"
            description="Add your first project to start managing workflow runs."
            action={{ label: 'Add Project', onClick: () => setShowAddProjectDialog(true) }}
            className="py-8"
          />
        ) : (
          <>
            {projectsWithRuns.map((project) => {
              const isExpanded = expandedProjects.has(project.id);
              const runCount = project.runs.length;
              const folderCount = project.folders?.length ?? 0;
              const hasChildren = runCount > 0 || folderCount > 0;
              const isDraggingOver = dragState.overType === 'project' && dragState.overProjectId === project.id;
              const isActiveProject = activeProjectId === project.id;

              return (
                <div key={project.id} className="mb-1">
                  <div
                    className={`group flex items-center space-x-1 px-2 py-2 rounded-lg transition-colors ${
                      isActiveProject
                        ? 'bg-interactive/10 text-interactive'
                        : isDraggingOver
                        ? 'bg-interactive/20'
                        : 'bg-surface-secondary/50 hover:bg-surface-hover'
                    }`}
                    draggable
                    onDragStart={(e) => handleProjectDragStart(e, project)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleProjectDragOver(e, project)}
                    onDrop={(e) => handleProjectDrop(e, project)}
                    onDragEnter={handleDragEnter}
                    onDragLeave={handleDragLeave}
                  >
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity cursor-move">
                      <GripVertical className="w-3 h-3 text-text-tertiary" />
                    </div>

                    {hasChildren ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleProject(project.id, e); }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="p-0.5 hover:bg-surface-hover rounded transition-colors z-10"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-text-tertiary" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-text-tertiary" />
                        )}
                      </button>
                    ) : (
                      <div className="w-3 h-3 p-0.5" />
                    )}

                    <div
                      className="flex items-center space-x-2 flex-1 min-w-0 cursor-pointer"
                      onClick={() => handleProjectClick(project)}
                    >
                      <div className="relative" title="Git-backed project (connected to repository)">
                        <GitBranch className="w-4 h-4 text-interactive flex-shrink-0" />
                      </div>
                      <span className="text-sm font-semibold text-text-primary truncate text-left" title={project.name}>
                        {project.name}
                      </span>
                    </div>

                    <button
                      onClick={(e) => handleRefreshProjectGitStatus(project, e)}
                      disabled={refreshingProjects.has(project.id)}
                      className={`p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-all opacity-0 group-hover:opacity-100 ${
                        refreshingProjects.has(project.id) ? 'cursor-wait' : ''
                      }`}
                      title="Refresh git status for all sessions"
                    >
                      <RefreshCw className={`w-3 h-3 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 ${
                        refreshingProjects.has(project.id) ? 'animate-spin' : ''
                      }`} />
                    </button>

                    {project.run_script && project.run_script.trim() && (
                      <button
                        onClick={(e) => handleRunProjectScript(project, e)}
                        disabled={closingProjectId === project.id}
                        className={`transition-opacity p-1 rounded ${
                          closingProjectId === project.id
                            ? 'cursor-wait text-status-warning'
                            : runningProjectId === project.id
                            ? 'hover:bg-status-error/10 text-status-error hover:text-status-error opacity-100'
                            : 'opacity-0 group-hover:opacity-100 hover:bg-status-success/10 text-status-success hover:text-status-success'
                        }`}
                        title={
                          closingProjectId === project.id ? 'Closing script...'
                            : runningProjectId === project.id ? 'Stop script'
                            : 'Run project script in project root'
                        }
                      >
                        {closingProjectId === project.id ? '⏸️' : runningProjectId === project.id ? '⏹️' : '▶️'}
                      </button>
                    )}

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedProjectForSettings(project);
                        setShowProjectSettings(true);
                      }}
                      className="p-1 hover:bg-surface-hover rounded transition-colors opacity-0 group-hover:opacity-100"
                      title="Project settings"
                    >
                      <Settings className="w-3 h-3 text-text-tertiary hover:text-text-primary" />
                    </button>
                  </div>

                  {isExpanded && hasChildren && (
                    <div className="relative mt-1 space-y-1">
                      <div className="absolute top-0 bottom-0 w-px bg-border-secondary" style={{ left: '8px' }} />

                      {/* Folder tree */}
                      {buildFolderTree(project.folders ?? []).map((folder, index, arr) => {
                        const isLastItem = index === arr.length - 1 && runCount === 0;
                        return renderFolder(folder, project, 1, isLastItem, [!isLastItem]);
                      })}

                      {/* Run rows — newest first (server returns DESC order) */}
                      {project.runs.map((run, index) => {
                        const isLastRun = index === project.runs.length - 1;
                        // TODO: enrich with workflow.name — currently shows workflow_id last-6
                        const runLabel = run.workflow_id.slice(-6);
                        const relativeTime = formatDistanceToNow(run.created_at);

                        return (
                          <div
                            key={run.id}
                            className="relative"
                            style={{ marginLeft: '16px' }}
                          >
                            <div className="absolute inset-0 pointer-events-none">
                              {!isLastRun && (
                                <div
                                  className="absolute top-0 bottom-0 w-px bg-border-secondary"
                                  style={{ left: '8px' }}
                                />
                              )}
                              <div
                                className="absolute h-px bg-border-secondary"
                                style={{ left: '8px', right: 'calc(100% - 16px)', top: '16px' }}
                              />
                            </div>

                            {/* Run row — NOT draggable */}
                            <div
                              className="relative flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-surface-hover transition-colors"
                              style={{ paddingLeft: '24px' }}
                              onClick={() => handleRunClick(run)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleRunClick(run); }}
                            >
                              {/* Status indicator dot */}
                              <span
                                className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotClass(run.status)}`}
                                title={run.status}
                              />
                              <span className="text-xs text-text-primary font-mono truncate" title={run.workflow_id}>
                                {runLabel}
                              </span>
                              <span className="text-xs text-text-tertiary truncate ml-auto">
                                {relativeTime}
                              </span>
                            </div>
                          </div>
                        );
                      })}

                      {/* Empty state when no runs AND no folders */}
                      {runCount === 0 && folderCount === 0 && (
                        <div className="px-4 py-2 text-xs text-text-tertiary">
                          No runs yet. Use Start Run.
                        </div>
                      )}

                      {/* Add folder button */}
                      <div className="ml-6 mt-2 border-t border-border-primary pt-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedProjectForFolder(project);
                            setShowCreateFolderDialog(true);
                            setNewFolderName('');
                          }}
                          className="w-full px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors flex items-center space-x-1"
                        >
                          <Plus className="w-3 h-3" />
                          <span>Add Folder</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Empty state for expanded project with zero children */}
                  {isExpanded && !hasChildren && (
                    <div className="px-4 py-2 text-xs text-text-tertiary">
                      No runs yet. Use Start Run.
                    </div>
                  )}
                </div>
              );
            })}

            <div className="mt-3 pt-3 border-t border-border-primary">
              <button
                onClick={() => setShowAddProjectDialog(true)}
                className="w-full px-2 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors flex items-center justify-center space-x-2"
              >
                <Plus className="w-4 h-4" />
                <span>New Project</span>
              </button>
            </div>
          </>
        )}

        {/* Archived Sessions Section — kept for structure; stub data */}
        <div className="mt-4 pt-4 border-t border-border-primary">
          <button
            onClick={toggleArchivedSessions}
            className="w-full flex items-center space-x-2 px-2 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-hover rounded transition-colors"
          >
            {showArchivedSessions ? (
              <ChevronDown className="w-4 h-4" />
            ) : (
              <ChevronRight className="w-4 h-4" />
            )}
            <Archive className="w-4 h-4" />
            <span>Archived Sessions</span>
          </button>

          {showArchivedSessions && (
            <div className="mt-2 space-y-1">
              {isLoadingArchived ? (
                <div className="flex items-center justify-center py-4">
                  <LoadingSpinner text="Loading archived sessions..." size="small" />
                </div>
              ) : archivedProjectsWithSessions.length === 0 ? (
                <div className="px-4 py-4 text-center text-sm text-text-tertiary">
                  No archived sessions
                </div>
              ) : (
                archivedProjectsWithSessions.map((project) => {
                  const isExpanded = expandedArchivedProjects.has(project.id);
                  return (
                    <div key={`archived-${project.id}`} className="ml-2">
                      <div className="flex items-center space-x-1 px-2 py-1 rounded hover:bg-surface-hover">
                        <button
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleArchivedProject(project.id, e); }}
                          className="p-0.5 hover:bg-surface-hover rounded transition-colors z-10"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3 text-text-tertiary" />
                          ) : (
                            <ChevronRight className="w-3 h-3 text-text-tertiary" />
                          )}
                        </button>
                        <FolderIcon className="w-4 h-4 text-text-tertiary" />
                        <span className="text-sm text-text-tertiary flex-1 text-left">
                          {project.name}
                        </span>
                      </div>
                      {isExpanded && (
                        <div className="ml-6 mt-1 space-y-1 px-4 py-2 text-xs text-text-tertiary">
                          No archived runs
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {selectedProjectForSettings && (
        <ProjectSettings
          project={selectedProjectForSettings}
          isOpen={showProjectSettings}
          onClose={() => {
            setShowProjectSettings(false);
            setSelectedProjectForSettings(null);
          }}
          onUpdate={() => {
            loadProjectsWithRuns();
          }}
          onDelete={() => {
            if (selectedProjectForSettings) {
              setProjectsWithRuns(prev => prev.filter(p => p.id !== selectedProjectForSettings.id));
            }
          }}
        />
      )}

      {/* Add Project Dialog */}
      <Modal
        isOpen={showAddProjectDialog}
        onClose={() => {
          setShowAddProjectDialog(false);
          setNewProject({ name: '', path: '', buildScript: '', runScript: '' });
          setDetectedBranchForNewProject(null);
          setShowValidationErrors(false);
        }}
        size="lg"
      >
        <ModalHeader title="Add New Project" icon={<Plus className="w-5 h-5" />} />
        <ModalBody>
          <div className="space-y-8">
            <div className="space-y-6">
              <div className="flex items-center gap-2 pb-2 border-b border-border-primary">
                <FolderIcon className="w-5 h-5 text-interactive" />
                <h3 className="text-heading-3 font-semibold text-text-primary">Project Information</h3>
              </div>

              <FieldWithTooltip
                label="Project Name"
                tooltip="A descriptive name for your project that will appear in the project selector."
                required
              >
                <EnhancedInput
                  type="text"
                  value={newProject.name}
                  onChange={(e) => { setNewProject({ ...newProject, name: e.target.value }); if (showValidationErrors) setShowValidationErrors(false); }}
                  placeholder="Enter project name"
                  size="lg"
                  fullWidth
                  required
                  showRequiredIndicator={showValidationErrors}
                />
              </FieldWithTooltip>

              <FieldWithTooltip
                label="Repository Path"
                tooltip="Path to your git repository. This is where Cyboflow will create worktrees for parallel development."
                required
              >
                <div className="space-y-3">
                  <EnhancedInput
                    type="text"
                    value={newProject.path}
                    onChange={(e) => {
                      setNewProject({ ...newProject, path: e.target.value });
                      detectCurrentBranch(e.target.value);
                      if (showValidationErrors) setShowValidationErrors(false);
                    }}
                    placeholder="/path/to/your/repository"
                    size="lg"
                    fullWidth
                    required
                    showRequiredIndicator={showValidationErrors}
                  />
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      onClick={async () => {
                        const result = await API.dialog.openDirectory({ title: 'Select Repository Directory', buttonLabel: 'Select' });
                        if (result.success && result.data) {
                          setNewProject({ ...newProject, path: result.data });
                          detectCurrentBranch(result.data);
                        }
                      }}
                      variant="secondary"
                      size="sm"
                    >
                      Browse
                    </Button>
                  </div>
                </div>
              </FieldWithTooltip>
            </div>

            <div className="space-y-6">
              <div className="flex items-center gap-2 pb-2 border-b border-border-primary">
                <GitBranch className="w-5 h-5 text-interactive" />
                <h3 className="text-heading-3 font-semibold text-text-primary">Git Information</h3>
              </div>

              <FieldWithTooltip
                label="Main Branch"
                tooltip="The main branch of your repository. Cyboflow will automatically detect this from your git configuration."
              >
                <Card variant="bordered" padding="md" className="text-text-secondary bg-surface-secondary">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4" />
                    <span className="font-mono">
                      {detectedBranchForNewProject || (newProject.path ? 'Detecting...' : 'Select a repository path first')}
                    </span>
                  </div>
                </Card>
              </FieldWithTooltip>
            </div>

            <div className="space-y-6">
              <div className="flex items-center gap-2 pb-2 border-b border-border-primary">
                <span className="text-xl">▶️</span>
                <h3 className="text-heading-3 font-semibold text-text-primary">Optional Scripts</h3>
              </div>

              <FieldWithTooltip
                label="Build Script"
                tooltip="Command to build your project. This runs automatically before each Claude Code session starts."
              >
                <EnhancedInput
                  type="text"
                  value={newProject.buildScript}
                  onChange={(e) => setNewProject({ ...newProject, buildScript: e.target.value })}
                  placeholder="pnpm build"
                  size="lg"
                  fullWidth
                />
              </FieldWithTooltip>

              <FieldWithTooltip
                label="Run Script"
                tooltip="Command to start your development server. You can run this manually from the Terminal view during sessions."
              >
                <EnhancedInput
                  type="text"
                  value={newProject.runScript}
                  onChange={(e) => setNewProject({ ...newProject, runScript: e.target.value })}
                  placeholder="pnpm dev"
                  size="lg"
                  fullWidth
                />
              </FieldWithTooltip>
            </div>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button
            onClick={() => {
              setShowAddProjectDialog(false);
              setNewProject({ name: '', path: '', buildScript: '', runScript: '' });
              setDetectedBranchForNewProject(null);
              setShowValidationErrors(false);
            }}
            variant="ghost"
            size="md"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (!newProject.name || !newProject.path) { setShowValidationErrors(true); return; }
              handleCreateProject();
            }}
            disabled={!newProject.name || !newProject.path}
            variant="primary"
            size="md"
            className={(!newProject.name || !newProject.path) ? 'border-status-error border-2' : ''}
          >
            Create Project
          </Button>
        </ModalFooter>
      </Modal>

      {/* Create Folder Dialog */}
      {showCreateFolderDialog && selectedProjectForFolder && (
        <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50">
          <div className="bg-surface-primary rounded-lg p-6 w-96 shadow-xl border border-border-primary">
            <h3 className="text-lg font-semibold text-text-primary mb-4">
              {parentFolderForCreate
                ? `Create Subfolder in "${parentFolderForCreate.name}"`
                : `Create Folder in ${selectedProjectForFolder.name}`
              }
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">Folder Name</label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  className="w-full px-3 py-2 bg-surface-secondary border border-border-primary rounded-md text-text-primary focus:outline-none focus:border-interactive focus:ring-1 focus:ring-interactive placeholder-text-tertiary"
                  placeholder="My Folder"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Enter' && newFolderName.trim()) handleCreateFolder(); }}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-2">Suggested Folder Types</label>
                <div className="grid grid-cols-2 gap-2">
                  {['Features', 'Bugs', 'Exploration', 'Refactoring', 'Tests', 'Documentation'].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setNewFolderName(suggestion)}
                      className="px-3 py-1.5 text-sm text-text-secondary bg-surface-tertiary hover:bg-surface-hover rounded-md transition-colors"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-6 flex justify-end space-x-3">
              <button
                onClick={() => {
                  setShowCreateFolderDialog(false);
                  setNewFolderName('');
                  setSelectedProjectForFolder(null);
                  setParentFolderForCreate(null);
                }}
                className="px-4 py-2 text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
                className="px-4 py-2 bg-interactive hover:bg-interactive-hover text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Create Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Folder Context Menu */}
      {isMenuOpen('folder') && menuState.payload && menuState.position && (
        <div
          className="context-menu fixed bg-surface-primary border border-border-primary rounded-md shadow-lg py-1 z-50 min-w-[150px]"
          style={{ top: menuState.position.y, left: menuState.position.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              closeMenu();
              if (menuState.payload) {
                handleStartFolderEdit(menuState.payload as Folder);
              }
            }}
            className="w-full text-left px-4 py-2 text-sm text-text-primary hover:bg-surface-hover hover:text-text-primary"
          >
            Rename
          </button>
          <div className="border-t border-border-primary my-1" />
          <button
            onClick={() => {
              closeMenu();
              const projectId = (menuState.payload as Folder)?.projectId ||
                projectsWithRuns.find(p => p.folders?.some(f => f.id === menuState.payload?.id))?.id;
              if (projectId) {
                handleDeleteFolder(menuState.payload as Folder, projectId);
              }
            }}
            className="w-full text-left px-4 py-2 text-sm text-status-error hover:bg-surface-hover hover:text-status-error"
          >
            Delete
          </button>
        </div>
      )}
    </>
  );
}
