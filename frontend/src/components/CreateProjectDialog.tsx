import { useEffect, useState } from 'react';
import { Plus, Folder as FolderIcon, GitBranch, Hammer, Play } from 'lucide-react';
import { API } from '../utils/api';
import type { Project, CreateProjectRequest } from '../types/project';
import { useErrorStore } from '../stores/errorStore';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { FieldWithTooltip } from './ui/FieldWithTooltip';
import { Card } from './ui/Card';

export interface CreateProjectDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void;
}

const EMPTY_PROJECT: CreateProjectRequest = { name: '', path: '', buildScript: '', runScript: '' };

/**
 * Single shared "Add New Project" form. Extracted from the duplicated inline
 * dialogs in ProjectSelector + DraggableProjectTreeView so both call sites use
 * the same form, validation, and error-store integration. On a successful
 * create it calls onCreated(project) then onClose(); the caller owns what
 * happens next (select / open wizard).
 */
export function CreateProjectDialog({ isOpen, onClose, onCreated }: CreateProjectDialogProps) {
  const [newProject, setNewProject] = useState<CreateProjectRequest>(EMPTY_PROJECT);
  const [showValidationErrors, setShowValidationErrors] = useState(false);
  const [detectedBranch, setDetectedBranch] = useState<string | null>(null);
  const [isDemoPrefill, setIsDemoPrefill] = useState(false);
  const { showError } = useErrorStore();

  // Demo mode: prefill the sandbox repo so the "add a project" tour step needs
  // no typing. Only fills untouched fields (the user can still edit them).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    API.demo
      .getInfo()
      .then((response) => {
        if (cancelled || !response.success || !response.data) return;
        const { demoMode, sandboxPath, projectName } = response.data;
        if (!demoMode || !sandboxPath) return;
        setIsDemoPrefill(true);
        setNewProject((prev) =>
          prev.name === '' && prev.path === ''
            ? { ...prev, name: projectName, path: sandboxPath }
            : prev,
        );
        detectCurrentBranch(sandboxPath);
      })
      .catch(() => {
        // Demo info is best-effort — the dialog works without it.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detectCurrentBranch is stable per render and intentionally not a dep
  }, [isOpen]);

  const resetForm = () => {
    setNewProject(EMPTY_PROJECT);
    setDetectedBranch(null);
    setShowValidationErrors(false);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const detectCurrentBranch = async (path: string) => {
    if (!path) return;
    try {
      const response = await API.projects.detectBranch(path);
      if (response.success && response.data) {
        setDetectedBranch(response.data);
      }
    } catch {
      setDetectedBranch(null);
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
      const createdProject = response.data;
      resetForm();
      // Broadcast so the project rail picks up the new project regardless of
      // which call site (rail, landing empty state, wizard) opened the dialog.
      window.dispatchEvent(new CustomEvent('project-created', { detail: createdProject }));
      onCreated(createdProject);
      onClose();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'An error occurred while creating the project.';
      const errorDetails = error instanceof Error ? error.stack : String(error);
      showError({
        title: 'Failed to Create Project',
        error: errorMessage,
        details: errorDetails || '',
      });
    }
  };

  const isInvalid = !newProject.name || !newProject.path;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="lg">
      <ModalHeader title="Add New Project" icon={<Plus className="w-5 h-5" />} />
      <ModalBody>
        <div className="space-y-8">
          {isDemoPrefill && (
            <Card variant="bordered" padding="md" className="text-text-secondary bg-surface-secondary">
              Demo mode — we prefilled the sandbox project for you. Just hit <strong>Create Project</strong>.
            </Card>
          )}
          {/* Project Info Section */}
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
                onChange={(e) => {
                  setNewProject({ ...newProject, name: e.target.value });
                  if (showValidationErrors) setShowValidationErrors(false);
                }}
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
                      const result = await API.dialog.openDirectory({
                        title: 'Select Repository Directory',
                        buttonLabel: 'Select',
                      });
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

          {/* Git Info Section */}
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
                    {detectedBranch || (newProject.path ? 'Detecting...' : 'Select a repository path first')}
                  </span>
                </div>
              </Card>
            </FieldWithTooltip>
          </div>

          {/* Optional Scripts Section */}
          <div className="space-y-6">
            <div className="flex items-center gap-2 pb-2 border-b border-border-primary">
              <Play className="w-5 h-5 text-interactive" />
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
                icon={<Hammer className="w-4 h-4" />}
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
                icon={<Play className="w-4 h-4" />}
              />
            </FieldWithTooltip>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button onClick={handleClose} variant="ghost" size="md">
          Cancel
        </Button>
        <Button
          onClick={handleCreateProject}
          disabled={isInvalid}
          variant="primary"
          size="md"
          className={isInvalid ? 'border-status-error border-2' : ''}
        >
          Create Project
        </Button>
      </ModalFooter>
    </Modal>
  );
}
