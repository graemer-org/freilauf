/**
 * Choosing a point on a route by pointer or keyboard: the start point before a ride, a jump
 * during it (docs/routes.md, "Choosing where to start, and jumping"). Hover shows a hairline with distance, elevation and
 * gradient; a click (or Enter) opens a small confirmation right there, so a stray click while
 * riding never moves the rider. The elevation profile is the primary, unambiguous control; the
 * map picks the nearest pass of the route (see chooseMapCandidate for overlapping legs).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  RefObject,
  SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { clientToBox, pickPrompt, pickSteps, pointLabel, type PickMode } from './routeView';

export interface PointInfo {
  distanceM: number;
  elevationM: number;
  gradePercent: number;
}

// ───────────── the confirmation ─────────────

export interface JumpConfirmProps {
  mode: PickMode;
  info: PointInfo;
  onConfirm: () => void;
  onCancel: () => void;
  /** Where to show it (fixed, viewport coordinates); omitted in server rendering. */
  style?: CSSProperties;
  /** Focus the confirm button when it opens (default true). */
  autoFocus?: boolean;
}

/** "Jump to km 42.3 · 812 m · +3.1 %" with Jump / Cancel (before the ride: "Start here"). */
export function JumpConfirm({
  mode,
  info,
  onConfirm,
  onCancel,
  style,
  autoFocus = true,
}: JumpConfirmProps) {
  const textId = useId();
  const okRef = useRef<HTMLButtonElement>(null);
  const prompt = pickPrompt(mode, pointLabel(info));
  useEffect(() => {
    if (autoFocus) okRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div
      className="rt-pick-confirm"
      role="dialog"
      aria-modal="false"
      aria-labelledby={textId}
      data-testid="route-jump-confirm"
      data-mode={mode}
      data-distance={info.distanceM.toFixed(1)}
      style={style}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="rt-pick-confirm-text" id={textId} data-testid="route-jump-text">
        {prompt.text}
      </p>
      <div className="rt-pick-confirm-actions">
        <button
          ref={okRef}
          type="button"
          className="btn btn-small btn-primary"
          data-testid="route-jump-ok"
          onClick={onConfirm}
        >
          {prompt.confirm}
        </button>
        <button
          type="button"
          className="btn btn-small"
          data-testid="route-jump-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The confirmation in a portal (the route card clips its content), placed above the anchor
 * (below when there is no room), kept inside the window, closed by Escape or a click elsewhere.
 */
function FloatingConfirm({
  anchor,
  returnFocus,
  ...props
}: JumpConfirmProps & {
  anchor: { x: number; top: number; bottom: number };
  returnFocus: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(gap, anchor.x - r.width / 2), Math.max(gap, vw - r.width - gap));
    const above = anchor.top - r.height - gap;
    const top =
      above >= gap ? above : Math.min(anchor.bottom + gap, Math.max(gap, vh - r.height - gap));
    setPos({ left, top });
  }, [anchor.x, anchor.top, anchor.bottom]);
  const { onCancel } = props;
  useEffect(() => {
    const onDown = (e: Event): void => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onCancel();
    };
    // After the click that opened it.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    };
    const t = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);
  useEffect(() => returnFocus, [returnFocus]);
  // The portal is outside the picker in the DOM but inside it in React: keep its events from
  // reaching the picker (a click on "Jump" must not open a new confirmation).
  const stop = (e: SyntheticEvent): void => e.stopPropagation();
  return createPortal(
    <div
      ref={ref}
      onClick={stop}
      onPointerDown={stop}
      onPointerMove={stop}
      onKeyDown={stop}
      onBlur={stop}
    >
      <JumpConfirm
        {...props}
        // Focus once it is placed (a hidden element cannot take focus).
        autoFocus={pos !== null}
        style={{
          position: 'fixed',
          left: pos?.left ?? anchor.x,
          top: pos?.top ?? anchor.top,
          visibility: pos ? 'visible' : 'hidden',
        }}
      />
    </div>,
    document.body,
  );
}

// ───────────── shared state ─────────────

interface Pending {
  info: PointInfo;
  anchor: { x: number; top: number; bottom: number };
}

/** Pending confirmation, with focus returned to `target` when it closes. */
function usePending(target: RefObject<HTMLElement | null>) {
  const [pending, setPending] = useState<Pending | null>(null);
  const returnFocus = useRef(() => {
    const el = target.current;
    if (el && document.activeElement === document.body) el.focus({ preventScroll: true });
  }).current;
  return { pending, setPending, returnFocus };
}

// ───────────── profile ─────────────

export interface ProfilePickerProps {
  mode: PickMode;
  /** Route distance at a fraction (0 … 1) of the profile's width. */
  distanceAt: (fraction: number) => number;
  /** Fraction of the width for a route distance, or null when it is not shown. */
  fractionOf: (distanceM: number) => number | null;
  /** Metres of road the profile shows (for the keyboard steps). */
  spanM: number;
  /** Distance, elevation and gradient at a route distance. */
  info: (distanceM: number) => PointInfo;
  /** Where the keyboard cursor starts: the rider's position (or the start point). */
  currentM: number;
  onPick: (distanceM: number) => void;
  /** Accessible name; the hint about the keys is added. */
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
  children: ReactNode;
}

/**
 * Makes a profile (any SVG stretched to its box) pickable. A slider for assistive tech: ← →
 * move the cursor (Shift: 10 ×), Home/End jump to the ends, Enter asks to jump there, Escape
 * clears the cursor. Its value text is the same as the hover label.
 */
export function ProfilePicker({
  mode,
  distanceAt,
  fractionOf,
  spanM,
  info,
  currentM,
  onPick,
  label,
  disabled = false,
  className,
  testId,
  children,
}: ProfilePickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { pending, setPending, returnFocus } = usePending(ref);
  /** Pointer hover, as a fraction of the width. */
  const [hover, setHover] = useState<number | null>(null);
  /** Keyboard cursor, as a route distance (stays put while the profile scrolls). */
  const [cursorM, setCursorM] = useState<number | null>(null);
  const steps = pickSteps(spanM);

  const shownFraction = hover ?? (cursorM === null ? null : fractionOf(cursorM));
  const shownM = hover !== null ? distanceAt(hover) : cursorM !== null ? cursorM : null;
  const shownInfo = shownM === null ? null : info(shownM);
  const shownLabel = shownInfo ? pointLabel(shownInfo) : null;

  const fractionFromEvent = (e: PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  };

  const open = (d: number, f: number | null): void => {
    const el = ref.current;
    if (!el || disabled) return;
    const r = el.getBoundingClientRect();
    const x = r.left + (f === null ? 0.5 : Math.max(0, Math.min(1, f))) * r.width;
    setPending({ info: info(d), anchor: { x, top: r.top, bottom: r.bottom } });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey) return;
    const base = cursorM ?? currentM;
    const step = e.shiftKey ? steps.large : steps.small;
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowLeft':
        next = base - step;
        break;
      case 'ArrowRight':
        next = base + step;
        break;
      case 'PageDown':
        next = base - steps.large;
        break;
      case 'PageUp':
        next = base + steps.large;
        break;
      case 'Home':
        next = distanceAt(0);
        break;
      case 'End':
        next = distanceAt(1);
        break;
      case 'Enter':
        e.preventDefault();
        open(base, fractionOf(base));
        return;
      case 'Escape':
        if (cursorM === null) return;
        e.preventDefault();
        setCursorM(null);
        return;
      default:
        return;
    }
    e.preventDefault();
    setHover(null);
    // Keep the cursor on what the profile shows.
    const lo = distanceAt(0);
    const hi = distanceAt(1);
    setCursorM(Math.min(Math.max(lo, hi), Math.max(Math.min(lo, hi), Math.round(next))));
  };

  const valueM = shownM ?? currentM;
  const valueText = shownLabel ?? pointLabel(info(currentM));
  const hint =
    mode === 'start'
      ? 'Arrow keys choose a point, Enter sets it as the start.'
      : 'Arrow keys choose a point, Enter jumps there.';
  return (
    <div
      ref={ref}
      className={`rt-pick${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={`${label} ${hint}`}
      aria-valuemin={Math.round(Math.min(distanceAt(0), distanceAt(1)))}
      aria-valuemax={Math.round(Math.max(distanceAt(0), distanceAt(1)))}
      aria-valuenow={Math.round(valueM)}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      data-testid={testId}
      data-mode={mode}
      data-cursor={shownM === null ? undefined : shownM.toFixed(1)}
      title={disabled ? undefined : (shownLabel ?? undefined)}
      onPointerMove={(e) => {
        if (disabled || e.pointerType === 'touch') return;
        setHover(fractionFromEvent(e));
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        if (disabled) return;
        const f = fractionFromEvent(e as unknown as PointerEvent<HTMLDivElement>);
        setHover(null);
        setCursorM(null);
        open(distanceAt(f), f);
      }}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !pending) setCursorM(null);
      }}
    >
      {children}
      {shownFraction !== null && shownLabel && !disabled && (
        <>
          <span
            className="rt-pick-line"
            data-testid="route-pick-hairline"
            style={{ left: `${(shownFraction * 100).toFixed(2)}%` }}
            aria-hidden="true"
          />
          <span
            className="rt-pick-tip"
            data-testid="route-pick-tip"
            // Slides along its own width with the cursor, so it never leaves the profile.
            style={{
              left: `${(shownFraction * 100).toFixed(2)}%`,
              transform: `translateX(${(-shownFraction * 100).toFixed(2)}%)`,
            }}
            aria-hidden="true"
          >
            {shownLabel}
          </span>
        </>
      )}
      {pending && (
        <FloatingConfirm
          mode={mode}
          info={pending.info}
          anchor={pending.anchor}
          returnFocus={returnFocus}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            onPick(pending.info.distanceM);
          }}
        />
      )}
    </div>
  );
}

// ───────────── map ─────────────

export interface MapPickerProps {
  mode: PickMode;
  /** viewBox size of the map SVG (it is drawn with xMidYMid meet). */
  box: number;
  /** The route distance a pointer at box coordinates means, or null for a miss. */
  pick: (boxX: number, boxY: number) => number | null;
  /** Box position of a route distance, for the hover marker. */
  boxOf: (distanceM: number) => [number, number];
  info: (distanceM: number) => PointInfo;
  onPick: (distanceM: number) => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}

/**
 * Makes the map pickable by pointer: hover marks the nearest point of the route (the pass
 * chosen by `pick`), a click asks to jump there. Keyboard users use the profile, which is
 * unambiguous; the map is not a separate tab stop.
 */
export function MapPicker({
  mode,
  box,
  pick,
  boxOf,
  info,
  onPick,
  disabled = false,
  testId,
  children,
}: MapPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { pending, setPending, returnFocus } = usePending(ref);
  const [hoverM, setHoverM] = useState<number | null>(null);
  const at = (e: PointerEvent<HTMLDivElement>): number | null => {
    const svg = e.currentTarget.querySelector('svg');
    const r = (svg ?? e.currentTarget).getBoundingClientRect();
    const [x, y] = clientToBox(r, e.clientX, e.clientY, box, box);
    return pick(x, y);
  };
  const hoverInfo = hoverM === null ? null : info(hoverM);
  const marker = (() => {
    if (hoverM === null || !ref.current) return null;
    const svg = ref.current.querySelector('svg');
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const outer = ref.current.getBoundingClientRect();
    const scale = Math.min(r.width / box, r.height / box) || 1;
    const [bx, by] = boxOf(hoverM);
    return {
      left: r.left - outer.left + (r.width - box * scale) / 2 + bx * scale,
      top: r.top - outer.top + (r.height - box * scale) / 2 + by * scale,
    };
  })();
  return (
    <div
      ref={ref}
      className={`rt-map-pick${disabled ? ' is-disabled' : ''}${hoverM !== null ? ' is-hover' : ''}`}
      data-testid={testId}
      data-mode={mode}
      data-cursor={hoverM === null ? undefined : hoverM.toFixed(1)}
      title={disabled ? undefined : hoverInfo ? pointLabel(hoverInfo) : undefined}
      onPointerMove={(e) => {
        if (disabled || e.pointerType === 'touch') return;
        setHoverM(at(e));
      }}
      onPointerLeave={() => setHoverM(null)}
      onClick={(e) => {
        if (disabled) return;
        const d = at(e as unknown as PointerEvent<HTMLDivElement>);
        setHoverM(null);
        if (d === null) return;
        setPending({
          info: info(d),
          anchor: { x: e.clientX, top: e.clientY - 6, bottom: e.clientY + 6 },
        });
      }}
    >
      {children}
      {marker && hoverInfo && !disabled && (
        <>
          <span
            className="rt-map-pick-dot"
            data-testid="route-map-hover"
            style={{ left: marker.left, top: marker.top }}
            aria-hidden="true"
          />
          <span
            className="rt-pick-tip rt-map-pick-tip"
            data-testid="route-pick-tip"
            style={{ left: marker.left, top: marker.top }}
            aria-hidden="true"
          >
            {pointLabel(hoverInfo)}
          </span>
        </>
      )}
      {pending && (
        <FloatingConfirm
          mode={mode}
          info={pending.info}
          anchor={pending.anchor}
          returnFocus={returnFocus}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            onPick(pending.info.distanceM);
          }}
        />
      )}
    </div>
  );
}
