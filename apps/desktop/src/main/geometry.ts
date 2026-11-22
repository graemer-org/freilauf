/**
 * Pure window geometry helpers (DIP coordinates, as Electron's `screen` API
 * reports them). Unit-tested in geometry.test.ts.
 */
import type { Bounds } from '../shared/contract';

export interface Size {
  width: number;
  height: number;
}

export const OVERLAY_MIN_SIZE: Size = { width: 140, height: 60 };
export const OVERLAY_DEFAULT_SIZE: Size = { width: 380, height: 240 };
export const MAIN_MIN_SIZE: Size = { width: 720, height: 480 };

/** Minimum part of a window that must lie on some display to count as reachable. */
const MIN_VISIBLE: Size = { width: 60, height: 40 };
const MARGIN = 24;

function intersection(a: Bounds, b: Bounds): Size {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, w), height: Math.max(0, h) };
}

export function clampSize(size: Size, min: Size, max: Size): Size {
  return {
    width: Math.round(Math.min(Math.max(size.width, min.width), Math.max(min.width, max.width))),
    height: Math.round(
      Math.min(Math.max(size.height, min.height), Math.max(min.height, max.height)),
    ),
  };
}

/** True when enough of `b` lies on one of the work areas to grab and move it. */
export function isReachable(b: Bounds, workAreas: readonly Bounds[]): boolean {
  return workAreas.some((wa) => {
    const i = intersection(b, wa);
    return (
      i.width >= Math.min(MIN_VISIBLE.width, b.width) &&
      i.height >= Math.min(MIN_VISIBLE.height, b.height)
    );
  });
}

/** Top-right corner of the primary work area. */
export function defaultOverlayBounds(primary: Bounds, size: Size = OVERLAY_DEFAULT_SIZE): Bounds {
  const s = clampSize(size, OVERLAY_MIN_SIZE, {
    width: primary.width - 2 * MARGIN,
    height: primary.height - 2 * MARGIN,
  });
  return {
    x: Math.round(primary.x + primary.width - s.width - MARGIN),
    y: Math.round(primary.y + MARGIN),
    width: s.width,
    height: s.height,
  };
}

/** Centred on the primary work area. */
export function centeredBounds(primary: Bounds, size: Size): Bounds {
  const s = clampSize(size, { width: 1, height: 1 }, primary);
  return {
    x: Math.round(primary.x + (primary.width - s.width) / 2),
    y: Math.round(primary.y + (primary.height - s.height) / 2),
    width: s.width,
    height: s.height,
  };
}

/**
 * Validates saved bounds against the current displays: enforces the minimum
 * size, caps the size at the largest work area, and if the window would be
 * unreachable (its monitor was unplugged, resolution changed…) places it with
 * `fallback` on the primary display, keeping its size where possible.
 */
export function fitToDisplays(
  saved: Bounds,
  workAreas: readonly Bounds[],
  primary: Bounds,
  min: Size,
  fallback: (primary: Bounds, size: Size) => Bounds,
): Bounds {
  const maxW = Math.max(primary.width, ...workAreas.map((w) => w.width));
  const maxH = Math.max(primary.height, ...workAreas.map((w) => w.height));
  const size = clampSize(saved, min, { width: maxW, height: maxH });
  const b: Bounds = { x: Math.round(saved.x), y: Math.round(saved.y), ...size };
  if (isReachable(b, workAreas.length > 0 ? workAreas : [primary])) return b;
  return fallback(primary, clampSize(size, min, primary));
}
