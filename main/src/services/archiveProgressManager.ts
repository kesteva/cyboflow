
export interface ArchiveTask {
  sessionId: string;
  sessionName: string;
  worktreeName: string;
  projectName: string;
  status: 'pending' | 'queued' | 'removing-worktree' | 'cleaning-artifacts' | 'completed' | 'failed';
  startTime: Date;
  endTime?: Date;
  error?: string;
  executeCallback?: () => Promise<void>;
}

export interface SerializedArchiveTask {
  sessionId: string;
  sessionName: string;
  worktreeName: string;
  projectName: string;
  status: 'pending' | 'queued' | 'removing-worktree' | 'cleaning-artifacts' | 'completed' | 'failed';
  startTime: string;
  endTime?: string;
  error?: string;
}

export class ArchiveProgressManager {
  private activeTasks: Map<string, ArchiveTask> = new Map();
  private taskQueue: ArchiveTask[] = [];
  private isProcessing: boolean = false;

  addTask(
    sessionId: string, 
    sessionName: string, 
    worktreeName: string,
    projectName: string,
    executeCallback?: () => Promise<void>
  ): void {
    const task: ArchiveTask = {
      sessionId,
      sessionName,
      worktreeName,
      projectName,
      status: 'queued',
      startTime: new Date(),
      executeCallback
    };
    
    this.activeTasks.set(sessionId, task);
    this.taskQueue.push(task);
    
    // Start processing if not already processing
    if (!this.isProcessing) {
      this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.taskQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.taskQueue.length > 0) {
      const task = this.taskQueue.shift();
      if (!task) continue;

      // Update status to pending (actively processing)
      task.status = 'pending';

      if (task.executeCallback) {
        try {
          console.log(`[ArchiveProgressManager] Starting archive for session ${task.sessionId}`);
          await task.executeCallback();
          
          // If the task wasn't explicitly marked as failed, mark it as completed
          const currentTask = this.activeTasks.get(task.sessionId);
          if (currentTask && currentTask.status !== 'failed') {
            this.updateTaskStatus(task.sessionId, 'completed');
          }
        } catch (error) {
          console.error(`[ArchiveProgressManager] Error processing archive for session ${task.sessionId}:`, error);
          this.updateTaskStatus(task.sessionId, 'failed', error instanceof Error ? error.message : 'Unknown error');
        }
      }
    }

    this.isProcessing = false;
    console.log('[ArchiveProgressManager] Queue processing completed');
  }

  updateTaskStatus(sessionId: string, status: ArchiveTask['status'], error?: string): void {
    const task = this.activeTasks.get(sessionId);
    if (!task) return;

    task.status = status;
    
    if (error) {
      task.error = error;
    }
    
    if (status === 'completed' || status === 'failed') {
      task.endTime = new Date();
    }
    
    
    // Remove completed/failed tasks after a delay to show completion
    if (status === 'completed' || status === 'failed') {
      setTimeout(() => {
        this.activeTasks.delete(sessionId);
      }, 3000); // Keep visible for 3 seconds
    }
  }

  getActiveTasks(): SerializedArchiveTask[] {
    // Return a serializable version without the executeCallback
    return Array.from(this.activeTasks.values()).map(task => ({
      sessionId: task.sessionId,
      sessionName: task.sessionName,
      worktreeName: task.worktreeName,
      projectName: task.projectName,
      status: task.status,
      startTime: task.startTime.toISOString(),
      endTime: task.endTime?.toISOString(),
      error: task.error
    }));
  }

  hasActiveTasks(): boolean {
    // Consider both active tasks and queued tasks
    const hasActive = Array.from(this.activeTasks.values()).some(
      task => task.status !== 'completed' && task.status !== 'failed'
    );
    return hasActive || this.taskQueue.length > 0;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  clearAll(): void {
    this.activeTasks.clear();
  }
}