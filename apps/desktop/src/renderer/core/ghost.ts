/**
 * The ghost rider (docs/ghost.md, ADR 0010): an earlier ride of the same route raced by moving
 * time along the route. No timers, no DOM: the ride controller feeds `GhostRace.update` with the
 * ride's moving time and route position on every tick; the ghost only reads them, it never
 * changes the ride, the recording or the trainer.
 *
 * Coordinates: route metres from the route's start, continuing across laps (the ride's
 * `offsetM + ridden distance`). The ghost's trace is in the same coordinates. The race is
 * anchored where the rider starts: the ghost starts there at the moment the ride starts (when
 * the countdown reaches zero), so a ride started part-way races the ghost from that place.
 */
import type { GhostTrace } from '@freilauf/session';
import type { GhostChoice, GhostLive, GhostSplit, RideListItem } from '../../shared/contract';

export interface GhostShape {
  lengthM: number;
  loop: boolean;
}

export interface GhostInput {
  state: 'idle' | 'riding' | 'paused';
  /** Moving time of the ride (s). */
  elapsedS: number;
  /** Route position (m, across laps): offset + ridden distance. */
  routeM: number;
  /** Jumps along the route so far (RouteControl.jumps). */
  jumps: number;
}

/** What the race came to at the finish (FinishedRide.ghost). */
export interface GhostResult {
  label: string;
  /** + = the rider was faster by this many seconds; null when never compared. */
  gapS: number | null;
  /** True when the rider rode the ghost's whole ride (the comparison is over its full length). */
  complete: boolean;
  splits: GhostSplit[];
}

const km = (m: number): string => `km ${(Math.max(0, m) / 1000).toFixed(1)}`;

export class GhostRace {
  readonly label: string;
  readonly #t: readonly number[];
  readonly #d: readonly number[];
  readonly #shape: GhostShape;
  readonly #start: number;
  readonly #end: number;
  /** Ghost place x0 matched with the rider's place r0 at ride time t0 (ghost at x0 then). */
  #anchor: { t0: number; x0: number; r0: number } | null = null;
  /** Rider place minus ghost place of the last anchor (keeps the lap alignment after a jump). */
  #lastShift: number | null = null;
  #started = false;
  #everAnchored = false;
  /** Seconds ahead carried over a jump (the comparison continues at the new place). */
  #carryS = 0;
  #lastGapS: number | null = null;
  #final: number | null = null;
  #prev: { t: number; x: number } | null = null;
  #jumps = 0;
  readonly #splitAt: readonly { atM: number; label: string }[];
  #nextSplit = 0;
  readonly #splits: GhostSplit[] = [];

  constructor(trace: GhostTrace, shape: GhostShape, label: string) {
    const n = Math.min(trace.timeS.length, trace.distanceM.length);
    if (n < 2) throw new RangeError('a ghost needs at least two points');
    this.#t = trace.timeS.slice(0, n);
    this.#d = trace.distanceM.slice(0, n);
    this.#shape = shape;
    this.label = label;
    this.#start = this.#d[0]!;
    this.#end = this.#d[n - 1]!;
    this.#splitAt = splitPoints(shape, this.#start, this.#end);
  }

  /** Where the ghost's ride begins and ends (m, across laps). */
  get coverage(): { fromM: number; toM: number } {
    return { fromM: this.#start, toM: this.#end };
  }

  /** The race at the end of the ride. */
  result(): GhostResult {
    return {
      label: this.label,
      gapS: this.#final ?? this.#lastGapS,
      complete: this.#final !== null,
      splits: [...this.#splits],
    };
  }

  update(input: GhostInput): GhostLive {
    const t = Number.isFinite(input.elapsedS) ? input.elapsedS : 0;
    const r = Number.isFinite(input.routeM) ? input.routeM : 0;
    if (input.state === 'idle' && !this.#started) {
      const x = this.#map(r, null);
      return this.#live('ready', {
        aheadM: x !== null ? 0 : null,
        note: x === null ? this.#joinNote(r) : null,
      });
    }
    this.#started = true;

    if (input.jumps !== this.#jumps) {
      this.#jumps = input.jumps;
      if (this.#final === null && this.#anchor) {
        this.#carryS = this.#lastGapS ?? 0;
        this.#lastShift = this.#anchor.r0 - this.#anchor.x0;
        this.#anchor = null;
        this.#prev = null;
      }
    }

    if (!this.#anchor) {
      const x = this.#map(r, this.#lastShift);
      if (x === null) {
        if (this.#final !== null) return this.#live('finished', { gapS: this.#final });
        if (this.#everAnchored) {
          return this.#live('stopped', {
            gapS: this.#lastGapS,
            note: `Ghost stopped: it never rode ${km(this.#routeKm(r))}`,
          });
        }
        return this.#live('waiting', { note: this.#joinNote(r) });
      }
      this.#anchor = { t0: t + this.#carryS, x0: x, r0: r };
      this.#everAnchored = true;
      this.#prev = { t, x };
      this.#nextSplit = this.#splitAt.findIndex((s) => s.atM > x + 1e-6);
      if (this.#nextSplit < 0) this.#nextSplit = this.#splitAt.length;
    }

    const a = this.#anchor;
    const x = a.x0 + (r - a.r0);
    const base = this.#timeAt(a.x0);
    const clock = (px: number): number => this.#timeAt(px) - base + a.t0;
    const prev = this.#prev;
    const cross = (at: number): number =>
      prev && x > prev.x ? prev.t + ((at - prev.x) / (x - prev.x)) * (t - prev.t) : t;

    while (this.#nextSplit < this.#splitAt.length) {
      const s = this.#splitAt[this.#nextSplit]!;
      if (s.atM > x || !prev || prev.x >= s.atM) break;
      const tc = cross(s.atM);
      this.#splits.push({ label: s.label, atM: s.atM, gapS: round1(clock(s.atM) - tc), atS: tc });
      this.#nextSplit++;
    }
    if (this.#final === null && x >= this.#end - 1e-6 && prev && prev.x < this.#end) {
      this.#final = clock(this.#end) - cross(this.#end);
    }
    this.#prev = { t, x };

    const ghostTime = t - a.t0 + base;
    const lastT = this.#t[this.#t.length - 1]!;
    const ghostDone = ghostTime >= lastT;
    const gx = this.#posAt(ghostTime);
    const gapS = this.#final ?? clock(Math.min(x, this.#end)) - t;
    if (this.#final === null) this.#lastGapS = gapS;
    return this.#live(this.#final !== null ? 'finished' : 'racing', {
      gapS,
      gapM: x - gx,
      aheadM: gx - x,
      speedMps: input.state === 'riding' && !ghostDone ? this.#speedAt(ghostTime) : 0,
      ghostDone,
    });
  }

  #live(status: GhostLive['status'], v: Partial<GhostLive>): GhostLive {
    return {
      status,
      label: this.label,
      gapM: v.gapM ?? null,
      gapS: v.gapS ?? null,
      aheadM: v.aheadM ?? null,
      speedMps: v.speedMps ?? 0,
      ghostDone: v.ghostDone ?? false,
      note: v.note ?? null,
      splits: [...this.#splits],
    };
  }

  /** The route place (0 … length) of route metres across laps, for messages. */
  #routeKm(r: number): number {
    const L = this.#shape.lengthM;
    return this.#shape.loop && L > 0 ? r - Math.floor(r / L) * L : r;
  }

  #joinNote(r: number): string {
    const L = this.#shape.lengthM;
    const from = this.#routeKm(this.#start);
    if (!this.#shape.loop && r >= this.#end) return 'The ghost never rode this far';
    return L > 0 ? `Ghost joins at ${km(from)}` : 'Ghost waits';
  }

  /**
   * The ghost's place for the rider's route position `r`, or null when its ride does not cover
   * it. On a loop the same place recurs every lap: with `shift` (after a jump) the one keeping
   * the lap alignment of the race so far, otherwise the first one covered.
   */
  #map(r: number, shift: number | null): number | null {
    const covered = (x: number): boolean => x >= this.#start - 1e-6 && x < this.#end - 1e-6;
    if (!this.#shape.loop) return covered(r) ? Math.max(r, this.#start) : null;
    const L = this.#shape.lengthM;
    if (!(L > 0)) return null;
    const base = shift === null ? r : r - shift;
    let best: number | null = null;
    const k0 = Math.ceil((this.#start - 1e-6 - base) / L);
    for (let k = k0; base + k * L < this.#end - 1e-6; k++) {
      const x = base + k * L;
      if (!covered(x)) continue;
      if (shift === null) return Math.max(x, this.#start);
      if (best === null || Math.abs(x - base) < Math.abs(best - base)) best = x;
    }
    return best === null ? null : Math.max(best, this.#start);
  }

  /** Ghost time at ghost place x (clamped to its ride). */
  #timeAt(x: number): number {
    const d = this.#d;
    const t = this.#t;
    if (x <= d[0]!) return t[0]!;
    if (x >= d[d.length - 1]!) return t[t.length - 1]!;
    let lo = 0;
    let hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid]! <= x) lo = mid;
      else hi = mid;
    }
    const f = (x - d[lo]!) / (d[hi]! - d[lo]!);
    return t[lo]! + f * (t[hi]! - t[lo]!);
  }

  /** Ghost place at ghost time (clamped to its ride). */
  #posAt(time: number): number {
    const d = this.#d;
    const t = this.#t;
    if (time <= t[0]!) return d[0]!;
    if (time >= t[t.length - 1]!) return d[d.length - 1]!;
    let lo = 0;
    let hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid]! <= time) lo = mid;
      else hi = mid;
    }
    const span = t[hi]! - t[lo]!;
    return span > 0 ? d[lo]! + ((time - t[lo]!) / span) * (d[hi]! - d[lo]!) : d[hi]!;
  }

  #speedAt(time: number): number {
    const t = this.#t;
    const d = this.#d;
    let i = 0;
    while (i < t.length - 2 && t[i + 1]! <= time) i++;
    const span = t[i + 1]! - t[i]!;
    return span > 0 ? (d[i + 1]! - d[i]!) / span : 0;
  }
}

/** Laps on a loop, quarters of a point-to-point route, within the ghost's ride. */
export function splitPoints(
  shape: GhostShape,
  fromM: number,
  toM: number,
): { atM: number; label: string }[] {
  const L = shape.lengthM;
  if (!(L > 0)) return [];
  const out: { atM: number; label: string }[] = [];
  if (shape.loop) {
    for (
      let k = Math.max(1, Math.floor(fromM / L) + 1);
      k * L <= toM + 1e-6 && out.length < 500;
      k++
    ) {
      out.push({ atM: k * L, label: `Lap ${k}` });
    }
    return out;
  }
  for (let q = 1; q <= 4; q++) {
    const at = (q * L) / 4;
    if (at > fromM + 1e-6 && at <= toM + 1e-6) {
      out.push({ atM: at, label: q === 4 ? 'Finish' : `km ${(at / 1000).toFixed(1)}` });
    }
  }
  return out;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ───────────── sources ─────────────

/** A ride of the history that can be raced on a route. */
export interface GhostCandidate {
  rideId: string;
  name: string;
  startedAt: number;
  fullTimeS: number | null;
  fromM: number;
  toM: number;
  continuous: boolean;
  /**
   * The conditions it was ridden in (docs/adr/0012-historical-wind.md): the key of the day's
   * wind and its label, or null for no wind.
   */
  conditions?: string | null;
  conditionsLabel?: string | null;
}

/** Finished rides of this route (routeBaseId) that can be ghosts, newest first. */
export function ghostCandidates(rides: readonly RideListItem[], routeId: string): GhostCandidate[] {
  return rides
    .filter((r) => r.finished && r.route?.id === routeId && r.route.ghost)
    .map((r) => ({
      rideId: r.id,
      name: r.name,
      startedAt: r.startedAt,
      fullTimeS: r.route!.fullTimeS,
      fromM: r.route!.fromM,
      toM: r.route!.toM,
      continuous: r.route!.continuous,
      conditions: r.route!.weather?.key ?? null,
      conditionsLabel: r.route!.weather?.label ?? null,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The fastest full ride of the route in the same conditions (ties: the newer one); null when
 * none was ridden fully. `conditions` is the wind's key or null for no wind: a ride with wind
 * is never the best time of rides without it, and the other way round.
 */
export function bestGhost(
  candidates: readonly GhostCandidate[],
  conditions: string | null = null,
): GhostCandidate | null {
  let best: GhostCandidate | null = null;
  for (const c of candidates) {
    if (c.fullTimeS === null || !(c.fullTimeS > 0)) continue;
    if ((c.conditions ?? null) !== conditions) continue;
    if (
      !best ||
      c.fullTimeS < best.fullTimeS! ||
      (c.fullTimeS === best.fullTimeS && c.startedAt > best.startedAt)
    ) {
      best = c;
    }
  }
  return best;
}

export type ResolvedGhost =
  { kind: 'best' | 'last' | 'ride'; ride: GhostCandidate } | { kind: 'none'; ride: null };

/**
 * Which ride a remembered choice means now: 'best' (else the last ride), 'last', a particular
 * ride (else the default), 'none'; without a remembered choice the best (else the last) one.
 */
export function resolveGhostChoice(
  choice: GhostChoice | undefined,
  candidates: readonly GhostCandidate[],
  enabled = true,
  conditions: string | null = null,
): ResolvedGhost {
  const none = { kind: 'none', ride: null } as const;
  if (!enabled || choice === 'none') return none;
  const best = bestGhost(candidates, conditions);
  const last = candidates[0] ?? null;
  const fallback = (): ResolvedGhost =>
    best ? { kind: 'best', ride: best } : last ? { kind: 'last', ride: last } : none;
  if (choice === 'last') return last ? { kind: 'last', ride: last } : none;
  if (choice?.startsWith('ride:')) {
    const id = choice.slice(5);
    const ride = candidates.find((c) => c.rideId === id);
    return ride ? { kind: 'ride', ride } : fallback();
  }
  return fallback();
}

// ───────────── words ─────────────

/** `24:13` / `1:02:09`. */
export function clockTime(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2 Nov` (this year) or `2 Nov 2025`. */
export function shortDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return y === new Date(now).getFullYear() ? day : `${day} ${y}`;
}

/** What a candidate shows in the picker: its time for the route, or the part it covers. */
export function candidateDetail(c: GhostCandidate, shape: GhostShape): string {
  if (c.fullTimeS !== null) return clockTime(c.fullTimeS);
  const L = shape.lengthM;
  const at = (m: number) => (shape.loop && L > 0 ? m - Math.floor(m / L) * L : m);
  const part = `${km(at(c.fromM))}–${km(at(c.toM) || c.toM)}`;
  return c.continuous ? `part · ${part}` : `jumped · ${part}`;
}

/**
 * " · with wind of 14 June 2025" / " · without wind" when a ride's conditions differ from the
 * current ride's (choosing such a ghost is allowed, but said); "" when they are the same.
 */
export function conditionsNote(c: GhostCandidate, conditions: string | null): string {
  if ((c.conditions ?? null) === conditions) return '';
  return c.conditions ? ` · with wind of ${c.conditionsLabel ?? 'another day'}` : ' · without wind';
}

/** The ghost's name in the race: "Best time · 24:13", "Last ride · 2 Nov · 25:40". */
export function ghostLabel(
  r: ResolvedGhost,
  shape: GhostShape,
  now = Date.now(),
  conditions: string | null = null,
): string {
  if (r.kind === 'none') return '';
  const detail = candidateDetail(r.ride, shape) + conditionsNote(r.ride, conditions);
  if (r.kind === 'best') return `Best time · ${detail}`;
  if (r.kind === 'last') return `Last ride · ${shortDate(r.ride.startedAt, now)} · ${detail}`;
  return `Ride of ${shortDate(r.ride.startedAt, now)} · ${detail}`;
}

/** Sign for a gap: + ahead, − (minus sign) behind. */
function signed(v: number, digits: number, unit: string): string {
  const r = Number(v.toFixed(digits));
  const s = Math.abs(r).toFixed(digits);
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${s} ${unit}`;
}

/** The gap chip: "+12 m · +2.1 s" (ahead) / "−8 m · −1.4 s" (behind). */
export function formatGhostGap(gapM: number | null, gapS: number | null): string {
  const parts: string[] = [];
  if (gapM !== null && Number.isFinite(gapM)) parts.push(signed(gapM, 0, 'm'));
  if (gapS !== null && Number.isFinite(gapS)) parts.push(signed(gapS, 1, 's'));
  return parts.join(' · ');
}

/** Ahead, behind or level (within 0.05 s) by the time gap. */
export function ghostTone(gapS: number | null): 'ahead' | 'behind' | 'even' {
  if (gapS === null || !Number.isFinite(gapS) || Math.abs(gapS) < 0.05) return 'even';
  return gapS > 0 ? 'ahead' : 'behind';
}

/** A split in words: "Lap 2 · +3.4 s". */
export function formatSplit(s: GhostSplit): string {
  return `${s.label} · ${signed(s.gapS, 1, 's')}`;
}

/** The summary line: "You beat your ghost by 12.4 s" / "Your ghost was 3.0 s faster". */
export function ghostVerdict(gapS: number | null): string | null {
  if (gapS === null || !Number.isFinite(gapS)) return null;
  const v = Math.abs(gapS).toFixed(1);
  if (Math.abs(gapS) < 0.05) return 'Dead heat with your ghost';
  return gapS > 0 ? `You beat your ghost by ${v} s` : `Your ghost was ${v} s faster`;
}
