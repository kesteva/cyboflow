import { useState, useEffect } from 'react';
import { ChevronDown, Plus, Check, Settings } from 'lucide-react';
import { API } from '../utils/api';
import type { Project } from '../types/project';
import ProjectSettings from './ProjectSettings';
import { Button, IconButton } from './ui/Button';
import { Card } from './ui/Card';
import { CreateProjectDialog } from './CreateProjectDialog';

interface ProjectSelectorProps {
  onProjectChange?: (project: Project) => void;
}

export default function ProjectSelector({ onProjectChange }: ProjectSelectorProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);

  useEffect(() => {
    fetchProjects();
  }, []);

  const fetchProjects = async () => {
    try {
      const response = await API.projects.getAll();
      if (!response.success) {
        throw new Error(response.error || 'Failed to fetch projects');
      }
      const data = response.data;
      setProjects(data);
      
      // Find and set the active project
      const active = data.find((p: Project) => p.active);
      if (active) {
        setActiveProject(active);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    }
  };

  const handleSelectProject = async (project: Project) => {
    try {
      const response = await API.projects.activate(project.id.toString());
      
      if (response.success) {
        setActiveProject(project);
        setIsOpen(false);
        onProjectChange?.(project);
        
        // Update projects list to reflect new active state
        setProjects(projects.map(p => ({
          ...p,
          active: p.id === project.id
        })));
      } else {
        throw new Error(response.error || 'Failed to activate project');
      }
    } catch (error) {
      console.error('Failed to activate project:', error);
    }
  };

  const handleSettingsClick = (project: Project) => {
    setSettingsProject(project);
    setShowSettings(true);
    setIsOpen(false);
  };

  const handleProjectUpdated = () => {
    // Since ProjectSettings already updated the project on the backend,
    // we need to refresh to get the updated data
    fetchProjects();
  };

  const handleProjectDeleted = () => {
    // Remove the deleted project from the list without refetching
    setProjects(prev => prev.filter(p => p.id !== settingsProject?.id));
    
    if (settingsProject?.id === activeProject?.id) {
      // If the deleted project was active, clear it
      setActiveProject(null);
    }
  };

  return (
    <>
      <div className="relative">
        <div className="flex items-center space-x-2">
          <Button
            onClick={() => setIsOpen(!isOpen)}
            variant="secondary"
            size="md"
            className="flex-1 justify-between"
          >
            <span>
              {activeProject ? activeProject.name : 'Select Project'}
            </span>
            <ChevronDown className={`w-4 h-4 ml-2 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </Button>
          {activeProject && (
            <IconButton
              onClick={() => handleSettingsClick(activeProject)}
              aria-label="Project Settings"
              size="md"
              icon={<Settings className="w-4 h-4" />}
            />
          )}
        </div>

        {isOpen && (
          <Card 
            variant="elevated" 
            className="absolute top-full left-0 mt-1 w-64 z-50"
            padding="none"
          >
            <div className="p-1">
              {projects.map(project => (
                <div
                  key={project.id}
                  className="flex items-center hover:bg-bg-hover rounded-md group"
                >
                  <button
                    onClick={() => handleSelectProject(project)}
                    className="flex-1 text-left px-3 py-2 flex items-center justify-between"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-text-primary">{project.name}</div>
                      <div className="text-xs text-text-tertiary truncate">{project.path}</div>
                    </div>
                    {project.active && (
                      <Check className="w-4 h-4 text-status-success ml-2 flex-shrink-0" />
                    )}
                  </button>
                  <IconButton
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSettingsClick(project);
                    }}
                    size="sm"
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Project Settings"
                    icon={<Settings className="w-4 h-4" />}
                  />
                </div>
              ))}
              
              <div className="border-t border-border-primary mt-2 pt-2">
                <Button
                  onClick={() => {
                    setIsOpen(false);
                    setShowAddDialog(true);
                  }}
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Project
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Add Project Dialog */}
      <CreateProjectDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onCreated={(createdProject) => {
          // Preserve existing UX: auto-open (activate) the newly created project.
          handleSelectProject(createdProject);
        }}
      />

      {/* Project Settings Dialog */}
      {settingsProject && (
        <ProjectSettings
          project={settingsProject}
          isOpen={showSettings}
          onClose={() => {
            setShowSettings(false);
            setSettingsProject(null);
          }}
          onUpdate={handleProjectUpdated}
          onDelete={handleProjectDeleted}
        />
      )}
    </>
  );
}