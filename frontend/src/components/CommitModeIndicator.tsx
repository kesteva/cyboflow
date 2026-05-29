import React from 'react';
import { GitCommit, Shield, Zap } from 'lucide-react';
import type { CommitMode } from '../../../shared/types';

interface CommitModeIndicatorProps {
  mode?: CommitMode;
  className?: string;
}

export const CommitModeIndicator: React.FC<CommitModeIndicatorProps> = ({ mode, className = '' }) => {
  if (!mode) {
    return null;
  }

  const getModeConfig = () => {
    switch (mode) {
      case 'structured':
        return {
          icon: Shield,
          label: 'Structured',
          color: 'text-status-info',
          bgColor: 'bg-status-info/10',
          borderColor: 'border-status-info/30',
          tooltip: 'Claude handles commits with proper messages'
        };
      case 'checkpoint':
        return {
          icon: Zap,
          label: 'Checkpoint',
          color: 'text-status-success',
          bgColor: 'bg-status-success/10',
          borderColor: 'border-status-success/30',
          tooltip: 'Auto-commits after each prompt'
        };
      case 'disabled':
        return {
          icon: GitCommit,
          label: 'Manual',
          color: 'text-text-secondary',
          bgColor: 'bg-bg-tertiary',
          borderColor: 'border-border-primary',
          tooltip: 'Manual commits only'
        };
      default:
        return null;
    }
  };

  const config = getModeConfig();
  if (!config) {
    return null;
  }

  const Icon = config.icon;

  return (
    <div className={`group relative inline-flex ${className}`}>
      <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${config.bgColor} ${config.borderColor} ${config.color}`}>
        <Icon className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{config.label}</span>
      </div>
      
      {/* Tooltip */}
      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-bg-tertiary text-text-primary text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-50">
        {config.tooltip}
        <div className="absolute top-full left-1/2 transform -translate-x-1/2 -mt-1">
          <div className="w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-bg-tertiary"></div>
        </div>
      </div>
    </div>
  );
};