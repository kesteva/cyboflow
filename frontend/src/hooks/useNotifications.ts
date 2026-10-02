import { useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useConfigStore } from '../stores/configStore';
import type { NotificationPreferences } from '../types/config';

// Extend window interface for webkit audio context compatibility
declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

/** Preferences in effect until config has loaded, or when it carries none. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  playSound: true,
  notifyOnStatusChange: true,
  notifyOnWaiting: true,
  notifyOnComplete: true,
};

/**
 * Desktop notifications for session status changes. Mount exactly once (App):
 * every instance runs its own session diff, so a second one notifies twice.
 *
 * Preferences come from the shared config store, so a Settings save (which
 * refetches it) takes effect without a reload.
 */
export function useNotifications(): void {
  const sessions = useSessionStore((state) => state.sessions);
  const sessionsLoaded = useSessionStore((state) => state.isLoaded);
  const settings =
    useConfigStore((state) => state.config?.notifications) ?? DEFAULT_NOTIFICATION_PREFERENCES;
  const prevSessionsRef = useRef<typeof sessions>([]);
  const initialLoadComplete = useRef(false);

  const requestPermission = async (): Promise<boolean> => {
    if (!('Notification' in window)) {
      console.warn('This browser does not support notifications');
      return false;
    }

    if (Notification.permission === 'granted') {
      return true;
    }

    if (Notification.permission === 'denied') {
      return false;
    }

    const permission = await Notification.requestPermission();
    return permission === 'granted';
  };

  const playNotificationSound = () => {
    if (!settings.playSound) return;
    
    try {
      // Create a simple notification sound using Web Audio API
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        console.warn('AudioContext not supported');
        return;
      }
      const audioContext = new AudioContextClass();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
    } catch (error) {
      console.warn('Could not play notification sound:', error);
    }
  };

  const showNotification = (title: string, body: string, icon?: string) => {
    if (!settings.enabled) return;

    requestPermission().then((hasPermission) => {
      if (hasPermission) {
        new Notification(title, {
          body,
          icon: icon || './favicon.ico',
          badge: './favicon.ico',
          tag: 'cyboflow',
          requireInteraction: false,
        });

        playNotificationSound();
      }
    });
  };

  const getStatusEmoji = (status: string): string => {
    switch (status) {
      case 'initializing': return '🔄';
      case 'running': return '🏃';
      case 'waiting': return '⏸️';
      case 'stopped': return '✅';
      case 'completed_unviewed': return '🔔';
      case 'error': return '❌';
      default: return '📝';
    }
  };

  const getStatusMessage = (status: string): string => {
    switch (status) {
      case 'initializing': return 'is starting up';
      case 'running': return 'is working';
      case 'waiting': return 'needs your input';
      case 'stopped': return 'has completed';
      case 'completed_unviewed': return 'has new activity';
      case 'error': return 'encountered an error';
      default: return 'status changed';
    }
  };

  useEffect(() => {
    const prevSessions = prevSessionsRef.current;

    // The initial session list (and anything that arrived before it) is the
    // baseline, not news: record it without notifying. Keyed on the store's
    // isLoaded flag so an install that boots with zero sessions still treats
    // its first real session as a change.
    if (!initialLoadComplete.current) {
      prevSessionsRef.current = sessions;
      if (sessionsLoaded) initialLoadComplete.current = true;
      return;
    }
    
    // Compare current sessions with previous sessions to detect changes
    sessions.forEach((currentSession) => {
      const prevSession = prevSessions.find(s => s.id === currentSession.id);
      
      if (!prevSession) {
        // New session created
        if (settings.notifyOnStatusChange) {
          showNotification(
            `New Session Created ${getStatusEmoji('initializing')}`,
            `"${currentSession.name}" is starting up`
          );
        }
        return;
      }

      // Check for status changes
      if (prevSession.status !== currentSession.status) {
        const emoji = getStatusEmoji(currentSession.status);
        const message = getStatusMessage(currentSession.status);

        // Notify based on specific status
        if (currentSession.status === 'waiting' && settings.notifyOnWaiting) {
          showNotification(
            `Input Required ${emoji}`,
            `"${currentSession.name}" is waiting for your response`
          );
        } else if (currentSession.status === 'completed_unviewed' && settings.notifyOnComplete) {
          showNotification(
            `Session Complete ✅`,
            `"${currentSession.name}" has finished`
          );
        } else if (currentSession.status === 'error') {
          showNotification(
            `Session Error ${emoji}`,
            `"${currentSession.name}" encountered an error`
          );
        } else if (settings.notifyOnStatusChange) {
          showNotification(
            `Status Update ${emoji}`,
            `"${currentSession.name}" ${message}`
          );
        }
      }
    });

    // Update the ref for next comparison
    prevSessionsRef.current = sessions;
  }, [sessions, sessionsLoaded, settings]);

  // Ask for notification permission once, on mount.
  useEffect(() => {
    requestPermission();
  }, []);
}