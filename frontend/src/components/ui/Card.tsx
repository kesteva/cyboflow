import React from 'react';
import { cn } from '../../utils/cn';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'bordered' | 'elevated' | 'interactive';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  nesting?: 'primary' | 'secondary' | 'tertiary';
  children: React.ReactNode;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ 
    className, 
    variant = 'default',
    padding = 'md',
    nesting = 'primary',
    children,
    ...props 
  }, ref) => {
    const baseStyles = 'rounded-card transition-all duration-normal';
    
    const variants = {
      default: '',
      bordered: 'border',
      elevated: 'shadow-card hover:shadow-modal',
      interactive: 'cursor-pointer hover:shadow-md'
    };
    
    const nestingLevels = {
      primary: 'bg-surface-primary border-border-primary',
      secondary: 'bg-surface-secondary border-border-secondary',
      tertiary: 'bg-bg-tertiary border-border-secondary'
    };
    
    const paddings = {
      none: '',
      sm: 'p-card-sm',
      md: 'p-card',
      lg: 'p-card-lg'
    };
    
    return (
      <div
        ref={ref}
        className={cn(
          baseStyles,
          nestingLevels[nesting],
          variants[variant],
          paddings[padding],
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';
