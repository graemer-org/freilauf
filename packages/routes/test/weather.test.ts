/**
 * The weather of a day along a route (src/times.ts, src/weather.ts, src/weatherFetch.ts):
 * recorded times from GPX, sampling and the grid, the archive request and its answer (with
 * synthetic JSON in the documented format: the live server was not reachable while this was
 * written), the stored profile, and the wind the rider feels.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  RouteTrack,
  SceneryModel,
  WeatherSeries,
  WeatherWhen,
  WindProfile,
} from '../src/index';
import {
  CancelSource,
  MAX_RIDER_WIND_MPS,
  MAX_WEATHER_SAMPLES,
  RIDER_WIND_FACTOR_OPEN,
  RIDER_WIND_FACTOR_SHELTERED,
  WEATHER_ATTRIBUTION,
  buildRoute,
  buildWindProfile,
  compassWord,
  conditionsText,
  decodeWindProfile,
  emptyScenery,
  encodeWindProfile,
  fetchWeather,
  formatWeatherSpan,
  parseGpx,
  parseWeatherJson,
  planWeather,
  prepareRoute,
  riderWind,
  riderWindFactor,
  routeTimeAt,
  routeTimesSpan,
  shelterAt,
  summarizeWind,
  unproject,
  wallClockMs,
  weatherAt,
  weatherLocations,
  weatherQuery,
  weatherSamples,
  windAt,
  windComponents,
  windConditionsKey,
} from '../src/index';

const ISAR = path.resolve(import.meta.dirname, '..', 'fixtures', 'isar-ursprung.gpx');
const ORIGIN = { lat0: 47.5, lon0: 11.4 };

/** GPX of points (x, y in m around ORIGIN) with optional times (ms). */
function gpx(points: { x: number; y: number; t?: number }[], timeText?: (t: number) => string) {
  const pts = points
    .map((p) => {
      const ll = unproject(ORIGIN, p.x, p.y);
      const time =
        p.t !== undefined
          ? `<time>${timeText ? timeText(p.t) : new Date(p.t).toISOString()}</time>`
          : '';
      return `<trkpt lat="${ll.lat.toFixed(7)}" lon="${ll.lon.toFixed(7)}"><ele>500</ele>${time}</trkpt>`;
    })
    .join('');
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>T</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

function prepare(text: string) {
  const parsed = parseGpx(text);
  if (!parsed.ok) throw new Error(parsed.errors.join(' '));
  const r = prepareRoute(parsed.track);
  if (!r.ok) throw new Error(r.errors.join(' '));
  return r;
}

/** A straight road north of `km` km, with points every 100 m. */
function northRoad(km: number, t0?: number, speedMps = 7): RouteTrack {
  const n = Math.round(km * 10);
  return prepare(
    gpx(
      Array.from({ length: n + 1 }, (_, i) => ({
        x: 0,
        y: i * 100,
        ...(t0 !== undefined ? { t: t0 + ((i * 100) / speedMps) * 1000 } : {}),
      })),
    ),
  ).track;
}

/** 5 km north and the same road back south. */
function outAndBack(): RouteTrack {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 50; i++) pts.push({ x: 0, y: i * 100 });
  for (let i = 49; i >= 0; i--) pts.push({ x: 2, y: i * 100 });
  const parsed = parseGpx(gpx(pts));
  if (!parsed.ok) throw new Error('bad');
  return buildRoute(parsed.track);
}

/** One location's hourly series (UTC hours from `fromMs`), all values from `f(hour)`. */
function series(
  fromMs: number,
  hours: number,
  f: (h: number) => Partial<Record<'s' | 'd' | 'g' | 't' | 'p' | 'c', number | null>>,
  offsetS = 7200,
) {
  const time: number[] = [];
  const cols = { s: [], d: [], g: [], t: [], p: [], c: [] } as Record<string, (number | null)[]>;
  for (let h = 0; h < hours; h++) {
    time.push(fromMs / 1000 + h * 3600);
    const v = f(h);
    cols.s!.push(v.s === undefined ? 5 : v.s);
    cols.d!.push(v.d === undefined ? 270 : v.d);
    cols.g!.push(v.g === undefined ? 9 : v.g);
    cols.t!.push(v.t === undefined ? 15 : v.t);
    cols.p!.push(v.p === undefined ? 0 : v.p);
    cols.c!.push(v.c === undefined ? 2 : v.c);
  }
  return {
    latitude: 47.5,
    longitude: 11.4,
    utc_offset_seconds: offsetS,
    timezone: 'Europe/Berlin',
    hourly_units: { time: 'unixtime', wind_speed_10m: 'm/s' },
    hourly: {
      time,
      wind_speed_10m: cols.s,
      wind_direction_10m: cols.d,
      wind_gusts_10m: cols.g,
      temperature_2m: cols.t,
      precipitation: cols.p,
      weather_code: cols.c,
    },
  };
}

const JUNE_14 = Date.UTC(2025, 5, 14);
const NOW = Date.UTC(2026, 10, 28, 12);

describe('recorded times from GPX', () => {
  it('reads the times of the Isar fixture and keeps a compact profile', () => {
    const r = prepare(readFileSync(ISAR, 'utf8'));
    expect(r.times).toBeDefined();
    const t = r.times!;
    expect(t.startMs).toBe(Date.parse('2026-05-02T19:36:32.298Z'));
    const span = routeTimesSpan(t);
    expect(span.endMs - Date.parse('2026-05-03T01:14:47.240Z')).toBeLessThan(2000);
    expect(t.offsetsS.length).toBeLessThanOrEqual(200);
    // Times run forward along the route.
    let prev = -Infinity;
    for (let d = 0; d <= r.track.totalDistanceM; d += 1000) {
      const at = routeTimeAt(t, d);
      expect(at).toBeGreaterThanOrEqual(prev);
      prev = at;
    }
    expect(routeTimeAt(t, r.track.totalDistanceM)).toBe(span.endMs);
  });

  it('interpolates by distance, accepts offsets and zone-less times, ignores unreadable ones', () => {
    const t0 = Date.UTC(2025, 5, 14, 7, 12);
    // 10 km at 5 m/s: 2000 s.
    const road = Array.from({ length: 101 }, (_, i) => ({ x: 0, y: i * 100, t: t0 + i * 20_000 }));
    const plain = prepare(gpx(road)).times!;
    expect(routeTimeAt(plain, 5000) - t0).toBeCloseTo(1000_000, -3);
    // "+02:00", "+0200" and no zone (= UTC) mean the same instants.
    const local = (t: number) => new Date(t + 7200_000).toISOString().replace('Z', '+02:00');
    const compact = (t: number) => new Date(t + 7200_000).toISOString().replace('Z', '+0200');
    const bare = (t: number) => new Date(t).toISOString().slice(0, 19);
    for (const fmt of [local, compact, bare]) {
      const times = prepare(gpx(road, fmt)).times!;
      expect(Math.abs(times.startMs - t0)).toBeLessThan(1000);
    }
    expect(prepare(gpx(road, () => 'yesterday')).times).toBeUndefined();
  });

  it('has no times without <time>, or with too few of them', () => {
    expect(
      prepare(
        gpx([
          { x: 0, y: 0 },
          { x: 0, y: 2000 },
        ]),
      ).times,
    ).toBeUndefined();
    const few = Array.from({ length: 21 }, (_, i) => ({
      x: 0,
      y: i * 100,
      ...(i < 3 ? { t: JUNE_14 + i * 20_000 } : {}),
    }));
    expect(prepare(gpx(few)).times).toBeUndefined();
  });
});

describe('places and times to ask for', () => {
  it('samples every 10 km with the recorded passage time', () => {
    const t0 = Date.UTC(2025, 5, 14, 7);
    const track = northRoad(35, t0, 7);
    const r = prepare(
      gpx([
        { x: 0, y: 0, t: t0 },
        { x: 0, y: 35_000, t: t0 + 5000_000 },
      ]),
    );
    const samples = weatherSamples(track, { kind: 'recorded', times: r.times! });
    expect(samples.map((s) => Math.round(s.alongM / 1000))).toEqual([0, 10, 20, 30, 35]);
    expect(samples[1]!.t - t0).toBeCloseTo((10_000 / 35_000) * 5000_000, -4);
  });

  it('estimates the passage at 25 km/h from the chosen start without times', () => {
    const track = northRoad(30);
    const s = weatherSamples(track, { kind: 'chosen', date: '2025-06-14', time: '10:00' });
    const start = Date.UTC(2025, 5, 14, 10);
    expect(s[0]!.t).toBe(start);
    // 25 km at 25 km/h: one hour later (wall-clock time at the route).
    const at = s.find((x) => Math.round(x.alongM) === 20_000)!;
    expect(at.t - start).toBeCloseTo((20 / 25) * 3600_000, -3);
  });

  it('caps the samples on a long route', () => {
    const track = northRoad(600);
    const s = weatherSamples(track, { kind: 'chosen', date: '2025-06-14', time: '10:00' });
    expect(s.length).toBeLessThanOrEqual(MAX_WEATHER_SAMPLES);
    expect(s.at(-1)!.alongM).toBeCloseTo(track.totalDistanceM, 3);
  });

  it('asks once per grid cell: the way back of an out-and-back reuses the way out', () => {
    const track = outAndBack();
    const s = weatherSamples(track, { kind: 'chosen', date: '2025-06-14', time: '10:00' });
    const { locations, index } = weatherLocations(s);
    expect(locations.length).toBeLessThan(s.length);
    expect(index).toHaveLength(s.length);
    // Snapped to 0.1°: the server learns cells, not the road.
    for (const l of locations) {
      expect(Math.round(l.lat * 10) / 10).toBeCloseTo(l.lat, 9);
      expect(Math.round(l.lon * 10) / 10).toBeCloseTo(l.lon, 9);
    }
  });

  it('builds the archive query with the documented parameters', () => {
    const q = weatherQuery(
      [
        { lat: 47.5, lon: 11.4 },
        { lat: 47.6, lon: 11.5 },
      ],
      '2025-06-13',
      '2025-06-15',
    );
    expect(q).toBe(
      'latitude=47.5,47.6&longitude=11.4,11.5&start_date=2025-06-13&end_date=2025-06-15' +
        '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation,weather_code' +
        '&wind_speed_unit=ms&timezone=auto&timeformat=unixtime',
    );
  });

  it('plans padded days, refuses the future and days before the archive', () => {
    const track = northRoad(20);
    const p = planWeather(track, { kind: 'chosen', date: '2025-06-14', time: '10:00' }, NOW);
    if (!p.ok) throw new Error(p.error);
    expect(p.queries).toHaveLength(1);
    expect(p.queries[0]).toContain('start_date=2025-06-13&end_date=2025-06-15');
    const future = planWeather(track, { kind: 'chosen', date: '2027-01-01', time: '10:00' }, NOW);
    expect(future.ok).toBe(false);
    const old = planWeather(track, { kind: 'chosen', date: '1930-06-01', time: '10:00' }, NOW);
    expect(old.ok).toBe(false);
    expect(planWeather(track, { kind: 'chosen', date: '2025-02-30', time: '10:00' }, NOW).ok).toBe(
      false,
    );
    // Yesterday: the end date is clamped to today.
    const recent = planWeather(track, { kind: 'chosen', date: '2026-11-27', time: '10:00' }, NOW);
    if (!recent.ok) throw new Error(recent.error);
    expect(recent.queries[0]).toContain('end_date=2026-11-28');
  });

  it('sends at most 10 places per request', () => {
    const track = northRoad(380);
    const p = planWeather(track, { kind: 'chosen', date: '2025-06-14', time: '06:00' }, NOW);
    if (!p.ok) throw new Error(p.error);
    expect(p.locations.length).toBeGreaterThan(10);
    expect(p.batches.every((b) => b.length <= 10)).toBe(true);
    expect(p.queries).toHaveLength(p.batches.length);
  });
});

describe('the archive answer', () => {
  it('reads one location or a list, keeping nulls', () => {
    const one = series(JUNE_14, 48, (h) => ({ s: h === 3 ? null : 4 }));
    const r1 = parseWeatherJson(JSON.stringify(one), 1);
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.series[0]!.windSpeedMps[3]).toBeNull();
    expect(r1.series[0]!.utcOffsetS).toBe(7200);
    const r2 = parseWeatherJson(JSON.stringify([one, one]), 2);
    expect(r2.ok && r2.series.length).toBe(2);
    // Out-of-range values count as missing.
    const odd = series(JUNE_14, 4, () => ({ d: 400, t: 99 }));
    const r3 = parseWeatherJson(JSON.stringify(odd), 1);
    expect(r3.ok && r3.series[0]!.windFromDeg[0]).toBeNull();
    expect(r3.ok && r3.series[0]!.tempC[0]).toBeNull();
  });

  it('reports the server’s reason, other places and garbage', () => {
    const e = parseWeatherJson(
      '{"error":true,"reason":"Parameter \'start_date\' is out of allowed range"}',
      1,
    );
    expect(e.ok).toBe(false);
    expect(!e.ok && e.error).toContain('out of allowed range');
    expect(parseWeatherJson(JSON.stringify(series(JUNE_14, 4, () => ({}))), 2).ok).toBe(false);
    expect(parseWeatherJson('<html>busy</html>', 1).ok).toBe(false);
    expect(parseWeatherJson('{"hourly":{"time":[1,2],"wind_speed_10m":[1]}}', 1).ok).toBe(false);
  });

  it('interpolates between hours, as a vector across north, bridging nulls', () => {
    const raw = series(JUNE_14, 4, (h) =>
      h === 0 ? { s: 4, d: 350 } : h === 1 ? { s: 6, d: 10 } : { s: null, d: null },
    );
    const parsed = parseWeatherJson(JSON.stringify(raw), 1);
    if (!parsed.ok) throw new Error(parsed.error);
    const s: WeatherSeries = parsed.series[0]!;
    const w = weatherAt(s, JUNE_14 + 1800_000)!;
    expect(w.speedMps).toBeCloseTo(5, 6);
    expect(Math.min(w.fromDeg, 360 - w.fromDeg)).toBeLessThan(3); // about north, not south
    // Past the last good hour the last value holds (a null neighbour is bridged).
    const later = weatherAt(s, JUNE_14 + 1.5 * 3600_000)!;
    expect(later.speedMps).toBeCloseTo(6, 6);
    // Far outside the series: no weather.
    expect(weatherAt(s, JUNE_14 + 30 * 3600_000)).toBeNull();
  });

  it('builds the profile; recorded times are UTC, chosen ones local at the route', () => {
    const track = northRoad(20);
    const raw = series(Date.UTC(2025, 5, 13), 72, (h) => ({ s: h, d: 180 }), 7200);
    const parsed = parseWeatherJson(JSON.stringify(raw), 1);
    if (!parsed.ok) throw new Error(parsed.error);
    const when: WeatherWhen = { kind: 'chosen', date: '2025-06-14', time: '10:00' };
    const samples = weatherSamples(track, when);
    const { index } = weatherLocations(samples);
    const built = buildWindProfile(track, when, samples, index, parsed.series, NOW);
    if (!built.ok) throw new Error(built.error);
    // 10:00 local (+2 h) = 08:00 UTC = hour 32 of the series from 13 June 00:00 UTC.
    expect(built.profile.points[0]!.speedMps).toBeCloseTo(32, 6);
    expect(built.profile.startMs).toBe(Date.UTC(2025, 5, 14, 8));
    expect(windConditionsKey(built.profile)).toBe('2025-06-14T10:00');
    expect(built.profile.attribution).toBe(WEATHER_ATTRIBUTION);
  });

  it('says so when the archive has no wind for that day', () => {
    const track = northRoad(5);
    const raw = series(JUNE_14, 48, () => ({ s: null, d: null }));
    const parsed = parseWeatherJson(JSON.stringify(raw), 1);
    if (!parsed.ok) throw new Error(parsed.error);
    const when: WeatherWhen = { kind: 'chosen', date: '2025-06-14', time: '10:00' };
    const samples = weatherSamples(track, when);
    const built = buildWindProfile(
      track,
      when,
      samples,
      weatherLocations(samples).index,
      parsed.series,
      NOW,
    );
    expect(built.ok).toBe(false);
    expect(!built.ok && built.error).toMatch(/no data for that day/);
  });
});

function profile(points: WindProfile['points'], track: RouteTrack): WindProfile {
  return {
    routeId: track.id,
    totalDistanceM: track.totalDistanceM,
    loop: track.loop,
    fetchedAt: NOW,
    attribution: WEATHER_ATTRIBUTION,
    when: 'chosen',
    startMs: Date.UTC(2025, 5, 14, 8),
    endMs: Date.UTC(2025, 5, 14, 9, 30),
    utcOffsetS: 7200,
    points,
  };
}

const pt = (alongM: number, speedMps: number, fromDeg: number) => ({
  alongM,
  speedMps,
  fromDeg,
  gustMps: speedMps * 1.8,
  tempC: 16.4,
  precipMm: 0,
  code: 3,
});

describe('the stored profile', () => {
  it('round-trips compactly and validates', () => {
    const track = northRoad(20);
    const p = profile(
      [pt(0, 4.2, 225), pt(10_000, 5.5, 240), pt(track.totalDistanceM, 6, 250)],
      track,
    );
    const text = encodeWindProfile(p);
    expect(text.length).toBeLessThan(600);
    const d = decodeWindProfile(text);
    if (!d.ok) throw new Error(d.error);
    // Stored to 0.1 m/s, 1°, 0.1 °C: decoding and encoding again gives the same text.
    expect(encodeWindProfile(d.profile)).toBe(text);
    expect(d.profile.points[0]).toMatchObject({
      speedMps: 4.2,
      fromDeg: 225,
      tempC: 16.4,
      code: 3,
    });
    expect(d.profile.routeId).toBe(track.id);
    expect(decodeWindProfile(text.replace('"freilauf-weather"', '"x"')).ok).toBe(false);
    expect(decodeWindProfile(text.replace('[0,42,225', '[0,-42,225')).ok).toBe(false);
    expect(decodeWindProfile('{').ok).toBe(false);
    expect(decodeWindProfile(42).ok).toBe(false);
  });

  it('summarizes for the route details', () => {
    const track = northRoad(20);
    const s = summarizeWind(profile([pt(0, 4, 225), pt(20_000, 6, 225)], track));
    expect(s.meanMps).toBeCloseTo(5, 6);
    expect(compassWord(s.mainFromDeg)).toBe('south-west');
    expect(s.span).toBe('14 June 2025, 10:00–11:30');
    expect(s.conditions).toBe('Overcast');
  });
});

describe('the wind the rider feels', () => {
  it('splits the wind into head, tail and cross components', () => {
    const north = 0;
    expect(windComponents(5, 0, north).headMps).toBeCloseTo(5, 9);
    expect(windComponents(5, 180, north).headMps).toBeCloseTo(-5, 9);
    const cross = windComponents(5, 90, north);
    expect(cross.headMps).toBeCloseTo(0, 9);
    expect(cross.crossMps).toBeCloseTo(5, 9); // from the right when riding north
    expect(windComponents(5, 270, north).crossMps).toBeCloseTo(-5, 9);
    // Riding east into an east wind.
    expect(windComponents(5, 90, Math.PI / 2).headMps).toBeCloseTo(5, 9);
  });

  it('reduces the 10 m wind to rider height: open 0.65, sheltered 0.4', () => {
    expect(riderWindFactor(0)).toBe(RIDER_WIND_FACTOR_OPEN);
    expect(riderWindFactor(1)).toBe(RIDER_WIND_FACTOR_SHELTERED);
    expect(riderWindFactor(0.5)).toBeCloseTo(0.525, 9);
    const track = northRoad(10);
    const p = profile([pt(0, 10, 0)], track);
    const w = riderWind(p, track, 5000);
    expect(w.headMps).toBeCloseTo(6.5, 6);
    expect(w.speed10Mps).toBe(10);
  });

  it('is sheltered by woods and houses from the stored surroundings', () => {
    const track = northRoad(10);
    const m: SceneryModel = emptyScenery(track.id, track.totalDistanceM, false);
    m.ground.push({ kind: 'forest', side: -1, fromM: 2000, toM: 3000, nearM: 10, farM: 300 });
    m.ground.push({ kind: 'forest', side: 1, fromM: 2000, toM: 3000, nearM: 20, farM: 300 });
    m.ground.push({ kind: 'meadow', side: 1, fromM: 5000, toM: 6000, nearM: 5, farM: 300 });
    m.buildings.push({
      alongM: 7000,
      offsetM: 15,
      lengthM: 10,
      depthM: 8,
      heightM: 6,
      kind: 'house',
    });
    expect(shelterAt(m, 2500)).toBe(1);
    expect(shelterAt(m, 5500)).toBe(0);
    expect(shelterAt(m, 7010)).toBe(0.5);
    expect(shelterAt(null, 2500)).toBe(0);
    const p = profile([pt(0, 10, 0)], track);
    expect(riderWind(p, track, 2500, m).headMps).toBeCloseTo(4, 6);
    expect(riderWind(p, track, 5500, m).headMps).toBeCloseTo(6.5, 6);
  });

  it('flips sign on the way back of an out-and-back', () => {
    const track = outAndBack();
    const p = profile([pt(0, 6, 0)], track);
    const out = riderWind(p, track, 2000);
    const back = riderWind(p, track, track.totalDistanceM - 2000);
    expect(out.headMps).toBeGreaterThan(3.5);
    expect(back.headMps).toBeLessThan(-3.5);
    expect(out.headMps + back.headMps).toBeCloseTo(0, 1);
  });

  it('follows the road through a bend', () => {
    // 3 km north, then 3 km east.
    const pts = [
      ...Array.from({ length: 31 }, (_, i) => ({ x: 0, y: i * 100 })),
      ...Array.from({ length: 30 }, (_, i) => ({ x: (i + 1) * 100, y: 3000 })),
    ];
    const track = prepare(gpx(pts)).track;
    const p = profile([pt(0, 8, 90)], track); // an east wind
    expect(Math.abs(riderWind(p, track, 1500).headMps)).toBeLessThan(0.2);
    expect(riderWind(p, track, 1500).crossMps).toBeGreaterThan(5);
    expect(riderWind(p, track, 4500).headMps).toBeCloseTo(8 * 0.65, 1);
  });

  it('caps the effect and interpolates between places', () => {
    const track = northRoad(20);
    const storm = profile([pt(0, 40, 0)], track);
    expect(riderWind(storm, track, 100).headMps).toBe(MAX_RIDER_WIND_MPS);
    const p = profile([pt(0, 2, 0), pt(10_000, 6, 0)], track);
    expect(windAt(p, 5000).speedMps).toBeCloseTo(4, 6);
    expect(windAt(p, 50_000).speedMps).toBe(6); // held past the last place
  });
});

describe('words', () => {
  it('formats the day of the weather in local time at the route', () => {
    expect(
      formatWeatherSpan(Date.UTC(2025, 5, 14, 7, 12), Date.UTC(2025, 5, 14, 11, 40), 7200),
    ).toBe('14 June 2025, 09:12–13:40');
    expect(
      formatWeatherSpan(Date.UTC(2026, 4, 2, 17, 36), Date.UTC(2026, 4, 2, 23, 14), 7200),
    ).toBe('2 May 2026, 19:36 – 3 May 2026, 01:14');
    expect(conditionsText(63)).toBe('Rain');
    expect(conditionsText(0)).toBe('Clear');
    expect(conditionsText(-1)).toBe('');
    expect(wallClockMs('2025-06-14', '25:00')).toBeNull();
  });
});

describe('fetchWeather', () => {
  const when: WeatherWhen = { kind: 'chosen', date: '2025-06-14', time: '10:00' };
  const answer = (q: string) => {
    const n = q.split('&')[0]!.split(',').length;
    const one = series(Date.UTC(2025, 5, 13), 72, () => ({ s: 5, d: 0 }));
    return JSON.stringify(n === 1 ? one : Array.from({ length: n }, () => one));
  };
  const fast = { sleep: async () => undefined, now: () => NOW };

  it('loads the profile with one request for a short route', async () => {
    const track = northRoad(25);
    const queries: string[] = [];
    const progress: string[] = [];
    const r = await fetchWeather(track, when, {
      ...fast,
      transport: async (q) => {
        queries.push(q);
        return { status: 200, text: answer(q) };
      },
      onProgress: (p) => progress.push(`${p.phase} ${p.done}/${p.total}`),
    });
    if (!r.ok) throw new Error(r.error);
    expect(queries).toHaveLength(1);
    expect(r.requests).toBe(1);
    expect(r.profile.points.length).toBeGreaterThanOrEqual(3);
    expect(decodeWindProfile(r.text).ok).toBe(true);
    expect(progress[0]).toBe('fetching 0/1');
  });

  it('retries a busy server with backoff (Retry-After wins) and gives up after the retries', async () => {
    const track = northRoad(5);
    const waits: number[] = [];
    let calls = 0;
    const r = await fetchWeather(track, when, {
      now: () => NOW,
      sleep: async (ms) => void waits.push(ms),
      backoffMs: 100,
      transport: async (q) => {
        calls++;
        if (calls === 1) return { status: 503, text: 'busy' };
        if (calls === 2) return { status: 429, text: 'slow down', retryAfterS: 7 };
        if (calls === 3) throw new Error('reset');
        return { status: 200, text: answer(q) };
      },
    });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([100, 7000, 400]);
    const fail = await fetchWeather(track, when, {
      ...fast,
      retries: 2,
      transport: async () => ({ status: 502, text: '' }),
    });
    expect(fail.ok).toBe(false);
    expect(!fail.ok && fail.requests).toBe(3);
    expect(!fail.ok && fail.error).toMatch(/gave up after 3 tries/);
  });

  it('stops at once on a refused request (400)', async () => {
    const track = northRoad(5);
    let calls = 0;
    const r = await fetchWeather(track, when, {
      ...fast,
      transport: async () => {
        calls++;
        return { status: 400, text: '{"error":true,"reason":"Cannot initialize WeatherVariable"}' };
      },
    });
    expect(calls).toBe(1);
    expect(!r.ok && r.error).toContain('Cannot initialize WeatherVariable');
  });

  it('is cancellable while a request is under way', async () => {
    const track = northRoad(5);
    const cancel = new CancelSource();
    const r = fetchWeather(track, when, {
      ...fast,
      signal: cancel.signal,
      transport: () => new Promise(() => undefined),
    });
    cancel.cancel();
    const res = await r;
    expect(res.ok).toBe(false);
    expect(!res.ok && res.cancelled).toBe(true);
  });

  it('asks nothing for a day it refuses', async () => {
    let calls = 0;
    const r = await fetchWeather(
      northRoad(5),
      { kind: 'chosen', date: '2030-01-01', time: '10:00' },
      {
        ...fast,
        transport: async () => {
          calls++;
          return { status: 200, text: '' };
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });
});
