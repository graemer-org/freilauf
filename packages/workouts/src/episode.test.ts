import { describe, expect, it } from 'vitest';
import type { EpisodeEffort, EpisodeOptions, EpisodePattern, EpisodePlan } from './episode';
import {
  DEFAULT_EPISODE_OPTIONS,
  EPISODE_EFFORTS,
  EPISODE_MAX_LENGTH_MIN,
  EPISODE_MIN_LENGTH_MIN,
  EPISODE_PATTERNS,
  EPISODE_PROFILES,
  HARD_NOW_RECOVERY_S,
  HARD_NOW_S,
  MIN_HARD_BLOCK_S,
  applyHardNow,
  episodeCooldownS,
  episodeWarmupS,
  generateEpisodeWorkout,
  hardNowAvailability,
  isEpisodeWorkoutId,
  normalizeEpisodeOptions,
} from './episode';
import { stepDurationS, totalDurationS, validateWorkout } from './model';
import { WorkoutRunner } from './runner';
import { buildTimeline, workoutStats } from './timeline';

const LENGTHS = [10, 11, 15, 22, 25, 30, 42, 45, 55, 60, 75, 90, 105, 120, 150, 179, 180];

function* allOptions(lengths: readonly number[] = LENGTHS): Generator<EpisodeOptions> {
  for (const lengthMin of lengths)
    for (const effort of EPISODE_EFFORTS)
      for (const pattern of EPISODE_PATTERNS) yield { lengthMin, effort, pattern };
}

/** [startS, endS, kind, power] per step (power: steady target or ramp start). */
function layout(plan: EpisodePlan) {
  let t = 0;
  return plan.workout.steps.map((s, i) => {
    const start = t;
    t += stepDurationS(s);
    const power = s.kind === 'steady' ? s.power : s.kind === 'ramp' ? s.powerStart : 0;
    return { start, end: t, kind: plan.blocks[i], power, step: s };
  });
}

function powers(plan: EpisodePlan): number[] {
  return plan.workout.steps.flatMap((s) =>
    s.kind === 'steady' ? [s.power] : s.kind === 'ramp' ? [s.powerStart, s.powerEnd] : [],
  );
}

describe('generateEpisodeWorkout', () => {
  it('fills exactly the episode length for every length 10–180, pattern and effort', () => {
    for (let lengthMin = EPISODE_MIN_LENGTH_MIN; lengthMin <= EPISODE_MAX_LENGTH_MIN; lengthMin++) {
      for (const o of allOptions([lengthMin])) {
        const plan = generateEpisodeWorkout(o);
        expect(totalDurationS(plan.workout), JSON.stringify(o)).toBe(lengthMin * 60);
        expect(plan.totalDurationS).toBe(lengthMin * 60);
        expect(buildTimeline(plan.workout).totalDurationS).toBe(lengthMin * 60);
        expect(plan.blocks).toHaveLength(plan.workout.steps.length);
      }
    }
  });

  it('produces valid workouts with whole-second steps only', () => {
    for (const o of allOptions()) {
      const plan = generateEpisodeWorkout(o);
      const v = validateWorkout(plan.workout);
      expect(v.ok, JSON.stringify(o)).toBe(true);
      for (const s of plan.workout.steps) {
        expect(s.kind === 'steady' || s.kind === 'ramp').toBe(true);
        const d = stepDurationS(s);
        expect(Number.isInteger(d) && d >= 1).toBe(true);
      }
    }
  });

  it('starts with a warm-up of ~10 % (≥ 3 min) and ends with a cool-down of ~8 % (≥ 2 min)', () => {
    for (const o of allOptions()) {
      const plan = generateEpisodeWorkout(o);
      const total = o.lengthMin * 60;
      const [first] = plan.workout.steps;
      const last = plan.workout.steps.at(-1);
      expect(plan.blocks[0]).toBe('warmup');
      expect(plan.blocks.at(-1)).toBe('cooldown');
      expect(plan.blocks.filter((b) => b === 'warmup' || b === 'cooldown')).toHaveLength(2);
      const warm = stepDurationS(first!);
      const cool = stepDurationS(last!);
      expect(warm).toBe(episodeWarmupS(total));
      expect(cool).toBe(episodeCooldownS(total));
      expect(warm).toBeGreaterThanOrEqual(180);
      expect(cool).toBeGreaterThanOrEqual(120);
      if (total * 0.1 >= 180) expect(Math.abs(warm - total * 0.1)).toBeLessThanOrEqual(15);
      if (total * 0.08 >= 120) expect(Math.abs(cool - total * 0.08)).toBeLessThanOrEqual(15);
      // Warm-up rises, cool-down falls, both easy.
      expect(first).toMatchObject({ kind: 'ramp' });
      expect(last).toMatchObject({ kind: 'ramp' });
      if (first?.kind === 'ramp' && last?.kind === 'ramp') {
        expect(first.powerEnd).toBeGreaterThan(first.powerStart);
        expect(first.powerEnd).toBeLessThanOrEqual(0.75);
        expect(last.powerEnd).toBeLessThan(last.powerStart);
        expect(last.powerStart).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('is deterministic', () => {
    for (const o of allOptions([10, 42, 180])) {
      expect(JSON.stringify(generateEpisodeWorkout(o))).toBe(
        JSON.stringify(generateEpisodeWorkout({ ...o })),
      );
    }
  });

  it('keeps every target within sane limits', () => {
    for (const o of allOptions()) {
      const plan = generateEpisodeWorkout(o);
      for (const p of powers(plan)) {
        expect(p).toBeGreaterThanOrEqual(0.4);
        expect(p).toBeLessThanOrEqual(1.2);
      }
      for (const l of layout(plan)) {
        if (l.kind === 'hard') {
          expect(l.end - l.start).toBeGreaterThanOrEqual(60);
          expect(l.end - l.start).toBeLessThanOrEqual(300);
        }
        if (l.kind === 'endurance' || l.kind === 'recovery')
          expect(l.power).toBeLessThanOrEqual(0.75);
      }
      // Hard time is capped per effort.
      const hardS = layout(plan)
        .filter((l) => l.kind === 'hard')
        .reduce((a, l) => a + l.end - l.start, 0);
      expect(hardS).toBeLessThanOrEqual(EPISODE_PROFILES[o.effort].maxHardTotalS);
    }
  });

  it('steady is zone 2 only, without hard parts', () => {
    for (const o of allOptions()) {
      if (o.pattern !== 'steady') continue;
      const plan = generateEpisodeWorkout(o);
      expect(plan.blocks).not.toContain('hard');
      for (const p of powers(plan)) expect(p).toBeLessThanOrEqual(0.75);
      const z = workoutStats(plan.workout, 250).timeInZonesS;
      expect(z.slice(2).every((s) => s === 0)).toBe(true);
    }
  });

  it('places the hard parts by pattern', () => {
    for (const o of allOptions()) {
      if (o.pattern === 'steady') continue;
      const plan = generateEpisodeWorkout(o);
      const rows = layout(plan);
      const mainStart = rows[0]!.end;
      const mainEnd = rows.at(-1)!.start;
      const mid = mainStart + Math.floor((mainEnd - mainStart) / 2);
      const hard = rows.filter((r) => r.kind === 'hard');
      expect(hard.length, JSON.stringify(o)).toBeGreaterThanOrEqual(o.pattern === 'spread' ? 2 : 1);
      if (o.pattern === 'early') for (const h of hard) expect(h.end).toBeLessThanOrEqual(mid);
      if (o.pattern === 'finale') {
        for (const h of hard) expect(h.start).toBeGreaterThanOrEqual(mid);
        // Builds: each hard part at least as hard as the one before; the last one into the cool-down.
        for (let i = 1; i < hard.length; i++) {
          expect(hard[i]!.power).toBeGreaterThanOrEqual(hard[i - 1]!.power);
        }
        expect(hard.at(-1)!.end).toBe(mainEnd);
      }
      if (o.pattern === 'spread' && hard.length >= 3) {
        // Both halves of the main part get hard parts.
        expect(hard.some((h) => h.start < mid)).toBe(true);
        expect(hard.some((h) => h.start >= mid)).toBe(true);
      }
    }
  });

  it('gets harder with effort', () => {
    const tss = (effort: EpisodeEffort, pattern: EpisodePattern) =>
      workoutStats(generateEpisodeWorkout({ lengthMin: 55, effort, pattern }).workout, 250).tss;
    for (const pattern of EPISODE_PATTERNS) {
      expect(tss('easy', pattern)).toBeLessThan(tss('medium', pattern));
      expect(tss('medium', pattern)).toBeLessThan(tss('hard', pattern));
    }
  });

  it('labels hard parts n/total and names the workout', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 42, effort: 'medium', pattern: 'spread' });
    expect(plan.workout.id).toBe('episode-42-medium-spread');
    expect(isEpisodeWorkoutId(plan.workout.id)).toBe(true);
    expect(isEpisodeWorkoutId('builtin-sweet-spot-3x12')).toBe(false);
    expect(plan.workout.name).toBe('Episode 42 min · Spread, medium');
    const labels = plan.workout.steps.map((s) => s.label);
    expect(labels[0]).toBe('Warm-up');
    expect(labels.at(-1)).toBe('Cool-down');
    expect(labels.filter((l) => l?.startsWith('Hard'))).toEqual([
      'Hard 1/3',
      'Hard 2/3',
      'Hard 3/3',
    ]);
  });

  it('normalizes options', () => {
    expect(normalizeEpisodeOptions({ lengthMin: 3, effort: 'x', pattern: 'finale' })).toEqual({
      lengthMin: 10,
      effort: 'medium',
      pattern: 'finale',
    });
    expect(normalizeEpisodeOptions({ lengthMin: 999.4 })).toMatchObject({ lengthMin: 180 });
    expect(normalizeEpisodeOptions({ lengthMin: 41.6 })).toMatchObject({ lengthMin: 42 });
    expect(normalizeEpisodeOptions(null)).toEqual(DEFAULT_EPISODE_OPTIONS);
    expect(normalizeEpisodeOptions({ lengthMin: Number.NaN })).toEqual(DEFAULT_EPISODE_OPTIONS);
    // Out-of-range input still generates the exact (clamped) length.
    expect(
      totalDurationS(
        generateEpisodeWorkout({ lengthMin: 5000, effort: 'hard', pattern: 'early' }).workout,
      ),
    ).toBe(180 * 60);
  });
});

describe('applyHardNow', () => {
  const cooldownOf = (plan: EpisodePlan) => JSON.stringify(plan.workout.steps.at(-1));

  /** The plan before `atS` is unchanged (the current step cut at atS). */
  function prefixKept(before: EpisodePlan, after: EpisodePlan, atS: number): void {
    const a = buildTimeline(before.workout);
    const b = buildTimeline(after.workout);
    for (let t = 0; t < atS; t += Math.max(7, Math.floor(atS / 25))) {
      const sa = a.segments.find((s) => s.startS <= t && t < s.endS)!;
      const sb = b.segments.find((s) => s.startS <= t && t < s.endS)!;
      const fa =
        sa.powerStart! + ((sa.powerEnd! - sa.powerStart!) * (t - sa.startS)) / sa.durationS;
      const fb =
        sb.powerStart! + ((sb.powerEnd! - sb.powerStart!) * (t - sb.startS)) / sb.durationS;
      expect(fb).toBeCloseTo(fa, 2);
    }
  }

  it('inserts a hard block now and keeps the total and the cool-down', () => {
    for (const o of allOptions([10, 22, 42, 55, 90, 180])) {
      const plan = generateEpisodeWorkout(o);
      const total = o.lengthMin * 60;
      const coolStart = total - stepDurationS(plan.workout.steps.at(-1)!);
      // Try ~90 points; accepted ones must keep the invariants.
      for (let t = 0; t < total; t += Math.max(20, Math.floor(total / 90))) {
        const r = applyHardNow(plan, t + 0.6);
        if (!r.ok) continue;
        expect(totalDurationS(r.plan.workout), `${JSON.stringify(o)} @${t}`).toBe(total);
        expect(cooldownOf(r.plan)).toBe(cooldownOf(plan));
        expect(validateWorkout(r.plan.workout).ok).toBe(true);
        expect(r.plan.blocks).toHaveLength(r.plan.workout.steps.length);
        const rows = layout(r.plan);
        const now = rows.find((x) => x.kind === 'hardNow' && x.start === t)!;
        expect(now, `${JSON.stringify(o)} @${t}`).toBeDefined();
        expect(now.end - now.start).toBe(HARD_NOW_S);
        expect(now.power).toBe(EPISODE_PROFILES[o.effort].hardNow);
        const rec = rows.find((x) => x.start === now.end)!;
        expect(rec.kind).toBe('recovery');
        expect(rec.end - rec.start).toBeGreaterThanOrEqual(HARD_NOW_RECOVERY_S);
        expect(rows.at(-1)!.start).toBe(coolStart);
        expect(r.startS).toBe(t);
        prefixKept(plan, r.plan, t);
        for (const x of rows)
          if (x.kind === 'hard') expect(x.end - x.start).toBeGreaterThanOrEqual(MIN_HARD_BLOCK_S);
      }
    }
  });

  it('removes later hard blocks before shortening anything else', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 42, effort: 'medium', pattern: 'spread' });
    // In the first endurance part after the warm-up.
    const r = applyHardNow(plan, 260);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hardBefore = layout(plan).filter((x) => x.kind === 'hard');
    const hardAfter = layout(r.plan).filter((x) => x.kind === 'hard');
    expect(hardAfter).toHaveLength(hardBefore.length - 1);
    expect(r.removedHardS).toBe(240);
    // The endurance before the cool-down got the time back that was not needed.
    const enduranceBefore = layout(plan)
      .filter((x) => x.kind === 'endurance')
      .reduce((a, x) => a + x.end - x.start, 0);
    const enduranceAfter = layout(r.plan)
      .filter((x) => x.kind === 'endurance')
      .reduce((a, x) => a + x.end - x.start, 0);
    expect(enduranceAfter).toBe(enduranceBefore + 240 + 180 - HARD_NOW_S - HARD_NOW_RECOVERY_S);
    expect(
      r.plan.workout.steps.filter((s) => /^Hard \d/.test(s.label ?? '')).map((s) => s.label),
    ).toEqual(['Hard 1/2', 'Hard 2/2']);
  });

  it('shortens endurance when no later hard block is left (steady)', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 22, effort: 'easy', pattern: 'steady' });
    const r = applyHardNow(plan, 600);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.removedHardS).toBe(0);
    expect(r.plan.blocks).toEqual([
      'warmup',
      'endurance',
      'hardNow',
      'recovery',
      'endurance',
      'cooldown',
    ]);
    expect(totalDurationS(r.plan.workout)).toBe(1320);
  });

  it('drops the rest of the warm-up when pressed during it', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 90, effort: 'hard', pattern: 'early' });
    const r = applyHardNow(plan, 100);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = layout(r.plan);
    expect(rows[0]).toMatchObject({ kind: 'warmup', start: 0, end: 100 });
    expect(rows[1]).toMatchObject({ kind: 'hardNow', start: 100 });
    // The cut warm-up ends where the ramp was at 100 s.
    const w = r.plan.workout.steps[0];
    expect(w?.kind === 'ramp' && w.powerEnd).toBeCloseTo(0.45 + ((0.75 - 0.45) * 100) / 540, 3);
    // 440 s of warm-up were freed for a 210 s block: no hard part had to go.
    expect(r.removedHardS).toBe(0);
    expect(rows.filter((x) => x.kind === 'hard')).toHaveLength(
      layout(plan).filter((x) => x.kind === 'hard').length,
    );
  });

  it('refuses inside a hard block and too close to the end', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 42, effort: 'medium', pattern: 'spread' });
    const rows = layout(plan);
    const hard = rows.find((x) => x.kind === 'hard')!;
    expect(applyHardNow(plan, hard.start + 10)).toMatchObject({ ok: false, reason: 'in-hard' });
    const cool = rows.at(-1)!;
    expect(applyHardNow(plan, cool.start + 5)).toMatchObject({ ok: false, reason: 'too-close' });
    expect(applyHardNow(plan, cool.start - 209)).toMatchObject({ ok: false, reason: 'too-close' });
    expect(applyHardNow(plan, cool.start - 210).ok).toBe(true);
    expect(applyHardNow(plan, 99999)).toMatchObject({ ok: false, reason: 'too-close' });
    expect(hardNowAvailability(plan, hard.start + 10)).toMatchObject({
      ok: false,
      reason: 'in-hard',
    });
    expect(hardNowAvailability(plan, 30)).toEqual({ ok: true });
    // Inside the inserted block as well.
    const r = applyHardNow(plan, 30);
    if (!r.ok) throw new Error('expected ok');
    expect(applyHardNow(r.plan, 60)).toMatchObject({ ok: false, reason: 'in-hard' });
    expect(r.plan.hardNowCount).toBe(1);
  });

  it('can be used many times; the length never changes', () => {
    for (const o of allOptions([10, 42, 90])) {
      let plan = generateEpisodeWorkout(o);
      const total = o.lengthMin * 60;
      const cool = cooldownOf(plan);
      let uses = 0;
      // Press every 30 s; inside a hard block or near the end it is refused.
      for (let t = 0; t < total; t += 30) {
        const r = applyHardNow(plan, t);
        if (!r.ok) continue;
        plan = r.plan;
        uses++;
        expect(totalDurationS(plan.workout)).toBe(total);
        expect(cooldownOf(plan)).toBe(cool);
        expect(validateWorkout(plan.workout).ok).toBe(true);
      }
      expect(uses).toBeGreaterThanOrEqual(1);
      expect(plan.hardNowCount).toBe(uses);
    }
  });

  it('a runner can continue the re-fitted plan at the same position', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 22, effort: 'hard', pattern: 'spread' });
    const r = applyHardNow(plan, 400.4);
    if (!r.ok) throw new Error('expected ok');
    const runner = new WorkoutRunner(r.plan.workout, {
      ftpW: 250,
      startRideS: 1000,
      positionS: 400.4,
    });
    const u = runner.update(1000);
    expect(u.label).toBe('Hard now');
    expect(u.targetPowerW).toBe(Math.round(1.2 * 250));
    expect(u.segmentRemainingS).toBeCloseTo(HARD_NOW_S - 0.4, 5);
    expect(runner.update(1010).elapsedS).toBeCloseTo(410.4, 5);
  });
});
