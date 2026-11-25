/**
 * Energy expenditure estimates: kilocalories, and how much of them came from fat and from
 * carbohydrate. Pure and deterministic; the same per-second accumulator runs live (RideSession)
 * and over a stored ride (rideEnergy), so the numbers in the ride view, the summary, the
 * history and the FIT file agree. Rider-level documentation: docs/energy.md.
 *
 * Three published methods, no proprietary ones (the heart-rate algorithms of watch makers,
 * e.g. the one licensed from Firstbeat, are not published):
 *
 * 1. From power (primary). The trainer measures the mechanical work W (kJ). The body turns
 *    food energy into work with a gross efficiency GE of about 20–25 % in cycling (trained
 *    cyclists ~22–25 %, e.g. Coyle et al. 1992, Med Sci Sports Exerc 24(7):782–788; Jeukendrup,
 *    Craig & Hawley 2000, J Sci Med Sport 3(4):414–433). So the metabolic energy is
 *    E = W / GE (kJ) = W / (4.184 × GE) kcal. With GE = 0.24 this is W × 0.996 — the
 *    reason for the rule of thumb "kJ on the bike ≈ kcal burned". We compute exactly
 *    W / (4.184 × 0.24), everywhere (live, summary, history, FIT).
 *
 * 2. From heart rate (cross-check, and the total when a ride has no power at all). Keytel
 *    et al. 2005, "Prediction of energy expenditure from heart rate monitoring during
 *    submaximal exercise", J Sports Sci 23(3):289–297, the equations without VO2max
 *    (energy expenditure in kJ/min; HR bpm, mass kg, age years):
 *      men:   −55.0969 + 0.6309·HR + 0.1988·mass + 0.2017·age
 *      women: −20.4022 + 0.4472·HR − 0.1263·mass + 0.0740·age
 *    divided by 4.184 for kcal/min. Derived from 115 regularly active adults (18–45 years)
 *    exercising on treadmill and cycle ergometer; it needs sex and age, ignores fitness and
 *    overestimates at low heart rates (it is a straight line through exercise data, so rest
 *    and easy spinning come out too high). Negative per-minute values are clamped to 0;
 *    seconds without a heart-rate reading add nothing.
 *
 * 3. Fat vs. carbohydrate (rough). The share of energy from fat falls with exercise intensity
 *    — the "crossover concept" (Brooks & Mercier 1994, J Appl Physiol 76(6):2253–2261): high at
 *    low intensity, carbohydrate predominant from moderate intensity on, almost none near and
 *    above threshold. FAT_FRACTION_CURVE follows the shape of indirect-calorimetry data
 *    (Romijn et al. 1993, Am J Physiol 265:E380–E391; Achten, Gleeson & Jeukendrup 2002, Med Sci
 *    Sports Exerc 34(1):92–97; Achten & Jeukendrup 2003, Int J Sports Med 24(8):603–608: fat
 *    oxidation peaks at ~45–65 % VO2max and becomes negligible at ~85–90 % VO2max). Intensity
 *    is taken from power relative to FTP: %VO2max ≈ FTP_FRACTION_OF_VO2MAX × power/FTP, with
 *    FTP at ~80 % of VO2max (typical of trained cyclists; it ranges ~70–90 %), using the
 *    30 s trailing mean power (substrate use does not follow second-by-second spikes).
 *    Energy is turned into grams with 9.4 kcal/g for fat and 4.1 kcal/g for carbohydrate
 *    (heats of combustion as used in exercise physiology, e.g. McArdle, Katch & Katch,
 *    "Exercise Physiology"); protein (a few per cent) is ignored. Depends strongly on training
 *    status and diet: a rough estimate only.
 */

/** Gross efficiency of cycling assumed for the power-based estimate (plausible 0.20–0.25). */
export const GROSS_EFFICIENCY = 0.24;
/** Thermochemical calorie: kJ per kcal. */
export const KJ_PER_KCAL = 4.184;
/** Metabolic kcal per kJ of mechanical work: 1 / (4.184 × 0.24) ≈ 0.9959. */
export const KCAL_PER_KJ_WORK = 1 / (KJ_PER_KCAL * GROSS_EFFICIENCY);
/** Energy per gram oxidised (kcal/g). */
export const FAT_KCAL_PER_G = 9.4;
export const CARB_KCAL_PER_G = 4.1;
/** FTP as a fraction of the power at VO2max, for the intensity proxy. */
export const FTP_FRACTION_OF_VO2MAX = 0.8;
/** Trailing window (s) of the power that sets the intensity for the substrate split. */
export const SUBSTRATE_WINDOW_S = 30;
/** Longest interval (s) one sample may count for — the same guard as the ride summary. */
export const MAX_SAMPLE_DT_S = 5;

/**
 * Keytel et al. (2005) coefficients without VO2max; result in kJ/min.
 * `[intercept, per bpm, per kg, per year]`.
 */
export const KEYTEL_2005 = {
  male: [-55.0969, 0.6309, 0.1988, 0.2017],
  female: [-20.4022, 0.4472, -0.1263, 0.074],
} as const satisfies Record<'male' | 'female', readonly [number, number, number, number]>;

/**
 * Share of energy from fat at an intensity (% of VO2max): points of a piecewise-linear curve,
 * constant outside. Shaped on the data cited in the module comment: ~85 % fat at very low
 * intensity, crossover (50 %) at ~58 % VO2max (≈ 72 % FTP), ~12 % at FTP, 0 from 90 %
 * VO2max (≈ 112 % FTP) on.
 */
export const FAT_FRACTION_CURVE: readonly (readonly [number, number])[] = [
  [25, 0.85],
  [40, 0.7],
  [55, 0.55],
  [65, 0.4],
  [75, 0.2],
  [85, 0.05],
  [90, 0],
];

export type EnergySex = 'female' | 'male';

/** What the estimates need to know about the rider. */
export interface EnergyProfile {
  /** Rider mass (kg); needed for the heart-rate estimate. */
  massKg: number;
  /** Needed for the heart-rate estimate; absent/null = no heart-rate estimate. */
  ageYears?: number | null;
  /** Needed for the heart-rate estimate; anything but 'female'/'male' = no estimate. */
  sex?: string | null;
  /** Needed for the fat/carbohydrate split; absent/null = no split. */
  ftpW?: number | null;
}

export interface EnergyTotals {
  /**
   * The estimate to show: from power when the ride has measured power, otherwise from heart
   * rate when that estimate exists, otherwise null (nothing is shown).
   */
  kcal: number | null;
  /** Which method `kcal` comes from. */
  source: 'power' | 'heartRate' | null;
  /** From the mechanical work; null while no power above 0 W was measured. */
  kcalPower: number | null;
  /** Keytel et al. (2005); null without heart rate, age, sex or mass. */
  kcalHr: number | null;
  /** Energy from fat (kcal) and grams of fat and carbohydrate; null without power or FTP. */
  fatKcal: number | null;
  fatG: number | null;
  carbG: number | null;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Metabolic kcal for mechanical work in kJ (see GROSS_EFFICIENCY). */
export function kcalFromWorkKj(workKj: number): number {
  return fin(workKj) && workKj > 0 ? workKj * KCAL_PER_KJ_WORK : 0;
}

/**
 * Keytel et al. (2005) energy expenditure in kcal/min, clamped at 0; null when an input is
 * missing or invalid (heart rate ≤ 0, sex not 'female'/'male', …).
 */
export function keytelKcalPerMin(
  heartRateBpm: number | null | undefined,
  massKg: number | null | undefined,
  ageYears: number | null | undefined,
  sex: string | null | undefined,
): number | null {
  if (sex !== 'male' && sex !== 'female') return null;
  if (!fin(heartRateBpm) || heartRateBpm <= 0) return null;
  if (!fin(massKg) || massKg <= 0 || !fin(ageYears) || ageYears <= 0) return null;
  const [c0, cHr, cW, cA] = KEYTEL_2005[sex];
  const kjPerMin = c0 + cHr * heartRateBpm + cW * massKg + cA * ageYears;
  return Math.max(0, kjPerMin) / KJ_PER_KCAL;
}

/** Share of energy from fat (0 … 0.85) at an intensity in % of VO2max. Non-increasing. */
export function fatFractionAtVo2(percentVo2max: number): number {
  const pts = FAT_FRACTION_CURVE;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (!fin(percentVo2max) || percentVo2max <= first[0]) return first[1];
  if (percentVo2max >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    if (percentVo2max <= x1) {
      const [x0, y0] = pts[i - 1]!;
      return y0 + ((y1 - y0) * (percentVo2max - x0)) / (x1 - x0);
    }
  }
  return last[1];
}

/** Share of energy from fat at a power relative to FTP (1 = at FTP). */
export function fatFractionAtFtp(fractionOfFtp: number): number {
  return fatFractionAtVo2(100 * FTP_FRACTION_OF_VO2MAX * (fin(fractionOfFtp) ? fractionOfFtp : 0));
}

/** One second (or `dtS` seconds) of riding. */
export interface EnergyInput {
  powerW: number | null | undefined;
  heartRateBpm: number | null | undefined;
  dtS: number;
}

/**
 * Accumulates the estimates sample by sample. Feed it the recorded samples in order (live:
 * each new sample as it is recorded; afterwards: rideEnergy does it over the stored ride).
 */
export class EnergyAccumulator {
  readonly #profile: EnergyProfile;
  #workKj = 0;
  #measuredPower = false;
  #kcalHr = 0;
  #hrSeen = false;
  #fatKcal = 0;
  #window: number[] = [];
  #windowSum = 0;

  constructor(profile: EnergyProfile) {
    this.#profile = profile;
  }

  add(input: EnergyInput): void {
    const dtS = fin(input.dtS) ? Math.min(MAX_SAMPLE_DT_S, Math.max(0, input.dtS)) : 0;
    const p = fin(input.powerW) ? Math.max(0, input.powerW) : 0;
    if (p > 0) this.#measuredPower = true;

    // Trailing mean power over the last SUBSTRATE_WINDOW_S samples (1 Hz).
    this.#window.push(p);
    this.#windowSum += p;
    if (this.#window.length > SUBSTRATE_WINDOW_S) this.#windowSum -= this.#window.shift()!;
    const meanW = this.#windowSum / this.#window.length;

    const workKj = (p * dtS) / 1000;
    this.#workKj += workKj;
    const ftp = this.#profile.ftpW;
    if (fin(ftp) && ftp > 0) {
      this.#fatKcal += kcalFromWorkKj(workKj) * fatFractionAtFtp(meanW / ftp);
    }

    const perMin = keytelKcalPerMin(
      input.heartRateBpm,
      this.#profile.massKg,
      this.#profile.ageYears,
      this.#profile.sex,
    );
    if (perMin !== null) {
      this.#hrSeen = true;
      this.#kcalHr += (perMin * dtS) / 60;
    }
  }

  totals(): EnergyTotals {
    const kcalPower = this.#measuredPower ? kcalFromWorkKj(this.#workKj) : null;
    const kcalHr = this.#hrSeen ? this.#kcalHr : null;
    const ftp = this.#profile.ftpW;
    const split = kcalPower !== null && fin(ftp) && ftp > 0;
    const fatKcal = split ? Math.min(this.#fatKcal, kcalPower) : null;
    const source = kcalPower !== null ? 'power' : kcalHr !== null ? 'heartRate' : null;
    return {
      kcal: kcalPower ?? kcalHr,
      source,
      kcalPower,
      kcalHr,
      fatKcal,
      fatG: fatKcal !== null ? fatKcal / FAT_KCAL_PER_G : null,
      carbG:
        fatKcal !== null && kcalPower !== null ? (kcalPower - fatKcal) / CARB_KCAL_PER_G : null,
    };
  }
}

/** Samples as recorded (RideSample has these fields). */
export interface EnergySample {
  elapsedS: number;
  powerW: number;
  heartRateBpm: number | null;
}

/**
 * The estimates over recorded samples. Time per sample comes from `elapsedS` like the ride
 * summary's work (1 s at 1 Hz, at most MAX_SAMPLE_DT_S; 1 s when elapsedS is unusable).
 */
export function energyOfSamples(
  samples: readonly EnergySample[],
  profile: EnergyProfile,
): EnergyTotals {
  const acc = new EnergyAccumulator(profile);
  let prev = 0;
  for (const s of samples) {
    let dtS = 1;
    if (fin(s.elapsedS)) {
      dtS = s.elapsedS - prev;
      prev = s.elapsedS;
    }
    acc.add({ powerW: s.powerW, heartRateBpm: s.heartRateBpm, dtS });
  }
  return acc.totals();
}

/**
 * The estimates of a stored ride. Mass and FTP come from the ride (as they were when it was
 * recorded); age and sex, which a ride does not store, from `rider`.
 */
export function rideEnergy(
  ride: { riderMassKg: number; ftpW?: number | null; samples: readonly EnergySample[] },
  rider: { ageYears?: number | null; sex?: string | null; ftpW?: number | null } = {},
): EnergyTotals {
  return energyOfSamples(ride.samples, {
    massKg: ride.riderMassKg,
    ageYears: rider.ageYears ?? null,
    sex: rider.sex ?? null,
    ftpW: fin(ride.ftpW) && ride.ftpW > 0 ? ride.ftpW : (rider.ftpW ?? null),
  });
}
