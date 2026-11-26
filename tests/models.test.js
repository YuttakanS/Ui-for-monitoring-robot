'use strict';
// 3D-view models: web/models/* must be what tools/models-src/build_models.js
// makes, and the frame bars must sit on the LED rows of web/js/monitor.js.
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var build = require('../tools/models-src/build_models.js').build;
var LEDS = require('../web/js/monitor.js').LEDS;
var MODELS_DIR = path.join(__dirname, '..', 'web', 'models');

function verts(objText, groupWord) {
  // vertices of the parts whose "g" line contains groupWord
  var out = [], take = false;
  objText.split('\n').forEach(function (l) {
    if (l.indexOf('g ') === 0) take = l.split(' ').indexOf(groupWord) >= 0;
    else if (take && l.indexOf('v ') === 0) out.push(l.split(' ').slice(1).map(Number));
  });
  return out;
}

function bounds(vs) {
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  vs.forEach(function (v) { for (var k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } });
  return { lo: lo, hi: hi };
}

// Line endings are ignored: with core.autocrlf on Windows, git checks these
// files out with CRLF while build_models.js writes LF.
function readLf(file) { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); }

test('models: web/models files are up to date with build_models.js (run npm run models)', function () {
  var res = build();
  Object.keys(res.obj).forEach(function (k) {
    assert.strictEqual(readLf(path.join(MODELS_DIR, k + '.obj')), res.obj[k], k + '.obj');
  });
  assert.strictEqual(readLf(path.join(MODELS_DIR, 'models.js')), res.js, 'models.js');
});

test('models: LED spacing and the frame bars match LEDS in monitor.js', function () {
  var res = build();
  var xs = LEDS.map(function (L) { return L[0]; }), ys = LEDS.map(function (L) { return L[1]; });
  assert.strictEqual(res.meta.ledSpacing, Math.max.apply(null, xs));
  assert.strictEqual(res.meta.ledSpacingY, Math.max.apply(null, ys));
  // one bar along x under every LED row, centred on the row's y
  [-res.meta.ledSpacingY, 0, res.meta.ledSpacingY].forEach(function (y) {
    var name = 'barX_' + String(y).replace('-', 'm').replace('.', 'p');
    var b = bounds(verts(res.obj.frame, name));
    assert.ok(b.lo.length && isFinite(b.lo[1]), 'bar ' + name + ' exists');
    assert.ok(Math.abs((b.lo[1] + b.hi[1]) / 2 - y) < 1e-6, name + ' centred at y = ' + y);
    assert.ok(b.lo[0] <= Math.min.apply(null, xs) && b.hi[0] >= Math.max.apply(null, xs), name + ' spans every LED');
    assert.ok(b.lo[2] >= res.meta.ledZ, name + ' is above the LEDs');
  });
});

test('models: every face uses existing vertices and normals, and each part has a material', function () {
  var res = build();
  Object.keys(res.obj).forEach(function (k) {
    var lines = res.obj[k].split('\n'), nv = 0, nn = 0, lastG = null, mtlForG = {};
    lines.forEach(function (l) {
      if (l.indexOf('v ') === 0) nv++;
      else if (l.indexOf('vn ') === 0) nn++;
      else if (l.indexOf('g ') === 0) lastG = l;
      else if (l.indexOf('usemtl ') === 0) mtlForG[lastG] = l.slice(7);
      else if (l.indexOf('f ') === 0) {
        assert.ok(mtlForG[lastG], k + ': face before usemtl');
        var refs = l.split(' ').slice(1);
        assert.ok(refs.length >= 3, k + ': face with < 3 points');
        refs.forEach(function (r) {
          var p = r.split('//').map(Number);
          assert.ok(p[0] >= 1 && p[0] <= nv && p[1] >= 1 && p[1] <= nn, k + ': bad reference ' + r);
        });
      }
    });
  });
});
