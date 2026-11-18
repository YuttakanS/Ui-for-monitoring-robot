# copy firmware (Raspberry Pi Pico): 6 LEDs + on/off from the web page

Pairs with the web page on this branch (`feature/task-2-ui-led-toggle`).
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

`PtxGamma` for LED 1 and 2 is a placeholder (0.46), not calibrated.

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
- `T` is still fixed at 0.2 s and sin/cos are still computed per photodiode;
  `firmware/copy2` on `feature/task-2-ui-6led-off45` has those speed-ups.
