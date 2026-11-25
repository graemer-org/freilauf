/**
 * Scene colours, derived from the app's design tokens so the illustration
 * follows the light and dark themes. Every tone is a mix of the surface and
 * the text colour (plus the accent for the jersey and the profile), so the
 * scene stays as restrained as the rest of the UI.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parses the forms a canvas normalises colours to: #rrggbb and rgba(r, g, b, a). */
export function parseColor(css: string): Rgb | null {
  const s = css.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const short = /^#([0-9a-f]{3})$/i.exec(s);
  if (short) {
    const [r, g, b] = short[1]!.split('').map((c) => Number.parseInt(c + c, 16));
    return { r: r!, g: g!, b: b!, a: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
    s,
  );
  if (fn) {
    const alpha =
      fn[4] === undefined
        ? 1
        : fn[4].endsWith('%')
          ? Number.parseFloat(fn[4]) / 100
          : Number(fn[4]);
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: alpha };
  }
  return null;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: 1,
  };
}

export const css = (c: Rgb, alpha = 1): string =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;

export interface ScenePalette {
  dark: boolean;
  skyTop: string;
  skyBottom: string;
  clouds: string;
  farHills: string;
  nearHills: string;
  field: string;
  trees: string;
  treesFar: string;
  road: string;
  roadEdge: string;
  roadMark: string;
  verge: string;
  shadow: string;
  ink: string;
  ink2: string;
  ink3: string;
  frame: string;
  frameFar: string;
  tyre: string;
  spokes: string;
  jersey: string;
  jerseyFar: string;
  shorts: string;
  skin: string;
  skinFar: string;
  ghost: string;
  ghostJersey: string;
  accent: string;
  profileFill: string;
  profileLine: string;
  wash: string;
  surface: string;
  /** Power-ups: the gate and cue line (the accent), its soft glow, and light streaks. */
  boost: string;
  boostGlow: string;
  boostFaint: string;
  streak: string;
  /** Freilauf Rumble: hits (the splash), the rain cape and protection, the haze of hornets. */
  attack: string;
  attackFaint: string;
  guard: string;
  guardFill: string;
  guardFaint: string;
  haze: string;
  /** Rumble items: water (bottle, splash), mud (puddle, spatter), hornets, the feed bag. */
  water: string;
  waterFaint: string;
  mud: string;
  mudFill: string;
  mudFaint: string;
  hornet: string;
  bag: string;
  bagLine: string;
}

const FALLBACK_LIGHT = {
  surface: '#ffffff',
  text: '#1b1b1f',
  text2: '#63636b',
  text3: '#a3a3aa',
  accent: '#0b63d1',
  attack: '#b4561f',
  guard: '#14857a',
  water: '#2f86d6',
  mud: '#7a5636',
  hornet: '#c98a12',
};

/**
 * Builds the palette from resolved token values. `normalise` turns any CSS
 * colour into #rrggbb / rgba() (a canvas does that); unknown values fall
 * back to the light theme.
 */
export function buildPalette(
  tokens: {
    surface: string;
    text: string;
    text2: string;
    text3: string;
    accent: string;
    attack?: string;
    guard?: string;
    water?: string;
    mud?: string;
    hornet?: string;
  },
  normalise: (css: string) => string = (c) => c,
): ScenePalette {
  const read = (v: string, fb: string): Rgb =>
    parseColor(normalise(v || fb)) ?? parseColor(fb) ?? { r: 0, g: 0, b: 0, a: 1 };
  const surface = read(tokens.surface, FALLBACK_LIGHT.surface);
  const ink = read(tokens.text, FALLBACK_LIGHT.text);
  const ink2 = read(tokens.text2, FALLBACK_LIGHT.text2);
  const ink3 = read(tokens.text3, FALLBACK_LIGHT.text3);
  const accent = read(tokens.accent, FALLBACK_LIGHT.accent);
  const attack = read(tokens.attack ?? '', FALLBACK_LIGHT.attack);
  const guard = read(tokens.guard ?? '', FALLBACK_LIGHT.guard);
  const water = read(tokens.water ?? '', FALLBACK_LIGHT.water);
  const mud = read(tokens.mud ?? '', FALLBACK_LIGHT.mud);
  const hornet = read(tokens.hornet ?? '', FALLBACK_LIGHT.hornet);
  const lum = (c: Rgb): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const dark = lum(surface) < lum(ink);
  const tone = (t: number): string => css(mix(surface, ink, t));
  return {
    dark,
    surface: css(surface),
    skyTop: css(surface),
    skyBottom: tone(dark ? 0.05 : 0.035),
    clouds: dark ? tone(0.075) : tone(0.04),
    farHills: tone(dark ? 0.08 : 0.065),
    nearHills: tone(dark ? 0.11 : 0.095),
    field: tone(dark ? 0.06 : 0.045),
    treesFar: tone(dark ? 0.14 : 0.13),
    trees: tone(dark ? 0.2 : 0.19),
    road: tone(dark ? 0.15 : 0.13),
    roadEdge: tone(dark ? 0.3 : 0.28),
    roadMark: dark ? tone(0.42) : css(surface),
    verge: tone(dark ? 0.09 : 0.075),
    shadow: dark ? 'rgba(0, 0, 0, 0.42)' : css(ink, 0.16),
    ink: css(ink),
    ink2: css(ink2),
    ink3: css(ink3),
    frame: css(ink),
    frameFar: tone(0.62),
    tyre: css(ink),
    spokes: css(ink, 0.55),
    jersey: css(accent),
    jerseyFar: css(mix(accent, surface, 0.38)),
    shorts: css(ink),
    skin: tone(dark ? 0.55 : 0.36),
    skinFar: tone(dark ? 0.36 : 0.24),
    ghost: tone(dark ? 0.32 : 0.3),
    ghostJersey: tone(dark ? 0.42 : 0.42),
    accent: css(accent),
    profileFill: css(accent, dark ? 0.2 : 0.13),
    profileLine: css(accent),
    wash: css(surface, 0.45),
    boost: css(accent, dark ? 0.95 : 0.9),
    boostGlow: css(accent, dark ? 0.26 : 0.18),
    boostFaint: css(accent, dark ? 0.12 : 0.08),
    streak: css(ink, dark ? 0.24 : 0.16),
    attack: css(attack, dark ? 0.9 : 0.85),
    attackFaint: css(attack, dark ? 0.35 : 0.28),
    guard: css(guard, dark ? 0.85 : 0.8),
    guardFill: css(guard, dark ? 0.12 : 0.08),
    guardFaint: css(guard, dark ? 0.35 : 0.3),
    haze: css(mix(surface, ink, dark ? 0.12 : 0.04), dark ? 0.62 : 0.68),
    water: css(water, 0.9),
    waterFaint: css(water, dark ? 0.3 : 0.22),
    mud: css(mud),
    mudFill: css(mix(mud, surface, dark ? 0.15 : 0.1), 0.88),
    mudFaint: css(mud, dark ? 0.45 : 0.35),
    hornet: css(hornet),
    bag: css(mix(surface, ink, dark ? 0.75 : 0.06)),
    bagLine: css(ink, dark ? 0.55 : 0.7),
  };
}
