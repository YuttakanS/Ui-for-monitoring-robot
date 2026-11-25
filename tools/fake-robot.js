#!/usr/bin/env node
/* A stand-in for the robot's WiFi server (robot.ino, USE_WIFI 1), to try the
 * web pages over "WiFi" without the board (task #3).
 *
 *   node tools/fake-robot.js [port]        (default 8080)
 *
 * then on the page connect WiFi to 127.0.0.1:8080. Same endpoints and lines
 * as the firmware in mode 3, at 20 Hz:
 *   GET /events   SSE: an RSS line (the model in calib-model.js) and a
 *                 Quadrant line per update; "# ..." replies to commands
 *   GET /cmd?c=   LED <n> <0|1>, USE <k>, TIMING <0|1>, WIFI
 *   GET /         "RA robot ok"
 *   GET /pose?x=&y=&theta=   (fake only) hold the robot still at a pose
 *                 (cm, deg); /pose with no values = move again
 * No dependencies (Node http).
 */
'use strict';
var http = require('node:http');
var path = require('node:path');
var C = require(path.join(__dirname, '..', 'web', 'js', 'calib-model.js'));

var CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' };

function createRobot(opts) {
  opts = opts || {};
  var periodMs = opts.periodMs || 50;
  // LED_ON at power-up, as in robot.ino (all 9 LEDs)
  var ledOn = {}; C.ROW_LED.forEach(function (led) { ledOn[led] = C.DEFAULT_LIT.indexOf(led) >= 0; });
  var timing = false, hold = null, t0 = Date.now(), useK = C.LED_USE_K;
  var clients = new Set();

  function emit(line) {
    var ev = 'data: ' + line + '\n\n';
    clients.forEach(function (res) { res.write(ev); });
  }
  function pose() {
    if (hold) return hold;
    var t = (Date.now() - t0) / 1000;
    return { x: -25 + 15 * Math.cos(t * 0.5), y: 20 * Math.sin(t * 0.5), theta: ((t * 20) % 360) - 180, z: 0 };
  }
  function tick() {
    var p = pose(), th = p.theta * Math.PI / 180, rss = [];
    for (var row = 0; row < C.N_LED; row++)
      for (var l = 0; l < C.N_PD; l++)
        rss.push(ledOn[C.ROW_LED[row]] ? C.predictRss(row, l, p.x / 100, p.y / 100, (p.z || 0) / 100, th) * (1 + 0.01 * (Math.random() - 0.5)) : 0);
    emit(C.formatRssLine(rss));
    var q = p.x >= 0 ? (p.y >= 0 ? 1 : 4) : (p.y >= 0 ? 2 : 3);
    emit('Quadrant ' + q + ': ' + [p.x, p.y, p.theta, p.z || 0].map(function (v) { return v.toFixed(2); }).join(', '));
    if (timing) emit('# T wait=20.0 demod=19.0 ekf=10.0 total=50.0');
  }
  function command(line) {
    var m;
    if ((m = /^LED (\d+) (\d+)$/.exec(line)) && ledOn[+m[1]] !== undefined) {
      ledOn[+m[1]] = m[2] !== '0';
      emit('# LED ' + m[1] + ' ' + (ledOn[+m[1]] ? 1 : 0));
    } else if ((m = /^USE (\d+)$/.exec(line))) {
      if (+m[1] >= 1 && +m[1] <= C.N_LED) useK = +m[1];  // the fake positions do not depend on it
      emit('# USE ' + useK);
    } else if ((m = /^TIMING (\d+)$/.exec(line))) {
      timing = m[1] !== '0';
      emit('# TIMING ' + (timing ? 1 : 0));
    } else if (line === 'WIFI') {
      emit('# WIFI ap=FAKE ip=127.0.0.1');
    }
  }

  var server = http.createServer(function (req, res) {
    var u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({ 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' }, CORS));
      return res.end();
    }
    if (u.pathname === '/events') {
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }, CORS));
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', function () { clients.delete(res); });
      return;
    }
    if (u.pathname === '/cmd') {
      res.writeHead(204, CORS); res.end();
      command(String(u.searchParams.get('c') || ''));
      return;
    }
    if (u.pathname === '/pose') {
      var x = parseFloat(u.searchParams.get('x')), y = parseFloat(u.searchParams.get('y'));
      hold = isNaN(x) || isNaN(y) ? null : { x: x, y: y, theta: parseFloat(u.searchParams.get('theta')) || 0, z: 0 };
      res.writeHead(204, CORS); return res.end();
    }
    if (u.pathname === '/') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, CORS)); return res.end('RA robot ok\n'); }
    res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, CORS)); res.end('not found\n');
  });
  var timer = setInterval(tick, periodMs);
  server.on('close', function () { clearInterval(timer); });
  return {
    server: server,
    ledOn: ledOn,
    close: function () {
      clearInterval(timer);
      clients.forEach(function (res) { res.end(); });
      server.closeAllConnections && server.closeAllConnections();
      return new Promise(function (r) { server.close(function () { r(); }); });
    }
  };
}

if (require.main === module) {
  var port = parseInt(process.argv[2], 10) || 8080;
  var robot = createRobot();
  robot.server.listen(port, '127.0.0.1', function () {
    console.log('fake robot on http://127.0.0.1:' + port + '  (on the page: WiFi address 127.0.0.1:' + port + ')');
  });
}
module.exports = { createRobot: createRobot };
