import type { RideCountdown } from '../../../shared/contract';
import { countdownDisplay } from './countdownView';

const RING_R = 44;

/**
 * The countdown before a ride starts or resumes, and the group's "Start together": one look for
 * all three, in the ride view and in the overlay. Presentational; the overlay variant marks its
 * text `ov-text` (always opaque with an outline, the overlay's rule) and leaves out the hint.
 */
export function CountdownView({
  countdown,
  variant,
}: {
  countdown: RideCountdown | null | undefined;
  variant: 'ride' | 'overlay';
}) {
  const view = countdownDisplay(countdown);
  if (!view) return null;
  const text = variant === 'overlay' ? ' ov-text' : '';
  return (
    <div
      className={`cd cd--${variant} cd--${view.kind}`}
      data-testid={variant === 'overlay' ? 'overlay-countdown' : 'ride-countdown'}
      data-kind={view.kind}
      role="timer"
      aria-live="polite"
      aria-atomic="true"
    >
      {variant === 'overlay' ? <div className="ov-backdrop" aria-hidden="true" /> : null}
      <div className="cd-dial">
        <svg className="cd-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle className="cd-ring-track" cx="50" cy="50" r={RING_R} pathLength={100} />
          <circle
            className="cd-ring-fill"
            cx="50"
            cy="50"
            r={RING_R}
            pathLength={100}
            strokeDasharray="100 100"
            style={{ strokeDashoffset: Math.round((1 - view.fraction) * 1000) / 10 }}
          />
        </svg>
        <span key={view.digit} className={`cd-digit${text}`} data-testid="countdown-digit">
          {view.digit}
        </span>
      </div>
      <span className={`cd-title${text}`}>{view.title}</span>
      {variant === 'ride' ? <span className="cd-hint">{view.hint}</span> : null}
    </div>
  );
}
