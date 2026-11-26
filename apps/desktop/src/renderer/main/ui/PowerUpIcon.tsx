import type { PowerUpKind } from '../../../shared/powerUps';

/**
 * Small line icons for the power-ups, drawn for Freilauf (24 × 24, currentColor, round caps):
 * wind lines, a lifted weight, a wake of chevrons, an arrow running downhill; and for Freilauf
 * Rumble a bidon, a mud puddle, a few hornets, a rain cape and the feed bag; and (v3) an energy
 * bar in its wrapper, two tacks, a wrench, two chain links, the team car and cobbles.
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
  // Freilauf Rumble. Water bottle: a cyclist's bidon, nozzle on top, two grip bands.
  bottle:
    'M10.5 3.5h3 M11 3.5v2 M13 3.5v2 M9 5.5h6l.5 2v12a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-12z M8.5 11h7 M8.5 14.5h7',
  // Mud puddle: a low, uneven pool on the road and a drop falling into it.
  puddle:
    'M3.5 16.5c0-1.8 2.6-2.6 4.6-2.2 1.6-1.4 5.2-1.6 6.8-.3 2.2-.4 5.6.4 5.6 2.4 0 2-3.8 3.1-8.5 3.1s-8.5-1-8.5-3z M12 4.5c1.5 2 2.3 3.3 2.3 4.4a2.3 2.3 0 0 1-4.6 0c0-1.1.8-2.4 2.3-4.4z',
  // Hornets: three small striped bodies with a wing each, and the swirl of their flight.
  hornets:
    'M4.8 15a2.2 1.4 0 1 0 4.4 0a2.2 1.4 0 1 0-4.4 0 M7 13.6v2.8 M6.1 13.5c-.7-1.5.4-2.6 1.6-1.7 M13.8 8a2.2 1.4 0 1 0 4.4 0a2.2 1.4 0 1 0-4.4 0 M16 6.6v2.8 M15.1 6.5c-.7-1.5.4-2.6 1.6-1.7 M15.4 18a1.6 1 0 1 0 3.2 0a1.6 1 0 1 0-3.2 0 M3 8.5c2.2-1.2 4-.8 5.6.6',
  // Rain cape: a hood and a cape flaring out to the hem, with its centre seam.
  cape: 'M12 3.5a3 3 0 0 0-3 3v1L5 19.5c2.3 1 4.6 1.5 7 1.5s4.7-.5 7-1.5L15 7.5v-1a3 3 0 0 0-3-3z M9 7.5h6 M12 10.5v8.5',
  // Energy bar: a bar on the slant, its wrapper crimped at both ends, torn open at the top.
  energyBar: 'M5.5 14.5 14.5 5.5l4 4-9 9z M3.5 16.5l4 4 M16.5 3.5l4 4 M9 11l4 4 M17 9.5l2.5-.5',
  // Tacks: two drawing pins, round heads and their points, and a glint.
  tacks:
    'M4 10.5h6 M5 10.5a2 2 0 0 1 4 0 M7 10.5v5 M13 15.5h6 M14 15.5a2 2 0 0 1 4 0 M16 15.5v5 M17 4.5v2 M16 5.5h2',
  // Mini tool: an open-ended wrench.
  tool: 'M14.5 4a4.2 4.2 0 0 0-5 5.4l-5.6 5.6a2 2 0 0 0 2.8 2.8l5.6-5.6a4.2 4.2 0 0 0 5.4-5l-2.7 2.7-2.6-.6-.6-2.6z',
  // Dropped chain: two links, the second one hanging loose.
  chain:
    'M3.5 8.5a2.5 2.5 0 0 1 2.5-2.5h4.5a2.5 2.5 0 0 1 0 5H6a2.5 2.5 0 0 1-2.5-2.5z M11.5 12.5l1.5 1.2a2.5 2.5 0 0 0 3.5-.4l1.3-1.6 M14.5 16l1.5 4 M17.5 15.5l2 3',
  // Team car: an estate with a bike on the roof.
  teamCar:
    'M3 17v-3.5l2.5-3.5h9l3.5 3.5h3v3.5z M6 17a1.8 1.8 0 1 0 3.6 0 M14.5 17a1.8 1.8 0 1 0 3.6 0 M6.5 7.5h9 M8 7.5a1.4 1.4 0 1 0 0 .01 M14 7.5a1.4 1.4 0 1 0 0 .01',
  // Rough section: cobbles on the road.
  rough:
    'M3 20h18 M4 16.5h4.5v3H4z M10 16.5h4.5v3H10z M16 16.5h4v3h-4z M6.5 12.5h4.5v3H6.5z M13 12.5h4.5v3H13z M9 8.5h5v3H9z',
};

/** Freilauf Rumble's pick-up: a feed bag (musette) on its long strap. */
const FEED_BAG =
  'M8.5 10.5 12 2.5l3.5 8 M6.5 10.5h11v8a2.5 2.5 0 0 1-2.5 2.5h-6a2.5 2.5 0 0 1-2.5-2.5z M6.5 13.5h11';

export function PowerUpIcon({
  kind,
  className,
}: {
  kind: PowerUpKind | 'feedBag';
  className?: string;
}) {
  return (
    <svg
      className={`pu-icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-kind={kind}
    >
      <path d={kind === 'feedBag' ? FEED_BAG : PATHS[kind]} />
    </svg>
  );
}
