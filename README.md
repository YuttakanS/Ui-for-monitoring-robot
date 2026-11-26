LED positioning robot

A robot finds its own position from 9 blinking LEDs above it. Three photodiodes on
the robot measure the light, the Pico W firmware separates each LED by its
frequency and estimates x, y, heading and height with an EKF, and the web pages show
the result over USB serial or WiFi.

## Layout

```
web/                    the web pages (open the .html files in Chrome or Edge)
  index.html            Position Monitor: map, 3D view, time graph, CSV recording
  calibrate.html        Calibrate PtxGamma, PD_GAIN and RSS_OFFSET at known poses
  style.css
  js/
    monitor.js          Position Monitor page (serial / WiFi, map, 3D, CSV)
    calib-model.js      the firmware's light model in JavaScript, and the fitting
                        (also used by the tests and the fake robot)
    calib-page.js       Calibrate page
    wifi-link.js        talks to the robot over WiFi (Server-Sent Events)
  models/               3D models for the 3D view (generated, see tools/models-src)
  vendor/               three.js
firmware/
  robot/robot.ino       Pico W firmware (Arduino IDE, board "Raspberry Pi Pico W")
  robot/README.md       firmware notes, calibration and board test results
data/
  2026-11-19/           calibration, position check and motion recordings
docs/
  firmware-explained.md how the firmware works and how it changed (Thai)
tools/
  fake-robot.js         a stand-in for the robot's WiFi server, to try the pages
  models-src/           build_models.js (npm run models) makes web/models
tests/                  npm test (Node, no dependencies)
```

## Use

- **Web pages:** open `web/index.html` (or `web/calibrate.html`) in Chrome or Edge.
  Connect over USB (Web Serial) or over WiFi to the robot's access point at
  `192.168.42.1`.
- **Firmware:** open `firmware/robot/robot.ino` in Arduino IDE, copy
  `wifi_secrets.example.h` to `wifi_secrets.h` in the same folder and set the
  password (this file is not in git), then upload.
- **Without the board:** `node tools/fake-robot.js 8080`, then connect the page
  over WiFi to `127.0.0.1:8080`.
- **Tests:** `npm test`.

The constants of the light model in `web/js/calib-model.js` must match
`firmware/robot/robot.ino`; the tests check this.
