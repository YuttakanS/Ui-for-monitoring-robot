// Run: node --test tests/
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var C = require('../web/js/calib-model.js');

// robot.ino without // comments (old commented-out values must not match)
var INO = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'robot', 'robot.ino'), 'utf8')
  .replace(/\/\/.*$/gm, '');
function inoArray(decl) {
  var m = new RegExp(decl.replace(/[<>,]/g, '\\$&') + '\\s*(?:\\[[^\\]]*\\])*\\s*=\\s*\\{([^}]*)\\}').exec(INO);
  assert.ok(m, decl + ' not found in robot.ino');
  return m[1].split(',').map(function (s) { return parseFloat(s); });
}
function close(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b); }

// deterministic noise so the tests never flake
function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

test('constants match robot.ino', function () {
  assert.deepEqual(inoArray('LED_NUM'), C.ROW_LED);
  assert.deepEqual(inoArray('PtxGamma'), C.CURRENT_GAMMA);
  var p = inoArray('BLA::Matrix<N_LED, 3> p');
  assert.deepEqual(p, [].concat.apply([], C.P));
  var mIno = /const float m = ([\d.]+);/.exec(INO);
  assert.ok(mIno, 'm not found in robot.ino');
  assert.equal(parseFloat(mIno[1]), C.M);
  assert.match(INO, /const float FoV = M_PI \/ 2;/);
  var beIno = /const float be = ([\d.]+)f? \* M_PI \/ 180\.0f?;/.exec(INO);
  assert.ok(beIno, 'be not found in robot.ino');
  close(parseFloat(beIno[1]) * Math.PI / 180, C.BETA, 1e-12, 'be');
  assert.match(INO, /const float al\[N_PD\] = \{ 0, 2\.0\*M_PI\/3\.0, -2\.0\*M_PI\/3\.0 \};/);
  assert.deepEqual(inoArray('PD_GAIN'), C.PD_GAIN);
  var offIno = /const float RSS_OFFSET = ([\d.]+)f?;/.exec(INO);
  assert.ok(offIno, 'RSS_OFFSET not found in robot.ino');
  assert.equal(parseFloat(offIno[1]), C.RSS_OFFSET);
  var zr = /const float Z_MIN = (-?[\d.]+)f?, Z_MAX = ([\d.]+)f?;/.exec(INO);
  assert.ok(zr, 'Z_MIN / Z_MAX not found in robot.ino');
  assert.equal(parseFloat(zr[1]), C.Z_MIN); assert.equal(parseFloat(zr[2]), C.Z_MAX);
  // the EKF prediction and Jacobian use the same model as predictRss()
  // (pathLossCS is pathLossWithoutGamma with cos / sin of the heading passed in)
  assert.match(INO, /PtxGamma\[f\] \* PD_GAIN\[g\] \* pathLossCS\([^;]*\) \+ RSS_OFFSET/);
  assert.equal((INO.match(/PtxGamma\[k\] \* PD_GAIN\[l\] \* pathLossCS/g) || []).length, 2);
  assert.match(INO, /return \(m \+ 1\) \* \(m == 1\.0f \? cosPhikl : powf\(cosPhikl, m\)\) \* cosPsikl \/ \(dk \* dk\);/);
});

test('fitModel recovers gamma, photodiode gain and offset', function () {
  var lit = [1, 2, 7, 8], r = rng(5);
  var truth = { gamma: [0.49, 0.49, 0.45, 0.43, 0.54, 0.51, 0.46, 0.46, 0.46], pdGain: [1, 0.9, 1.08], offset: 0.05 };
  var samples = C.presetPoses(lit).map(function (p) {
    var rss = [];
    for (var row = 0; row < 9; row++) for (var l = 0; l < 3; l++) {
      var on = lit.indexOf(C.ROW_LED[row]) >= 0;
      rss.push(on ? C.predictRss(row, l, p.x / 100, p.y / 100, 0, 0, truth) * (1 + 0.01 * (2 * r() - 1)) : 0);
    }
    return { x: p.x, y: p.y, rss: rss };
  });
  var f = C.fitModel(samples, { leds: lit });
  assert.ok(f.fitted);
  close(f.pdGain[1], 0.9, 0.02, 'pd1'); close(f.pdGain[2], 1.08, 0.02, 'pd2');
  close(f.offset, 0.05, 0.01, 'offset');
  lit.forEach(function (led) { var row = C.ROW_LED.indexOf(led); close(f.leds[row].gamma / truth.gamma[row], 1, 0.02, 'LED ' + led); });
  var lines = C.firmwareLines(f).split('\n');
  assert.match(lines[0], /^const float PtxGamma\[N_LED\]/);
  assert.match(lines[1], /^const float PD_GAIN\[N_PD\] = \{ 1\.000f, 0\.9\d\df, 1\.0\d\df \};$/);
  assert.match(lines[2], /^const float RSS_OFFSET = 0\.0\d{3}f;$/);
  // too few poses: gains and offset stay at the firmware values
  var few = C.fitModel(samples.slice(0, 2), { leds: lit });
  assert.equal(few.fitted, false); assert.deepEqual(few.pdGain, C.PD_GAIN); assert.equal(few.offset, C.RSS_OFFSET);
});

test('pathLoss: robot under LED 4, PD 0 (GP28) facing +X', function () {
  // d = 0.92, cos(phi) = 1, cos(psi) = sin(be): h = (m + 1) * sin(be) / 0.8464
  close(C.pathLoss(0, 0, 0, 0, 0, 0), (C.M + 1) * Math.sin(C.BETA) / (0.92 * 0.92), 1e-9);
});

test('pathLoss: PD 0 at theta equals PD 1 at theta - 120 deg', function () {
  var r = rng(1);
  for (var i = 0; i < 50; i++) {
    var row = Math.floor(r() * 9), x = r() - 0.5, y = r() - 0.5, th = (r() - 0.5) * 2 * Math.PI;
    close(C.pathLoss(row, 0, x, y, 0, th), C.pathLoss(row, 1, x, y, 0, th - 2 * Math.PI / 3), 1e-9);
  }
});

test('pathLoss: 0 when the LED is outside the field of view', function () {
  // PD 0 faces +X tilted up 60 deg. LED 5 at (-50, 0) seen from (+50, 0):
  // (pk - p0) . w = -1.0 * 0.5 + 0.92 * 0.866 > 0, still in view
  assert.ok(C.pathLoss(1, 0, 0.5, 0, 0, 0) > 0);
  // from 3 m away on +X the LED is low behind PD 0: -3.5 * 0.5 + 0.92 * 0.866 < 0
  assert.equal(C.pathLoss(1, 0, 3, 0, 0, 0), 0);
});

test('parseRssLine', function () {
  var vals = []; for (var i = 0; i < 27; i++) vals.push((i / 10).toFixed(2));
  assert.deepEqual(C.parseRssLine(vals.join(', ') + ', '), vals.map(Number));
  assert.equal(C.parseRssLine('Quadrant 1: 1.00, 2.00, 3.00, 0.00'), null);
  assert.equal(C.parseRssLine('# LED 4 1'), null);
  assert.equal(C.parseRssLine('1.0, 2.0, 3.0'), null);
  assert.equal(C.parseRssLine(''), null);
});

// 9 poses under the LEDs + 4 between them, theta = 0, on the floor
var POSES = [];
[-50, 0, 50].forEach(function (x) { [-50, 0, 50].forEach(function (y) { POSES.push({ x: x, y: y }); }); });
[[-25, -25], [-25, 25], [25, -25], [25, 25]].forEach(function (p) { POSES.push({ x: p[0], y: p[1] }); });

function simulate(trueGamma, ledOff, noise, seed) {
  var r = rng(seed);
  return POSES.map(function (pose) {
    var h = C.modelRow(pose);
    return {
      x: pose.x, y: pose.y,
      rss: h.map(function (hv, i) {
        var row = Math.floor(i / 3);
        if (ledOff.indexOf(C.ROW_LED[row]) >= 0) return 0;
        return trueGamma[row] * hv * (1 + noise * (2 * r() - 1)) + 0.002 * r(); // gain noise + small floor
      })
    };
  });
}

test('fitGamma recovers known gammas within 2 % (LED 4, 5 off)', function () {
  var truth = [0.49, 0.49, 0.52, 0.44, 0.47, 0.50, 0.41, 0.55, 0.45];
  var res = C.fitGamma(simulate(truth, [4, 5], 0.03, 7));
  res.forEach(function (r, row) {
    if (r.led === 4 || r.led === 5) {
      assert.equal(r.gamma, null); assert.equal(r.skipped, 'off');
    } else {
      assert.ok(r.n >= 3, 'LED ' + r.led + ' n=' + r.n);
      close(r.gamma / truth[row], 1, 0.02, 'LED ' + r.led);
      assert.ok(r.rmsRel < 0.05, 'LED ' + r.led + ' rms ' + r.rmsRel);
    }
  });
  var line = C.firmwareLine(res);
  // LED 4 and 5 (not fitted) keep the gamma in use now
  var kept = C.CURRENT_GAMMA.slice(0, 2).map(function (g) { return g.toFixed(3).replace('.', '\\.') + 'f'; }).join(', ');
  assert.match(line, new RegExp('^const float PtxGamma\\[N_LED\\] = \\{ ' + kept + ', 0\\.5\\d\\df, '));
});

test('fitGamma shows a photodiode that reads 10 % high', function () {
  var truth = [0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46, 0.46];
  var samples = simulate(truth, [4, 5], 0, 3);
  samples.forEach(function (s) { for (var row = 0; row < 9; row++) s.rss[row * 3 + 2] *= 1.1; });
  C.fitGamma(samples).forEach(function (r) {
    if (r.gamma === null) return;
    assert.ok(r.pdBias[2] > r.pdBias[0] + 0.05 && r.pdBias[2] > r.pdBias[1] + 0.05, 'LED ' + r.led + ' ' + r.pdBias);
  });
});

test('robot.ino prints RSS with 4 decimals', function () {
  assert.match(INO, /out\.print\(RSS\[f\]\[g\], 4\);/);
});

test('averageRss: mean and spread', function () {
  var a = [], b = [];
  for (var i = 0; i < 27; i++) { a.push(i < 3 ? 0 : 1.0); b.push(i < 3 ? 0 : 1.0); }
  b[5] = 1.2; // one value moved 20 %
  var r = C.averageRss([a, b]);
  assert.equal(r.n, 2);
  close(r.rss[5], 1.1, 1e-12);
  assert.equal(r.rss[0], 0);
  close(r.spread, 0.2 / 1.1, 1e-12);
  assert.equal(C.averageRss([a, a]).spread, 0);
  assert.equal(C.averageRss([]), null);
});

test('checkPose: lit LED reading 0, dark LED reading something', function () {
  var seven = [0, 1, 2, 3, 6, 7, 8];
  var rss = C.modelRow({ x: 0, y: 0 }).map(function (h, i) {
    return seven.indexOf(C.ROW_LED[Math.floor(i / 3)]) >= 0 ? 0.46 * h : 0;
  });
  assert.deepEqual(C.checkPose(rss, seven), []);
  var row0 = C.ROW_LED.indexOf(0), row4 = C.ROW_LED.indexOf(4);
  rss[row0 * 3] = rss[row0 * 3 + 1] = rss[row0 * 3 + 2] = 0; // LED 0 out
  rss[row4 * 3] = 0.5;                                        // LED 4 left on in firmware
  assert.deepEqual(C.checkPose(rss, seven), [{ led: 4, kind: 'unexpected' }, { led: 0, kind: 'zero' }]);
  // default set is all 9 LEDs (2026-11-25): LED 5 and 0 read nothing
  assert.deepEqual(C.DEFAULT_LIT, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(C.checkPose(rss).map(function (w) { return w.led + w.kind; }), ['5zero', '0zero']);
  assert.equal(C.presetPoses().length, 13);
});

test('presetPoses: grid inside the lit LEDs plus cell centres', function () {
  function key(ps) { return ps.map(function (p) { return p.x + ',' + p.y; }).sort(); }
  assert.deepEqual(key(C.presetPoses([1, 2, 7, 8])),
    key([{ x: -50, y: 50 }, { x: 0, y: 50 }, { x: -50, y: 0 }, { x: 0, y: 0 }, { x: -50, y: -50 }, { x: 0, y: -50 },
      { x: -25, y: 25 }, { x: -25, y: -25 }]));
  assert.equal(C.presetPoses([0, 1, 2, 3, 4, 5, 6, 7, 8]).length, 13);
  assert.deepEqual(key(C.presetPoses([4])), ['0,0']);
  assert.deepEqual(C.presetPoses([]), []);
});

test('fitGamma with LED 1, 2, 7, 8 at their 8 preset poses', function () {
  var lit = [1, 2, 7, 8], truth = [0.49, 0.49, 0.52, 0.44, 0.47, 0.50, 0.41, 0.55, 0.45], r = rng(21);
  var samples = C.presetPoses(lit).map(function (p) {
    return { x: p.x, y: p.y, rss: C.modelRow(p).map(function (h, i) {
      var row = Math.floor(i / 3);
      return lit.indexOf(C.ROW_LED[row]) >= 0 ? truth[row] * h * (1 + 0.03 * (2 * r() - 1)) : 0;
    }) };
  });
  var res = C.fitGamma(samples, { leds: lit });
  res.forEach(function (q) {
    if (lit.indexOf(q.led) < 0) { assert.equal(q.gamma, null); return; }
    assert.ok(q.n >= 15, 'LED ' + q.led + ' n=' + q.n);
    close(q.gamma / truth[q.row], 1, 0.02, 'LED ' + q.led);
  });
  // a chosen LED that reads 0 everywhere is reported, not fitted as gamma = 0
  var r2 = C.fitGamma(samples, { leds: [0, 1] });
  assert.equal(r2[C.ROW_LED.indexOf(0)].skipped, 'no signal');
  assert.ok(r2[C.ROW_LED.indexOf(1)].gamma > 0);
  // poses taken while LED 7 was off do not pull its gamma down
  var row7 = C.ROW_LED.indexOf(7);
  var mixed = samples.map(function (s, i) {
    var rss = s.rss.slice();
    if (i % 2) rss[row7 * 3] = rss[row7 * 3 + 1] = rss[row7 * 3 + 2] = 0;
    return { x: s.x, y: s.y, rss: rss };
  });
  close(C.fitGamma(mixed, { leds: lit })[row7].gamma / truth[row7], 1, 0.02, 'LED 7 mixed');
});

test('CSV round trip and RSS line round trip', function () {
  var poses = simulate(C.CURRENT_GAMMA, [4, 5], 0.02, 11).slice(0, 3);
  poses[0].theta = 0; poses[0].n = 30; poses[0].spread = 0.031;
  var back = C.csvToPoses(C.posesToCsv(poses));
  assert.deepEqual(back.errors, []);
  assert.equal(back.poses.length, 3);
  back.poses.forEach(function (p, i) {
    assert.equal(p.x, poses[i].x); assert.equal(p.y, poses[i].y);
    p.rss.forEach(function (v, j) { close(v, poses[i].rss[j], 5e-5); });
  });
  assert.equal(back.poses[0].n, 30);
  assert.equal(C.csvHeader()[5], 'led4_pd0');
  assert.equal(C.csvToPoses('a,b\n1,2').poses.length, 0);
  assert.match(C.csvToPoses('a,b\n1,2').errors[0], /missing columns/);
  var line = C.formatRssLine(poses[1].rss);
  C.parseRssLine(line).forEach(function (v, j) { close(v, poses[1].rss[j], 5e-5); });
});

test('CSV: z_cm (robot base height) is the last column and round-trips', function () {
  var poses = simulate(C.CURRENT_GAMMA, [4, 5], 0.02, 11).slice(0, 2);
  poses[0].z = 3; // standing on a steel beam
  var csv = C.posesToCsv(poses);
  var head = csv.split('\r\n')[0].split(',');
  assert.equal(head[head.length - 1], 'z_cm');
  var back = C.csvToPoses(csv);
  assert.deepEqual(back.errors, []);
  assert.equal(back.poses[0].z, 3);
  assert.equal(back.poses[1].z, 0);
  assert.equal(back.poses[0].rss.length, C.N_LED * C.N_PD);
});

test('CSV: files recorded before z_cm read as z = 0', function () {
  var file = path.join(__dirname, '..', 'data', '2026-11-19', 'calib_130953.csv');
  var text = fs.readFileSync(file, 'utf8');
  assert.ok(text.split(/\r?\n/)[0].indexOf('z_cm') < 0, 'old file has no z_cm');
  var r = C.csvToPoses(text);
  assert.deepEqual(r.errors, []);
  assert.ok(r.poses.length >= 8);
  r.poses.forEach(function (p) {
    assert.equal(p.z, 0);
    assert.equal(p.rss.length, C.N_LED * C.N_PD);
    assert.ok(p.rss.every(function (v) { return !isNaN(v); }));
  });
});

test('fitModel uses the pose height: z = 3 poses fit when the data are 3 cm up', function () {
  var lit = [1, 2, 7, 8], truth = { gamma: C.CURRENT_GAMMA, pdGain: C.PD_GAIN, offset: C.RSS_OFFSET };
  var samples = C.presetPoses(lit).map(function (p) {
    var z = Math.abs(p.y) === 50 ? 3 : 0, rss = [];
    for (var row = 0; row < 9; row++) for (var l = 0; l < 3; l++) {
      rss.push(lit.indexOf(C.ROW_LED[row]) >= 0 ? C.predictRss(row, l, p.x / 100, p.y / 100, z / 100, 0, truth) : 0);
    }
    return { x: p.x, y: p.y, z: z, rss: rss };
  });
  var withZ = C.fitModel(samples, { leds: lit });
  var noZ = C.fitModel(samples.map(function (s) { return { x: s.x, y: s.y, rss: s.rss }; }), { leds: lit });
  lit.forEach(function (led) {
    var row = C.ROW_LED.indexOf(led);
    close(withZ.leds[row].gamma, C.CURRENT_GAMMA[row], 1e-3, 'LED ' + led);
  });
  function misfit(fit) {
    var all = [];
    fit.leds.forEach(function (r) { if (r.resid) all = all.concat(r.resid); });
    return Math.sqrt(all.reduce(function (s, v) { return s + v * v; }, 0) / all.length);
  }
  assert.ok(misfit(withZ) < misfit(noZ) / 10, 'misfit with z ' + misfit(withZ) + ' vs without ' + misfit(noZ));
});

test('fitGamma: an LED seen at too few points is not fitted', function () {
  var samples = simulate(C.CURRENT_GAMMA, [4, 5], 0, 5).slice(0, 1);
  var res = C.fitGamma(samples, { minPoints: 5 });
  res.forEach(function (r) { if (r.skipped !== 'off') assert.equal(r.skipped, 'too few points'); });
});

test('solvePose finds a known pose, with and without z', function () {
  var rowsOn = [1, 2, 7, 8].map(function (k) { return C.ROW_LED.indexOf(k); });
  function rssAt(p) { // the firmware model with its constants
    var out = [];
    for (var row = 0; row < 9; row++) for (var l = 0; l < 3; l++)
      out.push(rowsOn.indexOf(row) >= 0 ? C.predictRss(row, l, p.x / 100, p.y / 100, (p.z || 0) / 100, (p.theta || 0) * Math.PI / 180) : 0);
    return out;
  }
  [{ x: -25, y: 0, z: 0, theta: 0 }, { x: -10, y: 20, z: 15, theta: 40 },
   { x: -30, y: -25, z: 30, theta: -120 }, { x: -25, y: 10, z: 50, theta: 170 }].forEach(function (p) {
    var r = C.solvePose(rssAt(p));
    close(r.x, p.x, 0.5, 'x'); close(r.y, p.y, 0.5, 'y'); close(r.z, p.z, 0.5, 'z');
    close(Math.abs(((r.theta - p.theta + 540) % 360) - 180), 0, 0.5, 'theta');
  });
  var flat = C.solvePose(rssAt({ x: -25, y: -25, theta: 0 }), { z: false });
  assert.equal(flat.z, 0);
  close(flat.x, -25, 0.5, 'x'); close(flat.y, -25, 0.5, 'y');
});

test('lowPd: PD 2 at (-25, -25) is left out, no photodiode at the good poses (2026-11-25 data)', function () {
  var file = path.join(__dirname, '..', 'data', '2026-11-25', 'calib_105643.csv');
  var poses = C.csvToPoses(fs.readFileSync(file, 'utf8')).poses;
  // the EKF judges at its prediction, so try priors up to 20 cm / 30 deg off
  var offs = [[0, 0, 0], [20, 0, 0], [-20, 0, 0], [0, 20, 0], [0, -20, 0], [14, 14, 0], [-14, -14, 0], [0, 0, 30], [0, 0, -30]];
  poses.forEach(function (p) {
    var bad = p.x === -25 && p.y === -25;
    offs.forEach(function (o) {
      var k = C.lowPd(p.rss, { x: p.x + o[0], y: p.y + o[1], z: p.z, theta: o[2] });
      assert.equal(k, bad ? 2 : -1, '(' + p.x + ', ' + p.y + ') prior off by ' + o);
    });
  });
  var p = poses.filter(function (q) { return q.x === -25 && q.y === -25; })[0];
  var all = C.solvePose(p.rss), skip = C.solvePose(p.rss, { skipPd: 2 });
  assert.ok(Math.hypot(all.x + 25, all.y + 25) > 30, 'with PD 2 the pose is far off');
  assert.ok(Math.hypot(skip.x + 25, skip.y + 25) < 6, 'without PD 2: ' + skip.x + ', ' + skip.y);
});

test('robot.ino leaves out a low photodiode with the same rule as lowPd()', function () {
  var ratio = /const float PD_LOW_RATIO = ([\d.]+)f;/.exec(INO), min = /const float PD_LOW_MIN = ([\d.]+)f;/.exec(INO);
  assert.ok(ratio && min, 'PD_LOW_RATIO / PD_LOW_MIN not found');
  assert.equal(parseFloat(ratio[1]), C.PD_LOW_RATIO);
  assert.equal(parseFloat(min[1]), C.PD_LOW_MIN);
  assert.match(INO, /const bool SKIP_LOW_PD = true;/);
  assert.match(INO, /meas \+= fmaxf\(0\.0f, zn\(i\) - RSS_OFFSET\);/);
  assert.match(INO, /model \+= zHn\(i\) - RSS_OFFSET;/);
  assert.match(INO, /return share\[lo\] < PD_LOW_RATIO \* med \? lo : -1;/);
  // judged after zHn is set and before the update, and the skipped values carry no information
  var body = INO.slice(INO.indexOf('computeJacobian(xHnnm1);')); // INO has its comments removed
  assert.ok(body.length < INO.length, 'correction step not found');
  assert.ok(body.indexOf('lowPd()') > body.indexOf('zHn(N_PD * f + g) ='), 'lowPd after zHn');
  assert.ok(body.indexOf('lowPd()') < body.indexOf('ekfUpdateSequential();'), 'lowPd before the update');
  assert.match(body, /zHn\(i\) = zn\(i\);\s*for \(int j = 0; j < N_STATE; j\+\+\) Jn\(i, j\) = 0;/);
});

test('selectLeds: the k brightest lit LEDs, others set to 0', function () {
  var rss = [];
  for (var row = 0; row < C.N_LED; row++) for (var l = 0; l < C.N_PD; l++) rss.push(row === 5 ? 0 : (row + 1) * (l === 1 ? 2 : 1));
  var out = C.selectLeds(rss, 3);
  var used = C.ROW_LED.map(function (_, r) { return out[r * 3] + out[r * 3 + 1] + out[r * 3 + 2] !== 0; });
  assert.deepEqual(used, [false, false, false, false, false, false, true, true, true]);
  out.forEach(function (v, i) { if (v !== 0) assert.equal(v, rss[i]); });
  // more than the lit LEDs: all lit ones (row 5 is off)
  var all = C.selectLeds(rss, 9);
  assert.deepEqual(all, rss);
  assert.equal(C.selectLeds(rss).filter(function (v) { return v !== 0; }).length, C.LED_USE_K * 3);
});

test('robot.ino selects LEDs with the same rule and LED_USE_K as calib-model.js', function () {
  var k = /int LED_USE_K = (\d+);/.exec(INO);
  assert.ok(k, 'LED_USE_K not found');
  assert.equal(+k[1], C.LED_USE_K);
  assert.match(INO, /lvl\[f\] = fmaxf\(zn\(N_PD \* f\), fmaxf\(zn\(N_PD \* f \+ 1\), zn\(N_PD \* f \+ 2\)\)\);/);
  assert.match(INO, /if \(LED_ON\[f\] && !LED_USED\[f\] && \(best < 0 \|\| lvl\[f\] > lvl\[best\]\)\) best = f;/);
  // chosen before the Jacobian; the update uses LED_USED, while lowPd() judges
  // on every lit LED (LED_ON), so zHn is predicted for all of them first and
  // set to zn for the unused ones only after lowPd()
  var body = INO.slice(INO.indexOf('xHnnm1 = A * xHnm1nm1;'));
  assert.ok(body.indexOf('selectLeds();') >= 0 && body.indexOf('selectLeds();') < body.indexOf('computeJacobian(xHnnm1);'));
  assert.match(body, /zHn\(N_PD \* f \+ g\) = LED_ON\[f\] \?/);
  var unused = body.search(/if \(!LED_USED\[f\]\)\s*for \(int g = 0; g < N_PD; g\+\+\) zHn\(N_PD \* f \+ g\) = zn\(N_PD \* f \+ g\);/);
  assert.ok(unused > body.indexOf('lowPd()') && unused < body.indexOf('ekfUpdateSequential();'), 'unused LEDs set to zn after lowPd, before the update');
  [['computeJacobian', 'LED_USED['], ['ekfUpdateSequential', 'LED_USED['], ['lowPd', 'LED_ON[']].forEach(function (c) {
    var src = INO.slice(INO.indexOf(c[0] + '('), INO.indexOf('\n}', INO.indexOf(c[0] + '(')));
    var other = c[1] === 'LED_ON[' ? 'LED_USED[' : 'LED_ON[';
    assert.ok(src.indexOf(c[1]) >= 0 && src.indexOf(other) < 0, c[0] + ' uses ' + c[1]);
  });
  assert.match(INO, /sscanf\(buf, "USE %d", &num\) == 1/);
});

test('LED_USE_K: leave one pose out on the 2026-11-25 data is no worse than all 9 LEDs', function () {
  var file = path.join(__dirname, '..', 'data', '2026-11-25', 'calib_105643.csv');
  var poses = C.csvToPoses(fs.readFileSync(file, 'utf8')).poses.filter(function (p) { return !(p.x === -25 && p.y === -25); });
  function meanErr(k) {
    var s = 0;
    poses.forEach(function (p, i) {
      var fit = C.fitModel(poses.filter(function (_, j) { return j !== i; }));
      var o = { gamma: fit.leds.map(function (r, n) { return r.gamma !== null ? r.gamma : C.CURRENT_GAMMA[n]; }), pdGain: fit.pdGain, offset: fit.offset };
      var pd = C.lowPd(p.rss, p, o), rss = C.selectLeds(p.rss, k);  // judged on all lit LEDs, as robot.ino
      if (pd >= 0) o.skipPd = pd;
      var r = C.solvePose(rss, o);
      s += Math.hypot(r.x - p.x, r.y - p.y);
    });
    return s / poses.length;
  }
  var all = meanErr(9), sel = meanErr(C.LED_USE_K);
  assert.ok(Math.abs(all - 4.13) < 0.05, 'all 9 LEDs: ' + all.toFixed(2) + ' cm');
  assert.ok(sel <= all, C.LED_USE_K + ' LEDs: ' + sel.toFixed(2) + ' cm, all 9: ' + all.toFixed(2) + ' cm');
});

test('PD 2 low at (0, 0) on 2026-11-25 13:41: found over all lit LEDs, position within 3 cm with 6 LEDs', function () {
  ['pd2_low_134138.csv', 'pd2_low_134223.csv'].forEach(function (name) {
    var p = C.csvToPoses(fs.readFileSync(path.join(__dirname, '..', 'data', '2026-11-25', name), 'utf8')).poses[0];
    assert.equal(p.x, 0); assert.equal(p.y, 0);
    var offs = [[0, 0, 0], [20, 0, 0], [-20, 0, 0], [0, 20, 0], [0, -20, 0], [14, 14, 0], [-14, -14, 0], [0, 0, 30], [0, 0, -30]];
    offs.forEach(function (o) {
      assert.equal(C.lowPd(p.rss, { x: o[0], y: o[1], theta: o[2] }), 2, name + ' prior off by ' + o);
    });
    // with PD 2 used, 6 LEDs put the robot about 18 cm off (13 cm on the board)
    var bad = C.solvePose(C.selectLeds(p.rss, C.LED_USE_K));
    assert.ok(Math.hypot(bad.x, bad.y) > 10, name + ': with PD 2 ' + bad.x.toFixed(1) + ', ' + bad.y.toFixed(1));
    var good = C.solvePose(C.selectLeds(p.rss, C.LED_USE_K), { skipPd: C.lowPd(p.rss, { x: 0, y: 0 }) });
    assert.ok(Math.hypot(good.x, good.y) < 3, name + ': without PD 2 ' + good.x.toFixed(1) + ', ' + good.y.toFixed(1));
  });
});

// ---- tilt (pitch / roll), PC only so far (feature/task-3-tilt-9led) ----------
test('pathLossTilt: level is pathLoss; pitch + lifts the front, roll + lowers the right side', function () {
  var d = Math.PI / 180;
  for (var row = 0; row < 9; row++) for (var l = 0; l < 3; l++)
    close(C.pathLossTilt(row, l, -0.2, 0.1, 0.05, 0.7, 0, 0), C.pathLoss(row, l, -0.2, 0.1, 0.05, 0.7), 1e-15);
  // PD 0 looks forward (+x at heading 0): nose up tips its normal up
  assert.ok(C.pdNormal(0, 0, 10 * d, 0)[2] > C.pdNormal(0, 0, 0, 0)[2]);
  // robot frame is forward, left, up: a normal pointing left (+y) goes up when the right side goes down
  var left = C.pdNormal(1, 0, 0, 0), leftRolled = C.pdNormal(1, 0, 0, 10 * d);
  assert.ok(left[1] !== 0);
  assert.ok((leftRolled[2] - left[2]) * Math.sign(left[1]) > 0, 'roll + lifts the left side');
  // the normal stays a unit vector
  var n = C.pdNormal(2, 0.4, 0.2, -0.3);
  close(Math.hypot(n[0], n[1], n[2]), 1, 1e-12);
});

test('solvePose with tilt: a tilt is told apart from a move when the model is exact', function () {
  var d = Math.PI / 180;
  [{ x: -25, y: 10, z: 0, theta: 30, pitch: 4, roll: -3 }, { x: 20, y: -30, z: 0, theta: -100, pitch: -8, roll: 6 },
   { x: 0, y: 0, z: 0, theta: 0, pitch: 0, roll: 0 }].forEach(function (p) {
    var rss = [];
    for (var row = 0; row < 9; row++) for (var l = 0; l < 3; l++)
      rss.push(C.predictRss(row, l, p.x / 100, p.y / 100, p.z / 100, p.theta * d, { pitch: p.pitch * d, roll: p.roll * d }));
    var r = C.solvePose(rss, { tilt: true });
    close(r.pitch, p.pitch, 0.1, 'pitch'); close(r.roll, p.roll, 0.1, 'roll');
    close(r.x, p.x, 0.2, 'x'); close(r.y, p.y, 0.2, 'y');
    // without tilt the result has pitch = roll = 0
    var flat = C.solvePose(rss);
    assert.equal(flat.pitch, 0); assert.equal(flat.roll, 0);
  });
});
