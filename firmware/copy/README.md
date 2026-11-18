# copy firmware (Raspberry Pi Pico): 9 LEDs + on/off from the web page

Pairs with the web page on this branch (`feature/task-2-ui-9led`).
It estimates position and orientation with an EKF from 3 photodiodes and sends:

```
Quadrant <n>: <x cm>, <y cm>, <orientation deg>
```

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
- The double gamma factor is fixed here (`pathLossWithoutGamma()` no longer
  multiplies by `PtxGamma`).
- Not yet compiled or tested on the board.
- With 9 LEDs each loop does more work: 9 LEDs are demodulated (per-sample
  sin/cos) and the EKF inverts a 27×27 matrix. If the update rate drops too
  far, port the speed-ups from `copy2` (see below).
- `T` is still fixed at 0.2 s and sin/cos are still computed per photodiode;
  `firmware/copy2` on `feature/task-2-ui-6led-off45` has those speed-ups.
