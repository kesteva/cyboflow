import { PanelEvent, PanelEventType, PanelEventSubscription } from '../../../shared/types/panels';
import { EventEmitter } from 'events';

export class PanelEventBus extends EventEmitter {
  private subscriptions = new Map<string, PanelEventSubscription[]>();
  private panelListenerMap = new Map<string, Map<PanelEventType | string, (event: PanelEvent) => void>>(); // Track listeners per panel
  
  constructor() {
    super();
    this.setMaxListeners(100); // Allow many panels to subscribe
  }
  
  subscribe(subscription: PanelEventSubscription): () => void {
    const { panelId, eventTypes } = subscription;
    
    // Get existing subscriptions for this panel
    const panelSubs = this.subscriptions.get(panelId) || [];
    
    // Add new subscription
    panelSubs.push(subscription);
    this.subscriptions.set(panelId, panelSubs);
    
    // Get or create listener map for this panel
    if (!this.panelListenerMap.has(panelId)) {
      this.panelListenerMap.set(panelId, new Map());
    }
    const panelListeners = this.panelListenerMap.get(panelId)!;
    
    // Set up event listeners for each event type
    eventTypes.forEach(eventType => {
      // Check if we already have a listener for this event type
      if (panelListeners.has(eventType)) {
        // Remove the old listener before adding new one
        const oldListener = panelListeners.get(eventType)!;
        this.removeListener(eventType, oldListener);
      }
      
      const listener = (event: PanelEvent) => {
        // Don't send events back to the source panel
        if (event.source.panelId !== panelId) {
          subscription.callback(event);
        }
      };
      
      // Store the listener reference so we can remove it later
      panelListeners.set(eventType, listener);
      this.on(eventType, listener);
    });
    
    // Return unsubscribe function
    return () => {
      this.unsubscribePanel(panelId);
    };
  }
  
  emitPanelEvent(event: PanelEvent): void {
    this.emit(event.type, event);
    
    // Also emit a generic 'panel:event' for logging/debugging
    this.emit('panel:event', event);
  }
  
  unsubscribePanel(panelId: string): void {
    // Get the listeners for this panel
    const panelListeners = this.panelListenerMap.get(panelId);
    
    if (panelListeners) {
      // Remove only this panel's listeners
      panelListeners.forEach((listener, eventType) => {
        this.removeListener(eventType, listener);
      });
      
      // Clean up the listener map
      this.panelListenerMap.delete(panelId);
    }
    
    // Remove from subscriptions map
    this.subscriptions.delete(panelId);
  }
}

// Export singleton instance
export const panelEventBus = new PanelEventBus();