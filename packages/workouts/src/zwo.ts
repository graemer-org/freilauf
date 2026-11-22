/**
 * Import/export of the community `.zwo` workout XML format (subset, see docs/workouts.md).
 * Written from the publicly documented structure of the format.
 */
import type { TextCue, Workout, WorkoutStep } from './model';
import { WORKOUT_LIMITS, stepDurationS, validateWorkout } from './model';
import type { XmlElement } from './xml';
import { parseXml } from './xml';

export const MAX_ZWO_BYTES = 1024 * 1024;

export type ZwoParseResult =
  | { ok: true; workout: Workout; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** UTF-8 byte length without TextEncoder (not available without DOM/Node libs). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const NUMBER = /^[ \t\r\n]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\r\n]*$/;

const BLOCK_ATTRS: Record<string, readonly string[]> = {
  Warmup: ['Duration', 'PowerLow', 'PowerHigh', 'Cadence'],
  Cooldown: ['Duration', 'PowerLow', 'PowerHigh', 'Cadence'],
  Ramp: ['Duration', 'PowerLow', 'PowerHigh', 'Cadence'],
  SteadyState: ['Duration', 'Power', 'PowerLow', 'PowerHigh', 'Cadence'],
  IntervalsT: [
    'Repeat',
    'OnDuration',
    'OffDuration',
    'OnPower',
    'OffPower',
    'Cadence',
    'CadenceResting',
  ],
  FreeRide: ['Duration', 'FlatRoad', 'Cadence'],
};

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

class Ctx {
  readonly errors: string[] = [];
  private readonly warningSet = new Set<string>();
  warn(msg: string): void {
    if (this.warningSet.size < 100) this.warningSet.add(msg);
  }
  get warnings(): string[] {
    return [...this.warningSet];
  }
  num(el: XmlElement, attr: string, where: string, required: boolean): number | undefined {
    const raw = el.attrs.get(attr);
    if (raw === undefined) {
      if (required) this.errors.push(`${where}: missing attribute ${attr}`);
      return undefined;
    }
    if (!NUMBER.test(raw)) {
      this.errors.push(`${where}: attribute ${attr} is not a number ("${raw.slice(0, 20)}")`);
      return undefined;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      this.errors.push(`${where}: attribute ${attr} is not finite`);
      return undefined;
    }
    return v;
  }
}

/** Whole seconds; anything < 0.5 s becomes 0 and is rejected by validation. */
const secs = (v: number) => Math.round(v);
/** A cadence of 0 means "no target" in practice; drop it rather than reject. */
const cadence = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);

function readCues(ctx: Ctx, el: XmlElement, where: string, durationS: number): TextCue[] {
  const cues: TextCue[] = [];
  for (const child of el.children) {
    if (child.name !== 'textevent') {
      ctx.warn(`Ignored element <${child.name}> inside <${el.name}>`);
      continue;
    }
    for (const a of child.attrs.keys()) {
      if (a !== 'timeoffset' && a !== 'message') ctx.warn(`Ignored attribute ${a} on <textevent>`);
    }
    const at = ctx.num(child, 'timeoffset', `${where} <textevent>`, true);
    const message = child.attrs.get('message') ?? child.text;
    if (at === undefined) continue;
    if (message.trim() === '') {
      ctx.warn(`${where}: skipped empty <textevent>`);
      continue;
    }
    if (at < 0 || at >= durationS) {
      ctx.warn(`${where}: skipped <textevent> at ${at} s outside the block`);
      continue;
    }
    if (cues.length >= WORKOUT_LIMITS.maxCuesPerStep) {
      ctx.warn(`${where}: more than ${WORKOUT_LIMITS.maxCuesPerStep} text events, rest skipped`);
      break;
    }
    cues.push({ atS: at, message: message.slice(0, WORKOUT_LIMITS.maxCueMessageLength * 4) });
  }
  return cues;
}

function readBlock(ctx: Ctx, el: XmlElement, where: string): WorkoutStep | undefined {
  const known = BLOCK_ATTRS[el.name];
  if (!known) {
    ctx.warn(`Ignored unsupported element <${el.name}>`);
    return undefined;
  }
  for (const a of el.attrs.keys()) {
    if (!known.includes(a)) ctx.warn(`Ignored attribute ${a} on <${el.name}>`);
  }
  const before = ctx.errors.length;
  let step: WorkoutStep | undefined;
  switch (el.name) {
    case 'Warmup':
    case 'Cooldown':
    case 'Ramp': {
      const d = ctx.num(el, 'Duration', where, true);
      let lo = ctx.num(el, 'PowerLow', where, true);
      let hi = ctx.num(el, 'PowerHigh', where, true);
      const cad = cadence(ctx.num(el, 'Cadence', where, false));
      if (d === undefined || lo === undefined || hi === undefined) break;
      // PowerLow is the start and PowerHigh the end value. Some tools write cool-downs the
      // other way round; a cool-down is by definition descending, so normalise it.
      if (el.name === 'Cooldown' && lo < hi) {
        [lo, hi] = [hi, lo];
        ctx.warn(`${where}: ascending <Cooldown> interpreted as descending`);
      }
      step = { kind: 'ramp', durationS: secs(d), powerStart: lo, powerEnd: hi };
      if (cad !== undefined) step.cadenceRpm = cad;
      break;
    }
    case 'SteadyState': {
      const d = ctx.num(el, 'Duration', where, true);
      let p = ctx.num(el, 'Power', where, false);
      if (p === undefined && !el.attrs.has('Power')) {
        const lo = ctx.num(el, 'PowerLow', where, false);
        const hi = ctx.num(el, 'PowerHigh', where, false);
        if (lo !== undefined && hi !== undefined) {
          p = (lo + hi) / 2;
          ctx.warn(`${where}: <SteadyState> without Power uses the mean of PowerLow/PowerHigh`);
        } else ctx.errors.push(`${where}: missing attribute Power`);
      }
      const cad = cadence(ctx.num(el, 'Cadence', where, false));
      if (d === undefined || p === undefined) break;
      step = { kind: 'steady', durationS: secs(d), power: p };
      if (cad !== undefined) step.cadenceRpm = cad;
      break;
    }
    case 'IntervalsT': {
      const repeat = ctx.num(el, 'Repeat', where, true);
      const on = ctx.num(el, 'OnDuration', where, true);
      const off = ctx.num(el, 'OffDuration', where, true);
      const onP = ctx.num(el, 'OnPower', where, true);
      const offP = ctx.num(el, 'OffPower', where, true);
      const onCad = cadence(ctx.num(el, 'Cadence', where, false));
      const offCad = cadence(ctx.num(el, 'CadenceResting', where, false));
      if (
        repeat === undefined ||
        on === undefined ||
        off === undefined ||
        onP === undefined ||
        offP === undefined
      ) {
        break;
      }
      step = {
        kind: 'intervals',
        repeat: Math.round(repeat),
        onDurationS: secs(on),
        onPower: onP,
        offDurationS: secs(off),
        offPower: offP,
      };
      if (onCad !== undefined) step.onCadenceRpm = onCad;
      if (offCad !== undefined) step.offCadenceRpm = offCad;
      break;
    }
    case 'FreeRide': {
      const d = ctx.num(el, 'Duration', where, true);
      const flat = ctx.num(el, 'FlatRoad', where, false);
      if (el.attrs.has('Cadence')) ctx.warn(`${where}: cadence targets in <FreeRide> are ignored`);
      if (d === undefined) break;
      step = { kind: 'freeRide', durationS: secs(d) };
      if (flat !== undefined && flat !== 0) step.gradePercent = 0;
      break;
    }
  }
  if (!step || ctx.errors.length > before) return undefined;
  const cues = readCues(ctx, el, where, stepDurationS(step));
  if (cues.length > 0) step.cues = cues;
  return step;
}

/**
 * Parses `.zwo` XML text (untrusted). Unknown elements/attributes are skipped with a warning;
 * malformed XML, DOCTYPE/entity declarations, oversize input (> 1 MiB UTF-8) and workouts that
 * fail `validateWorkout` are rejected. Never throws.
 */
export function parseZwo(xmlText: string): ZwoParseResult {
  const ctx = new Ctx();
  const fail = (...errors: string[]): ZwoParseResult => ({
    ok: false,
    errors: [...ctx.errors, ...errors],
    warnings: ctx.warnings,
  });
  try {
    if (typeof xmlText !== 'string') return fail('Input is not text');
    if (xmlText.length > MAX_ZWO_BYTES || utf8ByteLength(xmlText) > MAX_ZWO_BYTES) {
      return fail(`File is larger than ${MAX_ZWO_BYTES / 1024} KiB`);
    }
    const xml = parseXml(xmlText);
    if (!xml.ok) return fail(xml.error);
    const root = xml.root;
    if (root.name !== 'workout_file')
      return fail(`Root element must be <workout_file>, not <${root.name}>`);

    const meta: { name?: string; description?: string; author?: string } = {};
    const tags: string[] = [];
    let workoutEl: XmlElement | undefined;
    for (const child of root.children) {
      switch (child.name) {
        case 'name':
        case 'description':
        case 'author':
          if (meta[child.name] !== undefined) ctx.warn(`Duplicate <${child.name}> ignored`);
          else meta[child.name] = child.text.trim();
          break;
        case 'tags':
          for (const tag of child.children) {
            const n = tag.name === 'tag' ? tag.attrs.get('name') : undefined;
            if (n === undefined) ctx.warn(`Ignored element <${tag.name}> in <tags>`);
            else if (tags.length < WORKOUT_LIMITS.maxTags) tags.push(n);
          }
          break;
        case 'workout':
          if (workoutEl) ctx.warn('Duplicate <workout> ignored');
          else workoutEl = child;
          break;
        case 'sportType':
          if (child.text.trim().toLowerCase() === 'run')
            return fail('Running workouts are not supported');
          break;
        case 'durationType':
          if (child.text.trim().toLowerCase() === 'distance') {
            return fail('Distance-based workouts are not supported');
          }
          break;
        default:
          ctx.warn(`Ignored element <${child.name}>`);
      }
    }
    if (!workoutEl) return fail('Missing <workout> element');

    const steps: WorkoutStep[] = [];
    workoutEl.children.forEach((el, i) => {
      if (steps.length > WORKOUT_LIMITS.maxSteps) return;
      const step = readBlock(ctx, el, `Block ${i + 1} <${el.name}>`);
      if (step) steps.push(step);
    });
    if (ctx.errors.length > 0) return fail();
    if (steps.length === 0) return fail('The workout contains no supported blocks');

    const name = meta.name || 'Imported workout';
    const candidate: Record<string, unknown> = {
      id: `zwo-${slug(name) || 'workout'}-${fnv1a(xmlText)}`,
      name,
      steps,
    };
    if (meta.description) candidate['description'] = meta.description;
    if (meta.author) candidate['author'] = meta.author;
    if (tags.length > 0) candidate['tags'] = tags;
    const result = validateWorkout(candidate);
    if (!result.ok) return fail(...result.errors);
    return { ok: true, workout: result.workout, warnings: ctx.warnings };
  } catch {
    return fail('Could not read the file');
  }
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;');
}

function n(v: number): string {
  return String(Number(v.toFixed(4)));
}

function attrs(pairs: [string, number | undefined][]): string {
  return pairs
    .filter((p): p is [string, number] => p[1] !== undefined)
    .map(([k, v]) => ` ${k}="${n(v)}"`)
    .join('');
}

/**
 * Exports a workout as `.zwo` XML for other tools. Lossy: step labels, `expectedPower` and
 * free-ride gradients other than 0 (exported as `FlatRoad="1"`) are not representable.
 */
export function workoutToZwo(workout: Workout): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<workout_file>'];
  if (workout.author) out.push(`  <author>${esc(workout.author)}</author>`);
  out.push(`  <name>${esc(workout.name)}</name>`);
  if (workout.description) out.push(`  <description>${esc(workout.description)}</description>`);
  out.push('  <sportType>bike</sportType>');
  if (workout.tags && workout.tags.length > 0) {
    out.push('  <tags>');
    for (const t of workout.tags) out.push(`    <tag name="${esc(t)}"/>`);
    out.push('  </tags>');
  }
  out.push('  <workout>');
  const last = workout.steps.length - 1;
  workout.steps.forEach((step, i) => {
    let tag: string;
    let a: string;
    switch (step.kind) {
      case 'ramp':
        tag =
          i === 0 && step.powerEnd > step.powerStart
            ? 'Warmup'
            : i === last && step.powerEnd < step.powerStart
              ? 'Cooldown'
              : 'Ramp';
        a = attrs([
          ['Duration', step.durationS],
          ['PowerLow', step.powerStart],
          ['PowerHigh', step.powerEnd],
          ['Cadence', step.cadenceRpm],
        ]);
        break;
      case 'steady':
        tag = 'SteadyState';
        a = attrs([
          ['Duration', step.durationS],
          ['Power', step.power],
          ['Cadence', step.cadenceRpm],
        ]);
        break;
      case 'intervals':
        tag = 'IntervalsT';
        a = attrs([
          ['Repeat', step.repeat],
          ['OnDuration', step.onDurationS],
          ['OffDuration', step.offDurationS],
          ['OnPower', step.onPower],
          ['OffPower', step.offPower],
          ['Cadence', step.onCadenceRpm],
          ['CadenceResting', step.offCadenceRpm],
        ]);
        break;
      case 'freeRide':
        tag = 'FreeRide';
        a = attrs([
          ['Duration', step.durationS],
          ['FlatRoad', step.gradePercent === 0 ? 1 : undefined],
        ]);
        break;
    }
    const cues = step.cues ?? [];
    if (cues.length === 0) {
      out.push(`    <${tag}${a}/>`);
    } else {
      out.push(`    <${tag}${a}>`);
      for (const c of cues) {
        out.push(`      <textevent timeoffset="${n(c.atS)}" message="${esc(c.message)}"/>`);
      }
      out.push(`    </${tag}>`);
    }
  });
  out.push('  </workout>', '</workout_file>', '');
  return out.join('\n');
}
