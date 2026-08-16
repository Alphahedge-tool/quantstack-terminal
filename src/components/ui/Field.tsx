/**
 * Form controls, sharing one visual language so a form assembled in one feature
 * matches a form assembled in another without the two authors coordinating.
 *
 * Every control is the same height (--control-compact), the same radius and the
 * same focus treatment. That uniformity is the whole point — a toolbar of mixed
 * heights is the most common way a dense UI stops looking built.
 */

import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/cn';

const CONTROL_BASE =
  'h-[var(--control-compact)] rounded-[var(--control-radius)] ' +
  'bg-[var(--control-bg)] border border-[var(--control-border)] ' +
  'text-[length:var(--type-control)] text-[var(--text-primary)] ' +
  'transition-colors duration-100 outline-none ' +
  'hover:border-[var(--border-strong)] ' +
  'focus:border-[var(--border-focus)] focus:bg-[var(--control-bg-hover)] ' +
  'disabled:opacity-40 disabled:cursor-not-allowed ' +
  'placeholder:text-[var(--text-tertiary)]';

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="qs-label mb-1 block">
      {children}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(CONTROL_BASE, 'w-full px-3', className)} {...rest} />;
  },
);

/** Search input with the icon inset. Separate from Input because the padding
 *  offset has to match the icon's position exactly, and eyeballing that per
 *  call site is how it drifts. */
export const SearchInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SearchInput({ className, ...rest }, ref) {
    return (
      <div className="relative w-full">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
        />
        <input ref={ref} className={cn(CONTROL_BASE, 'w-full pl-9 pr-3', className)} {...rest} />
      </div>
    );
  },
);

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: Array<{ value: string; label: string }>;
}

/** Native select, restyled. Native because a custom listbox has to reimplement
 *  keyboard navigation, typeahead and mobile behaviour to break even. */
export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <div className="relative inline-flex">
      <select
        className={cn(CONTROL_BASE, 'w-full cursor-pointer appearance-none pl-3 pr-8', className)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
      />
    </div>
  );
}

/**
 * Segmented control — for small, mutually exclusive choices where showing all
 * options at once beats hiding them behind a select (timeframes, density, side).
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex h-[var(--control-compact)] items-center gap-0.5 rounded-[var(--control-radius)]',
        'border border-[var(--border-default)] bg-[var(--control-bg)] p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-full rounded-[var(--radius-xs)] px-2.5 transition-all duration-100',
              'text-[length:var(--type-caption)] font-semibold whitespace-nowrap',
              // Both rungs were too quiet to work as a control. The unselected
              // options sat at --text-tertiary (3.38:1), which is the caption
              // step — legible as an annotation, but these are BUTTONS, and a
              // tab you have to look for is not offering the choice. Secondary
              // (5.68:1) is the rung for anything read as an action.
              //
              // The selected one moves up too, to the hover accent with a ring:
              // once the unselected labels brighten, a soft-wash-only selection
              // stops separating from them.
              active
                ? 'bg-[var(--accent-info-soft)] text-[var(--accent-info-hover)] ' +
                  'shadow-[inset_0_0_0_1px_var(--accent-info)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
