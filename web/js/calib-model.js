/* PtxGamma calibration for firmware/robot/robot.ino (pure logic, no DOM).
 *
 * The firmware models the light that photodiode l sees from LED k as
 *   RSS[k][l] = PtxGamma[k] * h(k, l, x, y, z, theta)
 * where h depends only on geometry (see pathLossWithoutGamma() in robot.ino).
 * With the robot at known poses, each LED's gamma is the least-squares fit
 *   PtxGamma[k] = sum(RSS * h) / sum(h^2)
 * over every pose and photodiode where h is large enough to trust.
 *
 * Loads in the browser (window.RACalib) and in Node (require) for the tests.
 * The constants below must match robot.ino; tests/calibrate.test.js checks
 * them against the .ino file.
 */
(function (root) {
  'use strict';

  // ---- Firmware constants (robot.ino) --------------------------------------
  var N_PD = 3;
  // LED number for each row of p (LED_NUM), i.e. the order of the RSS values
  var ROW_LED = [4, 5, 7, 8, 1, 2, 0, 3, 6];
  var N_LED = ROW_LED.length;
  // LED positions p (m): x, y, height above the photodiodes (top and bottom
  // rows at y = +-0.515, measured 2026-11-24)
  var P = [
    [0, 0, 0.92], [-0.5, 0, 0.92], [0, 0.515, 0.92], [-0.5, 0.515, 0.92], [0, -0.515, 0.92],
    [-0.5, -0.515, 0.92], [0.5, -0.515, 0.92], [0.5, 0, 0.92], [0.5, 0.515, 0.92]
  ];
  // PtxGamma as in robot.ino now; kept for LEDs that are not fitted
  var CURRENT_GAMMA = [0.597, 0.567, 0.502, 0.475, 0.641, 0.590, 0.608, 0.529, 0.542];
  var M = 1.0;                       // Lambertian order
  var FOV = Math.PI / 2;
  var BETA = 55 * Math.PI / 180;     // photodiode normal elevation (be); pyramid face 35 deg
  var ALPHA = [0, 2 * Math.PI / 3, -2 * Math.PI / 3]; // al; PD 0 = pin GP28
  // Gain of each photodiode relative to PD 0 (PD_GAIN) and a constant added
  // to every RSS value of a lit LED (RSS_OFFSET: reflections, demodulation
  // noise floor), as in robot.ino. PD_GAIN = 1, 1, 1 and RSS_OFFSET = 0 give
  // the model used before 2026-11-19 (task #2 z axis).
  var PD_GAIN = [1.0, 0.759, 0.926];
  var RSS_OFFSET = 0.0461;
  // z range the firmware keeps (Z_MIN / Z_MAX, m)
  var Z_MIN = 0.0, Z_MAX = 0.80;
  // pitch / roll range when tilt is solved (rad); TILT_MAX in feature/task-3-tilt
  var TILT_MAX = 25 * Math.PI / 180;
  // photodiode normals v (rows), as in robot.ino
  var V = ALPHA.map(function (a) {
    return [Math.cos(BETA) * Math.cos(a), -Math.cos(BETA) * Math.sin(a), Math.sin(BETA)];
  });

  // ---- Model ----------------------------------------------------------------
  // Same as pathLossWithoutGamma(k, l, x0, y0, z0, t0) in robot.ino.
  // row = row of p (0..8), l = photodiode (0..2), x/y/z in m, theta in rad
  // (firmware convention: Omega0 = R(-theta)).
  function pathLoss(row, l, x, y, z, theta) {
    return pathLossTilt(row, l, x, y, z, theta, 0, 0);
  }

  // Normal of photodiode l for a robot turned by theta (firmware sign) and
  // tilted by pitch (> 0: the front, photodiode GP28, up) and roll (> 0: the
  // right side down), rad: roll about forward, then pitch about left, then the
  // heading (Omega0). With pitch = roll = 0 this is Omega0 * v, as in
  // robot.ino. (From feature/task-3-tilt, 2026-11-20; robot.ino itself keeps
  // the robot level: this is for trying tilt on the PC first.)
  function pdNormal(l, theta, pitch, roll, beta) {
    return rotBody(beta === undefined ? V[l] : pdVec(l, beta), theta, pitch, roll);
  }
  // Normal of photodiode l in the robot's own frame for another elevation
  // beta (rad) than the firmware's BETA: analysis on the PC only.
  function pdVec(l, beta) {
    return [Math.cos(beta) * Math.cos(ALPHA[l]), -Math.cos(beta) * Math.sin(ALPHA[l]), Math.sin(beta)];
  }
  // A vector fixed to the robot (v, robot frame) in the world frame.
  function rotBody(v, theta, pitch, roll) {
    var cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
    var r1 = cr * v[1] - sr * v[2], r2 = sr * v[1] + cr * v[2];
    var n0 = cp * v[0] - sp * r2, n2 = sp * v[0] + cp * r2;
    var c = Math.cos(theta), s = Math.sin(theta);
    return [c * n0 + s * r1, -s * n0 + c * r1, n2];   // Omega0 * n
  }

  // pathLoss() for a tilted robot. m (Lambertian order) and beta (photodiode
  // elevation, rad) default to the firmware's M and BETA; other values are for
  // analysis on the PC only (tools/eval-error-budget.js).
  function pathLossTilt(row, l, x, y, z, theta, pitch, roll, m, beta) {
    var pk = P[row], w = pdNormal(l, theta, pitch || 0, roll || 0, beta);
    if (m === undefined) m = M;
    var dx = x - pk[0], dy = y - pk[1], dz = z - pk[2];
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var cosPhi = -dz / d;                       // (p0 - pk) . uk / d, uk = (0, 0, -1)
    var cosPsi = (-dx * w[0] - dy * w[1] - dz * w[2]) / d; // (pk - p0) . w / d
    if (!(cosPsi > Math.cos(FOV))) return 0;
    return (m + 1) * Math.pow(cosPhi, m) * cosPsi / (d * d);
  }

  // RSS the firmware expects (zHn in robot.ino) from LED row / photodiode l.
  // opts.gamma / pdGain / offset override PtxGamma / PD_GAIN / RSS_OFFSET;
  // opts.pitch / opts.roll (rad) tilt the robot; opts.m / opts.beta as in
  // pathLossTilt().
  function predictRss(row, l, x, y, z, theta, opts) {
    opts = opts || {};
    var g = (opts.gamma || CURRENT_GAMMA)[row] * (opts.pdGain || PD_GAIN)[l];
    var off = opts.offset !== undefined ? opts.offset : RSS_OFFSET;
    return g * pathLossTilt(row, l, x, y, z, theta, opts.pitch, opts.roll, opts.m, opts.beta) + off;
  }

  // h for every RSS value of one pose, in firmware order (row * 3 + l).
  // Pose in the units the user measures: cm and degrees. geo: { m, beta } as
  // in pathLossTilt() (optional).
  function modelRow(pose, geo) {
    var x = pose.x / 100, y = pose.y / 100, z = (pose.z || 0) / 100;
    var th = (pose.theta || 0) * Math.PI / 180;
    geo = geo || {};
    var out = [];
    for (var row = 0; row < N_LED; row++)
      for (var l = 0; l < N_PD; l++) out.push(pathLossTilt(row, l, x, y, z, th, 0, 0, geo.m, geo.beta));
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
  // opts.pdGain / opts.offset: photodiode gains and RSS offset held fixed
  //   while gamma is fitted (default 1, 1, 1 and 0: gamma only, the model
  //   before PD_GAIN / RSS_OFFSET; fitModel() fits all of them).
  // Returns one entry per row of p; gamma is null when the LED is not fitted.
  function fitGamma(samples, opts) {
    opts = opts || {};
    var pdGain = opts.pdGain || [1, 1, 1], off = opts.offset || 0;
    var minRel = opts.minRel !== undefined ? opts.minRel : 0.1;
    var minPoints = opts.minPoints !== undefined ? opts.minPoints : 3;
    // opts.m / opts.beta: another Lambertian order / photodiode elevation
    // than the firmware's (analysis only)
    var H = samples.map(function (s) { return modelRow(s, opts); });
    var results = [];
    for (var row = 0; row < N_LED; row++) {
      var led = ROW_LED[row];
      var res = { row: row, led: led, gamma: null, n: 0, rmsRel: null, pdBias: [null, null, null], skipped: null };
      var wanted = opts.leds ? opts.leds.indexOf(led) >= 0 : samples.some(function (s) {
        for (var l = 0; l < N_PD; l++) if (s.rss[row * N_PD + l] !== 0) return true;
        return false;
      });
      if (!wanted) { res.skipped = 'off'; results.push(res); continue; }

      // a pose where this LED reads 0 on every photodiode was taken while the
      // LED was off in the firmware; it says nothing about its gamma
      var lit = samples.map(function (s) {
        for (var q = 0; q < N_PD; q++) if (s.rss[row * N_PD + q] !== 0) return true;
        return false;
      });
      if (lit.indexOf(true) < 0) { res.skipped = 'no signal'; results.push(res); continue; }
      var hMax = 0, si, l, h;
      for (si = 0; si < samples.length; si++)
        for (l = 0; l < N_PD; l++) if (lit[si]) hMax = Math.max(hMax, H[si][row * N_PD + l]);
      var used = [];
      for (si = 0; si < samples.length; si++)
        for (l = 0; l < N_PD; l++) {
          if (!lit[si]) continue;
          h = H[si][row * N_PD + l];
          if (h > 0 && h >= minRel * hMax) used.push({ h: pdGain[l] * h, r: samples[si].rss[row * N_PD + l] - off, l: l });
        }
      res.n = used.length;
      if (used.length < minPoints) { res.skipped = 'too few points'; results.push(res); continue; }

      var num = 0, den = 0;
      used.forEach(function (u) { num += u.r * u.h; den += u.h * u.h; });
      var g = num / den;
      res.gamma = g;
      // relative misfit of each value, overall and per photodiode
      var se = 0, sum = [0, 0, 0], cnt = [0, 0, 0];
      res.resid = []; // absolute misfit, for fitModel()
      used.forEach(function (u) {
        var rel = (u.r + off) / (g * u.h + off) - 1;
        se += rel * rel; sum[u.l] += rel; cnt[u.l]++;
        res.resid.push(u.r - g * u.h);
      });
      res.rmsRel = Math.sqrt(se / used.length);
      res.pdBias = sum.map(function (s, i) { return cnt[i] ? s / cnt[i] : null; });
      results.push(res);
    }
    return results;
  }

  // The PtxGamma line to paste into robot.ino; unfitted LEDs keep their value.
  function firmwareLine(results, current) {
    current = current || CURRENT_GAMMA;
    var vals = results.map(function (r, i) {
      return (r.gamma !== null ? r.gamma : current[i]).toFixed(3) + 'f';
    });
    return 'const float PtxGamma[N_LED] = { ' + vals.join(', ') + ' };  // LED ' + ROW_LED.join(', ');
  }

  // Fit gamma of every LED together with PD_GAIN (PD 1 and 2; PD 0 = 1) and
  // RSS_OFFSET, by least squares on the absolute RSS (as the EKF weighs it).
  // With fewer than opts.minPoses poses (default 4) the photodiode gains and
  // offset are not fitted: they stay at PD_GAIN / RSS_OFFSET.
  // Returns { leds: fitGamma() results, pdGain, offset, fitted }.
  function fitModel(samples, opts) {
    opts = opts || {};
    var minPoses = opts.minPoses !== undefined ? opts.minPoses : 4;
    function inner(q) {
      var o = {}; for (var k in opts) o[k] = opts[k];
      o.pdGain = [1, q[0], q[1]]; o.offset = q[2];
      return fitGamma(samples, o);
    }
    function resid(q) {
      var out = [];
      inner(q).forEach(function (r) { if (r.resid) out = out.concat(r.resid); });
      return out;
    }
    var q = [PD_GAIN[1] / PD_GAIN[0], PD_GAIN[2] / PD_GAIN[0], RSS_OFFSET], fitted = false;
    if (samples.length >= minPoses && resid(q).length > q.length) {
      q = levMar(resid, q, { step: 1e-5 }).q;
      fitted = true;
    }
    return { leds: inner(q), pdGain: [1, q[0], q[1]], offset: q[2], fitted: fitted };
  }

  // The lines to paste into robot.ino for a fitModel() result.
  function firmwareLines(fit, current) {
    return [
      firmwareLine(fit.leds, current),
      'const float PD_GAIN[N_PD] = { ' + fit.pdGain.map(function (v) { return v.toFixed(3) + 'f'; }).join(', ') + ' };',
      'const float RSS_OFFSET = ' + fit.offset.toFixed(4) + 'f;'
    ].join('\n');
  }

  // ---- Recording one pose -----------------------------------------------------
  // LEDs used for calibration unless the page chooses others; the same as
  // LED_ON at power-up in robot.ino (all 9 since 2026-11-25, 1, 2, 7, 8 before).
  var DEFAULT_LIT = [0, 1, 2, 3, 4, 5, 6, 7, 8];

  // Suggested poses (cm, theta = 0) for a set of lit LEDs: every 50 cm grid
  // point inside the box around them, plus the centre of each 50 x 50 cell.
  // All 9 LEDs -> 9 + 4 = 13 poses; LED 1, 2, 7, 8 -> 6 + 2 = 8 poses.
  function presetPoses(lit) {
    var xs = [], ys = [];
    (lit || DEFAULT_LIT).forEach(function (led) {
      var p = P[ROW_LED.indexOf(led)];
      // on the 50 cm grid (the rows at y = +-51.5 cm give +-50)
      xs.push(Math.round(p[0] * 2) * 50); ys.push(Math.round(p[1] * 2) * 50);
    });
    if (!xs.length) return [];
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var out = [], x, y;
    for (y = y1; y >= y0; y -= 50) for (x = x0; x <= x1; x += 50) out.push({ x: x, y: y });
    for (y = y1 - 25; y > y0; y -= 50) for (x = x0 + 25; x < x1; x += 50) out.push({ x: x, y: y });
    return out;
  }

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
    lit = lit || DEFAULT_LIT;
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
  // z_cm (added 2026-11-25) is the last column: the height of the robot base
  // above the floor (3 on the steel beams under LED rows 8 7 6 and 2 1 0).
  // Files without it read as z = 0.
  // x_cm, y_cm, theta_deg, n_lines, spread, then the 27 averaged RSS values in
  // firmware order, named led<k>_pd<l> (pd0 = pin GP28).
  function csvHeader() {
    var h = ['x_cm', 'y_cm', 'theta_deg', 'n_lines', 'spread'];
    ROW_LED.forEach(function (led) { for (var l = 0; l < N_PD; l++) h.push('led' + led + '_pd' + l); });
    h.push('z_cm');
    return h;
  }
  function posesToCsv(poses) {
    var out = [csvHeader().join(',')];
    poses.forEach(function (p) {
      out.push([p.x, p.y, p.theta || 0, p.n || '', p.spread !== undefined ? +p.spread.toFixed(4) : '']
        .concat(p.rss.map(function (v) { return +v.toFixed(4); }), [p.z || 0]).join(','));
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
      return idx[c] === undefined && c !== 'n_lines' && c !== 'spread' && c !== 'theta_deg' && c !== 'z_cm';
    });
    if (missing.length) return { poses: [], errors: ['missing columns: ' + missing.join(' ')] };
    var poses = [], errors = [];
    for (var i = 1; i < lines.length; i++) {
      var c = lines[i].split(',');
      var num = function (name) { return idx[name] === undefined ? NaN : parseFloat(c[idx[name]]); };
      var p = { x: num('x_cm'), y: num('y_cm'), theta: num('theta_deg'), z: num('z_cm'), n: num('n_lines'), spread: num('spread'), rss: [] };
      if (isNaN(p.theta)) p.theta = 0;
      if (isNaN(p.z)) p.z = 0;
      need.slice(5, 5 + N_LED * N_PD).forEach(function (name) { p.rss.push(num(name)); });
      if (isNaN(p.x) || isNaN(p.y) || p.rss.some(isNaN)) { errors.push('line ' + (i + 1)); continue; }
      // reference tilt of the robot, written by the tilt test page only
      var pit = num('pitch_deg'), rol = num('roll_deg');
      if (!isNaN(pit)) p.pitch = pit;
      if (!isNaN(rol)) p.roll = rol;
      if (isNaN(p.n)) delete p.n;
      if (isNaN(p.spread)) delete p.spread;
      poses.push(p);
    }
    return { poses: poses, errors: errors };
  }

  // ---- Least squares helper ---------------------------------------------------
  // Levenberg-Marquardt on resid(q) -> array, numerical Jacobian (central
  // differences, step h, as computeJacobian() in robot.ino). clamp(q) may
  // change q in place after each step. Returns { q, cost }.
  function solveLin(A, b) { // Gaussian elimination with partial pivoting
    var n = b.length, M2 = A.map(function (r, i) { return r.concat([b[i]]); }), r, k;
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (r = c + 1; r < n; r++) if (Math.abs(M2[r][c]) > Math.abs(M2[piv][c])) piv = r;
      var tmp = M2[c]; M2[c] = M2[piv]; M2[piv] = tmp;
      if (!(Math.abs(M2[c][c]) > 1e-300)) return null;
      for (r = c + 1; r < n; r++) {
        var f = M2[r][c] / M2[c][c];
        for (k = c; k <= n; k++) M2[r][k] -= f * M2[c][k];
      }
    }
    var x = new Array(n);
    for (r = n - 1; r >= 0; r--) {
      var s = M2[r][n];
      for (k = r + 1; k < n; k++) s -= M2[r][k] * x[k];
      x[r] = s / M2[r][r];
    }
    return x;
  }
  function sumSq(e) { var s = 0; for (var i = 0; i < e.length; i++) s += e[i] * e[i]; return s; }
  function levMar(resid, q, opts) {
    opts = opts || {};
    var h = opts.step || 1e-5, clamp = opts.clamp, nP = q.length;
    var e = resid(q), c0 = sumSq(e), lam = 1e-3;
    for (var it = 0; it < 200; it++) {
      var J = [], i, a, b;
      for (var j = 0; j < nP; j++) {
        var qp = q.slice(), qm = q.slice();
        qp[j] += h; qm[j] -= h;
        var ep = resid(qp), em = resid(qm);
        J.push(ep.map(function (v, n) { return (em[n] - v) / (2 * h); })); // d(model)/dq
      }
      var JTJ = [], JTe = [];
      for (a = 0; a < nP; a++) {
        var s = 0;
        for (i = 0; i < e.length; i++) s += J[a][i] * e[i];
        JTe.push(s);
        JTJ.push([]);
        for (b = 0; b < nP; b++) {
          var t = 0;
          for (i = 0; i < e.length; i++) t += J[a][i] * J[b][i];
          JTJ[a].push(t);
        }
      }
      var improved = false, done = false;
      while (lam < 1e12) {
        var A = JTJ.map(function (r, ai) { return r.map(function (v, bi) { return ai === bi ? v * (1 + lam) + 1e-12 : v; }); });
        var dq = solveLin(A, JTe);
        if (!dq) { lam *= 10; continue; }
        var qn = q.map(function (v, n) { return v + dq[n]; });
        if (clamp) clamp(qn);
        var en = resid(qn), cn = sumSq(en);
        if (cn < c0) {
          done = c0 - cn < 1e-14 * Math.max(1, c0);
          q = qn; e = en; c0 = cn; lam = Math.max(lam / 10, 1e-9); improved = true;
          break;
        }
        lam *= 10;
      }
      if (!improved || done) break;
    }
    return { q: q, cost: c0 };
  }

  // ---- Photodiode that reads far too low (as lowPd() in robot.ino) --------------
  // For each photodiode, the light it reads over all lit LEDs against what the
  // model predicts at the pose `prior` (both without RSS_OFFSET). A photodiode
  // whose share is below PD_LOW_RATIO times the median of the three reads low
  // for every LED at once: a loose wire, not a shadow, which would hit some
  // LEDs only. Returns its index, or -1. Needs PD_LOW_MIN of predicted light.
  // On 2026-11-25 PD 2 at (-25, -25) gave 0.19-0.26 and at (0, 0) at 13:41
  // 0.29-0.37; good poses 0.427 or more, with the prior up to 20 cm / 30 deg
  // off. Pass the RSS of every lit LED, before selectLeds(): the firmware
  // judges on all of them (over 6 LEDs PD 2 at 13:41 gave 0.35).
  var PD_LOW_RATIO = 0.40, PD_LOW_MIN = 0.1;
  function lowPd(rss, prior, opts) {
    opts = opts || {};
    var gamma = opts.gamma || CURRENT_GAMMA, pdGain = opts.pdGain || PD_GAIN;
    var off = opts.offset !== undefined ? opts.offset : RSS_OFFSET;
    var x = prior.x / 100, y = prior.y / 100, z = (prior.z || 0) / 100, th = (prior.theta || 0) * Math.PI / 180;
    var share = [];
    for (var l = 0; l < N_PD; l++) {
      var meas = 0, model = 0;
      for (var row = 0; row < N_LED; row++) {
        if (rss[row * N_PD] + rss[row * N_PD + 1] + rss[row * N_PD + 2] === 0) continue; // LED off
        meas += Math.max(0, rss[row * N_PD + l] - off);
        model += gamma[row] * pdGain[l] * pathLoss(row, l, x, y, z, th);
      }
      if (model < PD_LOW_MIN) return -1;
      share.push(meas / model);
    }
    var sorted = share.slice().sort(function (a, b) { return a - b; });
    var lo = share.indexOf(sorted[0]);
    return sorted[0] < PD_LOW_RATIO * sorted[1] ? lo : -1;
  }

  // ---- Pose from one averaged RSS line ---------------------------------------
  // Least squares of (rss - predicted) over the LEDs that read anything, the
  // same residual the EKF uses (equal weight, absolute RSS; predicted as in
  // predictRss()). No motion model, so this is where the EKF settles for a
  // robot that stands still.
  // opts.z: false = keep z at 0 (ESTIMATE_Z = false); opts.gamma / pdGain /
  // offset override the firmware constants. Returns { x, y, z, theta, rms }
  // in cm / deg. opts.skipPd: photodiode index left out (see lowPd()).
  // opts.tilt: true = also solve pitch and roll (kept within +-TILT_MAX);
  // the result then has pitch and roll in deg (0 otherwise).
  function solvePose(rss, opts) {
    opts = opts || {};
    var useZ = opts.z !== false, rows = [], skip = opts.skipPd === undefined ? -1 : opts.skipPd;
    var useTilt = !!opts.tilt, iT = useZ ? 4 : 3;   // index of pitch in q; roll follows
    var o = {}; for (var key in opts) o[key] = opts[key];
    for (var row = 0; row < N_LED; row++) {
      var sum = 0;
      for (var l = 0; l < N_PD; l++) sum += rss[row * N_PD + l];
      if (sum !== 0) rows.push(row);
    }
    if (!rows.length) return null;
    function resid(q) {
      var out = [], z = useZ ? q[3] : 0;
      if (useTilt) { o.pitch = q[iT]; o.roll = q[iT + 1]; }
      rows.forEach(function (r) {
        for (var l = 0; l < N_PD; l++) {
          if (l !== skip) out.push(rss[r * N_PD + l] - predictRss(r, l, q[0], q[1], z, q[2], o));
        }
      });
      return out;
    }
    function clamp(q) {
      if (useZ) q[3] = Math.max(Z_MIN, Math.min(Z_MAX, q[3]));
      if (useTilt) for (var i = iT; i < iT + 2; i++) q[i] = Math.max(-TILT_MAX, Math.min(TILT_MAX, q[i]));
    }
    var cx = 0, cy = 0;
    rows.forEach(function (r) { cx += P[r][0] / rows.length; cy += P[r][1] / rows.length; });
    var best = null;
    [0, Math.PI / 2, Math.PI, -Math.PI / 2].forEach(function (th) {
      (useZ ? [0, 0.3] : [0]).forEach(function (z0) {
        var q0 = useZ ? [cx, cy, th, z0] : [cx, cy, th];
        if (useTilt) q0.push(0, 0);   // start level
        var r = levMar(resid, q0, { clamp: clamp });
        if (!best || r.cost < best.cost) best = r;
      });
    });
    var th = Math.atan2(Math.sin(best.q[2]), Math.cos(best.q[2]));
    var deg = 180 / Math.PI, nVal = rows.length * (skip >= 0 ? N_PD - 1 : N_PD);
    return {
      x: best.q[0] * 100, y: best.q[1] * 100, z: useZ ? best.q[3] * 100 : 0,
      theta: th * deg, rms: Math.sqrt(best.cost / (rows.length * N_PD)),
      pitch: useTilt ? best.q[iT] * deg : 0, roll: useTilt ? best.q[iT + 1] * deg : 0,
      nValues: nVal, nUnknowns: best.q.length
    };
  }

  // ---- LEDs the EKF uses (as selectLeds() in robot.ino) ------------------------
  // The k brightest lit LEDs (largest RSS of the three photodiodes; ties keep
  // the lower row of p). Returns a copy of rss with the other LEDs set to 0, so
  // solvePose() / lowPd() leave them out. LED_USE_K must match robot.ino.
  var LED_USE_K = 6;
  function selectLeds(rss, k) {
    if (k === undefined) k = LED_USE_K;
    var lvl = [], used = [], row, n;
    for (row = 0; row < N_LED; row++) {
      var a = rss[row * N_PD], b = rss[row * N_PD + 1], c = rss[row * N_PD + 2];
      lvl.push(Math.max(a, b, c));
      used.push(false);
    }
    for (n = 0; n < k; n++) {
      var best = -1;
      for (row = 0; row < N_LED; row++) {
        var lit = rss[row * N_PD] + rss[row * N_PD + 1] + rss[row * N_PD + 2] !== 0;
        if (lit && !used[row] && (best < 0 || lvl[row] > lvl[best])) best = row;
      }
      if (best < 0) break;
      used[best] = true;
    }
    return rss.map(function (v, i) { return used[Math.floor(i / N_PD)] ? v : 0; });
  }

  // ---- Light per photodiode, for the wire check on calibrate.html ---------------
  // Sum over the lit LEDs (any reading on the three photodiodes) of what each
  // photodiode reads above RSS_OFFSET. A photodiode whose wire is loose drops
  // for every LED at once, so its share of the total drops; light that changes
  // for all three (a shadow, the LEDs) moves the three sums together.
  // Returns [PD0, PD1, PD2].
  function pdTotals(rss, offset) {
    var off = offset !== undefined ? offset : RSS_OFFSET, out = [0, 0, 0];
    for (var row = 0; row < N_LED; row++) {
      if (rss[row * N_PD] + rss[row * N_PD + 1] + rss[row * N_PD + 2] === 0) continue; // LED off
      for (var l = 0; l < N_PD; l++) out[l] += Math.max(0, rss[row * N_PD + l] - off);
    }
    return out;
  }

  // ---- Direction to each LED from its three readings ---------------------------
  // (docs/research-6dof-photodiode.md, step 2, in this file's conventions.)
  // For one LED the three photodiodes read  q_l = k * (v_l . u)  after taking
  // off RSS_OFFSET and PD_GAIN: v_l = normal of photodiode l, u = unit vector
  // from the robot to the LED, both in the robot's frame, and k the light a
  // photodiode facing the LED would get. So  k * u = inverse(V) * q.
  // u needs neither PtxGamma nor m: only the photodiode side (gains, normals,
  // how each photodiode answers to the angle) enters. That is what makes it a
  // check of the photodiodes on their own.
  // Returns one entry per row of p: { row, led, u: [3], k }, or null where a
  // photodiode reads no more than the offset (LED off, or not seen by all
  // three faces). opts.pdGain / offset / beta as in predictRss().
  function inv3(m) {
    var a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], g = m[2][0], h = m[2][1], i = m[2][2];
    var A = e * i - f * h, B = f * g - d * i, Cc = d * h - e * g, det = a * A + b * B + c * Cc;
    return [
      [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [Cc / det, (b * g - a * h) / det, (a * e - b * d) / det]
    ];
  }
  var V_INV = inv3(V);
  function ledDirections(rss, opts) {
    opts = opts || {};
    var pdGain = opts.pdGain || PD_GAIN, off = opts.offset !== undefined ? opts.offset : RSS_OFFSET;
    var vi = opts.beta === undefined ? V_INV : inv3([0, 1, 2].map(function (l) { return pdVec(l, opts.beta); }));
    var out = [];
    for (var row = 0; row < N_LED; row++) {
      var q = [], ok = true;
      for (var l = 0; l < N_PD; l++) {
        q.push((rss[row * N_PD + l] - off) / pdGain[l]);
        if (!(q[l] > 0)) ok = false;
      }
      if (!ok) { out.push(null); continue; }
      var b = vi.map(function (r) { return r[0] * q[0] + r[1] * q[1] + r[2] * q[2]; });
      var k = Math.sqrt(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
      out.push({ row: row, led: ROW_LED[row], u: [b[0] / k, b[1] / k, b[2] / k], k: k });
    }
    return out;
  }

  // Where each LED really is, seen from the robot: unit vector in the robot's
  // frame for a pose { x, y, z, theta, pitch, roll } (cm, deg).
  function ledDirectionTrue(row, pose) {
    var D = Math.PI / 180, th = (pose.theta || 0) * D, pi = (pose.pitch || 0) * D, ro = (pose.roll || 0) * D;
    var t = [P[row][0] - pose.x / 100, P[row][1] - pose.y / 100, P[row][2] - (pose.z || 0) / 100];
    var d = Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]);
    // world -> robot frame: the transpose of rotBody()
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(function (e) {
      var c = rotBody(e, th, pi, ro);
      return (c[0] * t[0] + c[1] * t[1] + c[2] * t[2]) / d;
    });
  }

  // Angle (deg) between the direction read from the photodiodes and the true
  // one, for every LED of a recorded pose { x, y, z, theta, pitch, roll, rss }.
  // Returns [{ row, led, err, zenith, k }]; zenith = how far the LED is from
  // straight above the robot (deg).
  function ledDirectionErrors(pose, opts) {
    var out = [], deg = 180 / Math.PI;
    ledDirections(pose.rss, opts).forEach(function (d) {
      if (!d) return;
      var t = ledDirectionTrue(d.row, pose);
      var dot = Math.max(-1, Math.min(1, d.u[0] * t[0] + d.u[1] * t[1] + d.u[2] * t[2]));
      var dx = P[d.row][0] - pose.x / 100, dy = P[d.row][1] - pose.y / 100, dz = P[d.row][2] - (pose.z || 0) / 100;
      out.push({ row: d.row, led: d.led, err: Math.acos(dot) * deg, zenith: Math.atan2(Math.sqrt(dx * dx + dy * dy), dz) * deg, k: d.k });
    });
    return out;
  }

  // ---- Harmonics of one LED landing on another LED's frequency -----------------
  // The LEDs blink as square waves (odd harmonics, the k-th 1 / k as strong) and
  // robot.ino samples at SAMPLE_RATE, so harmonic k of LED i shows up at
  // |k * f_i - n * SAMPLE_RATE|. Where that is the frequency of LED j, light of
  // LED i is counted as LED j (unless the photodiode amplifier is too slow to
  // pass it: to be measured with one LED lit at a time).
  // LED_FREQ: Fref in robot.ino (Hz, one per row of p).
  var LED_FREQ = [2300, 2900, 3700, 4100, 1300, 1700, 1100, 1900, 3100];
  var SAMPLE_RATE = 25000;           // one sample every 40 us
  // Returns [{ from, to (rows of p), k, share: 1 / k }], strongest first.
  function aliasPairs(freqs, fs, maxK) {
    freqs = freqs || LED_FREQ; fs = fs || SAMPLE_RATE; maxK = maxK || 41;
    var out = [];
    for (var i = 0; i < freqs.length; i++)
      for (var k = 3; k <= maxK; k += 2) {
        var a = (freqs[i] * k) % fs;
        if (a > fs / 2) a = fs - a;
        var j = freqs.indexOf(a);
        if (j >= 0 && j !== i) out.push({ from: i, to: j, k: k, share: 1 / k });
      }
    return out.sort(function (p, q) { return p.k - q.k; });
  }

  // An RSS line as the firmware prints it, for the page's demo mode and tests.
  function formatRssLine(rss) {
    return rss.map(function (v) { return v.toFixed(4); }).join(', ') + ', ';
  }

  var api = {
    N_PD: N_PD, N_LED: N_LED, ROW_LED: ROW_LED, P: P, CURRENT_GAMMA: CURRENT_GAMMA,
    M: M, FOV: FOV, BETA: BETA, ALPHA: ALPHA, DEFAULT_LIT: DEFAULT_LIT, presetPoses: presetPoses,
    pathLoss: pathLoss, pathLossTilt: pathLossTilt, pdNormal: pdNormal, TILT_MAX: TILT_MAX, modelRow: modelRow, parseRssLine: parseRssLine,
    PD_GAIN: PD_GAIN, RSS_OFFSET: RSS_OFFSET, Z_MIN: Z_MIN, Z_MAX: Z_MAX, predictRss: predictRss,
    fitGamma: fitGamma, firmwareLine: firmwareLine, fitModel: fitModel, firmwareLines: firmwareLines,
    solvePose: solvePose, levMar: levMar, lowPd: lowPd, PD_LOW_RATIO: PD_LOW_RATIO, PD_LOW_MIN: PD_LOW_MIN,
    averageRss: averageRss, checkPose: checkPose, LED_USE_K: LED_USE_K, selectLeds: selectLeds,
    csvHeader: csvHeader, posesToCsv: posesToCsv, csvToPoses: csvToPoses, formatRssLine: formatRssLine,
    ledDirections: ledDirections, ledDirectionTrue: ledDirectionTrue, ledDirectionErrors: ledDirectionErrors,
    LED_FREQ: LED_FREQ, SAMPLE_RATE: SAMPLE_RATE, aliasPairs: aliasPairs, pdTotals: pdTotals
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RACalib = api;
})(this);
