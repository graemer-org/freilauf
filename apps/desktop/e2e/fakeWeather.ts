/**
 * A fake historical weather archive on 127.0.0.1 for the e2e tests: answers GET /v1/archive in
 * the documented Open-Meteo format (several locations → a JSON list) with a steady, made-up
 * wind. Nothing here comes from the real service.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeWeather {
  url: string;
  requests: { method: string; userAgent: string; url: string }[];
  close(): Promise<void>;
}

export async function fakeWeather(
  wind: { speedMps: number; fromDeg: number } = { speedMps: 8, fromDeg: 200 },
): Promise<FakeWeather> {
  const requests: FakeWeather['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      userAgent: String(req.headers['user-agent'] ?? ''),
      url: req.url ?? '',
    });
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || u.pathname !== '/v1/archive') {
      res.writeHead(404).end();
      return;
    }
    const n = (u.searchParams.get('latitude') ?? '').split(',').length;
    const from = Date.parse(`${u.searchParams.get('start_date')}T00:00Z`) / 1000;
    const to = Date.parse(`${u.searchParams.get('end_date')}T23:00Z`) / 1000;
    const time: number[] = [];
    for (let t = from; t <= to; t += 3600) time.push(t);
    const col = (v: number) => time.map(() => v);
    const one = {
      latitude: 47.5,
      longitude: 11.5,
      utc_offset_seconds: 7200,
      timezone: 'Europe/Berlin',
      hourly: {
        time,
        wind_speed_10m: col(wind.speedMps),
        wind_direction_10m: col(wind.fromDeg),
        wind_gusts_10m: col(wind.speedMps * 1.8),
        temperature_2m: col(14),
        precipitation: col(0.6),
        weather_code: col(61),
      },
    };
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(n === 1 ? one : Array.from({ length: n }, () => one)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/archive`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
