/* PtxGamma calibration for firmware/copy/copy.ino (pure logic, no DOM).
 *
 * The firmware models the light that photodiode l sees from LED k as
 *   RSS[k][l] = PtxGamma[k] * h(k, l, x, y, z, theta)
 * where h depends only on geometry (see pathLossWithoutGamma() in copy.ino).
 * With the robot at known poses, each LED's gamma is the least-squares fit
 *   PtxGamma[k] = sum(RSS * h) / sum(h^2)
 * over every pose and photodiode where h is large enough to trust.
 *
 * Loads in the browser (window.RACalib) and in Node (require) for the tests.
 * The constants below must match copy.ino; tests/calibrate.test.js checks
 * them against the .ino file.
 */
(function (root) {
  'use strict';

  // ---- Firmware constants (copy.ino) --------------------------------------
  var N_PD = 3;
  // LED number for each row of p (LED_NUM), i.e. the order of the RSS values
  var ROW_LED = [4, 5, 7, 8, 1, 2, 0, 3, 6];
  var N_LED = ROW_LED.length;
  // LED positions p (m): x, y, height above the photodiodes
  var P = [
    [0, 0, 0.92], [-0.5, 0, 0.92], [0, 0.5, 0.92], [-0.5, 0.5, 0.92], [0, -0.5, 0.92],
    [-0.5, -0.5, 0.92], [0.5, -0.5, 0.92], [0.5, 0, 0.92], [0.5, 0.5, 0.92]
  ];
  // PtxGamma as in copy.ino now; kept for LEDs that are not fitted
  var CURRENT_GAMMA = [0.49, 0.49, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46];
  var M = 1.0;                       // Lambertian order
  var FOV = Math.PI / 2;
  var BETA = Math.PI / 3;            // photodiode tilt (be)
  var ALPHA = [0, 2 * Math.PI / 3, -2 * Math.PI / 3]; // al; PD 0 = pin GP28
  // photodiode normals v (rows), as in copy.ino
  var V = ALPHA.map(function (a) {
    return [Math.cos(BETA) * Math.cos(a), -Math.cos(BETA) * Math.sin(a), Math.sin(BETA)];
  });

  // ---- Model ----------------------------------------------------------------
  // Same as pathLossWithoutGamma(k, l, x0, y0, z0, t0) in copy.ino.
  // row = row of p (0..8), l = photodiode (0..2), x/y/z in m, theta in rad
  // (firmware convention: Omega0 = R(-theta)).
  function pathLoss(row, l, x, y, z, theta) {
    var pk = P[row], v = V[l];
    var dx = x - pk[0], dy = y - pk[1], dz = z - pk[2];
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var cosPhi = -dz / d;                       // (p0 - pk) . uk / d, uk = (0, 0, -1)
    var c = Math.cos(theta), s = Math.sin(theta);
    var w0 = c * v[0] + s * v[1], w1 = -s * v[0] + c * v[1], w2 = v[2]; // Omega0 * v
    var cosPsi = (-dx * w0 - dy * w1 - dz * w2) / d; // (pk - p0) . w / d
    if (!(cosPsi > Math.cos(FOV))) return 0;
    return (M + 1) * Math.pow(cosPhi, M) * cosPsi / (d * d);
  }

  // h for every RSS value of one pose, in firmware order (row * 3 + l).
  // Pose in the units the user measures: cm and degrees.
  function modelRow(pose) {
    var x = pose.x / 100, y = pose.y / 100, z = (pose.z || 0) / 100;
    var th = (pose.theta || 0) * Math.PI / 180;
    var out = [];
    for (var row = 0; row < N_LED; row++)
      for (var l = 0; l < N_PD; l++) out.push(pathLoss(row, l, x, y, z, th));
    return out;
  }

  // ---- Serial ---------------------------------------------------------------
  // RSS line from mode 1 / 3: "0.00, 0.00, 0.91, ... , 0.12, " (27 values,
  // trailing ", "). Returns the 27 numbers or null for any other line.
  function parseRssLine(raw) {
    var parts = String(raw).split(',');
    var vals = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (t === '') continue;
      if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
      vals.push(+t);
    }
    return vals.length === N_LED * N_PD ? vals : null;
  }

  // ---- Fit --------------------------------------------------------------------
  // samples: [{ x, y, z?, theta?, rss: [27] }]  (cm, deg; rss = averaged line)
  // opts.minRel: drop values whose h is below this share of the LED's largest
  //   h (near the edge of the photodiode's field of view the model is weakest).
  // opts.leds: LED numbers to fit; default = every LED with any non-zero RSS
  //   (the firmware prints 0 for LEDs switched off in LED_ON).
  // Returns one entry per row of p; gamma is null when the LED is not fitted.
  function fitGamma(samples, opts) {
    opts = opts || {};
    var minRel = opts.minRel !== undefined ? opts.minRel : 0.1;
    var minPoints = opts.minPoints !== undefined ? opts.minPoints : 3;
    var H = samples.map(modelRow);
    var results = [];
    for (var row = 0; row < N_LED; row++) {
      var led = ROW_LED[row];
      var res = { row: row, led: led, gamma: null, n: 0, rmsRel: null, pdBias: [null, null, null], skipped: null };
      var wanted = opts.leds ? opts.leds.indexOf(led) >= 0 : samples.some(function (s) {
        for (var l = 0; l < N_PD; l++) if (s.rss[row * N_PD + l] !== 0) return true;
        return false;
      });
      if (!wanted) { res.skipped = 'off'; results.push(res); continue; }

      var hMax = 0, si, l, h;
      for (si = 0; si < samples.length; si++)
        for (l = 0; l < N_PD; l++) hMax = Math.max(hMax, H[si][row * N_PD + l]);
      var used = [];
      for (si = 0; si < samples.length; si++)
        for (l = 0; l < N_PD; l++) {
          h = H[si][row * N_PD + l];
          if (h > 0 && h >= minRel * hMax) used.push({ h: h, r: samples[si].rss[row * N_PD + l], l: l });
        }
      res.n = used.length;
      if (used.length < minPoints) { res.skipped = 'too few points'; results.push(res); continue; }

      var num = 0, den = 0;
      used.forEach(function (u) { num += u.r * u.h; den += u.h * u.h; });
      var g = num / den;
      res.gamma = g;
      // relative misfit of each value, overall and per photodiode
      var se = 0, sum = [0, 0, 0], cnt = [0, 0, 0];
      used.forEach(function (u) {
        var rel = u.r / (g * u.h) - 1;
        se += rel * rel; sum[u.l] += rel; cnt[u.l]++;
      });
      res.rmsRel = Math.sqrt(se / used.length);
      res.pdBias = sum.map(function (s, i) { return cnt[i] ? s / cnt[i] : null; });
      results.push(res);
    }
    return results;
  }

  // The PtxGamma line to paste into copy.ino; unfitted LEDs keep their value.
  function firmwareLine(results, current) {
    current = current || CURRENT_GAMMA;
    var vals = results.map(function (r, i) {
      return (r.gamma !== null ? r.gamma : current[i]).toFixed(3) + 'f';
    });
    return 'const float PtxGamma[N_LED] = { ' + vals.join(', ') + ' };  // LED ' + ROW_LED.join(', ');
  }

  var api = {
    N_PD: N_PD, N_LED: N_LED, ROW_LED: ROW_LED, P: P, CURRENT_GAMMA: CURRENT_GAMMA,
    M: M, FOV: FOV, BETA: BETA, ALPHA: ALPHA,
    pathLoss: pathLoss, modelRow: modelRow, parseRssLine: parseRssLine,
    fitGamma: fitGamma, firmwareLine: firmwareLine
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RACalib = api;
})(this);
