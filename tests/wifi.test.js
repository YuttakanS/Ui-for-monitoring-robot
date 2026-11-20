// Tests for the WiFi link (task #3): wifi-link.js, tools/fake-robot.js and
// the WiFi part of copy.ino (as text; the .ino is compiled with arduino-cli).
// Run: npm test
'use strict';
var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var cp = require('node:child_process');
var W = require('../wifi-link.js');
var A = require('../app.js');
var C = require('../calibrate.js');
var robotLib = require('../tools/fake-robot.js');

var ROOT = path.join(__dirname, '..');
var INO = fs.readFileSync(path.join(ROOT, 'firmware', 'copy', 'copy.ino'), 'utf8');

/* ---------- wifi-link.js ---------- */

test('normalizeHost: what people type in the address box', function () {
  assert.equal(W.normalizeHost('192.168.42.1'), 'http://192.168.42.1');
  assert.equal(W.normalizeHost('  192.168.42.1  '), 'http://192.168.42.1');
  assert.equal(W.normalizeHost('http://192.168.42.1/'), 'http://192.168.42.1');
  assert.equal(W.normalizeHost('http://192.168.42.1/events'), 'http://192.168.42.1');
  assert.equal(W.normalizeHost('127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(W.normalizeHost('robot.local'), 'http://robot.local');
  assert.equal(W.normalizeHost(''), 'http://192.168.42.1');       // empty: the robot's default
  assert.equal(W.normalizeHost(null), 'http://192.168.42.1');
  ['ftp://x', 'http://', 'a b', 'http://user:pw@1.2.3.4', 'javascript:alert(1)'].forEach(function (s) {
    assert.equal(W.normalizeHost(s), null, s);
  });
});

test('cmdUrl: one command, URL-encoded, no line ending', function () {
  assert.equal(W.cmdUrl('http://192.168.42.1', 'LED 4 1\n'), 'http://192.168.42.1/cmd?c=LED%204%201');
  assert.equal(W.cmdUrl('http://h', 'A&B=C'), 'http://h/cmd?c=A%26B%3DC');
});

function fakeEventSource() {
  var made = [];
  function ES(url) { this.url = url; this.readyState = 0; this.closed = false; made.push(this); }
  ES.prototype.close = function () { this.closed = true; this.readyState = 2; };
  ES.made = made;
  return ES;
}

test('openWifi: lines in, commands out one at a time and in order', async function () {
  var ES = fakeEventSource(), lines = [], opened = 0, errors = [], urls = [];
  var order = [];
  function fetch(url) {
    urls.push(url);
    return new Promise(function (r) { setTimeout(function () { order.push(url); r({ ok: true }); }, 5 - urls.length); });
  }
  var link = W.openWifi('192.168.42.1', {
    EventSource: ES, fetch: fetch,
    onLine: function (l) { lines.push(l); }, onOpen: function () { opened++; }, onError: function (k) { errors.push(k); }
  });
  var es = ES.made[0];
  assert.equal(link.base, 'http://192.168.42.1');
  assert.equal(es.url, 'http://192.168.42.1/events');
  es.onopen();
  es.onmessage({ data: 'Quadrant 3: -24.50, -1.47, -0.66, 0.00' });
  es.onmessage({ data: '# LED 4 1\n# LED 5 0' });           // two lines in one event
  assert.deepEqual(lines, ['Quadrant 3: -24.50, -1.47, -0.66, 0.00', '# LED 4 1', '# LED 5 0']);
  assert.equal(opened, 1);
  es.readyState = 0; es.onerror();                          // dropped, EventSource retries
  es.readyState = 2; es.onerror();                          // gave up
  assert.deepEqual(errors, ['retrying', 'closed']);
  await link.send('LED 1 1\nLED 2 0\n\nTIMING 1\n');        // as sendAllLeds() writes to serial
  assert.deepEqual(order, ['http://192.168.42.1/cmd?c=LED%201%201', 'http://192.168.42.1/cmd?c=LED%202%200',
    'http://192.168.42.1/cmd?c=TIMING%201']);              // in order although later ones answer faster
  link.close();
  assert.equal(es.closed, true);
  es.onmessage({ data: 'Quadrant 1: 1, 2, 3' });            // late event after close: ignored
  assert.equal(lines.length, 3);
  assert.throws(function () { W.openWifi('ftp://x', { EventSource: ES }); });
});

test('openWifi: a failed command does not stop the next ones', async function () {
  var ES = fakeEventSource(), sent = [];
  var link = W.openWifi('h', {
    EventSource: ES,
    fetch: function (url) { sent.push(url); return sent.length === 1 ? Promise.reject(new Error('down')) : Promise.resolve({}); }
  });
  await link.send('LED 1 1\nLED 2 1');
  assert.equal(sent.length, 2);
});

/* ---------- fake robot over real HTTP ---------- */

function startRobot() {
  var robot = robotLib.createRobot({ periodMs: 20 });
  return new Promise(function (resolve) {
    robot.server.listen(0, '127.0.0.1', function () {
      robot.base = 'http://127.0.0.1:' + robot.server.address().port;
      resolve(robot);
    });
  });
}

// read SSE events from /events until want(lines) is true
async function readEvents(base, want, ms) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, ms || 3000);
  var res = await fetch(base + '/events', { signal: ac.signal });
  var lines = [], buf = '', dec = new TextDecoder();
  try {
    for await (var chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      var ev;
      while ((ev = buf.indexOf('\n\n')) >= 0) {
        var block = buf.slice(0, ev); buf = buf.slice(ev + 2);
        block.split('\n').forEach(function (l) { if (l.indexOf('data: ') === 0) lines.push(l.slice(6)); });
      }
      if (want(lines)) break;
    }
  } catch (e) { if (e.name !== 'AbortError') throw e; }
  clearTimeout(timer); ac.abort();
  return { res: res, lines: lines };
}

test('fake robot: SSE lines parse like serial; CORS for a page opened from file://', async function () {
  var robot = await startRobot();
  try {
    var r = await readEvents(robot.base, function (ls) {
      return ls.some(A.parseLine) && ls.some(function (l) { return C.parseRssLine(l); });
    });
    assert.equal(r.res.status, 200);
    assert.equal(r.res.headers.get('content-type'), 'text/event-stream');
    assert.equal(r.res.headers.get('access-control-allow-origin'), '*');
    assert.ok(r.lines.some(A.parseLine), 'a Quadrant line');
    var rss = r.lines.map(C.parseRssLine).filter(Boolean)[0];
    assert.ok(rss, 'an RSS line');
    // power-up LEDs as copy.ino: 1, 2, 7, 8 lit
    C.ROW_LED.forEach(function (led, row) {
      var sum = rss[row * 3] + rss[row * 3 + 1] + rss[row * 3 + 2];
      assert.equal(sum > 0, C.DEFAULT_LIT.indexOf(led) >= 0, 'LED ' + led);
    });
    var opt = await fetch(robot.base + '/cmd', { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    assert.equal(opt.headers.get('access-control-allow-private-network'), 'true');
    var root = await fetch(robot.base + '/');
    assert.equal(await root.text(), 'RA robot ok\n');
  } finally { await robot.close(); }
});

test('fake robot: a command sent with openWifi comes back as "# LED"', async function () {
  var robot = await startRobot();
  try {
    var pending = readEvents(robot.base, function (ls) { return ls.indexOf('# LED 7 0') >= 0; });
    await new Promise(function (r) { setTimeout(r, 100); });
    var link = W.openWifi(robot.base, { EventSource: fakeEventSource(), fetch: fetch });
    await link.send('LED 7 0\n');
    var r = await pending;
    assert.ok(r.lines.indexOf('# LED 7 0') >= 0);
    assert.deepEqual(A.parseLedAck('# LED 7 0'), { led: 7, on: false });
    assert.equal(robot.ledOn[7], false);
  } finally { await robot.close(); }
});

/* ---------- copy.ino (text) ---------- */

test('copy.ino WiFi: same endpoints, framing, address and CORS as the page and the fake robot', function () {
  assert.match(INO, /^#define USE_WIFI 1$/m);
  assert.match(INO, /#include "wifi_secrets\.h"/);
  assert.match(INO, /const IPAddress WIFI_IP\(192, 168, 42, 1\);/);
  assert.equal(W.DEFAULT_HOST, '192.168.42.1');
  assert.match(INO, /strncmp\(r, "GET \/events", 11\)/);
  assert.match(INO, /strncmp\(r, "GET \/cmd\?", 9\)/);
  assert.match(INO, /ringPut\("data: ", 6\);[\s\S]*?ringPut\("\\n\\n", 2\);/);
  assert.match(INO, /Access-Control-Allow-Origin: \*\\r\\nAccess-Control-Allow-Private-Network: true/);
  assert.match(INO, /Content-Type: text\/event-stream/);
  // every output line goes through `out` (USB serial + WiFi), none straight to Serial
  var code = INO.replace(/\/\/.*$/gm, '');
  assert.deepEqual(code.match(/Serial\.print/g), null);
  assert.match(code, /void handleCommand\(const char\* buf\)/);
  // WiFi is served while loop() waits for the next window (core 0 only)
  assert.match(code, /if \(end < N \|\| end < lastEnd \+ \(uint32_t\)UPDATE_EVERY\) wifiPoll\(\);/);
  assert.doesNotMatch(code, /void (setup1|loop1)\(/);
});

test('WiFi password stays out of git: wifi_secrets.h is ignored, only the example is tracked', function () {
  var secrets = 'firmware/copy/wifi_secrets.h';
  var ignored = cp.spawnSync('git', ['check-ignore', '-q', secrets], { cwd: ROOT });
  assert.equal(ignored.status, 0, secrets + ' must be in .gitignore');
  var tracked = cp.spawnSync('git', ['ls-files', '--error-unmatch', secrets], { cwd: ROOT });
  assert.notEqual(tracked.status, 0, secrets + ' must not be tracked');
  var ex = fs.readFileSync(path.join(ROOT, 'firmware', 'copy', 'wifi_secrets.example.h'), 'utf8');
  var pass = /#define WIFI_AP_PASS "([^"]*)"/.exec(ex);
  assert.ok(pass && pass[1].length >= 8 && pass[1].length <= 63, 'example password: 8-63 characters');
  assert.match(ex, /#define WIFI_AP_SSID "[^"]+"/);
});
