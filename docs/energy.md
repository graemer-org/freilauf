# Energy: calories, fat and carbohydrate

Freilauf estimates how much energy you used on a ride: **kilocalories**, and roughly how much of
it came from **fat** and from **carbohydrate**. This page says what is shown, how it is
computed, how accurate it is, and why it will not match your watch exactly.

Code: `packages/session/src/energy.ts` (pure, tested in `energy.test.ts`). The same per-second
calculation runs live during the ride and afterwards over the recorded ride, so the ride view,
the summary, the ride list and the `.fit` file agree.

## What is shown where

| Where                | What                                                                              |
| -------------------- | --------------------------------------------------------------------------------- |
| Ride view            | **Calories** (kcal so far) and **Fat (est.)** (grams) under the power             |
| Overlay              | Optional tiles **Calories** and **Fat (est.)** (Settings → Overlay)               |
| Summary after Finish | kcal from power, the heart-rate **cross-check**, grams of fat and of carbohydrate |
| Activity → Rides     | kcal per ride                                                                     |
| Activity → Community | the week's energy in kJ and ≈ kcal; the month line adds ≈ kcal                    |
| `.fit` export        | `total_calories` (session and laps) and `total_fat_calories` when known           |

When a ride has neither power nor a heart-rate estimate, no calorie number is shown — a dash
rather than a guess.

## How the calories are computed

### From power (the number you see)

Your trainer measures the **mechanical work** you did, in kilojoules (power × time). Your body
needs more energy than that, because only part of it ends up in the pedals: cycling has a
**gross efficiency** of roughly 20–25 % (trained cyclists usually 22–25 %). Freilauf uses
**24 %**:

```
kcal = work in kJ ÷ (4.184 × 0.24) = work in kJ × 0.996
```

4.184 is the number of kJ in a kcal. Because 4.184 × 0.24 is almost exactly 1, this is the
well-known rule of thumb **"1 kJ on the bike ≈ 1 kcal burned"**. Freilauf uses the exact
formula above everywhere (live, summary, ride list, community, `.fit`), so an hour at 200 W —
720 kJ — is **717 kcal**.

This is the most reliable estimate available on a trainer, because the work is measured rather
than guessed. Its uncertainty is your own efficiency: at 21 % the true value would be ~14 %
higher, at 25 % ~4 % lower.

### From heart rate (cross-check)

If you enter your **age** and **sex** in **Settings → Rider** (both optional), the summary also
shows a heart-rate estimate, using the published equations of **Keytel et al. (2005)** — the
variant that does not need a VO2max test:

```
men:   kcal/min = (−55.0969 + 0.6309 × HR + 0.1988 × weight + 0.2017 × age) ÷ 4.184
women: kcal/min = (−20.4022 + 0.4472 × HR − 0.1263 × weight + 0.0740 × age) ÷ 4.184
```

(HR in beats per minute, weight in kg, age in years; the equations give kJ/min, hence ÷ 4.184.)
Every second with a heart-rate reading adds its share; seconds without one add nothing, and a
negative result (very low heart rate) counts as 0.

The equations come from 115 regularly exercising adults aged 18–45, measured in the lab on a
treadmill and a cycle ergometer. They know nothing about your fitness, so they can be far off
for you; they read **too high at low heart rates** (easy spinning, warm-up, cool-down) and are
not meant for rest. That is why the power-based number is the one shown, and this one is a
cross-check. With **Prefer not to say** or without an age, it is not shown.

When a ride has **no power at all** (for example the trainer never delivered any) but heart rate,
this estimate becomes the calorie number, labelled _from heart rate_. Short trainer dropouts
inside a ride with power count as 0 W in the power estimate.

## Fat and carbohydrate (rough estimate)

The share of energy that comes from fat falls as you ride harder — the **crossover concept**
(Brooks & Mercier 1994): easy riding burns mostly fat, from moderate intensity on carbohydrate
takes over, and near and above threshold almost all energy comes from carbohydrate.

Freilauf takes the intensity from your power relative to your **FTP**, using the 30-second
average power (fuel use does not follow single-second spikes). FTP is taken as about **80 % of
VO2max** (typical for trained cyclists; it ranges from roughly 70 to 90 %), so
`% of VO2max ≈ 0.8 × power / FTP`. The share of energy from fat then follows this curve
(straight lines between the points):

| % of VO2max | ≈ % of FTP | Energy from fat |
| ----------: | ---------: | --------------: |
|  25 or less |         31 |            85 % |
|          40 |         50 |            70 % |
|          55 |         69 |            55 % |
|          65 |         81 |            40 % |
|          75 |         94 |            20 % |
|          85 |        106 |             5 % |
|  90 or more |        112 |             0 % |

The crossover (half fat, half carbohydrate) lies at about 58 % of VO2max, i.e. ~72 % of FTP. The
shape follows measurements by indirect calorimetry (Romijn et al. 1993; Achten, Gleeson &
Jeukendrup 2002; Achten & Jeukendrup 2003): fat burning peaks around 45–65 % of VO2max and
becomes negligible at about 85–90 %. Each second's energy is split by this curve and added up;
energy is turned into grams with **9.4 kcal per gram of fat** and **4.1 kcal per gram of
carbohydrate**. Protein (a few per cent) is ignored.

This depends strongly on **training status and diet** (well-trained, fat-adapted riders burn
much more fat at the same intensity; a big carbohydrate meal shifts it the other way), so the
split is a rough estimate and the app says so. The FTP used is the one stored with the ride
when it was recorded; rides from before this feature use your current FTP. Without power, no
split is shown.

## The `.fit` file

`total_calories` in the session and every lap is the power-based kcal above (it used to be the
kJ of work unchanged). `total_fat_calories` (kcal from fat) is written when the ride has its FTP
stored; older rides leave it out. The heart-rate estimate is not written to the file.

## Why the numbers differ from your watch or other apps

The big watch and app makers estimate calories from heart rate with their own algorithms (for
example the one licensed from Firstbeat). These are **not published**, so nobody else can
reproduce them. Freilauf uses only published methods, and on a trainer it prefers the measured
work over heart rate. Expect the numbers to differ — often by 10–30 %, sometimes more for
heart-rate-only estimates. Comparing your own rides with each other in Freilauf is meaningful;
the absolute value is an estimate.

## Sources

- Keytel LR, Goedecke JH, Noakes TD, et al. _Prediction of energy expenditure from heart rate
  monitoring during submaximal exercise._ J Sports Sci 2005; 23(3): 289–297.
- Brooks GA, Mercier J. _Balance of carbohydrate and lipid utilization during exercise: the
  "crossover" concept._ J Appl Physiol 1994; 76(6): 2253–2261.
- Romijn JA, Coyle EF, Sidossis LS, et al. _Regulation of endogenous fat and carbohydrate
  metabolism in relation to exercise intensity and duration._ Am J Physiol 1993; 265: E380–E391.
- Achten J, Gleeson M, Jeukendrup AE. _Determination of the exercise intensity that elicits
  maximal fat oxidation._ Med Sci Sports Exerc 2002; 34(1): 92–97.
- Achten J, Jeukendrup AE. _Maximal fat oxidation during exercise in trained men._ Int J Sports
  Med 2003; 24(8): 603–608.
- Coyle EF, Sidossis LS, Horowitz JF, Beltz JD. _Cycling efficiency is related to the percentage
  of type I muscle fibers._ Med Sci Sports Exerc 1992; 24(7): 782–788.
- Jeukendrup AE, Craig NP, Hawley JA. _The bioenergetics of world class cycling._ J Sci Med
  Sport 2000; 3(4): 414–433.
- McArdle WD, Katch FI, Katch VL. _Exercise Physiology_ (energy values of fat and carbohydrate).
