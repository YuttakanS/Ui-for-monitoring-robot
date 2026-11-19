// Run: node --test tests/
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var C = require('../calibrate.js');

// copy.ino without // comments (old commented-out values must not match)
var INO = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'copy', 'copy.ino'), 'utf8')
  .replace(/\/\/.*$/gm, '');
function inoArray(decl) {
  var m = new RegExp(decl.replace(/[<>,]/g, '\\$&') + '\\s*(?:\\[[^\\]]*\\])*\\s*=\\s*\\{([^}]*)\\}').exec(INO);
  assert.ok(m, decl + ' not found in copy.ino');
  return m[1].split(',').map(function (s) { return parseFloat(s); });
}
function close(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b); }

// deterministic noise so the tests never flake
function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

test('constants match copy.ino', function () {
  assert.deepEqual(inoArray('LED_NUM'), C.ROW_LED);
  assert.deepEqual(inoArray('PtxGamma'), C.CURRENT_GAMMA);
  var p = inoArray('BLA::Matrix<N_LED, 3> p');
  assert.deepEqual(p, [].concat.apply([], C.P));
  var mIno = /const float m = ([\d.]+);/.exec(INO);
  assert.ok(mIno, 'm not found in copy.ino');
  assert.equal(parseFloat(mIno[1]), C.M);
  assert.match(INO, /const float FoV = M_PI \/ 2;/);
  var beIno = /const float be = ([\d.]+)f? \* M_PI \/ 180\.0f?;/.exec(INO);
  assert.ok(beIno, 'be not found in copy.ino');
  close(parseFloat(beIno[1]) * Math.PI / 180, C.BETA, 1e-12, 'be');
  assert.match(INO, /const float al\[N_PD\] = \{ 0, 2\.0\*M_PI\/3\.0, -2\.0\*M_PI\/3\.0 \};/);
  assert.deepEqual(inoArray('PD_GAIN'), C.PD_GAIN);
  var offIno = /const float RSS_OFFSET = ([\d.]+)f?;/.exec(INO);
  assert.ok(offIno, 'RSS_OFFSET not found in copy.ino');
  assert.equal(parseFloat(offIno[1]), C.RSS_OFFSET);
  var zr = /const float Z_MIN = (-?[\d.]+)f?, Z_MAX = ([\d.]+)f?;/.exec(INO);
  assert.ok(zr, 'Z_MIN / Z_MAX not found in copy.ino');
  assert.equal(parseFloat(zr[1]), C.Z_MIN); assert.equal(parseFloat(zr[2]), C.Z_MAX);
  // the EKF prediction and Jacobian use the same model as predictRss()
  assert.match(INO, /PtxGamma\[f\] \* PD_GAIN\[g\] \* pathLossWithoutGamma\([^;]*\) \+ RSS_OFFSET/);
  assert.equal((INO.match(/PtxGamma\[k\] \* PD_GAIN\[l\] \* pathLossWithoutGamma/g) || []).length, 2);
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
  assert.match(line, /^const float PtxGamma\[N_LED\] = \{ 0\.490f, 0\.490f, 0\.5\d\df, /);
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

test('copy.ino prints RSS with 4 decimals', function () {
  assert.match(INO, /Serial\.print\(RSS\[f\]\[g\], 4\);/);
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
  // default set is LED 1, 2, 7, 8: LED 3 and 6 still on in the firmware
  assert.deepEqual(C.DEFAULT_LIT, [1, 2, 7, 8]);
  assert.deepEqual(C.checkPose(rss).map(function (w) { return w.led + w.kind; }),
    ['4unexpected', '3unexpected', '6unexpected']);
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
