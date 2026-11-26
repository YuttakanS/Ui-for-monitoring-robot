/* Yaw / pitch / roll test page: reads RSS lines (robot.ino in mode 3, or a CSV
 * of recorded points), solves the pose with pitch and roll on the PC
 * (tilt-test.js) and compares it with the pose the robot really had. */
(function () {
  'use strict';
  var C = window.RACalib, T = window.RATilt;
  var BAUD = 115200;
  var LIVE_N = 10;           // RSS lines averaged for the live solution
  var LIVE_EVERY = 500;      // ms between live solutions
  var SPREAD_MAX = 0.05;     // > 5 % movement while recording = warn
  var ANGLE_BAD = T.TILT_RMS_MAX;
  var STORE = 'ra.tilt.points', OPT_STORE = 'ra.tilt.opts';

  function $(id) { return document.getElementById(id); }
  var el = {
    connect: $('btnConnect'), wifiBtn: $('btnWifi'), wifiHost: $('wifiHost'), demo: $('btnDemo'), dot: $('statusDot'), status: $('statusText'), rate: $('rate'),
    notice: $('notice'), noticeText: $('noticeText'),
    optK: $('optK'), optModel: $('optModel'),
    liveYaw: $('liveYaw'), livePitch: $('livePitch'), liveRoll: $('liveRoll'), livePitchRel: $('livePitchRel'), liveRollRel: $('liveRollRel'),
    liveX: $('liveX'), liveY: $('liveY'), liveZ: $('liveZ'), liveNote: $('liveNote'), liveN: $('liveN'),
    zero: $('btnZero'), zeroReset: $('btnZeroReset'),
    form: $('poseForm'), x: $('inX'), y: $('inY'), z: $('inZ'), th: $('inTh'), pitch: $('inPitch'), roll: $('inRoll'), n: $('inN'), record: $('btnRecord'),
    bar: $('progressBar'), recText: $('recText'),
    table: $('resultTable').tBodies[0], pointCount: $('pointCount'), pointEmpty: $('pointEmpty'),
    imp: $('fileImport'), expResult: $('btnExportResult'), expPoints: $('btnExportPoints'), clear: $('btnClear'),
    verdict: $('verdict'), sumGrid: $('sumGrid'),
    sumFalse: $('sumFalse'), sumFalseSub: $('sumFalseSub'), sumYaw: $('sumYaw'), sumYawSub: $('sumYawSub'),
    sumXy: $('sumXy'), sumXySub: $('sumXySub'), sumTilt: $('sumTilt'), sumTiltSub: $('sumTiltSub'),
    chart: $('errChart'), legend: $('chartLegend')
  };
  el.liveN.textContent = LIVE_N;

  // theme chosen on the main page
  try {
    var th = localStorage.getItem('ra.theme');
    if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th);
  } catch (e) { /* storage unavailable */ }

  var state = {
    source: 'idle',          // idle | serial | wifi | demo
    wifiUp: false,
    points: [],              // { x, y, z, theta, pitch, roll, n, spread, rss, demo? }
    rec: null,               // { pose, need, lines }
    recent: [], fresh: false, // last LIVE_N RSS lines; new ones since the last live solution
    live: null,              // last live result of T.analyse()
    zero: null,              // { pitch, roll } solved when "zero" was pressed
    rssTimes: [], quadLines: 0, rssLines: 0, connectedAt: 0,
    result: null             // T.evaluate() of the points with the options chosen
  };
  try { state.points = JSON.parse(localStorage.getItem(STORE) || '[]') || []; } catch (e) { state.points = []; }
  try {
    var o = JSON.parse(localStorage.getItem(OPT_STORE) || 'null');
    if (o && (o.k === '6' || o.k === '9')) el.optK.value = o.k;
    if (o && (o.model === 'loo' || o.model === 'fw')) el.optModel.value = o.model;
  } catch (e) { /* storage unavailable or bad JSON */ }
  function savePoints() {
    // simulated points are not kept
    try { localStorage.setItem(STORE, JSON.stringify(state.points.filter(function (p) { return !p.demo; }))); } catch (e) { /* storage unavailable */ }
  }

  function showNotice(text) { el.noticeText.textContent = text || ''; el.notice.hidden = !text; }
  function td(text, cls) { var c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; }
  // fixed decimals, without "-0.0"
  function f(v, d) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var s = v.toFixed(d === undefined ? 1 : d);
    return +s === 0 ? s.replace('-', '') : s;
  }
  function signed(v, d) { var s = f(v, d); return s !== '—' && +s > 0 ? '+' + s : s; }
  function pointLabel(p) {
    return '(' + p.x + ', ' + p.y + ')' + (p.pitch || p.roll ? ' เอียง ' + (p.pitch || 0) + '°, ' + (p.roll || 0) + '°' : '');
  }
  function kUsed() { return +el.optK.value; }

  /* ---------- status ---------- */
  function setSource(src) {
    var was = state.source;
    state.source = src;
    el.connect.textContent = src === 'serial' ? 'ตัดการเชื่อมต่อ' : 'เชื่อมต่อ Serial';
    el.wifiBtn.textContent = src === 'wifi' ? 'ตัด WiFi' : 'เชื่อมต่อ WiFi';
    el.demo.textContent = src === 'demo' ? 'หยุด Demo' : 'Demo';
    el.demo.disabled = src === 'serial' || src === 'wifi';
    el.connect.disabled = src === 'demo' || src === 'wifi';
    el.wifiBtn.disabled = src === 'demo' || src === 'serial';
    el.wifiHost.disabled = src === 'wifi';
    if (src === 'idle') { cancelRec(); state.recent = []; state.live = null; renderLive(); }
    if (was === 'demo' && src !== 'demo' && state.points.some(function (p) { return p.demo; })) {
      state.points = state.points.filter(function (p) { return !p.demo; });   // simulated points go with the demo
      renderResult();
    }
    updateStatus();
  }
  function updateStatus() {
    var now = performance.now();
    state.rssTimes = state.rssTimes.filter(function (t) { return now - t < 5000; });
    var hz = state.rssTimes.length / 5;
    el.rate.textContent = (hz < 10 ? hz.toFixed(1) : Math.round(hz)) + ' Hz';
    var live = state.source === 'serial' || state.source === 'wifi';
    var up = state.source === 'serial' || state.wifiUp;
    el.dot.className = 'dot' + (live ? (up && state.rssLines ? ' on' : ' warn') : state.source === 'demo' ? ' demo' : '');
    el.status.textContent = state.source === 'wifi' && !state.wifiUp ? 'กำลังติดต่อหุ่นทาง WiFi…'
      : live ? (state.rssLines ? 'เชื่อมต่อแล้ว' + (state.source === 'wifi' ? ' (WiFi)' : '') : 'เชื่อมต่อแล้ว รอบรรทัด RSS')
      : state.source === 'demo' ? 'Demo (ข้อมูลจำลอง ไม่ใช่ค่าที่วัดจริง)' : 'ยังไม่เชื่อมต่อ';
    el.record.disabled = state.source === 'idle' && !state.rec;
    if (!state.rec) el.recText.textContent = state.source === 'idle' ? 'เชื่อมต่อบอร์ดหรือกด Demo ก่อน' : 'พร้อมบันทึก';
    // a board in mode 2 sends only Quadrant lines
    if (live && up && !state.rssLines && now - state.connectedAt > 3000) {
      showNotice(state.quadLines
        ? 'บอร์ดส่งแต่บรรทัดพิกัด ไม่มีบรรทัด RSS: firmware นี้ไม่รับคำสั่ง MODE 3 ให้ตั้ง mode = 3 ใน robot.ino แล้ว upload ใหม่'
        : 'ยังไม่มีข้อมูลจากบอร์ด: ตรวจว่า upload firmware แล้ว และไม่มีโปรแกรมอื่นเปิดพอร์ตอยู่');
    }
  }
  setInterval(updateStatus, 1000);

  /* ---------- incoming lines ---------- */
  function onLine(raw) {
    var line = raw.trim();
    if (!line) return;
    var rss = C.parseRssLine(line);
    if (rss) { onRss(rss); return; }
    if (/^Quadrant/i.test(line)) state.quadLines++;
  }

  function onRss(rss) {
    if (!state.rssLines && (state.source === 'serial' || state.source === 'wifi')) showNotice('');
    state.rssLines++;
    state.rssTimes.push(performance.now());
    state.recent.push(rss);
    if (state.recent.length > LIVE_N) state.recent.shift();
    state.fresh = true;
    var r = state.rec;
    if (!r) return;
    r.lines.push(rss);
    el.bar.style.width = (100 * r.lines.length / r.need) + '%';
    el.recText.textContent = 'กำลังเก็บ ' + pointLabel(r.pose) + ' ' + r.lines.length + ' / ' + r.need + ' บรรทัด';
    if (r.lines.length >= r.need) finishRec();
  }

  /* ---------- live solution ---------- */
  setInterval(function () {
    if (!state.fresh || !state.recent.length) return;
    state.fresh = false;
    state.live = T.analyse(C.averageRss(state.recent).rss, { k: kUsed() });
    renderLive();
  }, LIVE_EVERY);

  function renderLive() {
    var a = state.live, t = a && a.tilt;
    el.liveYaw.textContent = t ? f(t.theta) : '—';
    el.livePitch.textContent = t ? f(t.pitch) : '—';
    el.liveRoll.textContent = t ? f(t.roll) : '—';
    el.liveX.textContent = t ? f(t.x) : '—';
    el.liveY.textContent = t ? f(t.y) : '—';
    el.liveZ.textContent = t ? f(t.z) : '—';
    var z = state.zero;
    el.livePitchRel.textContent = t && z ? 'เปลี่ยน ' + signed(t.pitch - z.pitch) + '°' : '';
    el.liveRollRel.textContent = t && z ? 'เปลี่ยน ' + signed(t.roll - z.roll) + '°' : '';
    el.zero.disabled = !t;
    el.zeroReset.hidden = !z;
    if (!a) {
      el.liveNote.textContent = state.source === 'idle' ? 'เชื่อมต่อบอร์ดหรือกด Demo ก่อน'
        : state.rssLines ? 'ไม่มี LED ไหนอ่านค่าได้: ตรวจว่าเปิด LED ในหน้า Position Monitor แล้ว' : 'รอบรรทัด RSS…';
      return;
    }
    var edge = Math.abs(t.pitch) > 24.9 || Math.abs(t.roll) > 24.9;
    el.liveNote.textContent = 'ใช้ ' + t.nValues + ' ค่า หา ' + t.nUnknowns + ' ตัวแปร · แบบจำลองคลาด (rms) ' + t.rms.toFixed(4) +
      (a.skipPd >= 0 ? ' · ข้าม PD ' + a.skipPd + ' (อ่านได้ต่ำผิดปกติ)' : '') +
      (edge ? ' · pitch/roll ชนขอบ ±25°' : '') +
      ' · ถ้าถือว่าวางระดับ: x ' + f(a.flat.x) + ', y ' + f(a.flat.y) + ', yaw ' + f(a.flat.theta);
  }
  el.zero.addEventListener('click', function () {
    if (!state.live) return;
    state.zero = { pitch: state.live.tilt.pitch, roll: state.live.tilt.roll };
    renderLive();
  });
  el.zeroReset.addEventListener('click', function () { state.zero = null; renderLive(); });

  /* ---------- recording ---------- */
  function readPose() {
    var p = {
      x: parseFloat(el.x.value), y: parseFloat(el.y.value), z: parseFloat(el.z.value), theta: parseFloat(el.th.value),
      pitch: parseFloat(el.pitch.value), roll: parseFloat(el.roll.value)
    };
    var n = parseInt(el.n.value, 10);
    for (var key in p) if (isNaN(p[key])) return { error: 'กรอก x, y, z, yaw, pitch และ roll เป็นตัวเลข' };
    if (p.z < 0) return { error: 'z ต้องไม่ติดลบ (0 = วางบนพื้น)' };
    if (!(n >= 5 && n <= 200)) return { error: 'จำนวนบรรทัดต้องอยู่ระหว่าง 5 ถึง 200' };
    return { pose: p, n: n };
  }
  function startRec() {
    var r = readPose();
    if (r.error) { el.recText.textContent = r.error; return; }
    state.rec = { pose: r.pose, need: r.n, lines: [] };
    el.record.textContent = 'ยกเลิก';
    el.record.classList.remove('primary');
    el.bar.style.width = '0';
    el.recText.textContent = 'กำลังเก็บ ' + pointLabel(r.pose) + ' รอบรรทัดแรก…';
  }
  function cancelRec(msg) {
    if (!state.rec) return;
    state.rec = null;
    el.record.textContent = 'บันทึกจุดนี้';
    el.record.classList.add('primary');
    el.bar.style.width = '0';
    if (msg) el.recText.textContent = msg;
  }
  function addPoint(pt) {
    var i = state.points.findIndex(function (q) { return T.samePoint(q, pt); });
    if (i >= 0) state.points[i] = pt; else state.points.push(pt);
    return i >= 0;
  }
  function finishRec() {
    var r = state.rec, avg = C.averageRss(r.lines), p = r.pose;
    var pt = { x: p.x, y: p.y, z: p.z, theta: p.theta, pitch: p.pitch, roll: p.roll, n: avg.n, spread: avg.spread, rss: avg.rss };
    if (state.source === 'demo') pt.demo = true;
    var replaced = addPoint(pt);
    savePoints();
    cancelRec('บันทึก ' + pointLabel(pt) + ' แล้ว' + (replaced ? ' (แทนค่าเก่า)' : '') +
      (avg.spread > SPREAD_MAX ? ' · ค่าแกว่ง ' + (avg.spread * 100).toFixed(1) + '% หุ่นขยับหรือเปล่า? บันทึกซ้ำได้' : ''));
    renderResult();
  }
  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.rec) cancelRec('ยกเลิกแล้ว'); else startRec();
  });

  /* ---------- result table ---------- */
  function angleCell(v) { return td(signed(v), Math.abs(v) > ANGLE_BAD ? 'bad' : ''); }

  function renderResult() {
    var pts = state.points, has = pts.length > 0;
    state.result = has ? T.evaluate(pts, { k: kUsed(), loo: el.optModel.value === 'loo' }) : null;
    var res = state.result;
    el.pointEmpty.hidden = has;
    el.pointCount.textContent = has ? '(' + pts.length + ' จุด)' : '';
    el.clear.disabled = !has;
    // nothing simulated leaves the page as a result
    var real = has && !pts.some(function (p) { return p.demo; });
    el.expResult.disabled = el.expPoints.disabled = !real;
    el.sumGrid.hidden = !has;
    el.chart.hidden = el.legend.hidden = !has;
    if (!has) { el.table.replaceChildren(); el.verdict.textContent = ''; el.verdict.className = 'verdict'; return; }

    var rows = res.rows.map(function (r, i) {
      var p = r.point, t = r.tilt, e = r.err, tr = document.createElement('tr');
      tr.appendChild(td(String(i + 1)));
      [p.x, p.y, p.z || 0, p.theta || 0, p.pitch || 0, p.roll || 0].forEach(function (v) { tr.appendChild(td(String(v))); });
      if (!e) {
        for (var n = 0; n < 10; n++) tr.appendChild(td('—'));
        tr.appendChild(td('ไม่มี LED ไหนอ่านค่าได้', 'bad'));
      } else {
        tr.appendChild(td(f(t.theta))); tr.appendChild(td(f(t.pitch))); tr.appendChild(td(f(t.roll)));
        tr.appendChild(angleCell(e.yaw)); tr.appendChild(angleCell(e.pitch)); tr.appendChild(angleCell(e.roll));
        if (r.change) { tr.appendChild(angleCell(r.change.pitch)); tr.appendChild(angleCell(r.change.roll)); }
        else { tr.appendChild(td('—')); tr.appendChild(td('—')); }
        tr.appendChild(td(f(e.xyFlat))); tr.appendChild(td(f(e.xyTilt)));
        var notes = [];
        if (p.demo) notes.push('จำลอง');
        if (r.skipPd >= 0) notes.push('ข้าม PD ' + r.skipPd);
        if (Math.abs(t.pitch) > 24.9 || Math.abs(t.roll) > 24.9) notes.push('ชนขอบ ±25°');
        if (el.optModel.value === 'loo' && r.model !== 'loo') notes.push('ใช้ค่า firmware');
        tr.appendChild(td(notes.join(' · ') || '—'));
      }
      var c = document.createElement('td'), b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = 'ลบ';
      b.addEventListener('click', function () { state.points.splice(i, 1); savePoints(); renderResult(); });
      c.appendChild(b); tr.appendChild(c);
      return tr;
    });
    el.table.replaceChildren.apply(el.table, rows);
    renderSummary(res.summary, !real);
    renderChart(res.rows);
  }

  function renderSummary(s, simulated) {
    el.sumFalse.textContent = s.nLevel ? f(s.falseTiltRms) + '°' : '—';
    el.sumFalseSub.textContent = s.nLevel ? 'สูงสุด ' + f(s.falseTiltMax) + '° · ' + s.nLevel + ' จุดระดับ · เกณฑ์ ≤ ' + T.TILT_RMS_MAX + '°' : 'ยังไม่มีจุดที่วางระดับ';
    el.sumYaw.textContent = f(s.yawRms) + '°';
    el.sumYawSub.textContent = 'สูงสุด ' + f(s.yawMax) + '°';
    el.sumXy.textContent = f(s.xyFlat, 2) + ' → ' + f(s.xyTilt, 2) + ' cm';
    el.sumXySub.textContent = 'แบบระดับ → แบบมีเอียง · เกณฑ์: แย่ลงไม่เกิน ' + T.XY_WORSE_MAX + ' cm';
    el.sumTilt.textContent = s.nTilted ? f(s.tiltErrRms) + '°' : '—';
    el.sumTiltSub.textContent = !s.nTilted ? 'ยังไม่มีจุดที่เอียงจริง'
      : 'สูงสุด ' + f(s.tiltErrMax) + '° · มุมที่เปลี่ยน: ' + (s.nChange ? f(s.changeRms) + '° (สูงสุด ' + f(s.changeMax) + '°)' : 'ไม่มีจุดระดับคู่กัน');
    var head = simulated ? 'ข้อมูลจำลอง (Demo): ' : '';
    if (s.pass === null) {
      el.verdict.textContent = head + 'ยังตัดสินไม่ได้: ต้องมีจุดที่วางหุ่นระดับอย่างน้อย 1 จุด';
      el.verdict.className = 'verdict';
    } else {
      el.verdict.textContent = head + (s.pass ? 'ผ่านเกณฑ์' : 'ไม่ผ่านเกณฑ์') + ': ค่าเอียงหลอก rms ' + f(s.falseTiltRms) + '° (เกณฑ์ ≤ ' + T.TILT_RMS_MAX +
        '°) · ใช้ LED ' + kUsed() + ' ดวง · ' + (el.optModel.value === 'loo' ? 'leave-one-out' : 'ค่าคงที่ใน firmware');
      el.verdict.className = 'verdict ' + (s.pass ? 'good' : 'bad');
    }
  }

  /* ---------- bar chart: pitch and roll error of every point ---------- */
  var SVG = 'http://www.w3.org/2000/svg';
  function svgEl(name, attrs, text) {
    var n = document.createElementNS(SVG, name);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function renderChart(rows) {
    var W = 900, H = 220, L = 34, R = 8, top = 10, bot = 34, MAXV = 26;
    var ph = H - top - bot, mid = top + ph / 2, sc = (ph / 2) / MAXV;
    var kids = [];
    [-20, -10, 0, 10, 20].forEach(function (v) {
      var y = mid - v * sc;
      kids.push(svgEl('line', { class: 'axis', x1: L, x2: W - R, y1: y, y2: y, opacity: v === 0 ? 1 : 0.35 }));
      kids.push(svgEl('text', { x: L - 6, y: y + 3, 'text-anchor': 'end' }, v + '°'));
    });
    [-T.TILT_RMS_MAX, T.TILT_RMS_MAX].forEach(function (v) {
      kids.push(svgEl('line', { class: 'limit', x1: L, x2: W - R, y1: mid - v * sc, y2: mid - v * sc }));
    });
    var slot = (W - L - R) / rows.length, bw = Math.max(2, Math.min(16, slot * 0.3));
    rows.forEach(function (r, i) {
      var cx = L + slot * (i + 0.5);
      if (r.err) {
        [['b-pitch', r.err.pitch, -bw - 1], ['b-roll', r.err.roll, 1]].forEach(function (b) {
          var v = Math.max(-MAXV, Math.min(MAXV, b[1])), h = Math.abs(v) * sc;
          var bar = svgEl('rect', { class: b[0], x: cx + b[2], y: v >= 0 ? mid - h : mid, width: bw, height: Math.max(h, 0.5) });
          bar.appendChild(svgEl('title', {}, (b[0] === 'b-pitch' ? 'pitch ' : 'roll ') + signed(b[1]) + '° ที่ ' + pointLabel(r.point)));
          kids.push(bar);
        });
      }
      if (slot >= 44) {
        kids.push(svgEl('text', { x: cx, y: H - bot + 14, 'text-anchor': 'middle' }, r.point.x + ', ' + r.point.y));
        if (r.point.pitch || r.point.roll)
          kids.push(svgEl('text', { x: cx, y: H - bot + 26, 'text-anchor': 'middle' }, 'เอียง ' + (r.point.pitch || 0) + ', ' + (r.point.roll || 0)));
      } else {
        kids.push(svgEl('text', { x: cx, y: H - bot + 14, 'text-anchor': 'middle' }, String(i + 1)));
      }
    });
    el.chart.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    el.chart.replaceChildren.apply(el.chart, kids);
  }

  /* ---------- options ---------- */
  function onOption() {
    try { localStorage.setItem(OPT_STORE, JSON.stringify({ k: el.optK.value, model: el.optModel.value })); } catch (e) { /* storage unavailable */ }
    state.fresh = state.recent.length > 0;   // solve the live value again
    renderResult();
  }
  el.optK.addEventListener('change', onOption);
  el.optModel.addEventListener('change', onOption);

  /* ---------- CSV ---------- */
  function stamp(d) {
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function download(text, name) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  el.expPoints.addEventListener('click', function () {
    download(T.pointsToCsv(state.points), 'ra_tilt_points_' + stamp(new Date()) + '.csv');
  });
  el.expResult.addEventListener('click', function () {
    if (!state.result) return;
    download(T.resultsToCsv(state.result, kUsed()), 'ra_tilt_result_' + stamp(new Date()) + '.csv');
  });
  el.imp.addEventListener('change', function () {
    var file = el.imp.files[0];
    if (!file) return;
    file.text().then(function (text) {
      var r = T.csvToPoints(text);
      r.points.forEach(addPoint);
      savePoints(); renderResult();
      showNotice(r.errors.length ? 'เปิด ' + file.name + ': ได้ ' + r.points.length + ' จุด, อ่านไม่ได้: ' + r.errors.join(', ') : '');
      el.imp.value = '';
    });
  });
  el.clear.addEventListener('click', function () {
    if (!confirm('ลบจุดทั้งหมด ' + state.points.length + ' จุด? (ดาวน์โหลดข้อมูลดิบไว้ก่อนถ้ายังต้องใช้)')) return;
    state.points = []; savePoints(); renderResult();
  });

  /* ---------- serial ---------- */
  var port = null, reader = null, keepReading = false, sendChain = Promise.resolve();

  function splitter(onLine) {
    var buf = '';
    return function (chunk) {
      buf += chunk;
      var parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      if (buf.length > 4096) buf = '';
      parts.forEach(onLine);
    };
  }
  function send(text) {
    if (state.source === 'wifi') { if (wifi) wifi.send(text); return; }
    var p = port;
    if (!p || !p.writable) return;
    sendChain = sendChain.then(async function () {
      var w = p.writable.getWriter();
      try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
    }).catch(function () { /* port gone */ });
  }
  async function connect() {
    if (!navigator.serial) { showNotice('Browser นี้ไม่รองรับ Web Serial ใช้ Chrome หรือ Edge'); return; }
    var p;
    try { p = await navigator.serial.requestPort(); } catch (e) { return; }
    try { await p.open({ baudRate: BAUD }); } catch (e) {
      showNotice(e && (e.name === 'NetworkError' || e.name === 'InvalidStateError')
        ? 'พอร์ตถูกใช้อยู่: ปิดหน้า Position Monitor, Calibrate หรือ Serial Monitor ก่อน'
        : 'เปิดพอร์ตไม่ได้: ' + (e && e.message ? e.message : e));
      return;
    }
    try { await p.setSignals({ dataTerminalReady: true }); } catch (e) { /* not fatal */ }
    port = p; keepReading = true;
    state.rssLines = 0; state.quadLines = 0; state.connectedAt = performance.now();
    showNotice('');
    setSource('serial');
    readLoop();
    send('MODE 3\n');  // RSS lines for this page, position lines for the monitor
  }
  async function readLoop() {
    var decoder = new TextDecoder(), split = splitter(onLine), p = port;
    while (p.readable && keepReading) {
      reader = p.readable.getReader();
      try {
        for (;;) {
          var r = await reader.read();
          if (r.done) break;
          split(decoder.decode(r.value, { stream: true }));
        }
      } catch (e) { /* recoverable errors loop again; a pulled cable ends it */ }
      finally { reader.releaseLock(); reader = null; }
    }
    var lost = keepReading;
    keepReading = false;
    try { await p.close(); } catch (e) { /* already gone */ }
    if (port === p) port = null;
    if (state.source === 'serial') setSource('idle');
    if (lost) showNotice('การเชื่อมต่อหลุด: เสียบสายแล้วกดเชื่อมต่อใหม่ (จุดที่บันทึกแล้วยังอยู่)');
  }
  async function disconnect() {
    keepReading = false;
    if (reader) { try { await reader.cancel(); } catch (e) { /* ignore */ } }
  }
  el.connect.addEventListener('click', function () { if (state.source === 'serial') disconnect(); else connect(); });

  /* ---------- WiFi: the robot's access point, wifi-link.js ---------- */
  var wifi = null;
  function connectWifi() {
    var host = el.wifiHost.value;
    if (!RAWifi.normalizeHost(host)) { showNotice('ที่อยู่หุ่นไม่ถูกต้อง: ' + host + ' (ตัวอย่าง 192.168.42.1)'); return; }
    RAWifi.saveHost(host);
    state.rssLines = 0; state.quadLines = 0; state.connectedAt = performance.now(); state.wifiUp = false;
    showNotice('');
    var link = RAWifi.openWifi(host, {
      onLine: onLine,
      onOpen: function () {
        if (wifi !== link) return;
        state.wifiUp = true; state.connectedAt = performance.now();
        showNotice('');
        send('MODE 3\n');  // the robot may have restarted
        updateStatus();
      },
      onError: function (kind) {
        if (wifi !== link) return;
        state.wifiUp = false;
        if (kind === 'closed') {
          disconnectWifi();
          showNotice('หุ่นที่ ' + link.base + ' ไม่ตอบเป็นข้อมูลที่อ่านได้: ตรวจที่อยู่ แล้วกดเชื่อมต่อ WiFi ใหม่');
        } else {
          showNotice('ติดต่อหุ่นที่ ' + link.base + ' ไม่ได้: ตรวจว่าคอมต่อ WiFi ของหุ่นอยู่ กำลังลองใหม่เอง… (จุดที่บันทึกแล้วยังอยู่)');
        }
        updateStatus();
      }
    });
    wifi = link;
    setSource('wifi');
  }
  function disconnectWifi() {
    if (wifi) wifi.close();
    wifi = null;
    state.wifiUp = false;
    if (state.source === 'wifi') setSource('idle');
  }
  el.wifiHost.value = RAWifi.savedHost();
  el.wifiBtn.addEventListener('click', function () { if (state.source === 'wifi') disconnectWifi(); else connectWifi(); });
  el.wifiHost.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && state.source === 'idle') { e.preventDefault(); connectWifi(); }
  });

  /* ---------- demo: RSS from the model itself at the pose in the form ---------- */
  // The model answering its own question: the errors are small by construction.
  // It shows how the page works, not how well the method does.
  var demoTimer = null;
  function startDemo() {
    state.rssLines = 0;
    setSource('demo');
    showNotice('Demo: ค่า RSS มาจากแบบจำลองเอง (บวก noise 2%) ค่าคลาดจึงน้อยโดยธรรมชาติ ใช้ดูวิธีใช้หน้าเท่านั้น ไม่ใช่ผลวัดจริง จุดที่บันทึกในโหมดนี้จะหายเมื่อหยุด Demo');
    demoTimer = setInterval(function () {
      var D = Math.PI / 180;
      var x = (parseFloat(el.x.value) || 0) / 100, y = (parseFloat(el.y.value) || 0) / 100, z = (parseFloat(el.z.value) || 0) / 100;
      var o = { pitch: (parseFloat(el.pitch.value) || 0) * D, roll: (parseFloat(el.roll.value) || 0) * D };
      var th = (parseFloat(el.th.value) || 0) * D, rss = [];
      for (var row = 0; row < C.N_LED; row++)
        for (var l = 0; l < C.N_PD; l++) rss.push(C.predictRss(row, l, x, y, z, th, o) * (1 + 0.02 * (Math.random() - 0.5)));
      onLine(C.formatRssLine(rss));
    }, 100);
  }
  function stopDemo() {
    clearInterval(demoTimer); demoTimer = null;
    showNotice('');
    setSource('idle');
  }
  el.demo.addEventListener('click', function () { if (state.source === 'demo') stopDemo(); else startDemo(); });

  if (!navigator.serial) showNotice('Browser นี้ไม่รองรับ Web Serial ใช้ Chrome หรือ Edge (WiFi, ไฟล์ CSV และปุ่ม Demo ยังใช้ได้)');
  setSource('idle');
  renderResult();
})();
