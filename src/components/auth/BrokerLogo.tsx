/**
 * A broker's mark.
 *
 * The remote logo is progressive enhancement over the initial, never a
 * dependency on it: the initial is painted first and the image fades in on top
 * only once it has actually loaded. Broker logo hosts are third-party and go
 * down, and a broken-image glyph where a brand should be reads as a broken app.
 *
 * The brand colour is used for the TILE only. Status — connected, failing,
 * signing in — is carried by the app's own semantic colours everywhere else, so
 * that Kotak's gold never has to compete with the warning amber.
 */

import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { BrokerConfig } from '@/lib/brokers';

type Size = 'sm' | 'md' | 'lg';

const SIZES: Record<Size, string> = {
  sm: 'size-6 text-[length:var(--type-micro)] rounded-[var(--radius-xs)]',
  md: 'size-9 text-[length:var(--type-control)] rounded-[var(--radius-sm)]',
  lg: 'size-11 text-[length:var(--type-body)] rounded-[var(--radius-md)]',
};

export function BrokerLogo({
  broker,
  size = 'md',
  className,
}: {
  broker: BrokerConfig;
  size?: Size;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden',
        'font-bold tracking-[var(--tracking-tight)]',
        SIZES[size],
        className,
      )}
      style={{
        // A 16% wash of the brand hue, so the tile identifies the broker without
        // becoming the loudest thing in a list of five.
        backgroundColor: `color-mix(in srgb, ${broker.color} 16%, var(--surface-raised))`,
        color: broker.color,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${broker.color} 28%, transparent)`,
      }}
    >
      <span>{broker.logo}</span>
      {failed ? null : (
        <img
          src={broker.logoUrl}
          alt=""
          loading="lazy"
          className={cn(
            'absolute inset-0 size-full object-contain p-1 transition-opacity duration-200',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}
