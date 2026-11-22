/** Returns uniformly distributed numbers in [0, 1). */
export type RandomSource = () => number;

/** Small, fast, seedable PRNG (mulberry32). Same seed → same sequence. */
export function createSeededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Smooth, zero-mean noise: an Ornstein-Uhlenbeck process (mean-reverting
 * random walk). `amplitude` is the stationary standard deviation,
 * `timeConstantS` how quickly it wanders.
 */
export class SmoothNoise {
  private value = 0;
  private readonly random: RandomSource;
  private readonly amplitude: number;
  private readonly timeConstantS: number;

  constructor(random: RandomSource, amplitude: number, timeConstantS: number) {
    this.random = random;
    this.amplitude = amplitude;
    this.timeConstantS = timeConstantS;
  }

  step(dtS: number): number {
    if (this.amplitude === 0 || dtS <= 0) return this.value;
    const decay = Math.exp(-dtS / this.timeConstantS);
    // Uniform in [-√3, √3) has unit variance.
    const shock = (this.random() * 2 - 1) * Math.sqrt(3);
    this.value = this.value * decay + this.amplitude * Math.sqrt(1 - decay * decay) * shock;
    return this.value;
  }

  get current(): number {
    return this.value;
  }
}
