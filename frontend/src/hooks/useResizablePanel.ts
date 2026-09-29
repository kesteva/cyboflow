import { useState, useCallback, useEffect, useRef } from 'react';
import { useOcclusion } from './useOcclusion';

interface UseResizablePanelOptions {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  storageKey?: string;
  onResize?: (width: number) => void;
}

export function useResizablePanel({
  defaultWidth,
  minWidth,
  maxWidth,
  storageKey,
  onResize
}: UseResizablePanelOptions) {
  // Get initial width from localStorage or use default
  const getInitialWidth = () => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const width = parseInt(stored, 10);
        if (!isNaN(width) && width >= minWidth && width <= maxWidth) {
          return width;
        }
      }
    }
    return defaultWidth;
  };

  const [width, setWidth] = useState(getInitialWidth);
  const [isResizing, setIsResizing] = useState(false);
  // A native web view swallows mouse events once the cursor crosses it, which
  // would lose this drag's mouseup — hide it for the duration of the drag.
  useOcclusion(isResizing, 'resize');
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Save width to localStorage and call onResize
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, width.toString());
    }
    if (onResize) {
      onResize(width);
    }
  }, [width, storageKey, onResize]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startX.current = e.clientX;
    startWidth.current = width;
  }, [width]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const diff = e.clientX - startX.current;
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth.current + diff));
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Add class to body to change cursor globally while resizing
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, minWidth, maxWidth]);

  return {
    width,
    isResizing,
    startResize
  };
}