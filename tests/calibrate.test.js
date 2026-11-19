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
  assert.match(INO, /const float m = 1\.0;/);
  assert.match(INO, /const float FoV = M_PI \/ 2;/);
  assert.match(INO, /const float be = M_PI \/ 3;/);
  assert.match(INO, /const float al\[N_PD\] = \{ 0, 2\.0\*M_PI\/3\.0, -2\.0\*M_PI\/3\.0 \};/);
});

test('pathLoss: robot under LED 4, PD 0 (GP28) facing +X', function () {
  // d = 0.92, cos(phi) = 1, cos(psi) = sin(60 deg): h = 2 * 0.866 / 0.8464
  close(C.pathLoss(0, 0, 0, 0, 0, 0), 2 * Math.sin(Math.PI / 3) / (0.92 * 0.92), 1e-9);
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

test('fitGamma: an LED seen at too few points is not fitted', function () {
  var samples = simulate(C.CURRENT_GAMMA, [4, 5], 0, 5).slice(0, 1);
  var res = C.fitGamma(samples, { minPoints: 5 });
  res.forEach(function (r) { if (r.skipped !== 'off') assert.equal(r.skipped, 'too few points'); });
});
