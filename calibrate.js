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

  // ---- Recording one pose -----------------------------------------------------
  // LEDs that are physically lit now (LED 4 and 5 are not).
  var LEDS_LIT = [0, 1, 2, 3, 6, 7, 8];

  // Mean of several RSS lines, and how much they moved: spread = the largest
  // (max - min) / mean over the values that carry signal (mean >= 5 % of the
  // largest mean). A robot that moved while recording shows a large spread.
  function averageRss(lines) {
    var n = lines.length, len = N_LED * N_PD, mean = [], i, j;
    if (!n) return null;
    for (j = 0; j < len; j++) {
      var s = 0;
      for (i = 0; i < n; i++) s += lines[i][j];
      mean.push(s / n);
    }
    var top = Math.max.apply(null, mean), spread = 0;
    for (j = 0; j < len; j++) {
      if (!(mean[j] > 0) || mean[j] < 0.05 * top) continue;
      var lo = Infinity, hi = -Infinity;
      for (i = 0; i < n; i++) { lo = Math.min(lo, lines[i][j]); hi = Math.max(hi, lines[i][j]); }
      spread = Math.max(spread, (hi - lo) / mean[j]);
    }
    return { rss: mean, n: n, spread: spread };
  }

  // Warnings for an averaged pose: an LED meant to be lit reads 0 on every
  // photodiode (switched off in LED_ON, or the LED is out), or one meant to be
  // dark reads something (it is switched on in the firmware).
  function checkPose(rss, lit) {
    lit = lit || LEDS_LIT;
    var out = [];
    for (var row = 0; row < N_LED; row++) {
      var led = ROW_LED[row], sum = 0;
      for (var l = 0; l < N_PD; l++) sum += rss[row * N_PD + l];
      var want = lit.indexOf(led) >= 0;
      if (want && sum === 0) out.push({ led: led, kind: 'zero' });
      if (!want && sum !== 0) out.push({ led: led, kind: 'unexpected' });
    }
    return out;
  }

  // ---- CSV of recorded poses ------------------------------------------------------
  // x_cm, y_cm, theta_deg, n_lines, spread, then the 27 averaged RSS values in
  // firmware order, named led<k>_pd<l> (pd0 = pin GP28).
  function csvHeader() {
    var h = ['x_cm', 'y_cm', 'theta_deg', 'n_lines', 'spread'];
    ROW_LED.forEach(function (led) { for (var l = 0; l < N_PD; l++) h.push('led' + led + '_pd' + l); });
    return h;
  }
  function posesToCsv(poses) {
    var out = [csvHeader().join(',')];
    poses.forEach(function (p) {
      out.push([p.x, p.y, p.theta || 0, p.n || '', p.spread !== undefined ? +p.spread.toFixed(4) : '']
        .concat(p.rss.map(function (v) { return +v.toFixed(4); })).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }
  // Returns { poses, errors }. Columns are found by name, so their order may change.
  function csvToPoses(text) {
    var lines = String(text).split(/\r\n|\n|\r/).filter(function (s) { return s.trim() !== ''; });
    if (!lines.length) return { poses: [], errors: ['empty file'] };
    var head = lines[0].split(',').map(function (s) { return s.trim(); });
    var idx = {};
    head.forEach(function (name, i) { idx[name] = i; });
    var need = csvHeader(), missing = need.filter(function (c) {
      return idx[c] === undefined && c !== 'n_lines' && c !== 'spread' && c !== 'theta_deg';
    });
    if (missing.length) return { poses: [], errors: ['missing columns: ' + missing.join(' ')] };
    var poses = [], errors = [];
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split(',');
      var num = function (name) { return idx[name] === undefined ? NaN : parseFloat(c[idx[name]]); };
      var p = { x: num('x_cm'), y: num('y_cm'), theta: num('theta_deg'), n: num('n_lines'), spread: num('spread'), rss: [] };
      if (isNaN(p.theta)) p.theta = 0;
      need.slice(5).forEach(function (name) { p.rss.push(num(name)); });
      if (isNaN(p.x) || isNaN(p.y) || p.rss.some(isNaN)) { errors.push('line ' + (i + 1)); continue; }
      if (isNaN(p.n)) delete p.n;
      if (isNaN(p.spread)) delete p.spread;
      poses.push(p);
    }
    return { poses: poses, errors: errors };
  }

  // An RSS line as the firmware prints it, for the page's demo mode and tests.
  function formatRssLine(rss) {
    return rss.map(function (v) { return v.toFixed(4); }).join(', ') + ', ';
  }

  var api = {
    N_PD: N_PD, N_LED: N_LED, ROW_LED: ROW_LED, P: P, CURRENT_GAMMA: CURRENT_GAMMA,
    M: M, FOV: FOV, BETA: BETA, ALPHA: ALPHA, LEDS_LIT: LEDS_LIT,
    pathLoss: pathLoss, modelRow: modelRow, parseRssLine: parseRssLine,
    fitGamma: fitGamma, firmwareLine: firmwareLine,
    averageRss: averageRss, checkPose: checkPose,
    csvHeader: csvHeader, posesToCsv: posesToCsv, csvToPoses: csvToPoses, formatRssLine: formatRssLine
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RACalib = api;
})(this);
