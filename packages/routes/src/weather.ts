/**
 * The weather of one day along a route (docs/routes.md, "The weather of that day";
 * docs/adr/0012-historical-wind.md): which places and times to ask a historical weather archive
 * for (the Open-Meteo archive API, hourly values), reading its JSON answer, and the compact
 * route-relative wind profile kept next to the route — distance along the route → wind at
 * 10 m (speed and the direction it comes from), gusts, temperature, precipitation and the
 * weather code. At ride time the wind is reduced to the rider's height and projected onto the
 * direction of travel (`riderWind`); the physics feeds the head/tail component into the air
 * resistance.
 *
 * Pure: no DOM, no Node APIs; the request itself is made by the host (weatherFetch.ts).
 * Decoding validates everything (the stored file is untrusted input).
 */
import { clamp, utf8ByteLength } from './geo';
import { headingAt, pointAt } from './query';
import type { SceneryModel } from './scenery';
import { forEachBuildingIn, forEachStretchIn } from './scenery';
import { type RouteTimes, routeTimeAt } from './times';
import type { RouteTrack } from './types';

export const WEATHER_FORMAT = 'freilauf-weather';
export const WEATHER_FORMAT_VERSION = 1;
/** Required attribution wherever the data is shown (CC BY 4.0). */
export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com';
export const WEATHER_LICENCE = 'CC BY 4.0';
/** The public historical archive (free, no key): https://open-meteo.com/en/docs/historical-weather-api */
export const DEFAULT_WEATHER_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** Places along the route the weather is asked for: every this many metres … */
export const WEATHER_SPACING_M = 10_000;
/** … but at most this many per route (longer routes get a wider spacing). */
export const MAX_WEATHER_SAMPLES = 40;
/** Places are snapped to this grid (degrees) and asked for once per cell (~11 km). */
export const WEATHER_GRID_DEG = 0.1;
/** Places per request (the API takes comma-separated lists). */
export const WEATHER_LOCATIONS_PER_REQUEST = 10;
/** Without recorded times the ride is assumed to pass at this constant speed (25 km/h). */
export const ESTIMATED_SPEED_MPS = 25 / 3.6;
/** Default start time when the rider only picks a day. */
export const DEFAULT_WEATHER_START = '10:00';
/** Hourly variables asked for. */
export const WEATHER_HOURLY = [
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'temperature_2m',
  'precipitation',
  'weather_code',
] as const;
/** First day of the archive. */
export const WEATHER_FIRST_DAY = '1940-01-01';
/** The requested days may span at most this many (a bikepacking file is refused). */
export const MAX_WEATHER_DAYS = 16;
/** Encoded size limit of one route's wind profile (UTF-8 bytes). */
export const MAX_WEATHER_BYTES = 16 * 1024;

// ───────────── physics constants (docs/adr/0012-historical-wind.md) ─────────────

/**
 * 10 m wind → wind at a rider's height (~1.2 m), from the logarithmic wind profile
 * ln(1.2/z0)/ln(10/z0): open terrain (z0 ≈ 0.03 m) 0.63, so 0.65.
 */
export const RIDER_WIND_FACTOR_OPEN = 0.65;
/** Next to woods or houses (z0 ≈ 0.5 m and more): ln(2.4)/ln(20) ≈ 0.3; 0.4 kept. */
export const RIDER_WIND_FACTOR_SHELTERED = 0.4;
/** Woods, built-up land or houses within this of the road (m) shelter it. */
export const SHELTER_NEAR_M = 40;
/** The head/tail component at rider height is capped at ± this (m/s, 36 km/h). */
export const MAX_RIDER_WIND_MPS = 10;

// ───────────── model ─────────────

/** The wind and weather at one place along the route, at the time the ride passed there. */
export interface WindPoint {
  alongM: number;
  /** Mean wind at 10 m (m/s) and the direction it comes from (degrees, 0 = north, clockwise). */
  speedMps: number;
  fromDeg: number;
  gustMps: number;
  tempC: number;
  /** Precipitation of that hour (mm). */
  precipMm: number;
  /** WMO weather code (0 clear … 99 thunderstorm). */
  code: number;
}

export interface WindProfile {
  routeId: string;
  /** The route length the profile was built for (a check on load). */
  totalDistanceM: number;
  loop: boolean;
  /** When it was fetched (ms since 1970). */
  fetchedAt: number;
  attribution: string;
  /** 'recorded': the times of the recorded ride (GPX); 'chosen': a day picked by the rider. */
  when: 'recorded' | 'chosen';
  /** The ride the weather belongs to (ms, UTC). */
  startMs: number;
  endMs: number;
  /** Offset of local time at the route (s), as the weather server reported it. */
  utcOffsetS: number;
  /** Sorted by alongM; at least one. */
  points: WindPoint[];
}

/** When the weather is wanted: the recorded ride's times, or a day and start time. */
export type WeatherWhen =
  | { kind: 'recorded'; times: RouteTimes }
  /** `date` YYYY-MM-DD and `time` HH:MM, local time at the route. */
  | { kind: 'chosen'; date: string; time: string };

/** One place and time along the route. */
export interface WeatherSample {
  alongM: number;
  lat: number;
  lon: number;
  /** Recorded: ms UTC. Chosen: local wall-clock time at the route as if it were UTC. */
  t: number;
}

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{2}):(\d{2})$/;

/** Wall-clock ms of a YYYY-MM-DD + HH:MM, or null. */
export function wallClockMs(date: string, time: string): number | null {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) return null;
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, mi] = [Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, da, h, mi);
  const back = new Date(ms);
  return back.getUTCDate() === da ? ms : null; // 31 April is no day
}

/** YYYY-MM-DD of a ms value read in UTC. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The places and times to ask for: start, every WEATHER_SPACING_M (or wider), finish. */
export function weatherSamples(track: RouteTrack, when: WeatherWhen): WeatherSample[] {
  const total = track.totalDistanceM;
  const spacing = Math.max(WEATHER_SPACING_M, total / (MAX_WEATHER_SAMPLES - 2));
  const at: number[] = [];
  for (let d = 0; d < total - spacing / 4 && at.length < MAX_WEATHER_SAMPLES - 1; d += spacing)
    at.push(d);
  at.push(total);
  let start = 0;
  if (when.kind === 'chosen') start = wallClockMs(when.date, when.time) ?? Number.NaN;
  return at.map((alongM) => {
    const p = pointAt(track, alongM);
    const t =
      when.kind === 'recorded'
        ? routeTimeAt(when.times, alongM)
        : start + (alongM / ESTIMATED_SPEED_MPS) * 1000;
    return { alongM, lat: p.lat, lon: p.lon, t };
  });
}

export interface WeatherLocation {
  lat: number;
  lon: number;
}

const snap = (v: number): number =>
  Math.round(Math.round(v / WEATHER_GRID_DEG) * WEATHER_GRID_DEG * 100) / 100;

/**
 * The samples' places snapped to the grid and deduplicated: `locations` to ask for and, per
 * sample, the index of its location. The server only learns these grid cells (~11 km).
 */
export function weatherLocations(samples: readonly WeatherSample[]): {
  locations: WeatherLocation[];
  index: number[];
} {
  const locations: WeatherLocation[] = [];
  const byKey = new Map<string, number>();
  const index = samples.map((s) => {
    const lat = snap(s.lat);
    const lon = snap(s.lon);
    const key = `${lat},${lon}`;
    let i = byKey.get(key);
    if (i === undefined) {
      i = locations.length;
      locations.push({ lat, lon });
      byKey.set(key, i);
    }
    return i;
  });
  return { locations, index };
}

/** The archive request's query string (without the leading "?"). */
export function weatherQuery(
  locations: readonly WeatherLocation[],
  startDate: string,
  endDate: string,
): string {
  const n = (v: number): string => String(Math.round(v * 100) / 100);
  return [
    `latitude=${locations.map((l) => n(l.lat)).join(',')}`,
    `longitude=${locations.map((l) => n(l.lon)).join(',')}`,
    `start_date=${startDate}`,
    `end_date=${endDate}`,
    `hourly=${WEATHER_HOURLY.join(',')}`,
    'wind_speed_unit=ms',
    'timezone=auto',
    'timeformat=unixtime',
  ].join('&');
}

export type WeatherPlanResult =
  | {
      ok: true;
      samples: WeatherSample[];
      locations: WeatherLocation[];
      index: number[];
      /** One query per batch of locations, in order. */
      queries: string[];
      batches: number[][];
    }
  | { ok: false; error: string };

/**
 * Everything to ask for: the samples, their locations in batches and a query per batch.
 * Refuses days in the future, before the archive, or spanning more than MAX_WEATHER_DAYS.
 */
export function planWeather(
  track: RouteTrack,
  when: WeatherWhen,
  now = Date.now(),
): WeatherPlanResult {
  if (when.kind === 'chosen' && wallClockMs(when.date, when.time) === null)
    return { ok: false, error: 'Choose a day and a start time.' };
  const samples = weatherSamples(track, when);
  if (samples.some((s) => !Number.isFinite(s.t)))
    return { ok: false, error: 'The ride has no usable time.' };
  const first = Math.min(...samples.map((s) => s.t));
  const last = Math.max(...samples.map((s) => s.t));
  if (isoDay(first) < WEATHER_FIRST_DAY)
    return { ok: false, error: 'The weather archive starts in 1940.' };
  // A wall-clock time can be up to 14 h ahead of UTC.
  if (first > now - (when.kind === 'chosen' ? -14 * 3600_000 : 0))
    return { ok: false, error: 'That day is in the future: there is no weather of it yet.' };
  const startDate =
    isoDay(first - DAY_MS) < WEATHER_FIRST_DAY ? WEATHER_FIRST_DAY : isoDay(first - DAY_MS);
  const today = isoDay(now);
  const endDay = isoDay(last + DAY_MS);
  const endDate = endDay > today ? today : endDay;
  const days = Math.round((Date.parse(endDate) - Date.parse(startDate)) / DAY_MS) + 1;
  if (days > MAX_WEATHER_DAYS)
    return { ok: false, error: `The ride spans more than ${MAX_WEATHER_DAYS - 2} days.` };
  const { locations, index } = weatherLocations(samples);
  const batches: number[][] = [];
  for (let i = 0; i < locations.length; i += WEATHER_LOCATIONS_PER_REQUEST) {
    batches.push(locations.slice(i, i + WEATHER_LOCATIONS_PER_REQUEST).map((_, k) => i + k));
  }
  const queries = batches.map((b) =>
    weatherQuery(
      b.map((i) => locations[i]!),
      startDate,
      endDate,
    ),
  );
  return { ok: true, samples, locations, index, queries, batches };
}

// ───────────── the answer ─────────────

/** Hourly series of one location, as the archive returned it. */
export interface WeatherSeries {
  utcOffsetS: number;
  /** Hour starts (s since 1970, UTC). */
  timeS: number[];
  windSpeedMps: (number | null)[];
  windFromDeg: (number | null)[];
  gustMps: (number | null)[];
  tempC: (number | null)[];
  precipMm: (number | null)[];
  code: (number | null)[];
}

export type WeatherParseResult =
  { ok: true; series: WeatherSeries[] } | { ok: false; error: string; retry: boolean };

/** Hours per location read at most (MAX_WEATHER_DAYS of hourly values). */
const MAX_HOURS = MAX_WEATHER_DAYS * 24 + 48;

function numbers(v: unknown, n: number, lo: number, hi: number): (number | null)[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  return v.map((x) =>
    typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null,
  );
}

/**
 * Reads an archive answer: one object, or a list of them for several locations (in the order
 * asked). Missing values (`null`) are kept as null. Never throws.
 */
export function parseWeatherJson(text: string, expected: number): WeatherParseResult {
  const bad = (error = 'The answer was not weather data.'): WeatherParseResult => ({
    ok: false,
    error,
    retry: false,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad();
  }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.error === true) {
      const reason = typeof r.reason === 'string' ? r.reason.slice(0, 160) : 'unknown reason';
      return bad(`The weather server refused the request (${reason}).`);
    }
  }
  const list = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  if (list.length !== expected) return bad('The weather server answered for other places.');
  const series: WeatherSeries[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) return bad();
    const o = item as Record<string, unknown>;
    const hourly = o.hourly as Record<string, unknown> | undefined;
    if (typeof hourly !== 'object' || hourly === null || !Array.isArray(hourly.time)) return bad();
    const time = hourly.time as unknown[];
    if (time.length === 0 || time.length > MAX_HOURS) return bad();
    if (!time.every((t) => typeof t === 'number' && Number.isFinite(t))) return bad();
    const n = time.length;
    const speed = numbers(hourly.wind_speed_10m, n, 0, 120);
    const dir = numbers(hourly.wind_direction_10m, n, 0, 360);
    const gust = numbers(hourly.wind_gusts_10m, n, 0, 150);
    const temp = numbers(hourly.temperature_2m, n, -90, 60);
    const precip = numbers(hourly.precipitation, n, 0, 500);
    const code = numbers(hourly.weather_code, n, 0, 99);
    if (!speed || !dir) return bad();
    const offset = o.utc_offset_seconds;
    series.push({
      utcOffsetS:
        typeof offset === 'number' && Number.isFinite(offset) && Math.abs(offset) <= 14 * 3600
          ? offset
          : 0,
      timeS: time as number[],
      windSpeedMps: speed,
      windFromDeg: dir,
      gustMps: gust ?? new Array<number | null>(n).fill(null),
      tempC: temp ?? new Array<number | null>(n).fill(null),
      precipMm: precip ?? new Array<number | null>(n).fill(null),
      code: code ?? new Array<number | null>(n).fill(null),
    });
  }
  return { ok: true, series };
}

/** The value of an hourly list at a fractional hour index, nulls bridged by the neighbour. */
function lerpAt(list: readonly (number | null)[], i: number, f: number): number | null {
  const a = list[i] ?? null;
  const b = list[i + 1] ?? null;
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

/** Weather of one series at time `utcMs` (interpolated between the hours). */
export function weatherAt(s: WeatherSeries, utcMs: number): Omit<WindPoint, 'alongM'> | null {
  const ts = utcMs / 1000;
  const n = s.timeS.length;
  let i = 0;
  while (i < n - 2 && s.timeS[i + 1]! <= ts) i++;
  const t0 = s.timeS[i]!;
  const t1 = s.timeS[Math.min(n - 1, i + 1)]!;
  // More than an hour beyond the series: not this day.
  if (ts < t0 - 3600 || ts > s.timeS[n - 1]! + 3600) return null;
  const f = t1 > t0 ? clamp((ts - t0) / (t1 - t0), 0, 1) : 0;
  // Wind as a vector, so 350° and 10° average to north.
  const vec = (k: number): [number, number] | null => {
    const sp = s.windSpeedMps[k] ?? null;
    const d = s.windFromDeg[k] ?? null;
    if (sp === null || d === null) return null;
    const r = (d * Math.PI) / 180;
    return [sp * Math.sin(r), sp * Math.cos(r)];
  };
  const a = vec(i);
  const b = n > 1 ? vec(Math.min(n - 1, i + 1)) : a;
  const w: [number, number] | null =
    a && b ? [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] : (a ?? b);
  if (!w) return null;
  const sa = s.windSpeedMps[i] ?? null;
  const sb = s.windSpeedMps[Math.min(n - 1, i + 1)] ?? null;
  // Speed itself interpolated linearly (the vector mean shrinks when the direction swings).
  const speed =
    sa !== null && sb !== null ? sa + (sb - sa) * f : (sa ?? sb ?? Math.hypot(w[0], w[1]));
  let from = (Math.atan2(w[0], w[1]) * 180) / Math.PI;
  if (from < 0) from += 360;
  // Precipitation is the sum of the hour before each time stamp: the hour that ends after ts.
  const pi = f > 0 ? Math.min(n - 1, i + 1) : i;
  const nearest = f < 0.5 ? i : Math.min(n - 1, i + 1);
  return {
    speedMps: speed,
    fromDeg: from,
    gustMps: Math.max(speed, lerpAt(s.gustMps, i, f) ?? speed),
    tempC: lerpAt(s.tempC, i, f) ?? Number.NaN,
    precipMm: s.precipMm[pi] ?? s.precipMm[i] ?? 0,
    code: s.code[nearest] ?? s.code[i] ?? -1,
  };
}

export type BuildWindResult = { ok: true; profile: WindProfile } | { ok: false; error: string };

/** The profile from the samples and the series of their locations (in location order). */
export function buildWindProfile(
  track: RouteTrack,
  when: WeatherWhen,
  samples: readonly WeatherSample[],
  index: readonly number[],
  series: readonly WeatherSeries[],
  fetchedAt: number,
): BuildWindResult {
  const points: WindPoint[] = [];
  let offset = 0;
  const utcOf = (s: WeatherSample, ser: WeatherSeries): number =>
    when.kind === 'recorded' ? s.t : s.t - ser.utcOffsetS * 1000;
  for (let k = 0; k < samples.length; k++) {
    const s = samples[k]!;
    const ser = series[index[k]!];
    if (!ser) continue;
    if (k === 0) offset = ser.utcOffsetS;
    const w = weatherAt(ser, utcOf(s, ser));
    if (!w) continue;
    points.push({ alongM: s.alongM, ...w });
  }
  if (points.length === 0) {
    return {
      ok: false,
      error:
        'The weather archive has no data for that day yet (it lags a few days behind). Try an earlier day.',
    };
  }
  // Temperature gaps: from the nearest point that has one.
  for (const p of points) {
    if (Number.isFinite(p.tempC)) continue;
    const near = points
      .filter((q) => Number.isFinite(q.tempC))
      .sort((a, b) => Math.abs(a.alongM - p.alongM) - Math.abs(b.alongM - p.alongM))[0];
    p.tempC = near ? near.tempC : 15;
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const firstSeries = series[index[0]!];
  const startMs = firstSeries ? utcOf(first, firstSeries) : first.t;
  const lastSeries = series[index[samples.length - 1]!];
  const endMs = lastSeries ? utcOf(last, lastSeries) : last.t;
  return {
    ok: true,
    profile: {
      routeId: track.id,
      totalDistanceM: track.totalDistanceM,
      loop: track.loop,
      fetchedAt,
      attribution: WEATHER_ATTRIBUTION,
      when: when.kind,
      startMs,
      endMs: Math.max(startMs, endMs),
      utcOffsetS: offset,
      points,
    },
  };
}

// ───────────── codec ─────────────

/** Compact JSON: one integer tuple per point (m, dm/s, °, dm/s, 0.1 °C, 0.1 mm, code). */
export function encodeWindProfile(p: WindProfile): string {
  return JSON.stringify({
    format: WEATHER_FORMAT,
    version: WEATHER_FORMAT_VERSION,
    routeId: p.routeId,
    totalDistanceM: Math.round(p.totalDistanceM * 10) / 10,
    loop: p.loop,
    fetchedAt: Math.round(p.fetchedAt),
    attribution: WEATHER_ATTRIBUTION,
    when: p.when,
    startMs: Math.round(p.startMs),
    endMs: Math.round(p.endMs),
    utcOffsetS: Math.round(p.utcOffsetS),
    p: p.points.map((q) => [
      Math.round(q.alongM),
      Math.round(q.speedMps * 10),
      Math.round(q.fromDeg) % 360,
      Math.round(q.gustMps * 10),
      Math.round(q.tempC * 10),
      Math.round(q.precipMm * 10),
      Math.round(q.code),
    ]),
  });
}

export type DecodeWindResult = { ok: true; profile: WindProfile } | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validates and decodes a stored profile; never throws. */
export function decodeWindProfile(text: unknown): DecodeWindResult {
  const fail = (error: string): DecodeWindResult => ({ ok: false, error });
  if (typeof text !== 'string') return fail('not text');
  if (utf8ByteLength(text) > MAX_WEATHER_BYTES) return fail('too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not an object');
  const r = raw as Record<string, unknown>;
  if (r.format !== WEATHER_FORMAT) return fail('not a weather file');
  if (r.version !== WEATHER_FORMAT_VERSION) return fail(`unsupported version ${String(r.version)}`);
  if (typeof r.routeId !== 'string' || !ID.test(r.routeId)) return fail('bad route id');
  const total = r.totalDistanceM;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || total > 1e6)
    return fail('bad route length');
  if (r.when !== 'recorded' && r.when !== 'chosen') return fail('bad time');
  const { startMs, endMs, utcOffsetS, fetchedAt } = r;
  if (!isInt(startMs) || !isInt(endMs) || endMs < startMs || endMs - startMs > 20 * DAY_MS)
    return fail('bad time');
  if (!isInt(utcOffsetS) || Math.abs(utcOffsetS) > 14 * 3600) return fail('bad time');
  if (!Array.isArray(r.p) || r.p.length === 0 || r.p.length > MAX_WEATHER_SAMPLES + 2)
    return fail('bad points');
  const points: WindPoint[] = [];
  for (const t of r.p as unknown[]) {
    if (!Array.isArray(t) || t.length !== 7 || !t.every(isInt)) return fail('bad point');
    const [a, sp, dir, gust, temp, precip, code] = t as number[];
    if (
      a! < 0 ||
      a! > total + 1 ||
      sp! < 0 ||
      sp! > 1200 ||
      dir! < 0 ||
      dir! >= 360 ||
      gust! < 0 ||
      gust! > 1500 ||
      temp! < -900 ||
      temp! > 600 ||
      precip! < 0 ||
      precip! > 5000 ||
      code! < -1 ||
      code! > 99
    )
      return fail('bad point');
    points.push({
      alongM: a!,
      speedMps: sp! / 10,
      fromDeg: dir!,
      gustMps: gust! / 10,
      tempC: temp! / 10,
      precipMm: precip! / 10,
      code: code!,
    });
  }
  points.sort((x, y) => x.alongM - y.alongM);
  return {
    ok: true,
    profile: {
      routeId: r.routeId,
      totalDistanceM: total,
      loop: r.loop === true,
      fetchedAt: typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : 0,
      attribution: WEATHER_ATTRIBUTION,
      when: r.when,
      startMs,
      endMs,
      utcOffsetS,
      points,
    },
  };
}

// ───────────── at ride time ─────────────

/** The weather at route distance `alongM` (wrapped on a loop), interpolated between points. */
export function windAt(p: WindProfile, alongM: number): Omit<WindPoint, 'alongM'> {
  const pts = p.points;
  const L = p.totalDistanceM;
  let d = Number.isFinite(alongM) ? alongM : 0;
  if (p.loop && L > 0) d -= Math.floor(d / L) * L;
  else d = clamp(d, 0, L);
  const { alongM: _a, ...first } = pts[0]!;
  if (pts.length === 1 || d <= pts[0]!.alongM) return first;
  const lastPt = pts[pts.length - 1]!;
  if (d >= lastPt.alongM) {
    const { alongM: _b, ...last } = lastPt;
    return last;
  }
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1]!.alongM <= d) i++;
  const a = pts[i]!;
  const b = pts[i + 1]!;
  const f = b.alongM > a.alongM ? (d - a.alongM) / (b.alongM - a.alongM) : 0;
  const ra = (a.fromDeg * Math.PI) / 180;
  const rb = (b.fromDeg * Math.PI) / 180;
  const x = a.speedMps * Math.sin(ra) * (1 - f) + b.speedMps * Math.sin(rb) * f;
  const y = a.speedMps * Math.cos(ra) * (1 - f) + b.speedMps * Math.cos(rb) * f;
  let from = (Math.atan2(x, y) * 180) / Math.PI;
  if (from < 0) from += 360;
  const lerp = (u: number, v: number): number => u + (v - u) * f;
  return {
    speedMps: lerp(a.speedMps, b.speedMps),
    fromDeg: Math.hypot(x, y) > 1e-6 ? from : a.fromDeg,
    gustMps: lerp(a.gustMps, b.gustMps),
    tempC: lerp(a.tempC, b.tempC),
    precipMm: f < 0.5 ? a.precipMm : b.precipMm,
    code: f < 0.5 ? a.code : b.code,
  };
}

/**
 * Head/tail and cross component of a wind of `speedMps` coming from `fromDeg` for a rider
 * heading `headingRad` (0 = north, clockwise): `headMps` > 0 headwind, < 0 tailwind;
 * `crossMps` > 0 from the right, < 0 from the left.
 */
export function windComponents(
  speedMps: number,
  fromDeg: number,
  headingRad: number,
): { headMps: number; crossMps: number } {
  const rel = (fromDeg * Math.PI) / 180 - headingRad;
  return { headMps: speedMps * Math.cos(rel), crossMps: speedMps * Math.sin(rel) };
}

/**
 * How sheltered the road is at `alongM` (0 open … 1 sheltered on both sides): woods or
 * built-up land within SHELTER_NEAR_M of the road on a side, or a building that close within
 * 50 m along the road. From the stored surroundings (scenery.ts); 0 without them.
 */
export function shelterAt(m: SceneryModel | null | undefined, alongM: number): number {
  if (!m) return 0;
  const sides = { left: false, right: false };
  const mark = (side: number): void => {
    if (side < 0) sides.left = true;
    else sides.right = true;
  };
  forEachStretchIn(m.ground, m, alongM, alongM, (s, shift) => {
    if (s.fromM + shift > alongM || s.toM + shift < alongM) return;
    if ((s.kind === 'forest' || s.kind === 'residential') && s.nearM <= SHELTER_NEAR_M)
      mark(s.side);
  });
  if (!(sides.left && sides.right)) {
    forEachBuildingIn(m, alongM - 50, alongM + 50, (b) => {
      if (Math.abs(b.offsetM) - b.depthM / 2 <= SHELTER_NEAR_M) mark(Math.sign(b.offsetM) || 1);
    });
  }
  return (sides.left ? 0.5 : 0) + (sides.right ? 0.5 : 0);
}

/** The 10 m → rider height factor for a shelter of 0 … 1. */
export function riderWindFactor(shelter: number): number {
  const s = clamp(Number.isFinite(shelter) ? shelter : 0, 0, 1);
  return RIDER_WIND_FACTOR_OPEN + (RIDER_WIND_FACTOR_SHELTERED - RIDER_WIND_FACTOR_OPEN) * s;
}

/** What the rider feels at a place: the wind at rider height, split along the road. */
export interface RiderWind {
  /** Head (+) / tail (−) component at rider height, capped at ± MAX_RIDER_WIND_MPS (m/s). */
  headMps: number;
  /** Cross component at rider height (+ from the right), not used by the physics (m/s). */
  crossMps: number;
  /** Wind at 10 m and where it comes from (as reported). */
  speed10Mps: number;
  fromDeg: number;
  /** Where it comes from relative to the direction of travel (degrees, 0 = straight ahead, + right). */
  relativeDeg: number;
  factor: number;
  gustMps: number;
  tempC: number;
  precipMm: number;
  code: number;
}

/** The wind the rider feels at route distance `alongM`. */
export function riderWind(
  profile: WindProfile,
  track: RouteTrack,
  alongM: number,
  scenery?: SceneryModel | null,
): RiderWind {
  const w = windAt(profile, alongM);
  const L = track.totalDistanceM;
  const d = track.loop && L > 0 ? alongM - Math.floor(alongM / L) * L : clamp(alongM, 0, L);
  const heading = headingAt(track, d);
  const factor = riderWindFactor(shelterAt(scenery, d));
  const c = windComponents(w.speedMps * factor, w.fromDeg, heading);
  let rel = w.fromDeg - (heading * 180) / Math.PI;
  rel -= Math.round(rel / 360) * 360;
  return {
    headMps: clamp(c.headMps, -MAX_RIDER_WIND_MPS, MAX_RIDER_WIND_MPS),
    crossMps: c.crossMps,
    speed10Mps: w.speedMps,
    fromDeg: w.fromDeg,
    relativeDeg: rel,
    factor,
    gustMps: w.gustMps,
    tempC: w.tempC,
    precipMm: w.precipMm,
    code: w.code,
  };
}

// ───────────── words ─────────────

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Local time at the route of a UTC instant, as a Date read with the UTC getters. */
const local = (ms: number, offsetS: number): Date => new Date(ms + offsetS * 1000);
const hhmm = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
const dayText = (d: Date): string =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** "14 June 2025" in local time at the route. */
export function weatherDayLabel(p: Pick<WindProfile, 'startMs' | 'utcOffsetS'>): string {
  return dayText(local(p.startMs, p.utcOffsetS));
}

/** "14 June 2025, 09:12–13:40" (or "… 19:36 – 3 May 2026, 01:14" across midnight). */
export function formatWeatherSpan(startMs: number, endMs: number, utcOffsetS: number): string {
  const a = local(startMs, utcOffsetS);
  const b = local(Math.max(startMs, endMs), utcOffsetS);
  if (isoDay(a.getTime()) === isoDay(b.getTime())) return `${dayText(a)}, ${hhmm(a)}–${hhmm(b)}`;
  return `${dayText(a)}, ${hhmm(a)} – ${dayText(b)}, ${hhmm(b)}`;
}

/**
 * What a ride with this wind is compared by (best times and ghosts only compare rides with the
 * same conditions): the local start of the weather's ride, "2025-06-14T09:12".
 */
export function windConditionsKey(p: Pick<WindProfile, 'startMs' | 'utcOffsetS'>): string {
  return local(p.startMs, p.utcOffsetS).toISOString().slice(0, 16);
}

/** Short words for a WMO weather code ("" when unknown). */
export function conditionsText(code: number): string {
  if (code === 0) return 'Clear';
  if (code === 1) return 'Mostly clear';
  if (code === 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code === 45 || code === 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code === 85 || code === 86) return 'Snow showers';
  if (code >= 95) return 'Thunderstorm';
  return '';
}

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];

/** "south-west" for a direction the wind comes from. */
export function compassWord(fromDeg: number): string {
  const i = Math.round((((fromDeg % 360) + 360) % 360) / 45) % 8;
  return COMPASS[i]!;
}

/** What Details shows about a stored profile. */
export interface WeatherSummary {
  /** "14 June 2025, 09:12–13:40" */
  span: string;
  when: WindProfile['when'];
  /** Mean and strongest wind at 10 m (m/s), its main direction. */
  meanMps: number;
  maxMps: number;
  mainFromDeg: number;
  minTempC: number;
  maxTempC: number;
  /** Total precipitation over the points' hours (mm, a rough sum). */
  wet: boolean;
  conditions: string;
  places: number;
}

export function summarizeWind(p: WindProfile): WeatherSummary {
  let x = 0;
  let y = 0;
  let sum = 0;
  let max = 0;
  let tmin = Infinity;
  let tmax = -Infinity;
  let wet = false;
  const counts = new Map<string, number>();
  for (const q of p.points) {
    const r = (q.fromDeg * Math.PI) / 180;
    x += q.speedMps * Math.sin(r);
    y += q.speedMps * Math.cos(r);
    sum += q.speedMps;
    max = Math.max(max, q.speedMps);
    tmin = Math.min(tmin, q.tempC);
    tmax = Math.max(tmax, q.tempC);
    if (q.precipMm >= 0.1) wet = true;
    const c = conditionsText(q.code);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let main = (Math.atan2(x, y) * 180) / Math.PI;
  if (main < 0) main += 360;
  const conditions = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return {
    span: formatWeatherSpan(p.startMs, p.endMs, p.utcOffsetS),
    when: p.when,
    meanMps: sum / p.points.length,
    maxMps: max,
    mainFromDeg: main,
    minTempC: tmin,
    maxTempC: tmax,
    wet,
    conditions,
    places: p.points.length,
  };
}
