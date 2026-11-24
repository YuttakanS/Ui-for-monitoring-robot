// Run: node --test tests/
// Checks the arithmetic behind the speed-up of firmware/robot/robot.ino: the
// table demodulation and the one-measurement-at-a-time EKF update, written
// here in JS the same way as in the .ino. They show that the faster methods
// give the same numbers as the ones they replace; they do not compile or run
// the C++ itself.
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var C = require('../web/js/calib-model.js');

var INO = fs.readFileSync(path.join(__dirname, '..', 'firmware', 'robot', 'robot.ino'), 'utf8')
  .replace(/\/\/.*$/gm, '');
function inoInt(name) {
  var m = new RegExp('const int ' + name + ' = (\\d+);').exec(INO);
  assert.ok(m, name + ' not found in robot.ino');
  return +m[1];
}
function rng(seed) { return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

var N = inoInt('N'), FS = inoInt('samplingFreq'), F_STEP = inoInt('F_STEP'), LUT_SCALE = inoInt('LUT_SCALE');
var LUT_N = FS / F_STEP;
var FREF = /const float Fref\[N_LED\] = \{([^}]*)\}/.exec(INO)[1].split(',').map(parseFloat);

test('the demodulation table fits the LED frequencies and the sample window', function () {
  assert.match(INO, /const int LUT_N = samplingFreq \/ F_STEP;/);
  assert.equal(FS % F_STEP, 0);
  assert.equal(N % LUT_N, 0, 'the window must hold whole table periods');
  assert.equal(FREF.length, 9);
  FREF.forEach(function (f) { assert.equal(f % F_STEP, 0, f + ' Hz is not a multiple of F_STEP'); });
  assert.ok(LUT_SCALE <= 16384, 'sample (10 bit) * table must fit in int32, table in int16');
});

test('the ring buffer holds a window plus the slack the demodulation needs', function () {
  assert.match(INO, /const int RING_N = 2 \* N;/);
  var every = inoInt('UPDATE_EVERY'), ringN = 2 * N;
  assert.ok(every > 0 && every <= N, 'windows should overlap or touch');
  // the demodulation takes about 12 ms (300 samples); the slack is far larger
  assert.ok(ringN - N >= 1000, 'slack before the oldest sample is overwritten');
  assert.equal(FS / every, 20, 'update rate (Hz) the README states');
});

// the table as initDemod() builds it: first half rounded, second half negated
function makeTables() {
  var s = new Int16Array(LUT_N), c = new Int16Array(LUT_N), half = LUT_N / 2;
  for (var i = 0; i < half; i++) {
    var a = 2 * Math.PI * i / LUT_N;
    s[i] = Math.round(LUT_SCALE * Math.sin(a)); c[i] = Math.round(LUT_SCALE * Math.cos(a));
    s[i + half] = -s[i]; c[i + half] = -c[i];
  }
  return { s: s, c: c };
}
// one LED, one photodiode: the loop of robot.ino with integers
function demodTable(x, f, tab) {
  var accS = 0, accC = 0, idx = 0, step = Math.round(f / F_STEP) % LUT_N;
  for (var i = 0; i < N; i++) {
    accS += x[i] * tab.s[idx]; accC += x[i] * tab.c[idx];
    idx += step; if (idx >= LUT_N) idx -= LUT_N;
  }
  return Math.sqrt(accS * accS + accC * accC) / (N * LUT_SCALE);
}
// the loop it replaces: sin / cos per sample in single precision
function demodOld(x, f) {
  var fr = Math.fround, cs = fr(0), cc = fr(0);
  for (var i = 0; i < N; i++) {
    var angle = fr(2 * Math.PI * f * i / FS);
    cs = fr(cs + fr(x[i] * fr(Math.sin(angle)))); cc = fr(cc + fr(x[i] * fr(Math.cos(angle))));
  }
  return fr(fr(1 / N) * Math.sqrt(fr(fr(cs * cs) + fr(cc * cc))));
}
function demodExact(x, f) {
  var s = 0, c = 0;
  for (var i = 0; i < N; i++) { var a = 2 * Math.PI * f * i / FS; s += x[i] * Math.sin(a); c += x[i] * Math.cos(a); }
  return Math.sqrt(s * s + c * c) / N;
}

test('table demodulation gives the RSS of the per-sample sin / cos loop', function () {
  var r = rng(42), tab = makeTables(), lit = [3700, 4100, 1300, 1700];
  [200, 500, 800].forEach(function (dc) {
    var amp = lit.map(function () { return 0.2 + 2 * r(); }), ph = lit.map(function () { return 2 * Math.PI * r(); });
    var x = new Int32Array(N);
    for (var i = 0; i < N; i++) {
      var v = dc + 3 * (r() + r() + r() - 1.5); // ADC noise of a few counts
      lit.forEach(function (f, k) { v += amp[k] * Math.sin(2 * Math.PI * f * i / FS + ph[k]); });
      x[i] = Math.max(0, Math.min(1023, Math.round(v)));
    }
    FREF.forEach(function (f) { // lit and unlit frequencies
      var exact = demodExact(x, f), tb = demodTable(x, f, tab), old = demodOld(x, f);
      assert.ok(Math.abs(tb - exact) < 1e-4, 'table vs exact at ' + f + ' Hz, dc ' + dc + ': ' + tb + ' vs ' + exact);
      assert.ok(Math.abs(old - exact) < 5e-3, 'old vs exact at ' + f + ' Hz, dc ' + dc + ': ' + old + ' vs ' + exact);
    });
  });
});

// ---- EKF update --------------------------------------------------------------
function zeros(r, c) { var m = []; for (var i = 0; i < r; i++) { m.push([]); for (var j = 0; j < c; j++) m[i].push(0); } return m; }
function mul(A, B) {
  var out = zeros(A.length, B[0].length);
  for (var i = 0; i < A.length; i++) for (var j = 0; j < B[0].length; j++) for (var k = 0; k < B.length; k++) out[i][j] += A[i][k] * B[k][j];
  return out;
}
function tr(A) { return A[0].map(function (_, j) { return A.map(function (r) { return r[j]; }); }); }
function inv(A) {
  var n = A.length, M = A.map(function (r, i) { return r.concat(r.map(function (_, j) { return i === j ? 1 : 0; })); });
  for (var c = 0; c < n; c++) {
    var p = c;
    for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    var t = M[c]; M[c] = M[p]; M[p] = t;
    var d = M[c][c];
    for (var k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (r = 0; r < n; r++) if (r !== c) { var f = M[r][c]; for (k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map(function (r) { return r.slice(n); });
}

var NS = 8, NZ = 27, SIGMA2 = 0.01;
// the update robot.ino did before: K = P J' (R + J P J')^-1 over all 27 values
// (rows of LEDs that are off are 0 and their innovation is 0), Joseph form
function updateBatch(xp, Pp, J, zn, zh) {
  var R = zeros(NZ, NZ), I = zeros(NS, NS), i;
  for (i = 0; i < NZ; i++) R[i][i] = SIGMA2;
  for (i = 0; i < NS; i++) I[i][i] = 1;
  var S = mul(mul(J, Pp), tr(J));
  for (i = 0; i < NZ; i++) S[i][i] += SIGMA2;
  var K = mul(mul(Pp, tr(J)), inv(S));
  var x = xp.slice();
  for (var a = 0; a < NS; a++) for (i = 0; i < NZ; i++) x[a] += K[a][i] * (zn[i] - zh[i]);
  var KJ = mul(K, J), IKJ = I.map(function (r, a) { return r.map(function (v, b) { return v - KJ[a][b]; }); });
  var P = mul(mul(IKJ, Pp), tr(IKJ)), KRK = mul(mul(K, R), tr(K));
  for (a = 0; a < NS; a++) for (var b = 0; b < NS; b++) P[a][b] += KRK[a][b];
  return { x: x, P: P };
}
// ekfUpdateSequential() of robot.ino, loop for loop
function updateSequential(xp, Pp, J, zn, zh, ledOn) {
  var x = xp.slice(), P = Pp.map(function (r) { return r.slice(); });
  var h = [], Ph = [], hP = [], K = [], Mh = [], M = zeros(NS, NS), a, b, s;
  for (var f = 0; f < 9; f++) {
    if (!ledOn[f]) continue;
    for (var g = 0; g < 3; g++) {
      var i = 3 * f + g, S = SIGMA2, innov = zn[i] - zh[i];
      for (a = 0; a < NS; a++) h[a] = J[i][a];
      for (a = 0; a < NS; a++) {
        s = 0; for (b = 0; b < NS; b++) s += P[a][b] * h[b];
        Ph[a] = s;
        s = 0; for (b = 0; b < NS; b++) s += h[b] * P[b][a];
        hP[a] = s;
      }
      for (a = 0; a < NS; a++) { S += h[a] * Ph[a]; innov -= h[a] * (x[a] - xp[a]); }
      for (a = 0; a < NS; a++) { K[a] = Ph[a] / S; x[a] += K[a] * innov; }
      for (a = 0; a < NS; a++) for (b = 0; b < NS; b++) M[a][b] = P[a][b] - K[a] * hP[b];
      for (a = 0; a < NS; a++) { s = 0; for (b = 0; b < NS; b++) s += M[a][b] * h[b]; Mh[a] = s; }
      for (a = 0; a < NS; a++) for (b = 0; b < NS; b++) P[a][b] = M[a][b] - Mh[a] * K[b] + SIGMA2 * K[a] * K[b];
    }
  }
  return { x: x, P: P };
}

test('EKF update one value at a time equals the 27 x 27 update', function () {
  var r = rng(9), IX = 0, IY = 2, ITH = 4, IZ = 6, eps = 0.01;
  [[1, 2, 7, 8], [1, 2, 7, 8, 0, 3, 6], [7]].forEach(function (lit) {
    var ledOn = C.ROW_LED.map(function (led) { return lit.indexOf(led) >= 0; });
    for (var trial = 0; trial < 20; trial++) {
      // predicted state and a random symmetric positive definite covariance
      var xp = [-0.5 + r() * 0.6, 0.1 * (r() - 0.5), -0.5 + r(), 0.1 * (r() - 0.5), 6 * (r() - 0.5), 0.2 * (r() - 0.5), 0.3 * r(), 0.1 * (r() - 0.5)];
      var G = zeros(NS, NS), a, b;
      for (a = 0; a < NS; a++) for (b = 0; b < NS; b++) G[a][b] = 0.1 * (r() - 0.5);
      var Pp = mul(G, tr(G));
      for (a = 0; a < NS; a++) Pp[a][a] += 1e-3;
      // Jacobian by central differences and the prediction, as in robot.ino
      var J = zeros(NZ, NS), zh = [], zn = [];
      function rssAt(q, row, l) { return C.predictRss(row, l, q[IX], q[IY], q[IZ], q[ITH]); }
      for (var row = 0; row < 9; row++) for (var l = 0; l < 3; l++) {
        var i = 3 * row + l;
        zn[i] = ledOn[row] ? rssAt(xp, row, l) + 0.1 * (r() - 0.5) : 0;
        zh[i] = ledOn[row] ? rssAt(xp, row, l) : zn[i];
        if (!ledOn[row]) continue;
        [IX, IY, ITH, IZ].forEach(function (j) {
          var qp = xp.slice(), qm = xp.slice();
          qp[j] += eps; qm[j] -= eps;
          J[i][j] = (rssAt(qp, row, l) - rssAt(qm, row, l)) / (2 * eps);
        });
      }
      var A = updateBatch(xp, Pp, J, zn, zh), B = updateSequential(xp, Pp, J, zn, zh, ledOn);
      for (a = 0; a < NS; a++) {
        assert.ok(Math.abs(A.x[a] - B.x[a]) < 1e-9, 'x[' + a + '] ' + A.x[a] + ' vs ' + B.x[a]);
        for (b = 0; b < NS; b++) assert.ok(Math.abs(A.P[a][b] - B.P[a][b]) < 1e-9, 'P[' + a + '][' + b + ']');
      }
    }
  });
});

test('robot.ino keeps the model of calib-model.js in the faster EKF code', function () {
  // both updates and the Jacobian go through the same prediction
  assert.match(INO, /const bool EKF_SEQUENTIAL = (true|false);/);
  assert.match(INO, /Q\(i, i\) = Q0\[i\] \* T \/ T_REF;/);
});
