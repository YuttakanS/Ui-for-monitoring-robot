// Run: node --test tests/
// The yaw / pitch / roll test page: the pose solved back from RSS on the PC
// against a known pose (web/js/tilt-test.js).
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var C = require('../web/js/calib-model.js');
var T = require('../web/js/tilt-test.js');

var D = Math.PI / 180;
function close(a, b, tol, msg) { assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' ' + a + ' vs ' + b); }
// RSS the model itself gives at a pose (cm, deg), firmware constants
function modelRss(p) {
  var out = [];
  for (var row = 0; row < C.N_LED; row++)
    for (var l = 0; l < C.N_PD; l++)
      out.push(C.predictRss(row, l, p.x / 100, p.y / 100, (p.z || 0) / 100, (p.theta || 0) * D, { pitch: (p.pitch || 0) * D, roll: (p.roll || 0) * D }));
  return out;
}
function point(p) { return Object.assign({ z: 0, theta: 0, pitch: 0, roll: 0 }, p, { rss: modelRss(p) }); }

var CALIB = path.join(__dirname, '..', 'data', '2026-11-25', 'calib_105643.csv');
function calibPoints() {
  return T.csvToPoints(fs.readFileSync(CALIB, 'utf8')).points.filter(function (p) { return !(p.x === -25 && p.y === -25); }); // PD 2 low there
}

test('angDiff wraps at +-180 degrees', function () {
  assert.equal(T.angDiff(10, 350), 20);
  assert.equal(T.angDiff(-170, 170), 20);
  assert.equal(T.angDiff(170, -170), -20);
  assert.equal(T.angDiff(5, 5), 0);
});

test('analyse: RSS made by the model gives back yaw, pitch and roll', function () {
  [{ x: 10, y: -15, theta: 30, pitch: 5, roll: -4 }, { x: -20, y: 20, theta: -100, pitch: -8, roll: 6 }, { x: 0, y: 0, theta: 0 }]
    .forEach(function (p) {
      var a = T.analyse(modelRss(p), { k: 9 });
      close(a.tilt.x, p.x, 0.1, 'x'); close(a.tilt.y, p.y, 0.1, 'y');
      close(T.angDiff(a.tilt.theta, p.theta), 0, 0.1, 'yaw');
      close(a.tilt.pitch, p.pitch || 0, 0.1, 'pitch'); close(a.tilt.roll, p.roll || 0, 0.1, 'roll');
      assert.equal(a.skipPd, -1);
    });
});

test('analyse: no LED reads anything -> null', function () {
  assert.equal(T.analyse(new Array(C.N_LED * C.N_PD).fill(0)), null);
});

test('analyse: a photodiode reading a quarter is left out, as lowPd() in the firmware', function () {
  var p = { x: 5, y: 5, theta: 0 };
  var rss = modelRss(p).map(function (v, i) { return i % C.N_PD === 2 ? C.RSS_OFFSET + 0.25 * (v - C.RSS_OFFSET) : v; });
  var a = T.analyse(rss, { k: 9 });
  assert.equal(a.skipPd, 2);
  close(a.flat.x, p.x, 0.5, 'x'); close(a.flat.y, p.y, 0.5, 'y');
});

test('evaluate: errors are solved - reference; a tilted point gets "change" from the level point at the same place', function () {
  var pts = [point({ x: 10, y: 10 }), point({ x: 10, y: 10, pitch: 5, roll: -3 }), point({ x: -20, y: 0, pitch: 4 })];
  var r = T.evaluate(pts, { k: 9, loo: false });
  assert.equal(r.rows.length, 3);
  r.rows.forEach(function (row) {
    assert.equal(row.model, 'firmware');
    ['yaw', 'pitch', 'roll', 'xyFlat'].slice(0, 3).forEach(function (key) { close(row.err[key], 0, 0.1, key); });
    close(row.err.xyTilt, 0, 0.1, 'xy');
  });
  assert.equal(r.rows[0].change, null, 'level point');
  close(r.rows[1].change.pitch, 0, 0.1); close(r.rows[1].change.roll, 0, 0.1);
  assert.equal(r.rows[2].change, null, 'no level point at (-20, 0)');
  var s = r.summary;
  assert.equal(s.nLevel, 1); assert.equal(s.nTilted, 2); assert.equal(s.nChange, 1);
  assert.equal(s.pass, true);
});

test('evaluate: no level point -> no verdict; too few level points for leave-one-out -> firmware constants', function () {
  var r = T.evaluate([point({ x: 0, y: 0, pitch: 5 })], { k: 9, loo: true });
  assert.equal(r.summary.pass, null);
  assert.equal(r.rows[0].model, 'firmware');
});

test('real data 2026-11-25 (12 level poses): the figures of tools/eval-tilt.js, FAIL', function () {
  var pts = calibPoints();
  assert.equal(pts.length, 12);
  pts.forEach(function (p) { assert.ok(T.isLevel(p)); });
  var s9 = T.evaluate(pts, { k: 9, loo: true }).summary;
  close(s9.falseTiltRms, 12.7, 0.2, 'false tilt, 9 LEDs');
  close(s9.xyFlat, 4.13, 0.05, 'x/y level, 9 LEDs'); close(s9.xyTilt, 10.68, 0.1, 'x/y with tilt, 9 LEDs');
  assert.equal(s9.pass, false);
  var r6 = T.evaluate(pts, { k: 6, loo: true });
  close(r6.summary.falseTiltRms, 12.9, 0.2, 'false tilt, 6 LEDs');
  close(r6.summary.xyFlat, 3.72, 0.05, 'x/y level, 6 LEDs'); close(r6.summary.xyTilt, 9.99, 0.1, 'x/y with tilt, 6 LEDs');
  assert.equal(r6.summary.pass, false);
  r6.rows.forEach(function (row) { assert.equal(row.model, 'loo'); });
});

test('points CSV: calibration columns plus pitch_deg, roll_deg; round trip; a calibration file reads as level', function () {
  var pts = [point({ x: 10, y: -5, z: 3, theta: 20, pitch: 5, roll: -2.5 }), point({ x: 0, y: 0 })];
  pts[0].n = 30; pts[0].spread = 0.0123;
  var text = T.pointsToCsv(pts);
  assert.equal(text.split('\r\n')[0], C.csvHeader().concat(['pitch_deg', 'roll_deg']).join(','));
  var back = T.csvToPoints(text);
  assert.deepEqual(back.errors, []);
  assert.equal(back.points.length, 2);
  ['x', 'y', 'z', 'theta', 'pitch', 'roll', 'n'].forEach(function (k) { assert.equal(back.points[0][k], pts[0][k], k); });
  back.points[0].rss.forEach(function (v, i) { close(v, pts[0].rss[i], 1e-4); });
  assert.equal(back.points[1].pitch, 0); assert.equal(back.points[1].roll, 0);
  // the calibration page still reads the file (extra columns ignored) and its own files have no tilt
  assert.equal(C.csvToPoses(text).poses.length, 2);
  var calib = T.csvToPoints(C.posesToCsv([{ x: 1, y: 2, theta: 0, z: 0, rss: pts[1].rss }]));
  assert.equal(calib.points[0].pitch, 0); assert.equal(calib.points[0].roll, 0);
});

test('results CSV: one line per point under RESULT_HEADER', function () {
  var r = T.evaluate([point({ x: 10, y: 10 }), point({ x: 10, y: 10, pitch: 5 })], { k: 9 });
  var lines = T.resultsToCsv(r, 9).trim().split('\r\n');
  assert.equal(lines[0], T.RESULT_HEADER.join(','));
  assert.equal(lines.length, 3);
  lines.slice(1).forEach(function (l) { assert.equal(l.split(',').length, T.RESULT_HEADER.length); });
  var c = lines[2].split(','), col = function (name) { return c[T.RESULT_HEADER.indexOf(name)]; };
  assert.equal(col('pitch_deg'), '5'); assert.equal(col('leds_used'), '9'); assert.equal(col('model'), 'firmware');
  close(+col('solved_pitch_deg'), 5, 0.1); close(+col('change_err_pitch_deg'), 0, 0.1);
  assert.equal(lines[1].split(',')[T.RESULT_HEADER.indexOf('change_err_pitch_deg')], '', 'level point: no change');
});

test('tilt-test.html loads its scripts in order and has every element tilt-page.js asks for', function () {
  var web = path.join(__dirname, '..', 'web');
  var html = fs.readFileSync(path.join(web, 'tilt-test.html'), 'utf8');
  var js = fs.readFileSync(path.join(web, 'js', 'tilt-page.js'), 'utf8');
  var order = ['js/wifi-link.js', 'js/calib-model.js', 'js/tilt-test.js', 'js/tilt-page.js'].map(function (s) { return html.indexOf('src="' + s + '"'); });
  order.forEach(function (i, n) { assert.ok(i > 0 && (n === 0 || i > order[n - 1]), 'script ' + n); });
  var ids = js.match(/\$\('([^']+)'\)/g).map(function (s) { return s.slice(3, -2); });
  assert.ok(ids.length > 30);
  ids.forEach(function (id) { assert.ok(html.indexOf('id="' + id + '"') >= 0, 'missing #' + id); });
});

test('evaluate: direction to each LED per point and median / P95 in the summary', function () {
  var r = T.evaluate([point({ x: 10, y: 10 }), point({ x: -20, y: 0, theta: 50 })], { k: 9 });
  r.rows.forEach(function (row) {
    assert.equal(row.dir.length, C.N_LED);
    row.dir.forEach(function (d) { close(d, 0, 1e-3); });
  });
  var s = r.summary;
  assert.equal(s.nDir, 2 * C.N_LED);
  ['dirP50', 'dirP95', 'yawP50', 'yawP95', 'xyFlatP50', 'xyFlatP95', 'xyTiltP50', 'xyTiltP95', 'falseTiltP95'].forEach(function (k) {
    close(s[k], 0, 0.1, k);
  });
  assert.equal(T.pct([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(T.pct([5, 1, 3, 2, 4], 0.95), 5);
  assert.ok(isNaN(T.pct([], 0.5)));
});

test('real data 2026-11-25: directions to the LEDs are about 10 times off what tilt needs; the floor poses alone do far better', function () {
  var pts = calibPoints();
  var all = T.evaluate(pts, { k: 9, loo: true }).summary;
  assert.ok(all.dirP50 > 10 && all.dirP50 < 16, 'direction median ' + all.dirP50);
  assert.ok(all.dirP50 > 5 * T.DIR_NEED);
  // the 6 poses on the floor (the others stand on the steel beams, z = 3)
  var floor = pts.filter(function (p) { return !(p.z > 0); });
  assert.equal(floor.length, 6);
  var f = T.evaluate(floor, { k: 9, loo: true }).summary;
  assert.ok(f.dirP50 < 0.6 * all.dirP50, 'floor direction median ' + f.dirP50);
  close(f.falseTiltRms, 3.4, 0.3, 'false tilt on the floor');
  assert.ok(f.falseTiltRms < all.falseTiltRms / 3);
});
