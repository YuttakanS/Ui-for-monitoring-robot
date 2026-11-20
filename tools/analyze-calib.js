#!/usr/bin/env node
/* Task E, step 3: compare models on calibration CSVs from calibrate.html.
 *
 *   node tools/analyze-calib.js firmware/copy/calib/<file>.csv [more.csv ...]
 *
 * Models:
 *   firmware  the constants in copy.ino now (no fit)
 *   (a)       gamma + PD_GAIN + RSS_OFFSET refitted (only constants change)
 *   (b)       (a) + each photodiode's elevation be and azimuth al
 *             (needs a firmware change: be / al per photodiode)
 * Both fits nudge each pose's heading (+-10 deg) when the poses use several
 * headings. For each model: where the EKF would settle at every pose, how far
 * that moves with the heading at each place (drift) and the error against the
 * true place, fitted on all poses ("fit") and with each place left out of the
 * fit ("held out", the honest number).
 */
'use strict';
var fs = require('node:fs');
var path = require('node:path');
var C = require(path.join(__dirname, '..', 'calibrate.js'));

var files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/analyze-calib.js <calib.csv> [more.csv ...]');
  process.exit(1);
}

// poses from every file; a later file replaces the same (x, y, theta)
var samples = [];
files.forEach(function (f) {
  var r = C.csvToPoses(fs.readFileSync(f, 'utf8'));
  if (r.errors.length) console.warn(f + ': ' + r.errors.join(', '));
  r.poses.forEach(function (p) {
    var i = samples.findIndex(function (q) { return q.x === p.x && q.y === p.y && (q.theta || 0) === (p.theta || 0); });
    if (i >= 0) samples[i] = p; else samples.push(p);
  });
});
// LEDs lit = any LED with signal
var lit = C.ROW_LED.filter(function (led, row) {
  return samples.some(function (s) { return s.rss[row * 3] + s.rss[row * 3 + 1] + s.rss[row * 3 + 2] !== 0; });
});
var places = {};
samples.forEach(function (s) { places[s.x + ',' + s.y] = (places[s.x + ',' + s.y] || 0) + 1; });
console.log(samples.length + ' poses, ' + Object.keys(places).length + ' places, LEDs ' + lit.join(', '));
console.log('headings: ' + Array.from(new Set(samples.map(function (s) { return s.theta || 0; }))).sort(function (a, b) { return a - b; }).join(', ') + ' deg\n');

function f1(v) { return v === null || v === undefined ? '   —' : (v >= 0 ? ' ' : '') + v.toFixed(1); }
function summary(errs) {
  var d = C.driftByPlace(errs), ok = errs.filter(function (e) { return e && e.err !== null; });
  var meanErr = ok.reduce(function (s, e) { return s + e.err; }, 0) / ok.length;
  var maxDrift = Math.max.apply(null, d.filter(function (g) { return g.n >= 2; }).map(function (g) { return g.drift; }).concat([0]));
  var thErr = Math.sqrt(ok.reduce(function (s, e) { return s + e.dTheta * e.dTheta; }, 0) / ok.length);
  return { places: d, meanErr: meanErr, maxDrift: maxDrift, thErr: thErr };
}

var models = [
  { name: 'firmware', fit: null },
  { name: '(a) gains', opts: { leds: lit } },
  { name: '(b) gains + be/al', opts: { leds: lit, fitGeometry: true } }
];
var rows = [];
models.forEach(function (m) {
  var fitAll = m.opts ? C.fitModel(samples, m.opts) : null;
  var inS = summary(C.poseErrors(samples, fitAll ? C.fitParams(fitAll) : undefined));
  var held = m.opts && Object.keys(places).length >= 2 ? summary(C.leaveOnePlaceOut(samples, m.opts)) : null;
  rows.push({ m: m, fit: fitAll, inS: inS, held: held });
});

console.log('model                 | fit: error  drift  heading | held out: error  drift  heading');
rows.forEach(function (r) {
  var h = r.held;
  console.log(r.m.name.padEnd(21) + ' | ' + f1(r.inS.meanErr) + ' cm ' + f1(r.inS.maxDrift) + ' cm ' + f1(r.inS.thErr) + '°   | ' +
    (h ? f1(h.meanErr) + ' cm    ' + f1(h.maxDrift) + ' cm ' + f1(h.thErr) + '°' : '—'));
});
console.log('(error = mean x/y distance from the true place; drift = largest move with heading at one place;');
console.log(' heading = rms of EKF heading - entered heading)\n');

rows.forEach(function (r) {
  if (!r.fit) return;
  console.log(r.m.name + ':  PD_GAIN ' + r.fit.pdGain.map(function (v) { return v.toFixed(3); }).join(', ') +
    '  RSS_OFFSET ' + r.fit.offset.toFixed(4) +
    '  gamma ' + lit.map(function (led) { return 'LED' + led + '=' + r.fit.leds[C.ROW_LED.indexOf(led)].gamma.toFixed(3); }).join(' '));
  if (r.fit.geo) console.log('   be offset (deg) ' + r.fit.geo.beta.map(f1).join(',') + '   al offset (deg) ' + r.fit.geo.alpha.map(f1).join(','));
  if (r.fit.dTheta) {
    var big = r.fit.dTheta.map(function (d, i) { return { d: d, s: samples[i] }; }).filter(function (o) { return Math.abs(o.d) > 5; });
    console.log('   heading nudges: rms ' + Math.sqrt(r.fit.dTheta.reduce(function (s, d) { return s + d * d; }, 0) / r.fit.dTheta.length).toFixed(1) +
      '°' + (big.length ? ', over 5°: ' + big.map(function (o) { return '(' + o.s.x + ',' + o.s.y + ',' + o.s.theta + '°) ' + o.d.toFixed(1); }).join('; ') : ''));
  }
  r.fit.leds.forEach(function (l) {
    if (l.gamma === null) return;
    console.log('   LED ' + l.led + ': misfit rms ' + (100 * l.rmsRel).toFixed(1) + '%, PD bias ' +
      l.pdBias.map(function (b) { return b === null ? '—' : (b >= 0 ? '+' : '') + (100 * b).toFixed(1) + '%'; }).join(' '));
  });
});

console.log('\nper place (held out where available):');
console.log('place        | ' + rows.map(function (r) { return r.m.name.padEnd(17); }).join(' | '));
rows[0].inS.places.forEach(function (g, i) {
  console.log(('(' + g.x + ', ' + g.y + ')').padEnd(12) + ' | ' + rows.map(function (r) {
    var p = (r.held || r.inS).places[i];
    return ('drift' + f1(p.drift) + ' err' + f1(p.meanErr)).padEnd(17);
  }).join(' | '));
});

var a = rows[1].fit;
console.log('\nfirmware lines for (a):\n' + C.firmwareLines(a));
