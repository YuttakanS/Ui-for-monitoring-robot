/* Where does the model error come from, and how far is it from what pitch and
 * roll would need? A check on the PC with recorded calibration poses
 * (2026-11-26, after docs/research-6dof-photodiode.md).
 *
 *   node tools/eval-error-budget.js [calib.csv ...]
 *   (default: data/2026-11-25/calib_105643.csv)
 *
 * The poses must be level and at a known x, y, yaw (a file of calibrate.html
 * or the raw points of tilt-test.html). Poses where a photodiode reads far too
 * low (lowPd(), a loose wire) are left out and listed.
 *   A. Direction to each LED read from its three photodiode values against
 *      the true direction. Needs neither PtxGamma nor m, so it shows the
 *      photodiode side alone. The report's rough need for +-3 deg of attitude:
 *      1 to 1.5 deg per LED.
 *   B. The pose solved with each pose left out of the fit: (x, y, yaw) only,
 *      with z (the firmware), and with pitch and roll. Median and P95, centre
 *      of the field against its edge.
 *   C. Would another model help? Lambertian order m, photodiode elevation
 *      beta, and the fit without the poses on the steel beams, each judged on
 *      the pose left out (not on the fit itself).
 *   D. LED harmonics that land on another LED's frequency at the firmware's
 *      sample rate (in theory; to be measured with one LED lit at a time).
 */
'use strict';
var fs = require('fs');
var path = require('path');
var C = require(path.join(__dirname, '..', 'web', 'js', 'calib-model.js'));
var T = require(path.join(__dirname, '..', 'web', 'js', 'tilt-test.js'));

var files = process.argv.slice(2);
if (!files.length) files = [path.join(__dirname, '..', 'data', '2026-11-25', 'calib_105643.csv')];
var D = Math.PI / 180;

function mean(a) { return a.reduce(function (s, v) { return s + v; }, 0) / a.length; }
function rms(a) { return Math.sqrt(mean(a.map(function (v) { return v * v; }))); }
// value below which the share p of a list lies (nearest rank)
function pct(a, p) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.max(0, Math.ceil(p * s.length) - 1)]; }
function f(v, n) { return v === undefined || isNaN(v) ? '-' : v.toFixed(n === undefined ? 1 : n); }
function pad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }
function mp(a, n) { return f(pct(a, 0.5), n) + ' / ' + f(pct(a, 0.95), n); }

// ---- poses ---------------------------------------------------------------------
var all = [];
files.forEach(function (file) {
  var r = T.csvToPoints(fs.readFileSync(file, 'utf8'));
  if (r.errors.length) console.warn(file + ': ' + r.errors.join(', '));
  r.points.forEach(function (p) { if (T.isLevel(p)) all.push(p); });
});
var poses = all.filter(function (p) {
  var pd = C.lowPd(p.rss, p);
  if (pd >= 0) console.log('left out: (' + p.x + ', ' + p.y + ') PD ' + pd + ' reads far too low');
  return pd < 0;
});
console.log(poses.length + ' level poses from ' + files.map(function (s) { return path.basename(s); }).join(', ') + '\n');
if (poses.length < T.LOO_MIN_POINTS) { console.error('need at least ' + T.LOO_MIN_POINTS + ' level poses'); process.exit(1); }

function params(fit, geo) {
  var o = {
    gamma: fit.leds.map(function (r, n) { return r.gamma !== null ? r.gamma : C.CURRENT_GAMMA[n]; }),
    pdGain: fit.pdGain, offset: fit.offset
  };
  if (geo && geo.m !== undefined) o.m = geo.m;
  if (geo && geo.beta !== undefined) o.beta = geo.beta;
  return o;
}
function copy(o, extra) { var c = {}, k; for (k in o) c[k] = o[k]; for (k in extra) c[k] = extra[k]; return c; }
// relative misfit of the model at the poses it was fitted on (values that carry signal)
function misfit(list, o) {
  var rel = [];
  list.forEach(function (p) {
    var top = Math.max.apply(null, p.rss);
    p.rss.forEach(function (v, i) {
      if (v < 0.05 * top) return;
      rel.push(v / C.predictRss(Math.floor(i / C.N_PD), i % C.N_PD, p.x / 100, p.y / 100, (p.z || 0) / 100, (p.theta || 0) * D, o) - 1);
    });
  });
  return rms(rel);
}
function isEdge(p) { return Math.abs(p.x) >= 50 || Math.abs(p.y) >= 50; }

var fitAll = params(C.fitModel(poses));
console.log('Model fitted on all poses: PD_GAIN ' + fitAll.pdGain.map(function (v) { return f(v, 3); }).join(', ') +
  '  RSS_OFFSET ' + f(fitAll.offset, 4) + '  misfit (rms, relative) ' + f(100 * misfit(poses, fitAll)) + ' %\n');

// ---- A. direction to each LED ------------------------------------------------------
console.log('A. Direction to each LED from its three photodiode values, against the true direction (deg)');
console.log('   (no PtxGamma, no m: the photodiode side alone; rough need for +-3 deg attitude: 1 to 1.5 deg)\n');
var dirAll = [];
poses.forEach(function (p) { C.ledDirectionErrors(p, fitAll).forEach(function (e) { e.pose = p; dirAll.push(e); }); });
console.log('   all LEDs, all poses: median / P95  ' + mp(dirAll.map(function (e) { return e.err; })) + '   (' + dirAll.length + ' LED readings)');
[[0, 25], [25, 40], [40, 90]].forEach(function (b) {
  var s = dirAll.filter(function (e) { return e.zenith >= b[0] && e.zenith < b[1]; });
  if (s.length) console.log('   LED ' + pad(b[0], 2) + ' to ' + b[1] + ' deg from overhead: ' + mp(s.map(function (e) { return e.err; })) + '   (' + s.length + ')');
});
// photodiode gains that give the best directions at one pose: the same everywhere?
function bestGains(p) {
  var best = null;
  for (var g1 = 0.5; g1 <= 1.401; g1 += 0.02) for (var g2 = 0.5; g2 <= 1.401; g2 += 0.02) {
    var e = C.ledDirectionErrors(p, { pdGain: [1, g1, g2], offset: fitAll.offset }).map(function (x) { return x.err; });
    if (!e.length) continue;
    var m = rms(e);
    if (!best || m < best.rms) best = { rms: m, g1: g1, g2: g2 };
  }
  return best;
}
console.log('\n          pose   z   median    max   | gains of PD 1, PD 2 that fit this pose best -> rms');
var gains = [];
poses.forEach(function (p) {
  var e = dirAll.filter(function (x) { return x.pose === p; }).map(function (x) { return x.err; }), b = bestGains(p);
  gains.push(b);
  console.log('   ' + pad('(' + p.x + ', ' + p.y + ')', 11) + pad(p.z || 0, 4) + pad(f(pct(e, 0.5)), 9) + pad(f(Math.max.apply(null, e)), 7) +
    '   | ' + pad(f(b.g1, 2), 5) + pad(f(b.g2, 2), 6) + '  -> ' + f(b.rms));
});
console.log('   best gains range: PD 1 ' + f(Math.min.apply(null, gains.map(function (g) { return g.g1; })), 2) + ' to ' +
  f(Math.max.apply(null, gains.map(function (g) { return g.g1; })), 2) + ', PD 2 ' +
  f(Math.min.apply(null, gains.map(function (g) { return g.g2; })), 2) + ' to ' + f(Math.max.apply(null, gains.map(function (g) { return g.g2; })), 2) +
  '  (one constant gain per photodiode would give the same value at every pose)\n');

// ---- B. pose with each pose left out of the fit ----------------------------------------
// geo: { m, beta } for section C. Returns per pose { p, xy, yaw, pitch, roll }.
function leaveOneOut(list, mode, k, geo) {
  return list.map(function (p, i) {
    var rest = list.filter(function (_, j) { return j !== i; });
    var o = params(C.fitModel(rest, geo || {}), geo);
    var pd = C.lowPd(p.rss, p, o);
    if (pd >= 0) o.skipPd = pd;
    if (mode === 'xyyaw') o.z = false;
    if (mode === 'tilt') o.tilt = true;
    var s = C.solvePose(C.selectLeds(p.rss, k), o);
    return { p: p, xy: Math.hypot(s.x - p.x, s.y - p.y), yaw: Math.abs(T.angDiff(s.theta, p.theta || 0)), pitch: s.pitch, roll: s.roll, o: o };
  });
}
var floor = poses.filter(function (p) { return !(p.z > 0); });   // not on the steel beams
var floorToo = floor.length >= T.LOO_MIN_POINTS && floor.length < poses.length;
console.log('B. Pose solved with that pose left out of the fit: median / P95');
var MODES = [['xyyaw', 'x, y, yaw (flat floor)   '], ['z', 'x, y, yaw, z (firmware)  '], ['tilt', 'x, y, yaw, z, pitch, roll']];
function tableB(label, list) {
  console.log('   ' + label);
  console.log('   LEDs  unknowns                      x/y (cm)      yaw (deg)    x/y centre   x/y edge   false tilt rms (deg)');
  [9, 6].forEach(function (k) {
    MODES.forEach(function (m) {
      var r = leaveOneOut(list, m[0], k);
      var centre = r.filter(function (x) { return !isEdge(x.p); }), edge = r.filter(function (x) { return isEdge(x.p); });
      var tilt = [];
      r.forEach(function (x) { tilt.push(x.pitch, x.roll); });
      console.log('   ' + pad(k, 4) + '  ' + m[1] + pad(mp(r.map(function (x) { return x.xy; })), 14) + pad(mp(r.map(function (x) { return x.yaw; })), 15) +
        pad(centre.length ? f(pct(centre.map(function (x) { return x.xy; }), 0.5)) : '-', 12) +
        pad(edge.length ? f(pct(edge.map(function (x) { return x.xy; }), 0.5)) : '-', 11) + pad(m[0] === 'tilt' ? f(rms(tilt)) : '-', 14));
    });
  });
  console.log('   (centre = |x| and |y| under 50 cm: ' + list.filter(function (p) { return !isEdge(p); }).length + ' poses; edge: ' + list.filter(isEdge).length + ')\n');
}
tableB('all ' + poses.length + ' poses (mean x/y is what tools/eval-tilt.js prints)', poses);
if (floorToo) tableB('the ' + floor.length + ' poses on the floor only (z = 0; the others stand on the steel beams)', floor);

// ---- C. other models, judged on the pose left out ----------------------------------------
console.log('C. Would another model help? Each line: fitted without the pose, then that pose solved (9 LEDs, x, y, yaw, z)');
console.log('   model                          x/y mean   median / P95   LED direction median   misfit of the fit');
function variant(label, list, geo) {
  var r = leaveOneOut(list, 'z', 9, geo);
  var dir = [];
  r.forEach(function (x) { C.ledDirectionErrors(x.p, x.o).forEach(function (e) { dir.push(e.err); }); });
  var xy = r.map(function (x) { return x.xy; });
  console.log('   ' + (label + '                              ').slice(0, 30) + pad(f(mean(xy), 2), 8) + pad(mp(xy), 16) + pad(f(pct(dir, 0.5)), 18) +
    pad(f(100 * misfit(list, params(C.fitModel(list, geo || {}), geo))) + ' %', 20));
}
variant('as the firmware (m 1, be 55)', poses);
[0.6, 0.8, 1.2, 1.4, 1.6].forEach(function (m) { variant('m = ' + m, poses, { m: m }); });
[45, 50, 60, 65].forEach(function (b) { variant('be = ' + b + ' deg', poses, { beta: b * D }); });
if (floorToo) variant('floor poses only (' + floor.length + ')', floor);
if (floorToo) console.log('   constants fitted on the floor poses only (for comparison, NOT in the firmware: ' + floor.length + ' poses are few, and none under the outer LED rows):\n     ' +
  C.firmwareLines(C.fitModel(floor)).split('\n').join('\n     '));
console.log('   (a model is better only if the left-out x/y and the direction error both drop; the misfit of the fit alone always drops with more freedom)\n');

// ---- D. harmonics that alias onto another LED ---------------------------------------------
var pairs = C.aliasPairs();
console.log('D. Odd harmonics of one LED that land on another LED at ' + C.SAMPLE_RATE + ' samples/s (square wave: harmonic k is 1/k as strong)');
if (!pairs.length) console.log('   none up to harmonic 41');
pairs.slice(0, 10).forEach(function (pr) {
  console.log('   LED ' + C.ROW_LED[pr.from] + ' (' + C.LED_FREQ[pr.from] + ' Hz) x ' + pad(pr.k, 2) + ' -> LED ' + C.ROW_LED[pr.to] + ' (' + C.LED_FREQ[pr.to] +
    ' Hz)   up to ' + f(100 * pr.share) + ' % of LED ' + C.ROW_LED[pr.from]);
});
if (pairs.length > 10) console.log('   ... ' + pairs.length + ' pairs in all up to harmonic 41');
// do the recorded poses show it? misfit of the "to" LED against the reading of the "from" LED on the same photodiode
function corr(x, y) {
  var mx = mean(x), my = mean(y), sxy = 0, sxx = 0, syy = 0;
  for (var i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); syy += (y[i] - my) * (y[i] - my); }
  return sxy / Math.sqrt(sxx * syy);
}
function leak(list) {
  var x = [], y = [];
  list.forEach(function (pr) {
    poses.forEach(function (p) {
      for (var l = 0; l < C.N_PD; l++) {
        x.push(p.rss[pr.from * C.N_PD + l]);
        y.push(p.rss[pr.to * C.N_PD + l] - C.predictRss(pr.to, l, p.x / 100, p.y / 100, (p.z || 0) / 100, (p.theta || 0) * D, fitAll));
      }
    });
  });
  return corr(x, y);
}
var others = [];
for (var a = 0; a < C.N_LED; a++) for (var b = 0; b < C.N_LED; b++)
  if (a !== b && !pairs.some(function (pr) { return pr.from === a && pr.to === b; })) others.push({ from: a, to: b });
if (pairs.length) console.log('   in these poses: misfit of the LED hit against the reading of the LED that hits it, correlation ' + f(leak(pairs), 2) +
  '; for the pairs that do not alias ' + f(leak(others), 2) + '  (about equal = the data do not show it)');
