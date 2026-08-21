/**
 * One credential input.
 *
 * Secrets are masked with a reveal toggle rather than being permanently hidden:
 * an MPIN typed wrong is the single most common reason a login fails, and a
 * field that can never be read back turns a typo into an opaque broker error.
 *
 * `filled` marks a value that came from the backend's stored row. Without it a
 * pre-filled form is indistinguishable from browser autofill, and there is no
 * way to tell which fields still need a human.
 */

import { useId, useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { Input, Label } from '@/components/ui/Field';
import { cn } from '@/lib/cn';
import type { BrokerField } from '@/lib/brokers';

export function CredentialField({
  field,
  value,
  filled,
  onChange,
}: {
  field: BrokerField;
  value: string;
  /** True when this value arrived from `broker_accounts` rather than the user. */
  filled?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const secret = field.type === 'password' || field.type === 'totp_secret';

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{field.label}</Label>
        {field.type === 'totp_secret' ? (
          <span className="text-[length:var(--type-micro)] text-[var(--accent-info)]">
            Automatic OTP
          </span>
        ) : filled ? (
          <span className="flex items-center gap-1 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
            <Lock size={10} />
            stored
          </span>
        ) : null}
      </div>

      <div className="relative">
        <Input
          id={id}
          type={secret && !revealed ? 'password' : 'text'}
          inputMode={field.type === 'number' ? 'numeric' : undefined}
          // A stored secret arrives as a name with no value, so the ordinary
          // placeholder ("4-digit MPIN") would read as an empty field that
          // still needs typing. Dots say "held, and not shown to a browser".
          placeholder={filled && !value ? '••••••••' : field.placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={field.hint ? `${id}-hint` : undefined}
          className={cn(secret && 'pr-9 font-mono', secret && !revealed && 'tracking-widest')}
        />
        {secret ? (
          <button
            type="button"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? `Hide ${field.label}` : `Show ${field.label}`}
            aria-pressed={revealed}
            className={cn(
              'absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center',
              'rounded-[var(--radius-xs)] text-[var(--text-tertiary)]',
              'transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
            )}
          >
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        ) : null}
      </div>

      {field.hint ? (
        <p
          id={`${id}-hint`}
          className="mt-1 text-[length:var(--type-micro)] leading-snug text-[var(--text-tertiary)]"
        >
          {field.hint}
        </p>
      ) : null}
    </div>
  );
}
