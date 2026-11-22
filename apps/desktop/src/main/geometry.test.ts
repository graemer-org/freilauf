import { describe, expect, it } from 'vitest';
import { OVERLAY_MIN_SIZE, defaultOverlayBounds, fitToDisplays, isReachable } from './geometry';

const laptop = { x: 0, y: 0, width: 1536, height: 824 }; // 1920×1080 @125 %, minus taskbar
const external4k = { x: 1536, y: -400, width: 2560, height: 1400 }; // 3840×2160 @150 %

describe('geometry', () => {
  it('keeps bounds that are on a display', () => {
    const b = { x: 2000, y: 0, width: 400, height: 200 };
    expect(
      fitToDisplays(b, [laptop, external4k], laptop, OVERLAY_MIN_SIZE, defaultOverlayBounds),
    ).toEqual(b);
  });

  it('moves bounds from an unplugged monitor back onto the primary display', () => {
    const b = { x: 3000, y: 100, width: 400, height: 200 };
    const out = fitToDisplays(b, [laptop], laptop, OVERLAY_MIN_SIZE, defaultOverlayBounds);
    expect(isReachable(out, [laptop])).toBe(true);
    expect(out.width).toBe(400);
    expect(out.height).toBe(200);
    expect(out.x + out.width).toBeLessThanOrEqual(laptop.width);
  });

  it('treats a sliver at the edge as unreachable', () => {
    expect(isReachable({ x: 1530, y: 0, width: 400, height: 200 }, [laptop])).toBe(false);
    expect(isReachable({ x: 1400, y: 0, width: 400, height: 200 }, [laptop])).toBe(true);
  });

  it('enforces the minimum size and caps at the largest display', () => {
    const tiny = fitToDisplays(
      { x: 10, y: 10, width: 5, height: 5 },
      [laptop],
      laptop,
      OVERLAY_MIN_SIZE,
      defaultOverlayBounds,
    );
    expect(tiny.width).toBe(OVERLAY_MIN_SIZE.width);
    expect(tiny.height).toBe(OVERLAY_MIN_SIZE.height);
    const huge = fitToDisplays(
      { x: 0, y: 0, width: 9000, height: 9000 },
      [laptop],
      laptop,
      OVERLAY_MIN_SIZE,
      defaultOverlayBounds,
    );
    expect(huge.width).toBeLessThanOrEqual(laptop.width);
    expect(huge.height).toBeLessThanOrEqual(laptop.height);
  });

  it('default overlay position is top right of the primary work area', () => {
    const b = defaultOverlayBounds(laptop);
    expect(b.x + b.width).toBe(laptop.width - 24);
    expect(b.y).toBe(24);
  });
});
