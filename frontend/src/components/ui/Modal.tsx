import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { X } from 'lucide-react';
import { useOcclusion } from '../../hooks/useOcclusion';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  className?: string;
}

// Module-level stack of open Modal instances, most recent (top-most) last.
// Escape is a STACK operation: only the top-most open modal may consume it —
// otherwise nested modals (e.g. Settings -> a tracker "connected" view -> an
// add-mapping wizard) each bind their own document-level Escape handler and a
// single keypress unwinds every ancestor at once. A modal with
// closeOnEscape={false} still occupies the stack top while open, so it
// swallows Escape rather than letting it fall through to its parent — that's
// the correct "modal captures Escape" behaviour.
const escapeStack: symbol[] = [];

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  children,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  className,
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const mouseDownTargetRef = useRef<EventTarget | null>(null);
  const instanceIdRef = useRef<symbol | null>(null);
  if (instanceIdRef.current === null) {
    instanceIdRef.current = Symbol('modal');
  }

  // A native web view paints above all DOM; hide it while this modal is open.
  useOcclusion(isOpen, 'modal');

  // Register/unregister this instance on the escape stack while open, so
  // nested modals can tell whether they're the top-most one. Re-opening
  // (isOpen false -> true) re-registers on top of the stack.
  useEffect(() => {
    if (!isOpen) return;
    const id = instanceIdRef.current as symbol;
    escapeStack.push(id);
    return () => {
      const index = escapeStack.lastIndexOf(id);
      if (index !== -1) {
        escapeStack.splice(index, 1);
      }
    };
  }, [isOpen]);

  // Handle escape key — only the top-most open modal on the stack responds;
  // ancestors ignore a keypress that belongs to a modal stacked above them.
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const id = instanceIdRef.current as symbol;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (escapeStack[escapeStack.length - 1] !== id) return;
      onClose();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, closeOnEscape]);
  
  // Lock body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);
  
  // Focus management
  useEffect(() => {
    if (!isOpen) return;
    
    // Focus the modal when it opens
    const timer = setTimeout(() => {
      modalRef.current?.focus();
    }, 50);
    
    return () => clearTimeout(timer);
  }, [isOpen]);
  
  if (!isOpen) return null;
  
  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full mx-4',
  };
  
  const handleOverlayMouseDown = (e: React.MouseEvent) => {
    // A nested Modal (e.g. a name-prompt dialog rendered as a JSX child of this
    // one) portals to its own DOM node under document.body, but React still
    // bubbles its synthetic events through the REACT tree — so this handler
    // can fire for a mousedown that never actually touched this modal's DOM
    // subtree. Ignore those; the nested modal's own overlay handler owns them.
    if (!(e.currentTarget instanceof Node) || !(e.target instanceof Node) || !e.currentTarget.contains(e.target)) {
      return;
    }
    // Store where the mouse down occurred
    mouseDownTargetRef.current = e.target;
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    // Same cross-portal guard as handleOverlayMouseDown: a click inside a
    // nested Modal is a DOM descendant of THAT modal's wrapper, not this one's,
    // even though it reaches this handler via React-tree event bubbling. Bail
    // out rather than misreading it as an outside click on this modal.
    if (!(e.currentTarget instanceof Node) || !(e.target instanceof Node) || !e.currentTarget.contains(e.target)) {
      return;
    }
    // Check if the click target is the modal content or its children
    const modalContent = modalRef.current;
    const isClickInsideModal = modalContent && e.target && e.target instanceof Node && modalContent.contains(e.target);
    
    // Only close if:
    // 1. closeOnOverlayClick is enabled
    // 2. The click is not inside the modal content
    // 3. The mousedown also started outside the modal content
    if (closeOnOverlayClick && !isClickInsideModal) {
      const wasMouseDownInsideModal = modalContent && mouseDownTargetRef.current && mouseDownTargetRef.current instanceof Node && modalContent.contains(mouseDownTargetRef.current);
      if (!wasMouseDownInsideModal) {
        onClose();
      }
    }
    // Reset the ref after handling
    mouseDownTargetRef.current = null;
  };
  
  // PORTAL to document.body: a modal must not be subject to ancestor visual
  // context (e.g. the archived-card opacity-60 dim, overflow clipping, or a
  // transform creating a containing block for the fixed overlay). React portals
  // still bubble synthetic events through the REACT tree, so wrappers like the
  // card menu's stopPropagation span keep working unchanged.
  return createPortal(
    <div
      className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 overflow-y-auto"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-modal-overlay pointer-events-none" aria-hidden="true" />
      
      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'relative bg-bg-primary rounded-modal shadow-modal w-full max-h-[90vh] overflow-hidden flex flex-col',
          sizeClasses[size],
          'animate-fadeIn',
          className
        )}
      >
        {showCloseButton && (
          <div className="absolute top-4 right-4 z-10">
            <button
              aria-label="Close modal"
              onClick={onClose}
              className="text-text-tertiary hover:text-text-secondary transition-colors p-1 rounded"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
};

Modal.displayName = 'Modal';

// Modal Header component
export interface ModalHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  icon?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
}

export const ModalHeader = React.forwardRef<HTMLDivElement, ModalHeaderProps>(
  ({ className, title, icon, onClose, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center justify-between px-6 py-4 border-b border-border-primary',
          className
        )}
        {...props}
      >
        <div className="flex items-center gap-2">
          {icon && <div className="text-text-secondary">{icon}</div>}
          <h2 className="text-heading-2 text-text-primary">
            {title || children}
          </h2>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
    );
  }
);

ModalHeader.displayName = 'ModalHeader';

// Modal Body component
export interface ModalBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ModalBody = React.forwardRef<HTMLDivElement, ModalBodyProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex-1 overflow-y-auto px-6 py-4',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ModalBody.displayName = 'ModalBody';

// Modal Footer component
export interface ModalFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const ModalFooter = React.forwardRef<HTMLDivElement, ModalFooterProps>(
  ({ className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'px-6 py-4 border-t border-border-primary flex items-center justify-end gap-3',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

ModalFooter.displayName = 'ModalFooter';