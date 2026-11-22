import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { DeviceKind } from '@freilauf/devices';
import { DEFAULT_SETTINGS, type Bounds, type FreilaufApi, type LiveState, type OverlaySettings } from '../../../shared/contract';
import { OverlayView } from './OverlayView';
import { computeResizeBounds } from './logic';
import './overlay.css';

interface ResizeDrag {
  pointerId: number;
  startPointer: { screenX: number; screenY: number };
  latest: { screenX: number; screenY: number };
  /** Null until getBounds() resolves. */
  startBounds: Bounds | null;
  raf: number | null;
  cancelled: boolean;
  /** Pointer went up before getBounds() resolved: apply once on resolve. */
  released: boolean;
}

/** The overlay window's root: wires the preload api to the presentational view. */
export function Overlay({ api }: { api: FreilaufApi }) {
  const [live, setLive] = useState<LiveState | null>(null);
  const [settings, setSettings] = useState<OverlaySettings>(DEFAULT_SETTINGS.overlay);
  const [editMode, setEditMode] = useState(false);
  const [everConnected, setEverConnected] = useState<ReadonlySet<DeviceKind>>(() => new Set());

  useEffect(() => {
    let alive = true;
    const offChange = api.settings.onChange((s) => {
      if (alive) setSettings(s.overlay);
    });
    api.settings
      .get()
      .then((s) => {
        if (alive) setSettings(s.overlay);
      })
      .catch(() => {
        /* keep defaults */
      });
    return () => {
      alive = false;
      offChange();
    };
  }, [api]);

  useEffect(() => {
    const off = api.live.onState((state) => {
      setLive(state);
      // Only allocate a new set when a device connects for the first time.
      setEverConnected((prev) => {
        let next: Set<DeviceKind> | null = null;
        for (const [kind, status] of Object.entries(state.devices) as [DeviceKind, LiveState['devices'][DeviceKind]][]) {
          if (status?.state === 'connected' && !prev.has(kind)) {
            next ??= new Set(prev);
            next.add(kind);
          }
        }
        return next ?? prev;
      });
    });
    return off;
  }, [api]);

  useEffect(() => api.overlay.onEditMode(setEditMode), [api]);

  const drag = useRef<ResizeDrag | null>(null);

  const stopDrag = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.cancelled = true;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    drag.current = null;
  }, []);

  // Leaving edit mode or unmounting ends any resize in progress.
  useEffect(() => {
    if (!editMode) stopDrag();
    return stopDrag;
  }, [editMode, stopDrag]);

  const flush = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    d.raf = null;
    if (!d.startBounds || d.cancelled) return;
    api.overlay.setBounds(computeResizeBounds(d.startBounds, d.startPointer, d.latest));
  }, [api]);

  const schedule = useCallback(() => {
    const d = drag.current;
    if (d && d.raf === null) d.raf = requestAnimationFrame(flush);
  }, [flush]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      stopDrag();
      e.currentTarget.setPointerCapture(e.pointerId);
      const p = { screenX: e.screenX, screenY: e.screenY };
      const d: ResizeDrag = {
        pointerId: e.pointerId,
        startPointer: p,
        latest: p,
        startBounds: null,
        raf: null,
        cancelled: false,
        released: false,
      };
      drag.current = d;
      api.overlay
        .getBounds()
        .then((b) => {
          if (d.cancelled) return;
          d.startBounds = b;
          if (d.released) {
            api.overlay.setBounds(computeResizeBounds(b, d.startPointer, d.latest));
            return;
          }
          schedule(); // apply any movement made while waiting
        })
        .catch(() => {
          if (drag.current === d) drag.current = null;
        });
    },
    [api, schedule, stopDrag],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      d.latest = { screenX: e.screenX, screenY: e.screenY };
      schedule();
    },
    [schedule],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      d.latest = { screenX: e.screenX, screenY: e.screenY };
      if (d.raf !== null) cancelAnimationFrame(d.raf);
      d.raf = null;
      if (d.startBounds) {
        api.overlay.setBounds(computeResizeBounds(d.startBounds, d.startPointer, d.latest));
        d.cancelled = true;
      } else {
        d.released = true;
      }
      drag.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    },
    [api],
  );

  const onDone = useCallback(() => api.overlay.setEditMode(false), [api]);

  return (
    <OverlayView
      live={live}
      settings={settings}
      editMode={editMode}
      everConnected={everConnected}
      onDone={onDone}
      onResizePointerDown={onPointerDown}
      onResizePointerMove={onPointerMove}
      onResizePointerUp={onPointerUp}
    />
  );
}
