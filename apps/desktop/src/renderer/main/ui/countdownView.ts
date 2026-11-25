import type { RideCountdown } from '../../../shared/contract';

/** What the countdown before a ride (start, resume, group start) shows; pure for tests. */
export interface CountdownDisplay {
  kind: RideCountdown['kind'];
  /** The big digit: whole seconds left, never 0 (the ride starts at zero). */
  digit: number;
  title: string;
  /** One quiet line under the title (the ride view; the overlay leaves it out). */
  hint: string;
  /** Share of the countdown still to go, 1 … 0 (the ring). */
  fraction: number;
}

export function countdownDisplay(
  countdown: RideCountdown | null | undefined,
): CountdownDisplay | null {
  if (!countdown) return null;
  const remaining = Number.isFinite(countdown.remainingS) ? Math.max(0, countdown.remainingS) : 0;
  const total = Number.isFinite(countdown.totalS) && countdown.totalS > 0 ? countdown.totalS : 1;
  const digit = Math.max(1, Math.ceil(remaining));
  const fraction = Math.min(1, remaining / total);
  if (countdown.kind === 'group') {
    return {
      kind: 'group',
      digit,
      title: 'Starting together',
      hint: 'The ride starts on its own for everyone in the group.',
      fraction,
    };
  }
  return {
    kind: countdown.kind,
    digit,
    title: 'Get ready',
    hint:
      countdown.kind === 'resume'
        ? 'The ride resumes at zero. Space or Esc cancels.'
        : 'Time and recording start at zero. Space or Esc cancels.',
    fraction,
  };
}
