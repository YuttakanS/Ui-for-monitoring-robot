# copy firmware (Raspberry Pi Pico): 9 LEDs, height z, on/off from the web page

Pairs with the web page on `feature/task-2-ui-3d` and later (the page reads z).
It estimates position, height and orientation with an EKF from 3 photodiodes
and sends:

```
Quadrant <n>: <x cm>, <y cm>, <orientation deg>, <z cm>
```

`z` is the robot's height above its place on the floor (0 = on the floor; the
photodiodes are then 1 cm above the floor and 92 cm below the LEDs). Older
pages that expect 3 values do not read this line; pages from
`feature/task-2-ui-3d` on read both the 3- and 4-value lines.

## EKF state
`x, vx, y, vy, theta, omega, z, vz` (8 values; z and vz were added at the end,
so the others keep their index). `A`, `P`, `Q`, `R` are filled in `initEkf()`;
z / vz use the same `P` and `Q` as x / y.

- `ESTIMATE_Z = true` since 2026-11-19 (task #2 z axis); `false` keeps z at 0
  (robot always on the floor), as before. See "z axis" below for how
  accurate z can be.
- z is kept between `Z_MIN` (0, the floor; it was −5 cm until 2026-11-19 to
  leave room for noise, but the user wanted no negative z) and `Z_MAX`
  (80 cm); near the LEDs the path-loss model blows up. When the model
  would put the robot below the floor, z sits at 0 and x / y take up the
  difference, as with `ESTIMATE_Z = false`.

## LEDs (92 cm above the photodiodes)

| Row in `p` | LED | Position (cm) | Frequency | On at power-up |
|---|---|---|---|---|
| 0 | LED 4 | (0, 0) | 2300 Hz | no |
| 1 | LED 5 | (-50, 0) | 2900 Hz | no |
| 2 | LED 7 | (0, 50) | 3700 Hz | yes |
| 3 | LED 8 | (-50, 50) | 4100 Hz | yes |
| 4 | LED 1 | (0, -50) | 1300 Hz | yes |
| 5 | LED 2 | (-50, -50) | 1700 Hz | yes |
| 6 | LED 0 | (50, -50) | 1100 Hz | no |
| 7 | LED 3 | (50, 0) | 1900 Hz | no |
| 8 | LED 6 | (50, 50) | 3100 Hz | no |

Layout seen from above (+X right, +Y up), LED 4 at the origin:

```
8--7--6    y = +50
5--4--3    y =   0
2--1--0    y = -50
```

- `m = 1.0`. The LEDs are Cree XLamp CMA1306, viewing angle (FWHM)
  115–116°, so m ≈ 1.1, close to 1. A trial with `m = 0.55` (commit
  1e0106c) was reverted before it was measured on the board; see
  "Calibration results" below.
- `be = 55°`: the pyramid faces with the photodiodes measure 35° from the
  floor, so each normal is 55° above it (was 60°, a 30° face).
- The model is `RSS = PtxGamma[k] * PD_GAIN[l] * h + RSS_OFFSET` (the last
  two were added on 2026-11-19, see "z axis" below). `PtxGamma` for LED 7,
  8, 1, 2, `PD_GAIN` and `RSS_OFFSET` are fitted together from
  `calib/ra_calib_20261119_130953.csv`. LED 0, 3, 6 (off for now) keep the
  placeholder 0.46; LED 4, 5 (not lit) keep 0.49.
- The frequencies of LED 0, 3 and 6 (1100 / 1900 / 3100 Hz) were checked
  against the real LED drivers on 2026-11-19 and match `Fref`.

## Calibrating `PtxGamma`
Each LED's `PtxGamma` (its brightness times the photodiode and ADC gain) is
fitted from RSS values taken with the robot at known poses, using
`calibrate.html` in the repo root (Chrome or Edge, Web Serial). The page
repeats the path-loss model of this file in `calibrate.js`; `npm test`
checks that its constants still match this file.

1. Temporarily set `mode = 3` (RSS line + position line) and
   `ESTIMATE_Z = false`, then upload. RSS is printed with 4 decimals.
2. Close the Position Monitor page, open `calibrate.html`, pick the LEDs
   that are lit (default LED 1, 2, 7, 8) and connect. The page switches
   those on and the rest off in the firmware (`LED <n> <0|1>`).
3. Put the robot on the floor at **theta = 0**: the photodiode on pin
   **GP28** (`pins[0]`) faces **+X**. Keep room light the same throughout.
4. Record the suggested poses, 30 lines each: the 50 cm grid points inside
   the box around the lit LEDs plus the centre of each cell (8 poses for
   LED 1, 2, 7, 8; 13 for all 9). Re-record a pose whose spread is red (the
   robot moved). Poses where an LED reads 0 (it was off) are left out of
   that LED's fit.
5. Export the CSV as a record, copy the 3 lines (`PtxGamma`, `PD_GAIN`,
   `RSS_OFFSET`) into this file and into `calibrate.js` (`CURRENT_GAMMA`,
   `PD_GAIN`, `RSS_OFFSET`; `npm test` checks they match), set `mode = 2`
   again and upload. With fewer than 4 poses only the gammas are fitted.
6. Check: at a pose not among the suggested ones (e.g. (-25, 0)), the
   Position Monitor should show x / y within about 3 cm; then try
   `ESTIMATE_Z = true`, and a robot on the floor should read z ~ 0.

In the result table, PD0–PD2 is how much each photodiode reads above (+) or
below (−) the model (with `PD_GAIN`) on average. If one is still off by
more than 5 % for every LED, note it down. LEDs that are not fitted keep
their old value.

## Calibration results

### 2026-11-19: interim, LED 1, 2, 7, 8 (`calib/ra_calib_20261119_111822.csv`)
8 poses at theta = 0, 100 RSS lines each, firmware in `mode = 1`.
Fitted without (−25, −25), m = 1:

| LED | Old γ | New γ | Misfit (rms) | PD0 / PD1 / PD2 bias |
|---|---|---|---|---|
| 7 | 0.46 | 0.453 | 14.8 % | +12 / −7 / +7 % |
| 8 | 0.46 | 0.436 | 11.4 % | +12 / −2 / +1 % |
| 1 | 0.46 | 0.536 | 18.9 % | +19 / +10 / −2 % |
| 2 | 0.46 | 0.504 | 12.3 % | +14 / 0 / −3 % |

- **(−25, −25) left out:** PD2 read 34–57 % of the model for every LED,
  the same when recorded again, and no other pose or heading explains it.
  The user found nothing shading it. **Recorded again at 13:09
  (`calib/ra_calib_20261119_130953.csv`), it reads normally** (0.81–1.10
  of the model on every photodiode), so the earlier readings were
  temporary, most likely a loose PD2 wire or connector. Fitting all 8
  poses gives LED 7 0.454, LED 8 0.436, LED 1 0.536, LED 2 0.501, within
  0.6 % of the gammas in use, so they are kept.
- **Far LEDs read about 21 % above the model** (distance > 1.25 m), near
  ones match. The LEDs seem wider than m = 1 (half-power angle 60°):
  m ≈ 0.45 (about 78°) brings the misfit down to 9 %. Not changed, since
  m is also the EKF's model; check the LED datasheet first. Meanwhile,
  positions at the edge (y = ±50) are likely pulled about 8–10 cm towards
  the centre.
- The "spread" column (max − min over the lines) read 44–177 % at every
  pose, too sensitive to tell noise from a robot that moved.

### 2026-11-19: position check with the interim gammas (`calib/validate_20261119/`)
Firmware from commit 13f330e (`mode = 2`, `ESTIMATE_Z = false`, LED 1, 2,
7, 8 on), robot at theta = 0, about 20 s per pose with REC on the
Position Monitor (3.0 Hz). Mean of the second half of each file (after
the EKF settled):

| True (x, y) cm | Shown (x, y) cm | Error | Fit pose? |
|---|---|---|---|
| (−25, 50) | (−24.5, 50.3) | 0.6 cm | no |
| (−25, −50) | (−24.0, −49.4) | 1.2 cm | no |
| (−25, −25) | (−26.3, −23.8) | 1.8 cm | left out |
| (−50, −50) | (−48.2, −49.4) | 2.0 cm | yes |
| (0, 0) | (−2.4, 1.1) | 2.6 cm | yes |
| (−50, 0) | (−47.2, −0.3) | 2.8 cm | yes |
| (0, 50) | (−2.2, 53.4) | 4.1 cm | yes |
| (−50, 50) | (−44.0, 49.9) | 6.0 cm | yes |
| (0, −50) | (−6.2, −48.7) | 6.3 cm | yes |
| (25, 25) | (−20.3, 17.0) | 46 cm | outside the lit LEDs |

- Inside the lit area (x from −50 to 0) the error is 0.6–6.3 cm, about
  3 cm on average, with a spread (std) under 0.5 cm.
- x is pulled towards the middle of the lit LEDs (x = −25): x = 0 reads
  2–6 cm low, x = −50 reads 2–6 cm high.
- (25, 25) is 25 cm beyond the lit LEDs (LED 0, 3, 6 off), where the
  position cannot be found.
- After the robot is moved, the EKF takes 10–20 s to settle (Q = 1e-6).

### 2026-11-19: trial m = 0.55 (same calibration data)
More poses with m = 1 would not help much: the misfit comes from the
model. Leave-one-out on the 7 calibration poses (fit on 6, find the pose
of the 7th from its RSS without the EKF):

| Model | Mean error | Max error |
|---|---|---|
| m = 1, gamma only (before) | 7.9 cm | 15.7 cm |
| m = 1 + per-photodiode gain | 8.3 cm | 14.5 cm |
| **m fitted (≈ 0.55) + gamma** | **4.1 cm** | **7.3 cm** |
| m fitted + per-photodiode gain | 4.5 cm | 6.1 cm |

So `m = 0.55` with gammas LED 7 0.564, LED 8 0.542, LED 1 0.663, LED 2
0.620 (RSS misfit 7–11 %, 9.5 % overall, was 15 %). Per-photodiode gain
does not help, so it is not added.

**Reverted (2026-11-19):** the user chose the version with the smallest
error measured on the board, which is m = 1 with the interim gammas
(about 3 cm, table above). m = 0.55 was never measured on the board; it
can be tried again from commit 1e0106c.

The LED datasheet (Cree XLamp CMA1306, FWHM 115–116°, half-power angle
57.5–58°) gives m ≈ 1.1, so the LEDs are not wider than m = 1 and
m = 0.55 does not match the hardware. The far LEDs reading high more
likely comes from reflections (floor, walls, ceiling), which add about
the same light everywhere and so weigh more where the direct light is
weak.

### 2026-11-19: photodiode tilt be = 55° (measured)
The pyramid faces measure 35° from the floor; the code assumed 30°
(`be = M_PI / 3`). Refitted on the 8 poses of
`calib/ra_calib_20261119_130953.csv` (m = 1), finding each pose from its
RSS without the EKF:

| Face tilt | `be` | RSS misfit | Position error, leave-one-out (mean / max) |
|---|---|---|---|
| 30° (before) | 60° | 9.6 % | 6.7 / 14.2 cm |
| **35° (measured, now)** | **55°** | 10.8 % | **5.9 / 11.3 cm** |

New gammas: LED 7 0.476, LED 8 0.457, LED 1 0.562, LED 2 0.525. On the
board the user saw errors of about 1–2 cm, rarely 3 cm (by eye on the
Position Monitor, 2026-11-19; no CSV recorded), against about 3 cm on
average before. `rotate` has not been repeated yet.

### 2026-11-19: the professor's firmware for comparison
`firmware/copy2/copy2.ino` on `feature/task-2-ui-6led-off45` (m = 1,
gamma applied twice, gammas 0.51, 0.51, 0.44, 0.46): the user measured
about ±10 cm on the board, against about 3 cm for this firmware. With
the same RSS data, its model also gives about twice the error (16.5 cm
against 8.3 cm mean, solving each pose without the EKF).

## On/off commands
The web page (or the Serial Monitor) sends one line per command:

```
LED <number> <0|1>     e.g.  LED 4 1
```

The board answers `# LED <number> <0|1>`. An LED that is off is not demodulated
and adds nothing to the EKF update. This does not power the LED itself off.

```
TIMING <0|1>           e.g.  TIMING 1
```

The board answers `# TIMING <0|1>`. While it is on, every loop ends with

```
# T wait=31.0 demod=12.0 ekf=6.9 total=50.1
```

(numbers here are only an example): the ms spent waiting for the next
sample window (sampling runs all the time; it was `sample=` when each loop
collected its own window),
demodulating and in the EKF, and the whole loop. The web pages skip lines
that start with `#`, so use the Serial Monitor to read them.

## Update rate (2026-11-19, branch `feature/task-2-realtime`)
One update took about 0.33 s (3.0 Hz) with LED 1, 2, 7, 8: 0.1 s to collect
2500 samples at 25 kHz and the rest to compute, on a Pico without an FPU.
The sample window is unchanged; the computing was made lighter.

**Measured on the board (2026-11-19, LED 1, 2, 7, 8, `mode = 2`,
`ESTIMATE_Z = true`, `TIMING 1`):** one update takes **119.2 ms (8.4 Hz)**:
sampling 100.0 ms, demodulation 12.0 ms, EKF 6.9 ms, the rest printing.
Computing fell from about 230 ms to about 19 ms; 84 % of an update was then
the sample window itself.

**Continuous sampling (branch `feature/task-2-continuous-sampling`):** the
timer now samples all the time into a ring buffer of `RING_N` = 2 × N
samples per photodiode, and `loop()` demodulates the newest N samples every
`UPDATE_EVERY` = 1250 samples (50 ms, **20 Hz**). Each RSS still averages
0.1 s of signal, so its noise is unchanged, but consecutive windows share
half their samples: two updates in a row are not independent, and the EKF
(which assumes they are) trusts them a little more than it should. The
`# T` line now starts with `wait=` (time waiting for the next window)
instead of `sample=`. If a loop ever takes longer than 50 ms the next
window is taken at once, so the rate drops instead of lagging behind the
newest samples. **Not yet measured on the board.** For a different rate
change `UPDATE_EVERY` (samples; 25 000 / `UPDATE_EVERY` = Hz) and keep
`RING_N - N` well above the samples taken during one demodulation (~300).

- **Demodulation by table.** Every LED frequency is a multiple of 100 Hz
  (`F_STEP`), so at 25 kHz every reference repeats after 250 samples
  (`LUT_N`). One sin and one cos table of 250 values, built once, replaces
  the 2 × 2500 calls of `sin()` / `cos()` per LED and loop, and the sums are
  kept in integers. **A new LED frequency must be a multiple of 100 Hz**, and
  `N` a multiple of 250. Against exact arithmetic the table is within 1e-5
  of the RSS; the earlier single-precision loop was within about 2e-4, so
  the RSS can move in the 4th decimal.
- **Lighter path-loss function.** Same formula in single precision, without
  matrix temporaries or `pow()`; cos / sin of the heading are worked out
  once per shifted state instead of once per LED and photodiode.
- **EKF correction one value at a time** (`EKF_SEQUENTIAL = true`), for lit
  LEDs only, instead of inverting a 27×27 matrix. With a diagonal `R` and
  the Jacobian and prediction taken once at the predicted state, this gives
  the same state and covariance as before; Joseph form is kept.
  `EKF_SEQUENTIAL = false` runs the earlier update, to compare on the board.
- **`Q` follows the update period:** `Q = Q0 * T / T_REF`, `T_REF` = 0.33 s
  (the period when `Q0` was tuned). `Q` is added once per update, so without
  this, faster updates would mean more process noise per second. In a
  single-precision replica on the PC (robot still, RSS noise 0.02), x jitter
  was 0.43 cm at 3 Hz, 0.56 cm at 8 Hz with `Q` unscaled and 0.49 cm scaled.
- `tests/firmware-math.test.js` repeats the table demodulation and both EKF
  updates in JS and checks they agree. It does not compile the `.ino`.

## z axis (2026-11-19)
Checked on the PC first with `solvePose()` in `calibrate.js` (where the EKF
settles for a still robot), on the 8 floor poses of
`calib/ra_calib_20261119_130953.csv`, each solved with a model fitted
without that pose (leave one out):

| Model | Fit misfit | x / y error, z off | x / y error, z on | z on the floor |
|---|---|---|---|---|
| gamma only (before) | 12–18 % | 5.9 cm | 5.6 cm | rms 2.7 cm, −5.0 (limit) to +1.9 |
| **+ `PD_GAIN` + `RSS_OFFSET` (now)** | **8–10 %** | **3.6 cm** | **3.5 cm** | **rms 2.3 cm**, −5.0 (limit) to +2.2 |

Also tried: an offset per LED, `PD_GAIN` only, offset only; none was better
on both x / y and z. (PC numbers for x / y have always been larger than on
the board, where the old model gave about 1–3 cm.)

- **How accurate z can be:** raising the robot 1 cm changes the RSS by only
  about 0.8 % (0.07 % at a far corner such as (−50, 50)), so a 5 %
  brightness error in the model reads as about 6 cm of z. At (0, 0), z reads
  about −6 cm with every model tried (held at `Z_MIN`, then −5 cm); no single
  value there looks wrong. Absolute z within 1–2 cm would need the model
  right to about 2 %.
- **Height changes are clear:** lifting 30 cm raises the total RSS by about
  20–36 % inside the 4 lit LEDs.
  Zero z on the web page where the robot stands and read the change.
- The model assumes the robot is level. Held tilted, z, x and y are off.

## Notes
- **z depends on `PtxGamma` being right.** A brighter LED looks like a closer
  one, so a gamma error shows up as height: in a host simulation, LEDs 10 %
  brighter than `PtxGamma` gave z = 7 cm for a robot on the floor. Calibrate
  first; a robot lying on the floor should then read z ~ 0.
- If the robot never leaves the floor, z adds one more unknown and can make
  x / y noisier; set `ESTIMATE_Z = false` then.
- The double gamma factor is fixed here (`pathLossWithoutGamma()` no longer
  multiplies by `PtxGamma`).
- Not yet compiled for the Pico or tested on the board. It was compiled and
  run on a PC with stand-ins for BasicLinearAlgebra, Arduino and the Pico SDK,
  with the ADC fed the signal of the 9 LEDs at a known pose (ADC noise 1.5
  counts). After 50 loops (10 s at T = 0.2 s), with `PtxGamma` exact:

  | True (x, y, z) cm, theta | Estimate (x, y, z) cm, theta |
  |---|---|
  | (20, -10, 0), 30° | (19.8, -9.7, 0.4), 29.6° |
  | (20, -10, 15), 30° | (19.3, -9.6, 15.9), 29.8° |
  | (-30, 25, 30), -60° | (-29.8, 24.1, 31.8), -60.4° |
  | (0, 0, 40), 90° | (0.0, 0.1, 40.8), 89.9° |

  z settles more slowly than x / y (P0 = 0.01, Q = 1e-6 at the time).
- With 9 LEDs each loop does more work. LEDs that are off are not
  demodulated. (Until 2026-11-19 the EKF inverted a 27×27 matrix every
  loop; see "Update rate".)
- **EKF tuning (2026-11-19):** `T` is the measured time since the previous
  update (about 0.33 s with LED 1, 2, 7, 8; it was fixed at 0.2 s), sin/cos
  are worked out once per sample and reused for the 3 photodiodes (from
  `copy2`), and Q for x, y, z and their velocities is 1e-4 (was 1e-6).

  Before (`calib/motion_20261119/move_straight.csv`): moving the robot
  50 cm in a straight line, the position ran about 8 cm past where it
  stopped and took about 10 s to come back; the heading stayed within ±7°.
  An EKF replica on the PC (same model, 4 LEDs, RSS noise 0.01–0.03)
  gives:

  | Setting | Overshoot | Settles within 2 cm | Jitter when still |
  |---|---|---|---|
  | Q = 1e-6, T = 0.2 s (before) | 14 cm | 18 s | 2 cm |
  | Q = 1e-6, real T | 12 cm | 13–14 s | 1.1–1.3 cm |
  | **Q = 1e-4, real T (now)** | **3–4 cm** | **2–3 s** | **0.2–0.6 cm** |
  | Q = 1e-3, real T | 1–2 cm | 0–6 s | 0.3–0.8 cm |

  On the board (`move_straight_after.csv`, same 50 cm move but done in
  about 2 s instead of 6 s): overshoot 5 cm (was 7 cm), within 2 cm of the
  final position about 5 s after arriving (was about 11 s). The cost is
  more jitter when still: std 0.6–0.8 cm (was 0.1 cm). Update rate is
  unchanged at 3.0 Hz.
- `calib/motion_20261119/rotate.csv`: turning on the spot at (−25, 0),
  clockwise in 90° steps, the heading read 0°, 77–81°, ±180°, −90°, 0°
  (sign correct). The position moved with the heading, up to 10 cm in x
  at 180°; likely photodiodes with different gains, which a calibration
  at θ = 0 only cannot tell apart (not fixed yet).
