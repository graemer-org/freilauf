import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MAX_GHOST_CHOICES } from '../shared/contract';
import { applySettingsPatch, isGhostChoice, sanitizeSettings } from './settings';

describe('settings: ghost rider', () => {
  it('defaults: on, nothing remembered; settings from before it get the default', () => {
    expect(DEFAULT_SETTINGS.ghost).toEqual({ enabled: true, sources: {} });
    const { ghost: _drop, ...old } = structuredClone(DEFAULT_SETTINGS);
    expect(sanitizeSettings(old).ghost).toEqual({ enabled: true, sources: {} });
  });

  it('remembers a choice per route; a patch adds to the others', () => {
    let s = applySettingsPatch(DEFAULT_SETTINGS, { ghost: { sources: { 'route-a': 'last' } } });
    s = applySettingsPatch(s, { ghost: { sources: { 'route-b': 'ride:ride-2026-11-01' } } });
    expect(s.ghost.sources).toEqual({ 'route-a': 'last', 'route-b': 'ride:ride-2026-11-01' });
    s = applySettingsPatch(s, { ghost: { enabled: false } });
    expect(s.ghost).toMatchObject({ enabled: false, sources: { 'route-a': 'last' } });
  });

  it('drops invalid choices and bounds how many are kept', () => {
    const problems: string[] = [];
    const s = sanitizeSettings(
      { ghost: { enabled: 'yes', sources: { a: 'fastest', b: 'best', '': 'last', c: 'ride:' } } },
      DEFAULT_SETTINGS,
      problems,
    );
    expect(s.ghost).toEqual({ enabled: true, sources: { b: 'best' } });
    expect(problems.length).toBeGreaterThanOrEqual(4);
    const many = Object.fromEntries(
      Array.from({ length: MAX_GHOST_CHOICES + 20 }, (_, i) => [`r${i}`, 'best']),
    );
    const bounded = sanitizeSettings({ ghost: { sources: many } }).ghost.sources;
    expect(Object.keys(bounded)).toHaveLength(MAX_GHOST_CHOICES);
    expect(bounded['r0']).toBeUndefined(); // the oldest go first
    expect(bounded[`r${MAX_GHOST_CHOICES + 19}`]).toBe('best');
  });

  it('isGhostChoice', () => {
    for (const ok of ['best', 'last', 'none', 'ride:x']) expect(isGhostChoice(ok)).toBe(true);
    for (const bad of ['import', 'ride:', 7, null, `ride:${'x'.repeat(300)}`]) {
      expect(isGhostChoice(bad)).toBe(false);
    }
  });
});
