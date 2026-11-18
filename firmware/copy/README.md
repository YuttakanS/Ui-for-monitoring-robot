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
| 6 | LED 0 | (50, -50) | 1100 Hz | yes |
| 7 | LED 3 | (50, 0) | 1900 Hz | yes |
| 8 | LED 6 | (50, 50) | 3100 Hz | yes |

Layout seen from above (+X right, +Y up), LED 4 at the origin:

```
8--7--6    y = +50
5--4--3    y =   0
2--1--0    y = -50
```

- `PtxGamma` for LED 1, 2, 0, 3 and 6 is a placeholder (0.46), not calibrated.
- The frequencies of LED 0, 3 and 6 (1100 / 1900 / 3100 Hz) still need to be
  checked against the real LED drivers.

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
