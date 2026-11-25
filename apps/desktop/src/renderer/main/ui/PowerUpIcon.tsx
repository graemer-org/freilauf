import type { PowerUpKind } from '../../../shared/powerUps';

/**
 * Small line icons for the power-ups, drawn for Freilauf (24 × 24, currentColor, round caps):
 * wind lines, a lifted weight, a wake of chevrons, and an arrow running downhill.
 */
const PATHS: Record<PowerUpKind, string> = {
  // Three gusts of wind, the middle one longest, curling at their ends.
  tailwind:
    'M3 8.5h10.5a2.5 2.5 0 1 0-2.5-2.5 M3 12.5h15a2.5 2.5 0 1 1-2.5 2.5 M3 16.5h7.5a2 2 0 1 1-2 2',
  // A weight with an arrow lifting it.
  lightLoad: 'M12 3v7 M8.5 6.5 12 3l3.5 3.5 M6.5 14h11l1.5 6.5h-14z M10 14a2 2 0 0 1 4 0',
  // A teardrop wake behind a rider: two nested chevrons pointing ahead.
  slipstream: 'M4 6.5 10.5 12 4 17.5 M11 6.5 17.5 12 11 17.5 M18.5 9.5v5',
  // An arrow running down a slope, with a speed line beside it.
  downhill: 'M4 5.5l14 9 M18 14.5l-5.4.6 M18 14.5l-2.3-4.9 M4 12l7.5 4.8 M3.5 20h17',
  // Card Race. Headwind: gusts coming from the right (from ahead), against a small upright bar.
  headwind:
    'M21 8.5H10.5a2.5 2.5 0 1 1 2.5-2.5 M21 12.5H8a2.5 2.5 0 1 0 2.5 2.5 M21 16.5h-6.5 M4 7v10',
  // Fog: three soft horizontal bands, the middle one broken, and a question dot.
  fog: 'M3.5 8h11 M17.5 8h3 M3.5 12h5 M11.5 12h9 M3.5 16h14 M12 19.6v.1',
  // Shield: a rounded crest with a calm centre line.
  shield: 'M12 3.5 5 6.2v5.3c0 4.3 3 7.4 7 9 4-1.6 7-4.7 7-9V6.2z M12 8v8',
};

export function PowerUpIcon({ kind, className }: { kind: PowerUpKind; className?: string }) {
  return (
    <svg
      className={`pu-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      <path d={PATHS[kind]} />
    </svg>
  );
}
