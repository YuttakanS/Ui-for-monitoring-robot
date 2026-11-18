# copy2 firmware (Raspberry Pi Pico)

Firmware that pairs with the web page on this branch (`feature/task-2-ui-6led-off45`).
It estimates the robot's position and orientation with an EKF from 3 photodiodes
and sends one line per update over USB serial:

```
Quadrant <n>: <x cm>, <y cm>, <orientation deg>
```

## LEDs used
4 LEDs, 92 cm above the photodiodes. LED 4 and 5 are not used.

| LED | Position (cm) | Frequency |
|---|---|---|
| LED 1 | (0, -50) | 1300 Hz |
| LED 2 | (-50, -50) | 1700 Hz |
| LED 7 | (0, 50) | 3700 Hz |
| LED 8 | (-50, 50) | 4100 Hz |

## Build and upload
1. Arduino IDE with a Raspberry Pi Pico board package (for example
   "Raspberry Pi Pico/RP2040" by Earle F. Philhower) and the **BasicLinearAlgebra** library.
2. Open `copy2.ino`, select the Pico board and its port, then Verify and Upload.
3. Close the Serial Monitor before pressing "Connect Serial" on the web page.

## Known issue
`pathLossWithoutGamma()` multiplies by `PtxGamma[k]` and its callers multiply again,
so gamma is applied twice. It was left as is because the current `PtxGamma` values
may have been calibrated with this code. If positions shrink toward the centre,
check this first.
