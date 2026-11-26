/* Yaw / pitch / roll solved back from the RSS on the PC, against a known pose
 * (pure logic, no DOM). For web/tilt-test.html and the tests.
 *
 * The firmware keeps the robot level; here solvePose() of calib-model.js also
 * solves pitch and roll from one averaged RSS line (9 LEDs x 3 photodiodes),
 * and the result is compared with the pose the robot really had:
 *   - a level point (reference pitch = roll = 0): any tilt solved is false tilt
 *   - a tilted point: error = solved - reference, and "change" = the same with
 *     the tilt solved at the level point of the same x, y, yaw, z taken off
 *     (what a "zero at level" button would show)
 * Same rules as tools/eval-tilt.js, which is where the 2026-11-25 "FAIL" came
 * from (data/2026-11-25/calib_105643.csv: 12 level poses).
 *
 * Loads in the browser (window.RATilt, after calib-model.js) and in Node.
 */
(function (root) {
  'use strict';
  var C = (typeof module !== 'undefined' && module.exports) ? require('./calib-model.js') : root.RACalib;

  // Limits from the plan of 2026-11-25: false tilt on level points and how
  // much worse x/y may get when tilt is solved too.
  var TILT_RMS_MAX = 3;      // deg
  var XY_WORSE_MAX = 0.5;    // cm
  var LOO_MIN_POINTS = 5;    // level points needed to fit a model without one of them

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }
  function rms(a) { return Math.sqrt(mean(a.map(function (v) { return v * v; }))); }
  function maxAbs(a) { return a.length ? Math.max.apply(null, a.map(Math.abs)) : NaN; }
  // difference of two angles in deg, within +-180
  function angDiff(a, b) {
    var d = (a - b) % 360;
    return d > 180 ? d - 360 : d < -180 ? d + 360 : d;
  }

  function firmwareModel() { return { gamma: C.CURRENT_GAMMA, pdGain: C.PD_GAIN, offset: C.RSS_OFFSET }; }
  function isLevel(p) { return !(p.pitch) && !(p.roll); }
  function samePlace(a, b) {
    return a.x === b.x && a.y === b.y && (a.theta || 0) === (b.theta || 0) && (a.z || 0) === (b.z || 0);
  }
  function samePoint(a, b) {
    return samePlace(a, b) && (a.pitch || 0) === (b.pitch || 0) && (a.roll || 0) === (b.roll || 0);
  }

  // One averaged RSS line -> the pose with the level model (as the firmware)
  // and with pitch / roll solved too.
  // opts.k: LEDs used (the k brightest, as LED_USE_K in robot.ino; default 6)
  // opts.model: { gamma, pdGain, offset }, default the firmware constants
  // opts.prior: { x, y, theta, z } (cm, deg) where lowPd() judges a photodiode
  //   that reads far too low; default = the level solution of this line.
  // Returns { flat, tilt, skipPd } (skipPd = -1 when all three are used), or
  // null when no LED reads anything.
  function analyse(rss, opts) {
    opts = opts || {};
    var m = opts.model || firmwareModel();
    var o = { gamma: m.gamma, pdGain: m.pdGain, offset: m.offset };
    var used = C.selectLeds(rss, opts.k === undefined ? C.LED_USE_K : opts.k);
    var prior = opts.prior, flat = null;
    if (!prior) {
      flat = C.solvePose(used, o);
      if (!flat) return null;
      prior = flat;
    }
    var pd = C.lowPd(rss, prior, o);            // judged on every lit LED, as robot.ino
    if (pd >= 0) { o.skipPd = pd; flat = null; }
    if (!flat) flat = C.solvePose(used, o);
    if (!flat) return null;
    o.tilt = true;
    return { flat: flat, tilt: C.solvePose(used, o), skipPd: pd };
  }

  // Model fitted from the level points other than points[i]; null when there
  // are too few of them.
  function fitWithout(points, i) {
    var rest = points.filter(function (p, j) { return j !== i && isLevel(p); });
    if (rest.length < LOO_MIN_POINTS - 1) return null;
    var fit = C.fitModel(rest);
    return {
      gamma: fit.leds.map(function (r, n) { return r.gamma !== null ? r.gamma : C.CURRENT_GAMMA[n]; }),
      pdGain: fit.pdGain, offset: fit.offset
    };
  }

  // points: [{ x, y, z?, theta?, pitch?, roll?, rss: [27] }] (cm, deg: the
  //   pose the robot really had; theta is the yaw, firmware sign)
  // opts.k: LEDs used. opts.loo: true = each point is solved with a model
  //   fitted from the other level points (leave one out), so a point is not
  //   judged by constants it helped to fit; false = the firmware constants.
  // Returns { rows, summary }. Each row: { point, flat, tilt, skipPd, model:
  //   'loo' | 'firmware', err: { yaw, pitch, roll, z, xyFlat, xyTilt },
  //   change: { pitch, roll } | null }.
  function evaluate(points, opts) {
    opts = opts || {};
    var rows = points.map(function (p, i) {
      var model = opts.loo ? fitWithout(points, i) : null;
      var a = analyse(p.rss, { k: opts.k, model: model || firmwareModel(), prior: p });
      if (!a) return { point: p, flat: null, tilt: null, skipPd: -1, model: model ? 'loo' : 'firmware', err: null, change: null };
      return {
        point: p, flat: a.flat, tilt: a.tilt, skipPd: a.skipPd, model: model ? 'loo' : 'firmware',
        err: {
          yaw: angDiff(a.tilt.theta, p.theta || 0),
          pitch: a.tilt.pitch - (p.pitch || 0), roll: a.tilt.roll - (p.roll || 0),
          z: a.tilt.z - (p.z || 0),
          xyFlat: Math.hypot(a.flat.x - p.x, a.flat.y - p.y),
          xyTilt: Math.hypot(a.tilt.x - p.x, a.tilt.y - p.y)
        },
        change: null
      };
    });
    // tilted points: take off what the level point at the same place solved
    rows.forEach(function (r) {
      if (!r.err || isLevel(r.point)) return;
      var base = rows.filter(function (q) { return q.err && isLevel(q.point) && samePlace(q.point, r.point); })[0];
      if (base) r.change = {
        pitch: (r.tilt.pitch - base.tilt.pitch) - r.point.pitch,
        roll: (r.tilt.roll - base.tilt.roll) - r.point.roll
      };
    });
    return { rows: rows, summary: summarise(rows) };
  }

  function summarise(rows) {
    var ok = rows.filter(function (r) { return r.err; });
    var level = ok.filter(function (r) { return isLevel(r.point); });
    var tilted = ok.filter(function (r) { return !isLevel(r.point); });
    function both(list, key) {
      var out = [];
      list.forEach(function (r) { if (r[key]) out.push(r[key].pitch, r[key].roll); });
      return out;
    }
    var falseTilt = both(level, 'err'), tiltErr = both(tilted, 'err'), chg = both(tilted, 'change');
    var s = {
      n: ok.length, nLevel: level.length, nTilted: tilted.length, nChange: chg.length / 2,
      falseTiltRms: rms(falseTilt), falseTiltMax: maxAbs(falseTilt),
      tiltErrRms: rms(tiltErr), tiltErrMax: maxAbs(tiltErr),
      changeRms: rms(chg), changeMax: maxAbs(chg),
      yawRms: rms(ok.map(function (r) { return r.err.yaw; })), yawMax: maxAbs(ok.map(function (r) { return r.err.yaw; })),
      xyFlat: mean(ok.map(function (r) { return r.err.xyFlat; })),
      xyTilt: mean(ok.map(function (r) { return r.err.xyTilt; })),
      pass: null
    };
    // judged on level points only, as tools/eval-tilt.js
    if (level.length) {
      var xf = mean(level.map(function (r) { return r.err.xyFlat; })), xt = mean(level.map(function (r) { return r.err.xyTilt; }));
      s.pass = s.falseTiltRms <= TILT_RMS_MAX && xt - xf <= XY_WORSE_MAX;
    }
    return s;
  }

  // ---- CSV ------------------------------------------------------------------
  // Recorded points: the calibration columns (calib-model.js csvHeader(), raw
  // averaged RSS) plus the reference pitch_deg and roll_deg at the end. A
  // calibration file (no such columns) reads as level points.
  function pointsToCsv(points) {
    var out = [C.csvHeader().concat(['pitch_deg', 'roll_deg']).join(',')];
    points.forEach(function (p) {
      out.push([p.x, p.y, p.theta || 0, p.n || '', p.spread !== undefined ? +p.spread.toFixed(4) : '']
        .concat(p.rss.map(function (v) { return +v.toFixed(4); }), [p.z || 0, p.pitch || 0, p.roll || 0]).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }
  function csvToPoints(text) {
    var r = C.csvToPoses(text);
    r.poses.forEach(function (p) { if (!p.pitch) p.pitch = 0; if (!p.roll) p.roll = 0; });
    return { points: r.poses, errors: r.errors };
  }

  // The comparison table as CSV (to hand on): reference, solved, errors.
  var RESULT_HEADER = [
    'x_cm', 'y_cm', 'z_cm', 'yaw_deg', 'pitch_deg', 'roll_deg', 'leds_used', 'model', 'pd_skipped',
    'solved_x_cm', 'solved_y_cm', 'solved_z_cm', 'solved_yaw_deg', 'solved_pitch_deg', 'solved_roll_deg',
    'err_yaw_deg', 'err_pitch_deg', 'err_roll_deg', 'change_err_pitch_deg', 'change_err_roll_deg',
    'xy_err_with_tilt_cm', 'xy_err_level_model_cm', 'rss_rms'
  ];
  function resultsToCsv(result, k) {
    function n(v, d) { return v === null || v === undefined || isNaN(v) ? '' : +v.toFixed(d === undefined ? 2 : d); }
    var out = [RESULT_HEADER.join(',')];
    result.rows.forEach(function (r) {
      var p = r.point, t = r.tilt, e = r.err, c = r.change;
      out.push([p.x, p.y, p.z || 0, p.theta || 0, p.pitch || 0, p.roll || 0, k, r.model, r.skipPd >= 0 ? r.skipPd : '',
        t ? n(t.x) : '', t ? n(t.y) : '', t ? n(t.z) : '', t ? n(t.theta) : '', t ? n(t.pitch) : '', t ? n(t.roll) : '',
        e ? n(e.yaw) : '', e ? n(e.pitch) : '', e ? n(e.roll) : '', c ? n(c.pitch) : '', c ? n(c.roll) : '',
        e ? n(e.xyTilt) : '', e ? n(e.xyFlat) : '', t ? n(t.rms, 4) : ''].join(','));
    });
    return out.join('\r\n') + '\r\n';
  }

  var api = {
    TILT_RMS_MAX: TILT_RMS_MAX, XY_WORSE_MAX: XY_WORSE_MAX, LOO_MIN_POINTS: LOO_MIN_POINTS,
    angDiff: angDiff, isLevel: isLevel, samePlace: samePlace, samePoint: samePoint,
    firmwareModel: firmwareModel, analyse: analyse, fitWithout: fitWithout, evaluate: evaluate,
    pointsToCsv: pointsToCsv, csvToPoints: csvToPoints, RESULT_HEADER: RESULT_HEADER, resultsToCsv: resultsToCsv
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RATilt = api;
})(this);
