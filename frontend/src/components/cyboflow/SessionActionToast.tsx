import { useEffect } from 'react';

interface SessionActionToastProps {
  message: string;
  isVisible: boolean;
  onDismiss: () => void;
  durationMs?: number;
}

export function SessionActionToast({ message, isVisible, onDismiss, durationMs = 3000 }: SessionActionToastProps) {
  useEffect(() => {
    if (!isVisible) return;
    const timer = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(timer);
  }, [isVisible, onDismiss, durationMs]);

  if (!isVisible) return null;

  return (
    <div
      data-testid="session-action-toast"
      className="bg-status-success text-white rounded px-4 py-2 text-sm font-medium shadow-lg"
    >
      {message}
    </div>
  );
}
