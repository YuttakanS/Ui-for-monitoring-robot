// Tests for the pure logic of the Position Monitor page (monitor.js).
// Run: npm test
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var A = require('../web/js/monitor.js');

var ROOT = path.join(__dirname, '..');
// robot.ino without // comments (old commented-out values must not match)
var INO = fs.readFileSync(path.join(ROOT, 'firmware', 'robot', 'robot.ino'), 'utf8').replace(/\/\/.*$/gm, '');
function inoArray(decl) {
  var m = new RegExp(decl.replace(/[<>,\[\]]/g, '\\$&') + '\\s*(?:\\[[^\\]]*\\])*\\s*=\\s*\\{([^}]*)\\}').exec(INO);
  assert.ok(m, decl + ' not found in robot.ino');
  return m[1].split(',').map(function (s) { return s.trim(); });
}

// The header the CSV rule fixes (CLAUDE.md): raw values; new columns only
// ever added at the end (z 2026-11-19, pitch_deg / roll_deg 2026-11-20,
// pc_pitch_deg / pc_roll_deg 2026-11-26)
var HEADER_Z = 'timestamp_iso,t_ms,quadrant,x,y,incidence_angle_deg,source,z';
var HEADER = HEADER_Z + ',pitch_deg,roll_deg,pc_pitch_deg,pc_roll_deg';

// parseLine() result with the defaults for values not sent
function L(o) {
  return Object.assign({ z: 0, hasZ: false, pitch: 0, hasPitch: false, roll: 0, hasRoll: false }, o);
}

/* ---------- serial lines ---------- */

test('parseLine: lines as robot.ino prints them (Serial.print of a float = 2 decimals)', function () {
  assert.deepEqual(A.parseLine('Quadrant 3: -24.50, -1.47, -0.66, 0.00'),
    L({ quadrant: 3, x: -24.5, y: -1.47, angle: -0.66, z: 0, hasZ: true }));
  assert.deepEqual(A.parseLine('Quadrant 1: 12.34, 5.00, 179.99, 3.21\r'),
    L({ quadrant: 1, x: 12.34, y: 5, angle: 179.99, z: 3.21, hasZ: true }));
});

test('parseLine: without z (copy2 and older firmware) z = 0 and hasZ = false', function () {
  assert.deepEqual(A.parseLine('Quadrant 2: -33.84, 47.30, -23.71'),
    L({ quadrant: 2, x: -33.84, y: 47.3, angle: -23.71 }));
  assert.deepEqual(A.parseLine('Quadrant 4: 5, -6, 7'), L({ quadrant: 4, x: 5, y: -6, angle: 7 }));
});

test('parseLine: spacing and case are loose', function () {
  assert.deepEqual(A.parseLine('  quadrant 4 :1.0 ,-2.0,   3.0  '), L({ quadrant: 4, x: 1, y: -2, angle: 3 }));
  assert.deepEqual(A.parseLine('QUADRANT3: 1, 2, 3, 4'), L({ quadrant: 3, x: 1, y: 2, angle: 3, z: 4, hasZ: true }));
});

test('parseLine: optional pitch and roll after z (degrees)', function () {
  assert.deepEqual(A.parseLine('Quadrant 3: -24.50, -1.47, -0.66, 0.00, 2.50, -1.25'),
    L({ quadrant: 3, x: -24.5, y: -1.47, angle: -0.66, hasZ: true, pitch: 2.5, hasPitch: true, roll: -1.25, hasRoll: true }));
  assert.deepEqual(A.parseLine('Quadrant 1: 1, 2, 3, 4, 5'),               // pitch only
    L({ quadrant: 1, x: 1, y: 2, angle: 3, z: 4, hasZ: true, pitch: 5, hasPitch: true }));
});

test('parseLine: anything else is rejected (counted as a parse error, never a sample)', function () {
  [
    '', '   ', 'hello',
    '0.0000, 0.0000, 0.9100, 0.1200, ',          // RSS line (mode 1 / 3)
    '# LED 4 1', '# T wait=20.1 demod=19.0 ekf=10.2 total=50.0',
    'Quadrant 1: nan, 1.00, 2.00, 0.00',          // EKF blew up: Serial.print(NaN)
    'Quadrant 1: inf, 1.00, 2.00',
    'Quadrant 1: ovf, 1.00, 2.00',                // Serial.print of a float > 4e9
    'Quadrant 1: 1, 2',                           // too few values
    'Quadrant 1: 1, 2, 3, 4, 5, 6, 7',            // too many
    'Quadrant 1: 1, 2, 3, 4, nan, 0',             // a bad tilt value spoils the line
    'Quadrant 1: .5, 1, 2', 'Quadrant 1: 1e3, 1, 2', 'Quadrant 1: +1, 2, 3',
    'Quadrant -1: 1, 2, 3', 'Quadrant: 1, 2, 3',
    'Quadrant 1: 1, 2, 3 extra',
    'xQuadrant 1: 1, 2, 3'                        // half a line after a reset
  ].forEach(function (l) { assert.equal(A.parseLine(l), null, JSON.stringify(l)); });
});

test('isRssLine: the mode 1 / 3 RSS line is skipped, not a parse error', function () {
  var C = require('../web/js/calib-model.js');
  var rss = []; for (var i = 0; i < 27; i++) rss.push(i % 4 ? 0.1234 * i : 0);
  var line = C.formatRssLine(rss);                     // exactly as robot.ino prints it
  assert.ok(A.isRssLine(line));
  assert.ok(A.isRssLine(line.trim().replace(/,$/, ''))); // without the trailing ", "
  assert.equal(A.parseLine(line), null);
  ['0.1, 0.2, 0.3', line.replace('0.0000', 'nan'), line + '1.0, ', 'Quadrant 1: 1, 2, 3', '']
    .forEach(function (l) { assert.equal(A.isRssLine(l), false, l.slice(0, 30)); });
});

test('parseLine keeps the quadrant the board sent', function () {
  // the page shows the board's quadrant, even if it disagrees with x / y
  assert.equal(A.parseLine('Quadrant 2: 10.00, 10.00, 0.00').quadrant, 2);
});

test('robot.ino prints the line parseLine reads: Quadrant <n>: x, y, heading, z[, pitch, roll]', function () {
  // (out = USB serial + WiFi since task #3; pitch / roll only with an IMU, task #5)
  assert.match(INO, /out\.print\("Quadrant "\); out\.print\(q\); out\.print\(": "\);\s*out\.print\(xcm\); out\.print\(", "\);\s*out\.print\(ycm\); out\.print\(", "\);\s*out\.print\(deg\); out\.print\(", "\);/);
  assert.match(INO, /if \(imuOk\) \{\s*out\.print\(zcm\); out\.print\(", "\);\s*out\.print\(\(imuPitch - imuZeroP\) \* 180\.0f \/ M_PI\); out\.print\(", "\);\s*out\.println\(\(imuRoll - imuZeroR\) \* 180\.0f \/ M_PI\);\s*\} else \{\s*out\.println\(zcm\);/);
  // what that prints, read back by the page
  var line = 'Quadrant 1: 12.34, 5.00, 179.99, 0.00, 2.50, -1.25';
  assert.deepEqual(A.parseLine(line), L({ quadrant: 1, x: 12.34, y: 5, angle: 179.99, hasZ: true, pitch: 2.5, hasPitch: true, roll: -1.25, hasRoll: true }));
  // same quadrant numbering as quadrantOf()
  assert.match(INO, /int q = \(xcm >= 0\) \? \(ycm >= 0 \? 1 : 4\) : \(ycm >= 0 \? 2 : 3\);/);
});

test('parseLedAck: the board\'s reply to LED <n> <0|1>', function () {
  assert.deepEqual(A.parseLedAck('# LED 4 1'), { led: 4, on: true });
  assert.deepEqual(A.parseLedAck('#LED 8 0\r'), { led: 8, on: false });
  assert.deepEqual(A.parseLedAck('# led 7 1'), { led: 7, on: true });
  ['# TIMING 1', '# LED 4', '# LED 4 2', '# LED x 1', 'LED 4 1', '# LED 4 10', 'Quadrant 1: 1, 2, 3']
    .forEach(function (l) { assert.equal(A.parseLedAck(l), null, l); });
  // robot.ino answers in that form
  assert.match(INO, /out\.print\("# LED "\); out\.print\(num\); out\.print\(" "\); out\.println\(LED_ON\[k\] \? 1 : 0\);/);
});

test('createLineSplitter: chunks split anywhere, any line ending', function () {
  var got = [], split = A.createLineSplitter(function (l) { got.push(l); });
  split('Quadrant 1: 1, 2'); split(', 3\r\n'); split('Quadrant 2: -1, 2, 3\n# LED 4 1\rlast');
  assert.deepEqual(got, ['Quadrant 1: 1, 2, 3', 'Quadrant 2: -1, 2, 3', '# LED 4 1']);
  split('\r\n');
  assert.equal(got[3], 'last');
  // "\r\n" split across two chunks gives one extra empty line, which
  // feedLine() skips (not a parse error)
  got = []; split('Quadrant 1: 1, 2, 3\r'); split('\nQuadrant 2: 1, 2, 3\r\n');
  assert.deepEqual(got, ['Quadrant 1: 1, 2, 3', '', 'Quadrant 2: 1, 2, 3']);
});

test('createLineSplitter: garbage with no newline is dropped, not kept forever', function () {
  var got = [], split = A.createLineSplitter(function (l) { got.push(l); });
  split('x'.repeat(5000));
  split('\nQuadrant 1: 1, 2, 3\n');
  assert.deepEqual(got, ['', 'Quadrant 1: 1, 2, 3']);
});

/* ---------- CSV (must stay raw) ---------- */

function sample(line, wall, t, zShown) {
  var s = A.parseLine(line);
  s.wall = wall; s.t = t;
  s.zRaw = s.z;
  if (zShown !== undefined) s.z = zShown; // what the page shows after "zero z"
  return s;
}

test('toCsv: header, t from the first row, raw values, CRLF', function () {
  var rows = [
    A.logEntry(sample('Quadrant 3: -24.50, -1.47, -0.66, 2.30', Date.UTC(2026, 10, 20, 3, 4, 5, 6), 1000.4), 'serial'),
    A.logEntry(sample('Quadrant 1: 12.34, 5.00, 179.99, 0.00', Date.UTC(2026, 10, 20, 3, 4, 5, 56), 1050.6), 'serial')
  ];
  var csv = A.toCsv(rows);
  assert.equal(csv,
    HEADER + '\r\n' +
    '2026-11-20T03:04:05.006Z,0,3,-24.5,-1.47,-0.66,serial,2.3,,,,\r\n' +
    '2026-11-20T03:04:05.056Z,50,1,12.34,5,179.99,serial,0,,,,\r\n');
});

test('toCsv: pitch and roll are the last two columns, raw degrees', function () {
  var csv = A.toCsv([A.logEntry(sample('Quadrant 1: 1.00, 2.00, 3.00, 4.00, -2.50, 1.75', 0, 0), 'wifi')]);
  assert.equal(csv.split('\r\n')[1], '1970-01-01T00:00:00.000Z,0,1,1,2,3,wifi,4,-2.5,1.75,,');
  csv = A.toCsv([A.logEntry(sample('Quadrant 1: 1.00, 2.00, 3.00, 4.00, -2.50', 0, 0), 'serial')]);
  assert.equal(csv.split('\r\n')[1].split(',').slice(7).join(','), '4,-2.5,,,');  // roll not sent: empty
});

test('toCsv: z is empty (not 0) when the board did not send it', function () {
  var csv = A.toCsv([A.logEntry(sample('Quadrant 2: -33.84, 47.30, -23.71', 0, 0), 'serial')]);
  assert.equal(csv.split('\r\n')[1], '1970-01-01T00:00:00.000Z,0,2,-33.84,47.3,-23.71,serial,,,,,');
});

test('logEntry keeps z as sent, not shifted by the page\'s z zero', function () {
  var s = sample('Quadrant 1: 1.00, 2.00, 3.00, 7.50', 0, 0, 7.5 - 6.0); // z zero at 6 cm: shows 1.5
  var e = A.logEntry(s, 'serial');
  assert.equal(e.z, 7.5);
  assert.equal(A.toCsv([e]).split('\r\n')[1].split(',')[7], '7.5');
  assert.equal(A.logEntry(s, 'demo').source, 'demo');
});

test('toCsv: no unit conversion (cm in, cm out) and an empty log gives the header only', function () {
  assert.equal(A.toCsv([]), HEADER + '\r\n');
  assert.deepEqual(A.UNITS.cm, { f: 1, d: 2 }); // the unit menu only changes the display
});

test('toCsv header only adds columns at the end of the files already recorded', function () {
  var dir = path.join(ROOT, 'data', '2026-11-19', 'motion');
  fs.readdirSync(dir).filter(function (f) { return /\.csv$/.test(f); }).forEach(function (f) {
    var first = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)[0];
    assert.equal(first, HEADER_Z, f);                   // recorded before pitch / roll
    assert.equal(HEADER.indexOf(first), 0, f);          // same columns, same place
  });
});

test('toCsv: pitch / roll solved on the PC go in pc_pitch_deg / pc_roll_deg (raw, before the tilt zero), not in pitch_deg / roll_deg', function () {
  var s = sample('Quadrant 1: 1.00, 2.00, 3.00, 4.00', 0, 0);
  s.pcPitch = 2.3456; s.pcRoll = -1.2; s.hasPcTilt = true;
  var row = A.toCsv([A.logEntry(s, 'serial')]).split('\r\n')[1].split(',');
  assert.deepEqual(row.slice(7), ['4', '', '', '2.35', '-1.2']);
});

test('shownTilt: the board\'s values first, else the PC values less the tilt zero, else level', function () {
  var board = A.parseLine('Quadrant 1: 1, 2, 3, 4, 5, -6');
  board.pcPitch = 9; board.pcRoll = 9; board.hasPcTilt = true;
  assert.deepEqual(A.shownTilt(board, { pitch: 1, roll: 1 }), { pitch: 5, roll: -6, src: 'board' });
  var pc = A.parseLine('Quadrant 1: 1, 2, 3, 4');
  pc.pcPitch = 4; pc.pcRoll = -2; pc.hasPcTilt = true;
  assert.deepEqual(A.shownTilt(pc), { pitch: 4, roll: -2, src: 'pc' });
  assert.deepEqual(A.shownTilt(pc, { pitch: 1.5, roll: -0.5 }), { pitch: 2.5, roll: -1.5, src: 'pc' });
  assert.deepEqual(A.shownTilt(A.parseLine('Quadrant 1: 1, 2, 3')), { pitch: 0, roll: 0, src: null });
});

test('index.html loads calib-model.js before monitor.js and has the tilt controls', function () {
  var html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  var a = html.indexOf('src="js/calib-model.js"'), b = html.indexOf('src="js/monitor.js"');
  assert.ok(a > 0 && a < b);
  ['pcTilt', 'tiltZeroRow', 'btnTiltZero', 'btnTiltZeroReset', 'attNote'].forEach(function (id) {
    assert.ok(html.indexOf('id="' + id + '"') >= 0, 'missing #' + id);
  });
});

/* ---------- follow cameras lean with the robot (task #5) ---------- */

test('robotToWorld turns a vector exactly as three.js turns the 3D model (robotEuler)', function () {
  var T = require('../web/vendor/three.min.js');
  [[0, 0, 0], [30, 5, 0], [-120, 0, -7], [75, 12, 9], [180, -20, 15]].forEach(function (a) {
    [[1, 0, 0], [0, 1, 0], [0, 0, 1], [3, -2, 5]].forEach(function (v) {
      var e = A.robotEuler(a[0], a[1], a[2]);
      var want = new T.Vector3(v[0], v[1], v[2]).applyEuler(new T.Euler(e.x, e.y, e.z, e.order));
      var got = A.robotToWorld(v, a[0], a[1], a[2]);
      [want.x, want.y, want.z].forEach(function (w, i) { assert.ok(Math.abs(got[i] - w) < 1e-12, a + ' ' + v); });
    });
  });
});

test('followCamPose: level = the old cameras; pitch lifts the view, roll tilts the horizon', function () {
  var third = { back: 95, up: 60, ahead: 30 }, first = { eye: 5, pitch: 14 }, H = 3;
  function near(a, b, msg) { a.forEach(function (x, i) { assert.ok(Math.abs(x - b[i]) < 1e-9, msg + ' ' + a + ' vs ' + b); }); }
  // level, facing 30 deg on the map, at (10, -20, 2): the formulas used before
  var f = { x: 10, y: -20, z: 2, yaw: 30, pitch: 0, roll: 0 }, hx = Math.cos(30 * Math.PI / 180), hy = Math.sin(30 * Math.PI / 180);
  var p = A.followCamPose('third', f, third, H);
  near(p.pos, [10 - hx * 95, -20 - hy * 95, 2 + 60], 'third pos');
  near(p.look, [10 + hx * 30, -20 + hy * 30, 2 + H], 'third look');
  near(p.up, [0, 0, 1], 'third up');
  p = A.followCamPose('first', f, first, H);
  near(p.pos, [10, -20, 7], 'first pos');
  near(p.look, [10 + hx * 100, -20 + hy * 100, 7 + 100 * Math.tan(14 * Math.PI / 180)], 'first look');
  // facing +X: nose up -> the first-person view looks higher; right side down
  // (roll > 0) -> the camera's up leans to the robot's right (-Y)
  var level = A.followCamPose('first', { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 }, first, H);
  var noseUp = A.followCamPose('first', { x: 0, y: 0, z: 0, yaw: 0, pitch: 10, roll: 0 }, first, H);
  assert.ok(noseUp.look[2] > level.look[2] + 10);
  var rightDown = A.followCamPose('third', { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 10 }, third, H);
  assert.ok(rightDown.up[1] < -0.15 && Math.abs(rightDown.up[0]) < 1e-9);
});

/* ---------- 3D model tilt (pitch / roll) ---------- */

test('robotEuler: yaw turns, pitch + lifts the front, roll + lowers the right side (three.js)', function () {
  var T = require('../web/vendor/three.min.js');
  function turned(v, mapYaw, pitch, roll) {
    var e = A.robotEuler(mapYaw, pitch, roll);
    return new T.Vector3(v[0], v[1], v[2]).applyEuler(new T.Euler(e.x, e.y, e.z, e.order));
  }
  function close(a, b) { assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b); }
  var s10 = Math.sin(10 * Math.PI / 180);
  // level: forward follows the map heading only
  var f = turned([1, 0, 0], 90, 0, 0);
  close(f.x, 0); close(f.y, 1); close(f.z, 0);
  // pitch +10: front (local +X) goes up by sin 10, whatever the heading
  [0, 90, -135].forEach(function (yaw) { close(turned([1, 0, 0], yaw, 10, 0).z, s10); });
  // roll +10: right side (local -Y) goes down, left side up
  [0, 90, -135].forEach(function (yaw) {
    close(turned([0, -1, 0], yaw, 0, 10).z, -s10);
    close(turned([0, 1, 0], yaw, 0, 10).z, s10);
  });
  // yaw does not change how high the front is; roll does not move the front
  close(turned([1, 0, 0], 45, 10, 20).z, s10);
});

/* ---------- LEDs ---------- */

test('LEDS (map and power-up on/off) match robot.ino p, LED_NUM and LED_ON', function () {
  var num = inoArray('const int LED_NUM[N_LED]').map(Number);
  var on = inoArray('bool LED_ON[N_LED]').map(function (s) { return s === 'true'; });
  var p = inoArray('BLA::Matrix<N_LED, 3> p').map(Number);
  assert.equal(A.LEDS.length, num.length);
  A.LEDS.forEach(function (L) {
    var row = num.indexOf(+L[2]);
    assert.ok(row >= 0, 'LED ' + L[2] + ' not in LED_NUM');
    assert.ok(Math.abs(L[0] - p[row * 3] * 100) < 1e-6, 'x of LED ' + L[2]);
    assert.ok(Math.abs(L[1] - p[row * 3 + 1] * 100) < 1e-6, 'y of LED ' + L[2]);
    assert.equal(L[3], on[row], 'LED ' + L[2] + ' on at power-up');
  });
});

/* ---------- small helpers ---------- */

test('quadrantOf: standard numbering, axes go to the positive side', function () {
  assert.deepEqual([[1, 1], [-1, 1], [-1, -1], [1, -1], [0, 0], [0, -1], [-1, 0]].map(function (p) { return A.quadrantOf(p[0], p[1]); }),
    [1, 2, 3, 4, 1, 4, 2]);
});

test('wrapDeg: into [-180, 180)', function () {
  assert.deepEqual([0, 180, -180, 190, -190, 360, 540, -721].map(A.wrapDeg), [0, -180, -180, -170, 170, 0, -180, -1]);
});

test('niceStep / niceCeil / fmtTick', function () {
  assert.equal(A.niceStep(100, 5), 20);
  assert.equal(A.niceStep(7, 10), 1);
  assert.equal(A.niceStep(0.3, 5), 0.1);
  assert.deepEqual([0, -1, 0.7, 2.2, 3, 70, 101].map(A.niceCeil), [1, 1, 1, 2.5, 5, 100, 200]);
  assert.equal(A.fmtTick(-0.0001, 0.5), '0.0');
  assert.equal(A.fmtTick(25, 5), '25');
  assert.equal(A.fmtTick(0.25, 0.05), '0.25');
});

test('fileStamp: local time, zero padded', function () {
  assert.equal(A.fileStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102_030405');
});

test('I18N: every language has the same keys and the same {n} placeholders', function () {
  var langs = Object.keys(A.I18N), base = A.I18N.th;
  langs.forEach(function (lang) {
    var d = A.I18N[lang];
    assert.deepEqual(Object.keys(d).sort(), Object.keys(base).sort(), lang + ' keys');
    Object.keys(base).forEach(function (k) {
      assert.equal(d[k].indexOf('{n}') >= 0, base[k].indexOf('{n}') >= 0, lang + '.' + k + ' {n}');
    });
  });
  assert.equal(A.translate('xx', 'connect'), base.connect);   // unknown language: Thai
  assert.equal(A.translate('en', 'no-such-key'), 'no-such-key');
});
