/* Can pitch and roll be read from the photodiodes alone? A check on the PC with
 * real data before the firmware is touched (2026-11-25).
 *
 *   node tools/eval-tilt.js
 *
 * Uses solvePose() of web/js/calib-model.js with opts.tilt (x, y, yaw, z, pitch
 * and roll from one RSS line: where an EKF settles for a robot that stands
 * still).
 *   A. False tilt: the calibration poses were recorded with the robot level,
 *      so any pitch / roll solved there is error. Each pose is solved with a
 *      model fitted without it (leave one out).
 *   B. Known tilt: the model's RSS for a tilted robot, times the misfit the
 *      real data shows at that pose (measured / model, per value). Shows
 *      whether a real tilt would be seen on top of the false one.
 *   C. The (0, 0) recordings with PD 2 reading low, PD 2 left out.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var C = require(path.join(__dirname, '..', 'web', 'js', 'calib-model.js'));

var DATA = path.join(__dirname, '..', 'data', '2026-11-25');
function read(name) { return C.csvToPoses(fs.readFileSync(path.join(DATA, name), 'utf8')).poses; }
var poses = read('calib_105643.csv').filter(function (p) { return !(p.x === -25 && p.y === -25); }); // PD 2 low there
var D = Math.PI / 180;

function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }
function rms(a) { return Math.sqrt(mean(a.map(function (v) { return v * v; }))); }
function maxAbs(a) { return Math.max.apply(null, a.map(Math.abs)); }
function f(v, n) { return v.toFixed(n === undefined ? 1 : n); }
function pad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

// model fitted without pose i
function fitWithout(i) {
  var fit = C.fitModel(poses.filter(function (_, j) { return j !== i; }));
  return {
    gamma: fit.leds.map(function (r, n) { return r.gamma !== null ? r.gamma : C.CURRENT_GAMMA[n]; }),
    pdGain: fit.pdGain, offset: fit.offset
  };
}
function solve(rss, p, o, k, tilt) {
  var opts = { gamma: o.gamma, pdGain: o.pdGain, offset: o.offset, tilt: tilt };
  var pd = C.lowPd(rss, p, o);            // judged on every lit LED, as robot.ino
  if (pd >= 0) opts.skipPd = pd;
  return C.solvePose(C.selectLeds(rss, k), opts);
}

var fits = poses.map(function (_, i) { return fitWithout(i); });

// ---- A. false tilt on level poses ------------------------------------------------
console.log('A. Robot level at the 12 calibration poses (leave one out): pitch / roll solved there are false\n');
var summaryA = {};
[9, 6].forEach(function (k) {
  var rows = [], eFlat = [], eTilt = [], pit = [], rol = [];
  poses.forEach(function (p, i) {
    var a = solve(p.rss, p, fits[i], k, false), b = solve(p.rss, p, fits[i], k, true);
    var ea = Math.hypot(a.x - p.x, a.y - p.y), eb = Math.hypot(b.x - p.x, b.y - p.y);
    eFlat.push(ea); eTilt.push(eb); pit.push(b.pitch); rol.push(b.roll);
    rows.push(pad('(' + p.x + ', ' + p.y + ')', 11) + pad(f(ea), 8) + pad(f(eb), 8) + pad(f(b.pitch), 9) + pad(f(b.roll), 8) + pad(f(b.z - (p.z || 0)), 8));
  });
  console.log('  ' + k + ' LEDs      pose  xy flat  xy tilt    pitch    roll  z err   (cm, deg)');
  rows.forEach(function (r) { console.log('  ' + r); });
  var tiltAll = pit.concat(rol);
  summaryA[k] = { flat: mean(eFlat), tilt: mean(eTilt), tiltMax: Math.max.apply(null, eTilt), rmsTilt: rms(tiltAll), maxTilt: maxAbs(tiltAll) };
  console.log('  mean x/y: level model ' + f(mean(eFlat), 2) + ' cm, with tilt ' + f(mean(eTilt), 2) + ' cm (max ' + f(Math.max.apply(null, eTilt)) +
    ')   false tilt rms ' + f(rms(tiltAll)) + ' deg, max ' + f(maxAbs(tiltAll)) + ' deg\n');
});

// ---- B. known tilt with the real misfit ---------------------------------------
console.log('B. Known tilt, RSS = model at that tilt x the misfit seen in the real data at each pose');
console.log('   error = solved tilt - true tilt; "change" = solved tilt - tilt solved for the same pose level\n');
var cases = [[5, 0], [-5, 0], [0, 5], [0, -5], [10, 0], [0, 10], [5, -5], [10, 10]];
[9, 6].forEach(function (k) {
  console.log('  ' + k + ' LEDs   true pitch, roll   error rms / max (deg)   change error rms / max (deg)   x/y mean (cm)');
  cases.forEach(function (c) {
    var err = [], chg = [], exy = [];
    poses.forEach(function (p, i) {
      var x = p.x / 100, y = p.y / 100, z = (p.z || 0) / 100, o = fits[i];
      var level = [], tilted = [];
      for (var row = 0; row < C.N_LED; row++) for (var l = 0; l < C.N_PD; l++) {
        var m0 = C.predictRss(row, l, x, y, z, 0, o);
        var mt = C.predictRss(row, l, x, y, z, 0, { gamma: o.gamma, pdGain: o.pdGain, offset: o.offset, pitch: c[0] * D, roll: c[1] * D });
        var ratio = p.rss[row * C.N_PD + l] / m0;        // what the real robot read against the model
        level.push(p.rss[row * C.N_PD + l]);
        tilted.push(mt * ratio);
      }
      var s0 = solve(level, p, o, k, true), s1 = solve(tilted, p, o, k, true);
      err.push(s1.pitch - c[0], s1.roll - c[1]);
      chg.push((s1.pitch - s0.pitch) - c[0], (s1.roll - s0.roll) - c[1]);
      exy.push(Math.hypot(s1.x - p.x, s1.y - p.y));
    });
    console.log('  ' + pad(c[0] + ', ' + c[1], 23) + pad(f(rms(err)) + ' / ' + f(maxAbs(err)), 22) + pad(f(rms(chg)) + ' / ' + f(maxAbs(chg)), 30) + pad(f(mean(exy), 2), 16));
  });
  console.log('');
});

// ---- C. PD 2 low ---------------------------------------------------------------
console.log('C. Robot level at (0, 0), PD 2 reading about 1/3 (13:41 and 13:42), firmware constants');
['pd2_low_134138.csv', 'pd2_low_134223.csv'].forEach(function (name) {
  var p = read(name)[0], o = { gamma: C.CURRENT_GAMMA, pdGain: C.PD_GAIN, offset: C.RSS_OFFSET };
  [9, 6].forEach(function (k) {
    var a = solve(p.rss, p, o, k, false), b = solve(p.rss, p, o, k, true);
    console.log('  ' + name + ' ' + k + ' LEDs: level model x/y ' + f(a.x) + ', ' + f(a.y) + '   with tilt x/y ' + f(b.x) + ', ' + f(b.y) +
      '  pitch ' + f(b.pitch) + '  roll ' + f(b.roll) + '  (' + b.nValues + ' values, ' + b.nUnknowns + ' unknowns)');
  });
});

// ---- verdict against the limits proposed in the plan -------------------------------
console.log('\nLimits: false tilt rms <= 3 deg and mean x/y no more than 0.5 cm worse than the level model');
[9, 6].forEach(function (k) {
  var s = summaryA[k], ok = s.rmsTilt <= 3 && s.tilt - s.flat <= 0.5;
  console.log('  ' + k + ' LEDs: false tilt rms ' + f(s.rmsTilt) + ' deg, x/y ' + f(s.flat, 2) + ' -> ' + f(s.tilt, 2) + ' cm  => ' + (ok ? 'PASS' : 'FAIL'));
});
