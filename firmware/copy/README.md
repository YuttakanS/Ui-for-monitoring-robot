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

- `ESTIMATE_Z = false` keeps z at 0 (robot always on the floor), as before.
- z is kept between `Z_MIN` (-5 cm) and `Z_MAX` (80 cm); near the LEDs the
  path-loss model blows up.

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

- **`m = 0.55` (trial, 2026-11-19)** instead of 1.0, fitted from the
  calibration data; see "Calibration results" below. Not yet checked
  against the LED datasheet. To go back: `m = 1.0` and the m = 1 gammas
  in the comment above `PtxGamma`.
- `PtxGamma` for LED 7, 8, 1, 2 is an **interim calibration** (2026-11-19,
  see "Calibration results" below). LED 0, 3, 6 (off for now) keep the
  placeholder 0.46; LED 4, 5 (not lit) keep 0.49. `ESTIMATE_Z` is `false`
  until the fit is better.
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
5. Export the CSV as a record, copy the `PtxGamma` line into this file,
   set `mode = 2` again and upload.
6. Check: at a pose not among the suggested ones (e.g. (-25, 0)), the
   Position Monitor should show x / y within about 3 cm; then try
   `ESTIMATE_Z = true`, and a robot on the floor should read z ~ 0.

In the result table, PD0–PD2 is how much each photodiode reads above (+) or
below (−) the model on average. If the same photodiode is off by more than
5 % for every LED, the photodiodes differ in gain, which this firmware does
not model yet. Note it down. LEDs that are not fitted keep their old value.

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
  the same when recorded again, and no other pose or heading explains it,
  so something probably shaded PD2 there. Not checked yet.
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
does not help, so it is not added. Still to do: measure the same 10 poses
again with this firmware and compare with the table above.

## On/off commands
The web page (or the Serial Monitor) sends one line per command:

```
LED <number> <0|1>     e.g.  LED 4 1
```

The board answers `# LED <number> <0|1>`. An LED that is off is not demodulated
and adds nothing to the EKF update. This does not power the LED itself off.

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

  z settles more slowly than x / y (P0 = 0.01, Q = 1e-6); raise them to
  follow faster height changes.
- With 9 LEDs each loop does more work: 9 LEDs are demodulated (per-sample
  sin/cos) and the EKF inverts a 27×27 matrix (the gain is now 8×27). If the update rate drops too
  far, port the speed-ups from `copy2` (see below).
- `T` is still fixed at 0.2 s and sin/cos are still computed per photodiode;
  `firmware/copy2` on `feature/task-2-ui-6led-off45` has those speed-ups.
