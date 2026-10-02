import { CreatePanelRequest, ToolPanel } from '../../../shared/types/panels';

export const panelApi = {
  async createPanel(request: CreatePanelRequest): Promise<ToolPanel> {
    // Pass the request THROUGH — never re-spread it into positional args. The
    // old four-arg call dropped `substrate` and `metadata` on the floor (see the
    // preload note); forwarding the object keeps this seam field-complete by
    // construction.
    const response = await window.electronAPI.panels.createPanel(request);
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to create panel');
    }
    return response.data;
  },
  
  async deletePanel(panelId: string): Promise<void> {
    const response = await window.electronAPI.panels.deletePanel(panelId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to delete panel');
    }
  },
  
  async loadPanelsForSession(sessionId: string): Promise<ToolPanel[]> {
    const response = await window.electronAPI.panels.getSessionPanels(sessionId);
    if (!response.success || !response.data) {
      throw new Error(response.error || 'Failed to load panels');
    }
    return response.data;
  },
  
  async setActivePanel(sessionId: string, panelId: string): Promise<void> {
    const response = await window.electronAPI.panels.setActivePanel(sessionId, panelId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to set active panel');
    }
  },
  
  async clearPanelUnviewedContent(panelId: string): Promise<void> {
    // Clear the hasUnviewedContent flag and set status to 'stopped' for AI panels
    const response = await window.electron!.invoke('panels:clearUnviewedContent', panelId);
    if (!response.success) {
      throw new Error(response.error || 'Failed to clear unviewed content');
    }
  }
};