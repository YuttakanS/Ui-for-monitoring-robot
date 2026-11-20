/* Calibration page: reads RSS lines (copy.ino with mode = 3), averages them at
 * known poses and fits PtxGamma with calibrate.js. */
(function () {
  'use strict';
  var C = window.RACalib;
  var BAUD = 115200;
  var SPREAD_MAX = 0.05;   // > 5 % movement while recording = warn
  var RMS_MAX = 0.10, BIAS_MAX = 0.05;
  var STORE = 'ra.calib.poses';

  function $(id) { return document.getElementById(id); }
  var el = {
    connect: $('btnConnect'), demo: $('btnDemo'), dot: $('statusDot'), status: $('statusText'), rate: $('rate'),
    notice: $('notice'), noticeText: $('noticeText'),
    form: $('poseForm'), x: $('inX'), y: $('inY'), th: $('inTh'), n: $('inN'), record: $('btnRecord'),
    bar: $('progressBar'), recText: $('recText'), presets: $('presets'),
    live: $('liveTable').tBodies[0], lastRaw: $('lastRaw'),
    poses: $('poseTable').tBodies[0], poseCount: $('poseCount'), poseEmpty: $('poseEmpty'),
    exp: $('btnExport'), imp: $('fileImport'), clear: $('btnClear'),
    fit: $('fitTable').tBodies[0], fwLine: $('fwLine'), copy: $('btnCopy'), litGrid: $('litGrid'),
    anglePresets: $('anglePresets'), thMax: $('thMax'),
    drift: $('driftTable').tBodies[0], driftPoses: $('driftPoseTable').tBodies[0], driftEmpty: $('driftEmpty')
  };
  el.thMax.textContent = C.THETA_FIT_MAX;
  var LIT_STORE = 'ra.calib.lit';

  // theme chosen on the main page
  try {
    var th = localStorage.getItem('ra.theme');
    if (th === 'light' || th === 'dark') document.documentElement.setAttribute('data-theme', th);
  } catch (e) { /* storage unavailable */ }

  var state = {
    source: 'idle',          // idle | serial | demo
    poses: [],
    rec: null,               // { pose, need, lines }
    rssTimes: [],            // arrival times of RSS lines (rate)
    quadLines: 0, rssLines: 0, connectedAt: 0,
    demoTruth: null,         // { gamma, pdGain, offset } made up for the demo
    lit: C.DEFAULT_LIT.slice() // LED numbers in use
  };
  try {
    var savedLit = JSON.parse(localStorage.getItem(LIT_STORE) || 'null');
    if (Array.isArray(savedLit)) state.lit = savedLit.filter(function (n) { return n >= 0 && n < C.N_LED; });
  } catch (e) { /* storage unavailable or bad JSON */ }
  function isLit(led) { return state.lit.indexOf(led) >= 0; }

  try { state.poses = JSON.parse(localStorage.getItem(STORE) || '[]') || []; } catch (e) { state.poses = []; }
  function savePoses() {
    try { localStorage.setItem(STORE, JSON.stringify(state.poses)); } catch (e) { /* storage unavailable */ }
  }

  function showNotice(text) { el.noticeText.textContent = text || ''; el.notice.hidden = !text; }
  function td(text, cls) { var c = document.createElement('td'); c.textContent = text; if (cls) c.className = cls; return c; }
  function pct(v, signed) { return v === null || v === undefined ? '—' : (signed && v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%'; }
  function samePose(a, b) { return a.x === b.x && a.y === b.y && (a.theta || 0) === (b.theta || 0); }
  function poseLabel(p) { return '(' + p.x + ', ' + p.y + ')' + (p.theta ? ' θ ' + p.theta + '°' : ''); }
  function fixed(v, d) { return v === null || v === undefined ? '—' : v.toFixed(d); }

  /* ---------- status ---------- */
  function setSource(src) {
    state.source = src;
    el.connect.textContent = src === 'serial' ? 'ตัดการเชื่อมต่อ' : 'เชื่อมต่อ Serial';
    el.demo.textContent = src === 'demo' ? 'หยุด Demo' : 'Demo';
    el.demo.disabled = src === 'serial';
    el.connect.disabled = src === 'demo';
    if (src === 'idle') cancelRec();
    updateStatus();
  }
  function updateStatus() {
    var now = performance.now();
    state.rssTimes = state.rssTimes.filter(function (t) { return now - t < 5000; });
    var hz = state.rssTimes.length / 5;
    el.rate.textContent = (hz < 10 ? hz.toFixed(1) : Math.round(hz)) + ' Hz';
    el.dot.className = 'dot' + (state.source === 'serial' ? (state.rssLines ? ' on' : ' warn') : state.source === 'demo' ? ' demo' : '');
    el.status.textContent = state.source === 'serial' ? (state.rssLines ? 'เชื่อมต่อแล้ว' : 'เชื่อมต่อแล้ว รอบรรทัด RSS')
      : state.source === 'demo' ? 'Demo (ข้อมูลจำลอง)' : 'ยังไม่เชื่อมต่อ';
    el.record.disabled = state.source === 'idle' && !state.rec;
    if (!state.rec) el.recText.textContent = state.source === 'idle' ? 'เชื่อมต่อบอร์ดหรือกด Demo ก่อน' : 'พร้อมเก็บค่า';
    // a board in mode 2 sends only Quadrant lines
    if (state.source === 'serial' && !state.rssLines && now - state.connectedAt > 3000) {
      showNotice(state.quadLines
        ? 'บอร์ดส่งแต่บรรทัดพิกัด ไม่มีบรรทัด RSS: ตั้ง mode = 3 (หรือ 1) ใน copy.ino แล้ว upload ใหม่'
        : 'ยังไม่มีข้อมูลจากบอร์ด: ตรวจว่า upload firmware แล้ว และไม่มีโปรแกรมอื่นเปิดพอร์ตอยู่');
    }
  }
  setInterval(updateStatus, 1000);

  /* ---------- incoming lines ---------- */
  function onLine(raw) {
    var line = raw.trim();
    if (!line) return;
    el.lastRaw.textContent = line.length > 160 ? line.slice(0, 160) + '…' : line;
    var rss = C.parseRssLine(line);
    if (rss) { onRss(rss); return; }
    if (/^Quadrant/i.test(line)) state.quadLines++;
  }

  function onRss(rss) {
    if (!state.rssLines && state.source === 'serial') showNotice('');
    state.rssLines++;
    state.rssTimes.push(performance.now());
    renderLive(rss);
    var r = state.rec;
    if (!r) return;
    r.lines.push(rss);
    el.bar.style.width = (100 * r.lines.length / r.need) + '%';
    el.recText.textContent = 'กำลังเก็บ ' + poseLabel(r.pose) + ' ' + r.lines.length + ' / ' + r.need + ' บรรทัด';
    if (r.lines.length >= r.need) finishRec();
  }

  function renderLive(rss) {
    var rows = [];
    for (var led = 0; led < C.N_LED; led++) {
      var row = C.ROW_LED.indexOf(led), lit = isLit(led);
      var tr = document.createElement('tr');
      tr.appendChild(td('LED ' + led + (lit ? '' : ' (ไม่ใช้)'), lit ? '' : 'off'));
      for (var l = 0; l < C.N_PD; l++) tr.appendChild(td(rss[row * C.N_PD + l].toFixed(4), lit ? '' : 'off'));
      rows.push(tr);
    }
    el.live.replaceChildren.apply(el.live, rows);
  }

  /* ---------- recording ---------- */
  function readPose() {
    var p = { x: parseFloat(el.x.value), y: parseFloat(el.y.value), theta: parseFloat(el.th.value) };
    var n = parseInt(el.n.value, 10);
    if (isNaN(p.x) || isNaN(p.y) || isNaN(p.theta)) return { error: 'กรอก x, y และ θ เป็นตัวเลข' };
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
    el.recText.textContent = 'กำลังเก็บ ' + poseLabel(r.pose) + ' รอบรรทัดแรก…';
  }

  function cancelRec(msg) {
    if (!state.rec) return;
    state.rec = null;
    el.record.textContent = 'เก็บจุดนี้';
    el.record.classList.add('primary');
    el.bar.style.width = '0';
    if (msg) el.recText.textContent = msg;
  }

  function finishRec() {
    var r = state.rec;
    var avg = C.averageRss(r.lines);
    var pose = { x: r.pose.x, y: r.pose.y, theta: r.pose.theta, n: avg.n, spread: avg.spread, rss: avg.rss };
    var i = state.poses.findIndex(function (p) { return samePose(p, pose); });
    if (i >= 0) state.poses[i] = pose; else state.poses.push(pose);
    savePoses();
    var warn = C.checkPose(pose.rss, state.lit);
    cancelRec('เก็บ ' + poseLabel(pose) + ' แล้ว' + (i >= 0 ? ' (แทนค่าเก่า)' : '') +
      (avg.spread > SPREAD_MAX ? ' · ค่าแกว่ง ' + pct(avg.spread) + ' หุ่นขยับหรือเปล่า? เก็บซ้ำได้' : '') +
      (warn.length ? ' · มีคำเตือน ดูในตาราง' : ''));
    renderAll();
  }

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.rec) cancelRec('ยกเลิกแล้ว'); else startRec();
  });

  /* ---------- which LEDs are lit (picker laid out like the real grid) ---------- */
  var GRID = [8, 7, 6, 5, 4, 3, 2, 1, 0];
  GRID.forEach(function (led) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn led-btn';
    b.dataset.led = led;
    b.innerHTML = '<span class="led-dot" aria-hidden="true"></span>LED ' + led;
    b.addEventListener('click', function () {
      var i = state.lit.indexOf(led);
      if (i >= 0) state.lit.splice(i, 1); else state.lit.push(led);
      state.lit.sort();
      try { localStorage.setItem(LIT_STORE, JSON.stringify(state.lit)); } catch (e) { /* storage unavailable */ }
      sendLit();
      renderLit();
      renderAll();
    });
    el.litGrid.appendChild(b);
  });
  function renderLit() {
    var btns = el.litGrid.children;
    for (var i = 0; i < btns.length; i++)
      btns[i].setAttribute('aria-pressed', isLit(+btns[i].dataset.led) ? 'true' : 'false');
  }
  // bring the firmware's LED_ON in line with the picker
  function sendLit() {
    for (var led = 0; led < C.N_LED; led++) send('LED ' + led + ' ' + (isLit(led) ? 1 : 0) + '\n');
  }

  /* ---------- suggested poses (follow the lit LEDs) ---------- */
  function renderPresets() {
    var rows = C.presetPoses(state.lit).map(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = '(' + p.x + ', ' + p.y + ')';
      b.classList.toggle('done', state.poses.some(function (q) { return samePose(q, { x: p.x, y: p.y, theta: 0 }); }));
      b.addEventListener('click', function () { el.x.value = p.x; el.y.value = p.y; el.th.value = 0; });
      return b;
    });
    el.presets.replaceChildren.apply(el.presets, rows);

    // several headings: one row per place
    var places = [], byKey = {};
    C.anglePoses(state.lit).forEach(function (p) {
      var k = p.x + ',' + p.y;
      if (!byKey[k]) { byKey[k] = { x: p.x, y: p.y, poses: [] }; places.push(byKey[k]); }
      byKey[k].poses.push(p);
    });
    var angleRows = places.map(function (pl) {
      var row = document.createElement('div');
      row.className = 'angle-row';
      var lab = document.createElement('span');
      lab.className = 'place';
      lab.textContent = '(' + pl.x + ', ' + pl.y + ')';
      row.appendChild(lab);
      pl.poses.forEach(function (p) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn small';
        b.textContent = (p.theta > 0 ? '+' : '') + p.theta + '°';
        b.title = 'x = ' + p.x + ', y = ' + p.y + ', θ = ' + p.theta + '°';
        b.classList.toggle('done', state.poses.some(function (q) { return samePose(q, p); }));
        b.addEventListener('click', function () { el.x.value = p.x; el.y.value = p.y; el.th.value = p.theta; });
        row.appendChild(b);
      });
      return row;
    });
    el.anglePresets.replaceChildren.apply(el.anglePresets, angleRows);
  }

  /* ---------- tables ---------- */
  function warnText(pose) {
    return C.checkPose(pose.rss, state.lit).map(function (w) {
      return w.kind === 'zero' ? 'LED ' + w.led + ' อ่านได้ 0' : 'LED ' + w.led + ' ยังเปิดใน firmware';
    }).join(', ');
  }

  // fit = fitModel() result or null; its dTheta says how far the fit turned
  // each pose (red when it hit the limit: wrong heading entered?)
  function renderPoses(fit) {
    var dth = fit && fit.dTheta;
    var rows = state.poses.map(function (p, i) {
      var tr = document.createElement('tr');
      tr.appendChild(td(String(i + 1)));
      tr.appendChild(td(String(p.x)));
      tr.appendChild(td(String(p.y)));
      tr.appendChild(td(String(p.theta || 0)));
      if (dth) {
        var d = dth[i];
        tr.appendChild(td((d > 0 ? '+' : '') + d.toFixed(1) + '°', Math.abs(d) > C.THETA_FIT_MAX - 0.5 ? 'bad' : ''));
      } else tr.appendChild(td('—', 'off'));
      tr.appendChild(td(p.n ? String(p.n) : '—'));
      tr.appendChild(td(p.spread !== undefined ? pct(p.spread) : '—', p.spread > SPREAD_MAX ? 'bad' : ''));
      var w = warnText(p);
      tr.appendChild(td(w || '—', w ? 'bad' : ''));
      var c = document.createElement('td'), b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.textContent = 'ลบ';
      b.addEventListener('click', function () { state.poses.splice(i, 1); savePoses(); renderAll(); });
      c.appendChild(b); tr.appendChild(c);
      return tr;
    });
    el.poses.replaceChildren.apply(el.poses, rows);
    el.poseEmpty.hidden = state.poses.length > 0;
    el.poseCount.textContent = state.poses.length ? '(' + state.poses.length + ' จุด)' : '';
    el.exp.disabled = el.clear.disabled = !state.poses.length;
  }

  function renderFit(fit) {
    var demoCols = document.querySelectorAll('.demo-col');
    for (var d = 0; d < demoCols.length; d++) demoCols[d].hidden = !state.demoTruth;
    if (!fit) {
      el.fit.replaceChildren();
      el.fwLine.textContent = 'เก็บค่าอย่างน้อย 1 จุดก่อน (แนะนำ ' + C.presetPoses(state.lit).length + ' จุด)';
      el.copy.disabled = true;
      return;
    }
    var res = fit.leds;
    var rows = [];
    // show in LED number order
    for (var led = 0; led < C.N_LED; led++) {
      var row = C.ROW_LED.indexOf(led), r = res[row], old = C.CURRENT_GAMMA[row];
      var tr = document.createElement('tr');
      tr.appendChild(td('LED ' + led));
      if (r.gamma === null) {
        var why = r.skipped === 'off' ? 'ไม่ใช้' : r.skipped === 'no signal' ? 'ไม่มีสัญญาณ' : 'ข้อมูลน้อยไป';
        tr.appendChild(td(why, r.skipped === 'off' ? 'off' : 'bad'));
        tr.appendChild(td(old.toFixed(3), 'off'));
        for (var k = 0; k < 6; k++) tr.appendChild(td('—', 'off'));
      } else {
        tr.appendChild(td(r.gamma.toFixed(3)));
        tr.appendChild(td(old.toFixed(3)));
        tr.appendChild(td(pct(r.gamma / old - 1, true)));
        tr.appendChild(td(String(r.n)));
        tr.appendChild(td(pct(r.rmsRel), r.rmsRel > RMS_MAX ? 'bad' : ''));
        r.pdBias.forEach(function (b) { tr.appendChild(td(pct(b, true), b !== null && Math.abs(b) > BIAS_MAX ? 'bad' : '')); });
      }
      if (state.demoTruth) tr.appendChild(td(isLit(led) ? state.demoTruth.gamma[row].toFixed(3) : '—'));
      rows.push(tr);
    }
    el.fit.replaceChildren.apply(el.fit, rows);
    var t = state.demoTruth;
    el.fwLine.textContent = C.firmwareLines(fit) + (fit.fitted ? '' :
      '\n// PD_GAIN / RSS_OFFSET: ค่าเดิมใน firmware (ต้องมีอย่างน้อย 4 จุดจึงจะคำนวณใหม่)') +
      (t ? '\n// Demo ค่าจริง: PD_GAIN = ' + t.pdGain.map(function (v) { return v.toFixed(3); }).join(', ') +
        ', RSS_OFFSET = ' + t.offset.toFixed(4) : '');
    el.copy.disabled = false;
  }

  /* ---------- does the position move with the heading? ---------- */
  function renderDrift(fit) {
    // only places recorded at two or more headings say anything here
    var count = {};
    state.poses.forEach(function (p) { var k = p.x + ',' + p.y; count[k] = (count[k] || 0) + 1; });
    var multi = state.poses.filter(function (p) { return count[p.x + ',' + p.y] >= 2; });
    el.driftEmpty.hidden = multi.length > 0;
    if (!multi.length || !fit) { el.drift.replaceChildren(); el.driftPoses.replaceChildren(); return; }
    var before = C.poseErrors(multi), after = C.poseErrors(multi, C.fitParams(fit));
    var gb = C.driftByPlace(before), ga = C.driftByPlace(after);
    function cm(v) { return v === null || v === undefined ? '—' : v.toFixed(1) + ' cm'; }
    function better(b, a) { return a < b - 0.5 ? 'good' : a > b + 0.5 ? 'bad' : ''; }
    el.drift.replaceChildren.apply(el.drift, gb.map(function (b, i) {
      var a = ga[i], tr = document.createElement('tr');
      tr.appendChild(td('(' + b.x + ', ' + b.y + ')'));
      tr.appendChild(td(b.headings.map(function (h) { return h + '°'; }).join(' ')));
      tr.appendChild(td(cm(b.drift)));
      tr.appendChild(td(cm(b.meanErr)));
      tr.appendChild(td(cm(a && a.drift), a ? better(b.drift, a.drift) : ''));
      tr.appendChild(td(cm(a && a.meanErr), a ? better(b.meanErr, a.meanErr) : ''));
      return tr;
    }));
    el.driftPoses.replaceChildren.apply(el.driftPoses, before.map(function (b, i) {
      var a = after[i], tr = document.createElement('tr');
      tr.appendChild(td(String(b.x))); tr.appendChild(td(String(b.y))); tr.appendChild(td(b.theta + '°'));
      [b, a].forEach(function (e, j) {
        tr.appendChild(td(e.est ? '(' + e.est.x.toFixed(1) + ', ' + e.est.y.toFixed(1) + ')' : '—'));
        tr.appendChild(td(e.est ? fixed(e.est.z, 1) : '—'));
        tr.appendChild(td(cm(e.err)));
        if (j === 0) tr.appendChild(td(e.dTheta === null ? '—' : (e.dTheta > 0 ? '+' : '') + e.dTheta.toFixed(0) + '°',
          e.dTheta !== null && Math.abs(e.dTheta) > 30 ? 'bad' : ''));
      });
      return tr;
    }));
  }

  function renderAll() {
    // gamma together with PD_GAIN and RSS_OFFSET (fixed at the firmware values
    // when there are too few poses to fit them), and each pose's heading
    // nudged when the poses use several headings
    var fit = state.poses.length ? C.fitModel(state.poses, { leds: state.lit }) : null;
    renderPoses(fit); renderPresets(); renderFit(fit); renderDrift(fit);
  }

  /* ---------- CSV ---------- */
  function stamp(d) {
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  el.exp.addEventListener('click', function () {
    var blob = new Blob([C.posesToCsv(state.poses)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'ra_calib_' + stamp(new Date()) + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  });
  el.imp.addEventListener('change', function () {
    var f = el.imp.files[0];
    if (!f) return;
    f.text().then(function (text) {
      var r = C.csvToPoses(text);
      r.poses.forEach(function (p) {
        var i = state.poses.findIndex(function (q) { return samePose(q, p); });
        if (i >= 0) state.poses[i] = p; else state.poses.push(p);
      });
      savePoses(); renderAll();
      showNotice(r.errors.length ? 'Import ' + r.poses.length + ' จุด, อ่านไม่ได้: ' + r.errors.join(', ') : '');
      if (!r.errors.length) el.recText.textContent = 'Import ' + r.poses.length + ' จุดแล้ว';
      el.imp.value = '';
    });
  });
  el.clear.addEventListener('click', function () {
    if (!confirm('ลบจุดที่เก็บไว้ทั้งหมด ' + state.poses.length + ' จุด? (export CSV ไว้ก่อนถ้ายังต้องใช้)')) return;
    state.poses = []; savePoses(); renderAll();
  });
  el.copy.addEventListener('click', function () {
    var text = el.fwLine.textContent;
    var done = function () { el.copy.textContent = 'Copy แล้ว ✓'; setTimeout(function () { el.copy.textContent = 'Copy บรรทัด firmware'; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, selectLine);
    else selectLine();
  });
  function selectLine() {
    var range = document.createRange(); range.selectNodeContents(el.fwLine);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }

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
        ? 'พอร์ตถูกใช้อยู่: ปิดหน้า Position Monitor หรือ Serial Monitor ก่อน'
        : 'เปิดพอร์ตไม่ได้: ' + (e && e.message ? e.message : e));
      return;
    }
    try { await p.setSignals({ dataTerminalReady: true }); } catch (e) { /* not fatal */ }
    port = p; keepReading = true;
    state.rssLines = 0; state.quadLines = 0; state.connectedAt = performance.now();
    showNotice('');
    setSource('serial');
    readLoop();
    sendLit();
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
    if (lost) showNotice('การเชื่อมต่อหลุด: เสียบสายแล้วกดเชื่อมต่อใหม่ (จุดที่เก็บแล้วยังอยู่)');
  }

  async function disconnect() {
    keepReading = false;
    if (reader) { try { await reader.cancel(); } catch (e) { /* ignore */ } }
  }

  el.connect.addEventListener('click', function () { if (state.source === 'serial') disconnect(); else connect(); });

  /* ---------- demo: RSS lines from the model at the pose in the form ---------- */
  var demoTimer = null;
  function startDemo() {
    // made-up "true" gammas within +-15 % of the current ones, photodiode gains
    // within +-10 % and an offset; the fit should find them
    function jitter(v, f) { return v * (1 - f + 2 * f * Math.random()); }
    state.demoTruth = {
      gamma: C.CURRENT_GAMMA.map(function (g) { return +jitter(g, 0.15).toFixed(3); }),
      pdGain: [1, +jitter(C.PD_GAIN[1], 0.1).toFixed(3), +jitter(C.PD_GAIN[2], 0.1).toFixed(3)],
      offset: +jitter(C.RSS_OFFSET, 0.3).toFixed(4)
    };
    // the "robot" sits a few degrees off the heading typed in, as when turned by hand
    var thetaErr = {};
    state.rssLines = 0;
    setSource('demo');
    showNotice('');
    renderAll();
    demoTimer = setInterval(function () {
      var x = parseFloat(el.x.value) || 0, y = parseFloat(el.y.value) || 0, t = parseFloat(el.th.value) || 0;
      var k = x + ',' + y + ',' + t;
      if (thetaErr[k] === undefined) thetaErr[k] = 6 * (Math.random() - 0.5);
      var th = (t + thetaErr[k]) * Math.PI / 180, rss = [];
      for (var row = 0; row < C.N_LED; row++)
        for (var l = 0; l < C.N_PD; l++)
          rss.push(isLit(C.ROW_LED[row])
            ? C.predictRss(row, l, x / 100, y / 100, 0, th, state.demoTruth) * (1 + 0.02 * (Math.random() - 0.5)) : 0);
      onLine(C.formatRssLine(rss));
    }, 150);
  }
  function stopDemo() {
    clearInterval(demoTimer); demoTimer = null;
    state.demoTruth = null;
    setSource('idle');
    renderAll();
  }
  el.demo.addEventListener('click', function () { if (state.source === 'demo') stopDemo(); else startDemo(); });

  if (!navigator.serial) showNotice('Browser นี้ไม่รองรับ Web Serial ใช้ Chrome หรือ Edge (ปุ่ม Demo ยังใช้ได้)');
  renderLit();
  renderLive(new Array(C.N_LED * C.N_PD).fill(0));
  setSource('idle');
  renderAll();
})();
