/**
 * Button — the shared control language.
 *
 * Variants are semantic, not decorative: `primary` is the one action a screen
 * wants you to take, `danger` is destructive, `ghost` is navigation-weight.
 * A screen with two primaries has a hierarchy problem the component should not
 * paper over, so there is no "secondary primary".
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'default' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** Renders the icon alone at a square footprint. */
  iconOnly?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--action-primary-bg)] text-[var(--action-primary-text)] font-semibold ' +
    'hover:bg-[var(--action-primary-hover)] shadow-[var(--control-shadow)]',
  default:
    'bg-[var(--control-bg)] text-[var(--text-primary)] border border-[var(--control-border)] ' +
    'hover:bg-[var(--control-bg-hover)] hover:border-[var(--border-strong)] shadow-[var(--control-shadow)]',
  ghost:
    'bg-transparent text-[var(--text-secondary)] ' +
    'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
  danger:
    'bg-transparent text-[var(--status-danger)] border border-[var(--status-danger)] ' +
    'hover:bg-[var(--status-danger-soft)]',
  success:
    'bg-transparent text-[var(--status-success)] border border-[var(--status-success)] ' +
    'hover:bg-[var(--status-success-soft)]',
};

const SIZES: Record<Size, string> = {
  sm: 'h-[var(--control-compact)] px-3 text-[length:var(--type-caption)] gap-1.5',
  md: 'h-[var(--control-comfortable)] px-4 text-[length:var(--type-control)] gap-2',
};

const ICON_SIZES: Record<Size, string> = {
  sm: 'size-[var(--control-compact)] px-0',
  md: 'size-[var(--control-comfortable)] px-0',
};

export function Button({
  variant = 'default',
  size = 'sm',
  icon,
  iconOnly,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--control-radius)]',
        'font-medium whitespace-nowrap transition-all duration-100',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
        VARIANTS[variant],
        iconOnly ? ICON_SIZES[size] : SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {iconOnly ? null : children}
    </button>
  );
}
