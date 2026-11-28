import { describe, expect, it } from 'vitest';
import { generateEpisodeWorkout } from '@freilauf/workouts';
import { cueWord, episodeSummary, hardNowText, parseLengthMin } from './episodeView';

describe('episode view helpers', () => {
  it('parses a custom length: whole minutes 10–180', () => {
    expect(parseLengthMin('42')).toBe(42);
    expect(parseLengthMin(' 10 ')).toBe(10);
    expect(parseLengthMin('180')).toBe(180);
    for (const bad of ['', '9', '181', '4.5', '-20', 'abc', '1e2', '0042']) {
      expect(parseLengthMin(bad), bad).toBeNull();
    }
  });

  it('turns step labels into cue words', () => {
    expect(cueWord('Hard 2/5')).toBe('hard');
    expect(cueWord('Cool-down')).toBe('cool-down');
    expect(cueWord('Recovery')).toBe('recovery');
    expect(cueWord('Zone 2')).toBe('zone 2');
  });

  it('summarises a plan at the rider’s FTP', () => {
    const plan = generateEpisodeWorkout({ lengthMin: 42, effort: 'medium', pattern: 'spread' });
    const s = episodeSummary(plan, 250);
    expect(s.duration).toBe('42 min · ends exactly with the episode');
    expect(s.warmup).toBe('4 min');
    expect(s.cooldown).toBe('4 min'); // 3:30 rounded
    expect(s.hard).toBe('3 × 4 min at 95 % FTP (238 W)');
    expect(s.load).toMatch(/^≈ \d+ TSS · \d+ kJ · avg \d+ W$/);
    const finale = episodeSummary(
      generateEpisodeWorkout({ lengthMin: 90, effort: 'hard', pattern: 'finale' }),
      200,
    );
    expect(finale.hard).toBe('6 × 3 min at 105–115 % FTP (210–230 W)');
    expect(
      episodeSummary(
        generateEpisodeWorkout({ lengthMin: 55, effort: 'easy', pattern: 'steady' }),
        200,
      ).hard,
    ).toBe('No intervals');
    expect(hardNowText(plan.options, 200)).toBe('2 min at 110 % (220 W)');
  });
});
