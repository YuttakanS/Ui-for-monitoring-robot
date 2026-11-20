// Tests for the pure logic of the Position Monitor page (app.js).
// Run: npm test
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var A = require('../app.js');

var ROOT = path.join(__dirname, '..');
// copy.ino without // comments (old commented-out values must not match)
var INO = fs.readFileSync(path.join(ROOT, 'firmware', 'copy', 'copy.ino'), 'utf8').replace(/\/\/.*$/gm, '');
function inoArray(decl) {
  var m = new RegExp(decl.replace(/[<>,\[\]]/g, '\\$&') + '\\s*(?:\\[[^\\]]*\\])*\\s*=\\s*\\{([^}]*)\\}').exec(INO);
  assert.ok(m, decl + ' not found in copy.ino');
  return m[1].split(',').map(function (s) { return s.trim(); });
}

// The header the CSV rule fixes (CLAUDE.md): raw cm, z last
var HEADER = 'timestamp_iso,t_ms,quadrant,x,y,incidence_angle_deg,source,z';

/* ---------- serial lines ---------- */

test('parseLine: lines as copy.ino prints them (Serial.print of a float = 2 decimals)', function () {
  assert.deepEqual(A.parseLine('Quadrant 3: -24.50, -1.47, -0.66, 0.00'),
    { quadrant: 3, x: -24.5, y: -1.47, angle: -0.66, z: 0, hasZ: true });
  assert.deepEqual(A.parseLine('Quadrant 1: 12.34, 5.00, 179.99, 3.21\r'),
    { quadrant: 1, x: 12.34, y: 5, angle: 179.99, z: 3.21, hasZ: true });
});

test('parseLine: without z (copy2 and older firmware) z = 0 and hasZ = false', function () {
  assert.deepEqual(A.parseLine('Quadrant 2: -33.84, 47.30, -23.71'),
    { quadrant: 2, x: -33.84, y: 47.3, angle: -23.71, z: 0, hasZ: false });
  assert.deepEqual(A.parseLine('Quadrant 4: 5, -6, 7'), { quadrant: 4, x: 5, y: -6, angle: 7, z: 0, hasZ: false });
});

test('parseLine: spacing and case are loose', function () {
  assert.deepEqual(A.parseLine('  quadrant 4 :1.0 ,-2.0,   3.0  '), { quadrant: 4, x: 1, y: -2, angle: 3, z: 0, hasZ: false });
  assert.deepEqual(A.parseLine('QUADRANT3: 1, 2, 3, 4'), { quadrant: 3, x: 1, y: 2, angle: 3, z: 4, hasZ: true });
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
    'Quadrant 1: 1, 2, 3, 4, 5',                  // too many
    'Quadrant 1: .5, 1, 2', 'Quadrant 1: 1e3, 1, 2', 'Quadrant 1: +1, 2, 3',
    'Quadrant -1: 1, 2, 3', 'Quadrant: 1, 2, 3',
    'Quadrant 1: 1, 2, 3 extra',
    'xQuadrant 1: 1, 2, 3'                        // half a line after a reset
  ].forEach(function (l) { assert.equal(A.parseLine(l), null, JSON.stringify(l)); });
});

test('isRssLine: the mode 1 / 3 RSS line is skipped, not a parse error', function () {
  var C = require('../calibrate.js');
  var rss = []; for (var i = 0; i < 27; i++) rss.push(i % 4 ? 0.1234 * i : 0);
  var line = C.formatRssLine(rss);                     // exactly as copy.ino prints it
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

test('copy.ino prints the line parseLine reads: Quadrant <n>: x, y, heading, z', function () {
  // (out = USB serial + WiFi since task #3)
  assert.match(INO, /out\.print\("Quadrant "\); out\.print\(q\); out\.print\(": "\);\s*out\.print\(xcm\); out\.print\(", "\);\s*out\.print\(ycm\); out\.print\(", "\);\s*out\.print\(deg\); out\.print\(", "\);\s*out\.println\(zcm\);/);
  // same quadrant numbering as quadrantOf()
  assert.match(INO, /int q = \(xcm >= 0\) \? \(ycm >= 0 \? 1 : 4\) : \(ycm >= 0 \? 2 : 3\);/);
});

test('parseLedAck: the board\'s reply to LED <n> <0|1>', function () {
  assert.deepEqual(A.parseLedAck('# LED 4 1'), { led: 4, on: true });
  assert.deepEqual(A.parseLedAck('#LED 8 0\r'), { led: 8, on: false });
  assert.deepEqual(A.parseLedAck('# led 7 1'), { led: 7, on: true });
  ['# TIMING 1', '# LED 4', '# LED 4 2', '# LED x 1', 'LED 4 1', '# LED 4 10', 'Quadrant 1: 1, 2, 3']
    .forEach(function (l) { assert.equal(A.parseLedAck(l), null, l); });
  // copy.ino answers in that form
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
    '2026-11-20T03:04:05.006Z,0,3,-24.5,-1.47,-0.66,serial,2.3\r\n' +
    '2026-11-20T03:04:05.056Z,50,1,12.34,5,179.99,serial,0\r\n');
});

test('toCsv: z is empty (not 0) when the board did not send it', function () {
  var csv = A.toCsv([A.logEntry(sample('Quadrant 2: -33.84, 47.30, -23.71', 0, 0), 'serial')]);
  assert.equal(csv.split('\r\n')[1], '1970-01-01T00:00:00.000Z,0,2,-33.84,47.3,-23.71,serial,');
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

test('toCsv header matches the CSV files already recorded', function () {
  var dir = path.join(ROOT, 'firmware', 'copy', 'calib', 'motion_20261119');
  fs.readdirSync(dir).filter(function (f) { return /\.csv$/.test(f); }).forEach(function (f) {
    var first = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)[0];
    assert.equal(first, HEADER, f);
  });
});

/* ---------- LEDs ---------- */

test('LEDS (map and power-up on/off) match copy.ino p, LED_NUM and LED_ON', function () {
  var num = inoArray('const int LED_NUM[N_LED]').map(Number);
  var on = inoArray('bool LED_ON[N_LED]').map(function (s) { return s === 'true'; });
  var p = inoArray('BLA::Matrix<N_LED, 3> p').map(Number);
  assert.equal(A.LEDS.length, num.length);
  A.LEDS.forEach(function (L) {
    var row = num.indexOf(+L[2]);
    assert.ok(row >= 0, 'LED ' + L[2] + ' not in LED_NUM');
    assert.equal(L[0], Math.round(p[row * 3] * 100), 'x of LED ' + L[2]);
    assert.equal(L[1], Math.round(p[row * 3 + 1] * 100), 'y of LED ' + L[2]);
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
