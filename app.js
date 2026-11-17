(function () {
  'use strict';

  /* =====================================================================
   * Pure logic (no DOM) - also loadable from Node for testing
   * ===================================================================== */

  // Firmware line format:  Quadrant 3: -33.84, -47.30, -23.71
  //                        Quadrant <n>: <x>, <y>, <incidence angle>
  var LINE_RE = /^Quadrant\s*(\d+)\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/i;

  function parseLine(raw) {
    var m = LINE_RE.exec(String(raw).trim());
    if (!m) return null;
    return { quadrant: +m[1], x: +m[2], y: +m[3], angle: +m[4] };
  }

  // Turns arbitrary text chunks into complete lines.
  function createLineSplitter(onLine) {
    var buf = '';
    return function (chunk) {
      buf += chunk;
      var parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      if (buf.length > 2048) buf = ''; // garbage without newlines
      for (var i = 0; i < parts.length; i++) onLine(parts[i]);
    };
  }

  function niceStep(span, target) {
    var raw = span / target;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function niceCeil(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function fmtTick(v, step) {
    var d = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
    var s = v.toFixed(d);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fileStamp(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  }

  function toCsv(rows) {
    var out = ['timestamp_iso,t_ms,quadrant,x,y,incidence_angle_deg,source'];
    var t0 = rows.length ? rows[0].t : 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push([
        new Date(r.wall).toISOString(), Math.round(r.t - t0),
        r.quadrant, r.x, r.y, r.angle, r.source
      ].join(','));
    }
    return out.join('\r\n') + '\r\n';
  }

  // The firmware sends centimetres. Samples, the map range and the CSV export
  // stay in raw cm; only what is shown on screen is converted.
  // f = factor from cm, d = decimals (2 decimals in cm = 0.1 mm resolution).
  var UNITS = {
    cm: { f: 1, d: 2 },
    mm: { f: 10, d: 1 },
    m: { f: 0.01, d: 4 }
  };
  var DEFAULT_UNIT = 'cm';

  // UI text. To add a language: add a block here and an <option> in index.html (#lang).
  // {n} is replaced with a number or detail text.
  var I18N = {
    th: {
      connect: 'เชื่อมต่อ Serial',
      disconnect: 'ตัดการเชื่อมต่อ',
      demo: 'Demo',
      demoStop: 'หยุด Demo',
      unitField: 'หน่วยพิกัด',
      langField: 'ภาษา',
      settings: 'ตั้งค่า',
      statusIdle: 'ยังไม่เชื่อมต่อ',
      statusDemo: 'Demo (ข้อมูลจำลอง)',
      statusStale: 'เชื่อมต่อแล้ว — ยังไม่มีข้อมูลที่อ่านได้',
      statusOn: 'เชื่อมต่อ Serial แล้ว',
      mapTitle: 'แผนที่ตำแหน่ง (มุมมองบน)',
      fitScale: 'ปรับสเกลให้พอดี',
      mapAria: 'แผนที่ 2 มิติแสดงตำแหน่งหุ่นยนต์เทียบกับ LED',
      waiting: 'รอข้อมูล…',
      hintTitle: 'ยังไม่มีข้อมูล',
      hintStep1: '1. ต่อบอร์ดเข้ากับคอมพิวเตอร์ผ่าน USB',
      hintStep2: '2. กด "เชื่อมต่อ Serial" แล้วเลือกพอร์ตของบอร์ด',
      hintDemo: 'หรือกด Demo เพื่อทดลองด้วยข้อมูลจำลอง',
      hintNoSerial: 'เบราว์เซอร์นี้ใช้ Serial ไม่ได้ — กด Demo เพื่อทดลองด้วยข้อมูลจำลอง',
      hintWaitTitle: 'เชื่อมต่อแล้ว — กำลังรอข้อมูล',
      hintWait1: 'ตรวจว่า baud rate ในเมนูตั้งค่าตรงกับที่บอร์ดใช้',
      hintWait2: 'บอร์ดต้องส่งบรรทัดแบบ  Quadrant 1: x, y, มุม',
      distLed: 'ระยะจาก LED',
      angle: 'มุมตกกระทบ',
      gaugeAria: 'หน้าปัดมุมตกกระทบ',
      recTitle: 'บันทึกข้อมูล',
      recStart: '● เริ่มบันทึก',
      recStop: '■ หยุดบันทึก',
      rows: '{n} แถว',
      csv: 'ดาวน์โหลด CSV',
      clear: 'ล้าง',
      confirmClear: 'ข้อมูลที่บันทึกไว้ยังไม่ได้ดาวน์โหลด ต้องการล้างทิ้งหรือไม่?',
      chartXYTitle: 'ตำแหน่งตามเวลา',
      chartATitle: 'มุมตกกระทบตามเวลา',
      chartXYAria: 'กราฟ X และ Y ย้อนหลัง 30 วินาที',
      chartAAria: 'กราฟมุมตกกระทบย้อนหลัง 30 วินาที',
      tipAngle: 'มุมตกกระทบ (°)',
      tableTitle: 'ตารางค่าล่าสุด (20 แถว)',
      thTime: 'เวลา',
      thAngle: 'มุมตกกระทบ (°)',
      lastRaw: 'บรรทัดล่าสุดจาก serial:',
      parseErr: '· อ่านไม่ได้ {n} บรรทัด',
      errBusy: 'เปิดพอร์ตไม่ได้ — พอร์ตอาจถูกโปรแกรมอื่นใช้อยู่ ให้ปิด Serial Monitor ของ Arduino IDE แล้วลองใหม่',
      errOpen: 'เปิดพอร์ตไม่ได้: {n}',
      errLost: 'การเชื่อมต่อหลุด — สายอาจถูกถอดหรือบอร์ดรีเซ็ต กดเชื่อมต่อ Serial อีกครั้ง',
      errUnsupported: 'เบราว์เซอร์นี้ไม่รองรับ Web Serial — ให้เปิดด้วย Chrome หรือ Edge บนคอมพิวเตอร์ (ปุ่ม Demo ยังใช้ได้)'
    },
    en: {
      connect: 'Connect Serial',
      disconnect: 'Disconnect',
      demo: 'Demo',
      demoStop: 'Stop demo',
      unitField: 'Unit',
      langField: 'Language',
      settings: 'Settings',
      statusIdle: 'Not connected',
      statusDemo: 'Demo (simulated data)',
      statusStale: 'Connected — no readable data yet',
      statusOn: 'Serial connected',
      mapTitle: 'Position map (top view)',
      fitScale: 'Fit scale',
      mapAria: '2D map of the robot position relative to the LED',
      waiting: 'Waiting for data…',
      hintTitle: 'No data yet',
      hintStep1: '1. Plug the board in over USB',
      hintStep2: '2. Press "Connect Serial" and pick its port',
      hintDemo: 'Or press Demo to try with simulated data',
      hintNoSerial: 'This browser can\'t use Serial — press Demo to try with simulated data',
      hintWaitTitle: 'Connected — waiting for data',
      hintWait1: 'Check that the baud rate in Settings matches the board',
      hintWait2: 'The board must send lines like  Quadrant 1: x, y, angle',
      distLed: 'Distance from LED',
      angle: 'Incidence angle',
      gaugeAria: 'Incidence angle dial',
      recTitle: 'Recording',
      recStart: '● Start recording',
      recStop: '■ Stop recording',
      rows: '{n} rows',
      csv: 'Download CSV',
      clear: 'Clear',
      confirmClear: 'The recorded data has not been downloaded yet. Clear it anyway?',
      chartXYTitle: 'Position over time',
      chartATitle: 'Incidence angle over time',
      chartXYAria: 'Chart of X and Y over the last 30 seconds',
      chartAAria: 'Chart of the incidence angle over the last 30 seconds',
      tipAngle: 'Incidence angle (°)',
      tableTitle: 'Latest values (20 rows)',
      thTime: 'Time',
      thAngle: 'Incidence angle (°)',
      lastRaw: 'Last line from serial:',
      parseErr: '· {n} unreadable lines',
      errBusy: 'Could not open the port — another program may be using it. Close the Arduino IDE Serial Monitor and try again.',
      errOpen: 'Could not open the port: {n}',
      errLost: 'Connection lost — the cable may be unplugged or the board was reset. Press Connect Serial again.',
      errUnsupported: 'This browser does not support Web Serial — open the page in Chrome or Edge on a computer (Demo still works).'
    }
  };
  var DEFAULT_LANG = 'th';

  function translate(lang, key, n) {
    var dict = I18N[lang] || I18N[DEFAULT_LANG];
    var s = dict[key] !== undefined ? dict[key] : I18N[DEFAULT_LANG][key];
    if (s === undefined) return key;
    return n === undefined ? s : s.replace('{n}', function () { return String(n); });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseLine: parseLine, createLineSplitter: createLineSplitter,
      niceStep: niceStep, niceCeil: niceCeil, fmtTick: fmtTick,
      fileStamp: fileStamp, toCsv: toCsv, I18N: I18N, translate: translate, UNITS: UNITS
    };
  }
  if (typeof document === 'undefined') return;

  /* =====================================================================
   * App state
   * ===================================================================== */

  var WINDOW_MS = 30000;   // chart history
  // Break the line only on a real dropout. Must stay well above 1000 ms: a hidden
  // tab throttles the Demo timer to ~1 sample/s, which must still draw as one line.
  var GAP_MS = 2500;
  var DEFAULT_RANGE = 100; // cm

  var state = {
    source: 'idle',        // idle | serial | demo
    samples: [],
    latest: null,
    range: null,           // map half-width in cm; null = not fitted yet
    unit: DEFAULT_UNIT,    // display unit only (key of UNITS)
    lang: DEFAULT_LANG,
    notice: null,          // { key, arg } so it can be re-rendered on language change
    parseErrors: 0,
    lastRaw: '',
    recording: false,
    log: [],
    logSaved: true,
    dirty: true,
    tilesDirty: true
  };

  function $(id) { return document.getElementById(id); }
  function t(key, n) { return translate(state.lang, key, n); }
  function unitInfo() { return UNITS[state.unit] || UNITS[DEFAULT_UNIT]; }
  // cm value -> display string in the selected unit
  function fmtLen(cm) { var u = unitInfo(); return (cm * u.f).toFixed(u.d); }

  var el = {
    btnConnect: $('btnConnect'), btnDemo: $('btnDemo'), baud: $('baud'), unit: $('unit'), lang: $('lang'),
    btnSettings: $('btnSettings'), settingsPanel: $('settingsPanel'),
    statusDot: $('statusDot'), statusText: $('statusText'), rate: $('rate'), notice: $('notice'),
    map: $('map'), btnResetScale: $('btnResetScale'),
    valX: $('valX'), valY: $('valY'), valQ: $('valQ'), valR: $('valR'), valA: $('valA'),
    gNeedle: $('gNeedle'), gWedge: $('gWedge'),
    btnRecord: $('btnRecord'), recCount: $('recCount'), btnCsv: $('btnCsv'), btnClearLog: $('btnClearLog'),
    tableDetails: $('tableDetails'), tableBody: $('tableBody'),
    lastRaw: $('lastRaw'), parseErr: $('parseErr')
  };

  /* ---------- theme colors for canvas ---------- */
  var C = {};
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    ['surface', 'text', 'text2', 'muted', 'grid', 'axis', 's1', 's2', 's3', 'led'].forEach(function (k) {
      C[k] = cs.getPropertyValue('--' + k).trim();
    });
    C.font = getComputedStyle(document.body).fontFamily;
    state.dirty = true;
  }

  /* =====================================================================
   * Data intake
   * ===================================================================== */

  function feedLine(raw) {
    var line = String(raw).trim();
    if (!line) return;
    state.lastRaw = line.length > 120 ? line.slice(0, 120) + '…' : line;
    var s = parseLine(line);
    if (!s) { state.parseErrors++; return; }

    s.t = performance.now();
    s.wall = Date.now();
    state.samples.push(s);
    state.latest = s;

    var cutoff = s.t - WINDOW_MS - 2000;
    if (state.samples.length > 512 && state.samples[0].t < cutoff) {
      var i = 0;
      while (state.samples[i].t < cutoff) i++;
      state.samples.splice(0, i);
    }

    var m = Math.max(Math.abs(s.x), Math.abs(s.y));
    if (state.range === null) state.range = niceCeil(Math.max(m * 1.5, 1e-6));
    else if (m > state.range * 0.92) state.range = niceCeil(m * 1.2);

    if (state.recording) {
      state.log.push({
        wall: s.wall, t: s.t, quadrant: s.quadrant, x: s.x, y: s.y, angle: s.angle, source: state.source
      });
      state.logSaved = false;
    }
    state.dirty = state.tilesDirty = true;
  }

  function clearData() {
    state.samples = [];
    state.latest = null;
    state.range = null;
    state.parseErrors = 0;
    state.lastRaw = '';
    state.dirty = state.tilesDirty = true;
  }

  /* =====================================================================
   * Serial (Web Serial API)
   * ===================================================================== */

  var port = null, reader = null, keepReading = false;

  function showNotice(key, arg) {
    state.notice = key ? { key: key, arg: arg } : null;
    el.notice.textContent = key ? t(key, arg) : '';
    el.notice.hidden = !key;
  }

  function updateButtons() {
    el.btnConnect.textContent = t(state.source === 'serial' ? 'disconnect' : 'connect');
    el.btnDemo.textContent = t(state.source === 'demo' ? 'demoStop' : 'demo');
    el.btnRecord.textContent = t(state.recording ? 'recStop' : 'recStart');
  }

  function setSource(src) {
    state.source = src;
    updateButtons();
    el.btnDemo.disabled = src === 'serial';
    el.baud.disabled = src === 'serial';
    state.dirty = true;
    updateStatus();
  }

  async function connectSerial() {
    showNotice('');
    var p;
    try {
      p = await navigator.serial.requestPort();
    } catch (e) {
      return; // user closed the port picker
    }
    try {
      await p.open({ baudRate: Number(el.baud.value) });
    } catch (e) {
      if (e && (e.name === 'NetworkError' || e.name === 'InvalidStateError')) showNotice('errBusy');
      else showNotice('errOpen', e && e.message ? e.message : String(e));
      return;
    }
    // Pico's USB CDC only starts sending once DTR is asserted.
    try { await p.setSignals({ dataTerminalReady: true }); } catch (e) { /* not fatal */ }

    stopDemo();
    clearData();
    port = p;
    keepReading = true;
    setSource('serial');
    readLoop();
  }

  async function readLoop() {
    var decoder = new TextDecoder();
    var split = createLineSplitter(feedLine);
    var p = port;
    while (p.readable && keepReading) {
      reader = p.readable.getReader();
      try {
        for (;;) {
          var r = await reader.read();
          if (r.done) break;
          split(decoder.decode(r.value, { stream: true }));
        }
      } catch (e) {
        // Recoverable errors (framing, overrun) loop again; a fatal one
        // (cable pulled) leaves p.readable null and ends the loop.
      } finally {
        reader.releaseLock();
        reader = null;
      }
    }
    var lost = keepReading;
    keepReading = false;
    try { await p.close(); } catch (e) { /* already gone */ }
    if (port === p) port = null;
    if (state.source === 'serial') setSource('idle');
    if (lost) showNotice('errLost');
  }

  async function disconnectSerial() {
    keepReading = false;
    if (reader) {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
    }
  }

  /* =====================================================================
   * Demo mode - synthetic lines through the same splitter + parser
   * ===================================================================== */

  var demoTimer = null;

  function startDemo() {
    showNotice('');
    clearData();
    setSource('demo');
    var split = createLineSplitter(feedLine);
    var t0 = performance.now();
    demoTimer = setInterval(function () {
      var t = (performance.now() - t0) / 1000 + 4.2;
      var x = 62 * Math.cos(t * 0.35) + (Math.random() - 0.5) * 1.2;
      var y = 48 * Math.sin(t * 0.55) + (Math.random() - 0.5) * 1.2;
      var a = Math.atan2(x, 150) * 180 / Math.PI + (Math.random() - 0.5) * 0.6;
      var q = x >= 0 ? (y >= 0 ? 1 : 4) : (y >= 0 ? 2 : 3);
      var line = 'Quadrant ' + q + ': ' + x.toFixed(2) + ', ' + y.toFixed(2) + ', ' + a.toFixed(2) + '\r\n';
      var cut = Math.floor(Math.random() * line.length); // arrive in two chunks, like real serial
      split(line.slice(0, cut));
      split(line.slice(cut));
    }, 50);
  }

  function stopDemo() {
    if (demoTimer === null) return;
    clearInterval(demoTimer);
    demoTimer = null;
    if (state.source === 'demo') setSource('idle');
  }

  /* =====================================================================
   * Status, tiles, gauge, table
   * ===================================================================== */

  function currentRate() {
    var S = state.samples, now = performance.now(), n = 0;
    for (var i = S.length - 1; i >= 0 && now - S[i].t <= 1000; i--) n++;
    return n;
  }

  function updateStatus() {
    var hz = state.source === 'idle' ? 0 : currentRate();
    el.rate.textContent = hz + ' Hz';

    var cls = 'dot', text = t('statusIdle');
    if (state.source === 'demo') { cls = 'dot demo'; text = t('statusDemo'); }
    else if (state.source === 'serial') {
      var stale = !state.latest || performance.now() - state.latest.t > 2000;
      cls = stale ? 'dot warn' : 'dot on';
      text = t(stale ? 'statusStale' : 'statusOn');
    }
    el.statusDot.className = cls;
    el.statusText.textContent = text;

    el.lastRaw.textContent = state.lastRaw || '—';
    el.parseErr.textContent = state.parseErrors ? t('parseErr', state.parseErrors) : '';

    el.recCount.textContent = t('rows', state.log.length.toLocaleString('en-US'));
    el.btnCsv.disabled = el.btnClearLog.disabled = state.log.length === 0;

    if (el.tableDetails.open) updateTable();
  }

  function updateTiles() {
    var s = state.latest;
    var values = [el.valX, el.valY, el.valQ, el.valR, el.valA];
    for (var i = 0; i < values.length; i++) {
      values[i].classList.toggle('empty', !s);
      if (!s) values[i].textContent = t('waiting');
    }
    if (!s) {
      el.gNeedle.style.visibility = 'hidden';
      el.gWedge.setAttribute('d', '');
      return;
    }
    el.gNeedle.style.visibility = 'visible';
    el.valX.textContent = fmtLen(s.x);
    el.valY.textContent = fmtLen(s.y);
    el.valQ.textContent = String(s.quadrant);
    el.valR.textContent = fmtLen(Math.hypot(s.x, s.y));
    el.valA.textContent = s.angle.toFixed(2) + '°';

    // Dial: 0° is straight up, positive to the right, clamped to ±90° for drawing.
    var a = Math.max(-90, Math.min(90, s.angle));
    var rad = a * Math.PI / 180, r = 56;
    el.gNeedle.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' 100 105)');
    el.gWedge.setAttribute('d',
      'M100 105 L100 ' + (105 - r) + ' A' + r + ' ' + r + ' 0 0 ' + (a >= 0 ? 1 : 0) + ' ' +
      (100 + r * Math.sin(rad)).toFixed(2) + ' ' + (105 - r * Math.cos(rad)).toFixed(2) + ' Z');
  }

  function clockTime(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function updateTable() {
    var S = state.samples, frag = document.createDocumentFragment();
    for (var i = S.length - 1; i >= 0 && i >= S.length - 20; i--) {
      var s = S[i], tr = document.createElement('tr');
      [clockTime(s.wall) + '.' + String(s.wall % 1000).padStart(3, '0'),
        s.quadrant, fmtLen(s.x), fmtLen(s.y), s.angle.toFixed(2)].forEach(function (v) {
        var td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      frag.appendChild(tr);
    }
    el.tableBody.replaceChildren(frag);
  }

  function updateUnitLabels() {
    var nodes = document.querySelectorAll('[data-unit]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = state.unit ? '(' + state.unit + ')' : '';
    state.dirty = true;
  }

  /* =====================================================================
   * Canvas helpers
   * ===================================================================== */

  function fitCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight;
    var pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function hline(ctx, x1, x2, y) {
    y = Math.round(y) + 0.5;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  }

  function vline(ctx, x, y1, y2) {
    x = Math.round(x) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x, y2); ctx.stroke();
  }

  function dot(ctx, x, y, color) {
    ctx.fillStyle = C.surface;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }

  /* =====================================================================
   * 2D map (top view): LED centre at the origin, robot at (x, y)
   * ===================================================================== */

  function drawRobot(ctx, x, y) {
    var s = 14;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = C.surface; // surface ring so it stays legible over grid lines
    ctx.beginPath(); ctx.roundRect(-s - 6, -s - 3, 2 * s + 12, 2 * s + 6, 8); ctx.fill();
    ctx.fillStyle = C.text2;   // wheels
    ctx.beginPath(); ctx.roundRect(-s - 4, -9, 6, 18, 2); ctx.fill();
    ctx.beginPath(); ctx.roundRect(s - 2, -9, 6, 18, 2); ctx.fill();
    ctx.fillStyle = C.text;    // body
    ctx.beginPath(); ctx.roundRect(-s + 1, -s, 2 * s - 2, 2 * s, 6); ctx.fill();
    ctx.fillStyle = C.surface; // photodiode sensor on top
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.s3;
    ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawMap() {
    var f = fitCanvas(el.map), ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var pad = 36;
    var half = (Math.min(w, h) - pad * 2) / 2;
    if (half < 40) return;
    var cx = w / 2, cy = h / 2;
    // Grid and ticks work in the display unit; sample values (cm) go through f.
    // Factors are powers of 10, so a "nice" cm range stays nice in mm and m.
    var f = unitInfo().f;
    var R = (state.range === null ? DEFAULT_RANGE : state.range) * f;
    var k = half / R;
    var s = state.latest;
    function PX(x) { return cx + x * k; }
    function PY(y) { return cy - y * k; }

    // Quadrant reported by the firmware (standard numbering: Q1 = +x,+y, counter-clockwise).
    var qRect = { 1: [cx, cy - half], 2: [cx - half, cy - half], 3: [cx - half, cy], 4: [cx, cy] };
    if (s && qRect[s.quadrant]) {
      ctx.save();
      ctx.globalAlpha = 0.07;
      ctx.fillStyle = C.text;
      ctx.fillRect(qRect[s.quadrant][0], qRect[s.quadrant][1], half, half);
      ctx.restore();
    }

    // Grid + tick labels
    var step = niceStep(2 * R, 10);
    ctx.lineWidth = 1;
    ctx.font = '11px ' + C.font;
    ctx.fillStyle = C.muted;
    ctx.strokeStyle = C.grid;
    var n = Math.floor(R / step + 1e-9);
    for (var i = -n; i <= n; i++) {
      var v = i * step;
      if (i !== 0) {
        vline(ctx, PX(v), cy - half, cy + half);
        hline(ctx, cx - half, cx + half, PY(v));
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(fmtTick(v, step), PX(v), cy + half + 7);
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtTick(v, step), cx - half - 7, PY(v));
    }
    ctx.strokeRect(Math.round(cx - half) + 0.5, Math.round(cy - half) + 0.5, Math.round(half * 2), Math.round(half * 2));

    // Axes through the origin
    ctx.strokeStyle = C.axis;
    vline(ctx, cx, cy - half, cy + half);
    hline(ctx, cx - half, cx + half, cy);
    ctx.fillStyle = C.text2;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('X', cx + half - 6, cy - 5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Y', cx + 6, cy - half + 6);

    // Quadrant labels in the outer corners
    var qPos = {
      1: [cx + half - 10, cy - half + 10, 'right', 'top'],
      2: [cx - half + 10, cy - half + 10, 'left', 'top'],
      3: [cx - half + 10, cy + half - 10, 'left', 'bottom'],
      4: [cx + half - 10, cy + half - 10, 'right', 'bottom']
    };
    for (var q = 1; q <= 4; q++) {
      var active = s && s.quadrant === q;
      ctx.font = (active ? '600 ' : '') + '13px ' + C.font;
      ctx.fillStyle = active ? C.text : C.muted;
      ctx.textAlign = qPos[q][2]; ctx.textBaseline = qPos[q][3];
      ctx.fillText('Q' + q, qPos[q][0], qPos[q][1]);
    }

    // LED -> robot line
    if (s) {
      ctx.strokeStyle = C.text2;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(PX(s.x * f), PY(s.y * f)); ctx.stroke();
    }

    // LED centre
    ctx.fillStyle = C.surface;
    ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.led;
    ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();
    ctx.font = '600 11px ' + C.font;
    ctx.fillStyle = C.text2;
    var ledRight = !s || s.x < 0, ledUp = !s || s.y < 0; // keep the label off the LED->robot line
    ctx.textAlign = ledRight ? 'left' : 'right';
    ctx.textBaseline = ledUp ? 'bottom' : 'top';
    ctx.fillText('LED', cx + (ledRight ? 10 : -10), cy + (ledUp ? -6 : 6));

    // Robot + coordinate label
    if (s) {
      var rx = PX(s.x * f), ry = PY(s.y * f);
      drawRobot(ctx, rx, ry);
      var label = '(' + fmtLen(s.x) + ', ' + fmtLen(s.y) + ')';
      ctx.font = '600 12px ' + C.font;
      var tw = ctx.measureText(label).width;
      var lx = Math.max(4 + tw / 2, Math.min(w - 4 - tw / 2, rx));
      var above = ry - 30 > 12;
      var ly = above ? ry - 30 : ry + 30;
      ctx.fillStyle = C.surface;
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.roundRect(lx - tw / 2 - 5, ly - 9, tw + 10, 18, 4); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.text;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, lx, ly);
    } else {
      drawHint(ctx, cx, cy + half * 0.5);
    }
  }

  // Next-step guidance shown on the empty map; depends on what the user can do now.
  function hintLines() {
    if (state.source === 'serial') return [t('hintWaitTitle'), t('hintWait1'), t('hintWait2')];
    if (!('serial' in navigator)) return [t('hintTitle'), t('hintNoSerial')];
    return [t('hintTitle'), t('hintStep1'), t('hintStep2'), t('hintDemo')];
  }

  function drawHint(ctx, x, yMid) {
    var lines = hintLines(), lh = 21, i, wMax = 0;
    for (i = 0; i < lines.length; i++) {
      ctx.font = (i === 0 ? '600 14px ' : '13px ') + C.font;
      wMax = Math.max(wMax, ctx.measureText(lines[i]).width);
    }
    var top = yMid - lines.length * lh / 2;
    ctx.fillStyle = C.surface;
    ctx.globalAlpha = 0.92;
    ctx.beginPath(); ctx.roundRect(x - wMax / 2 - 14, top - 8, wMax + 28, lines.length * lh + 16, 8); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (i = 0; i < lines.length; i++) {
      ctx.font = (i === 0 ? '600 14px ' : '13px ') + C.font;
      ctx.fillStyle = i === 0 ? C.text : C.text2;
      ctx.fillText(lines[i], x, top + lh * (i + 0.5));
    }
  }

  function fitScale() {
    var S = state.samples, t0 = chartNow() - WINDOW_MS, m = 0;
    for (var i = lowerBound(S, t0); i < S.length; i++) {
      m = Math.max(m, Math.abs(S[i].x), Math.abs(S[i].y));
    }
    state.range = m > 0 ? niceCeil(m * 1.2) : null;
    state.dirty = true;
  }

  /* =====================================================================
   * Time charts (rolling 30 s window)
   * ===================================================================== */

  function lowerBound(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // While a source is live the window scrolls with the clock; when idle it
  // freezes on the last sample so the history stays readable.
  function chartNow() {
    if (state.source !== 'idle' || !state.latest) return performance.now();
    return state.latest.t;
  }

  // scaled: series are lengths in cm, shown in the selected unit
  function makeChart(cv, tip, series, scaled) {
    var ch = { cv: cv, tip: tip, series: series, scaled: !!scaled, hoverX: null, rows: [], names: [] };
    ch.head = document.createElement('div');
    ch.head.className = 'tip-head';
    tip.appendChild(ch.head);
    series.forEach(function (d) {
      var row = document.createElement('div'); row.className = 'tip-row';
      var key = document.createElement('span'); key.className = 'key'; key.style.setProperty('--k', 'var(--' + d.color + ')');
      var val = document.createElement('span'); val.className = 'tip-val';
      var name = document.createElement('span'); name.className = 'tip-name';
      name.textContent = d.labelKey ? t(d.labelKey) : d.label;
      row.appendChild(key); row.appendChild(val); row.appendChild(name);
      tip.appendChild(row);
      ch.rows.push(val);
      ch.names.push(name);
    });
    cv.addEventListener('pointermove', function (e) {
      ch.hoverX = e.clientX - cv.getBoundingClientRect().left;
      state.dirty = true;
    });
    cv.addEventListener('pointerleave', function () { ch.hoverX = null; state.dirty = true; });
    return ch;
  }

  function drawChart(ch) {
    var f = fitCanvas(ch.cv), ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var L = 48, Rm = 60, T = 12, B = 24, pw = w - L - Rm, ph = h - T - B;
    if (pw < 40 || ph < 40) { ch.tip.hidden = true; return; }

    var S = state.samples, series = ch.series;
    var tNow = chartNow(), t0 = tNow - WINDOW_MS;
    var i0 = lowerBound(S, t0), i, j, v;
    var sf = ch.scaled ? unitInfo().f : 1, dp = ch.scaled ? unitInfo().d : 2;
    function val(sample, d) { return sample[d.key] * sf; }

    // y range over what is visible, snapped to clean numbers
    var lo = Infinity, hi = -Infinity;
    for (i = i0; i < S.length; i++) {
      for (j = 0; j < series.length; j++) {
        v = val(S[i], series[j]);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (lo === Infinity) { lo = -1; hi = 1; }
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    var padY = (hi - lo) * 0.08;
    var step = niceStep(hi - lo + 2 * padY, 4);
    lo = Math.floor((lo - padY) / step) * step;
    hi = Math.ceil((hi + padY) / step) * step;
    function X(t) { return L + (t - t0) / WINDOW_MS * pw; }
    function Y(val) { return T + (hi - val) / (hi - lo) * ph; }

    // grid, y ticks
    ctx.lineWidth = 1;
    ctx.font = '11px ' + C.font;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    var n = Math.round((hi - lo) / step);
    for (i = 0; i <= n; i++) {
      v = lo + i * step;
      ctx.strokeStyle = Math.abs(v) < step * 1e-6 ? C.axis : C.grid;
      hline(ctx, L, L + pw, Y(v));
      ctx.fillStyle = C.muted;
      ctx.fillText(fmtTick(v, step), L - 8, Y(v));
    }
    // x ticks: seconds before the right edge
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var sec = 0; sec <= WINDOW_MS / 1000; sec += 5) {
      ctx.fillText(sec === 0 ? '0s' : '-' + sec + 's', L + pw - sec * 1000 / WINDOW_MS * pw, T + ph + 8);
    }

    // lines
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    for (j = 0; j < series.length; j++) {
      ctx.strokeStyle = C[series[j].color];
      ctx.beginPath();
      var prev = -Infinity;
      for (i = i0; i < S.length; i++) {
        var px = X(S[i].t), py = Y(val(S[i], series[j]));
        if (S[i].t - prev > GAP_MS) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        prev = S[i].t;
      }
      ctx.stroke();
    }

    // end markers + value labels (skipped when two labels would collide)
    if (S.length > i0) {
      var last = S[S.length - 1], ex = X(last.t), ys = [];
      for (j = 0; j < series.length; j++) {
        ys.push(Y(val(last, series[j])));
        dot(ctx, ex, ys[j], C[series[j].color]);
      }
      var collide = false;
      for (j = 1; j < ys.length; j++) if (Math.abs(ys[j] - ys[j - 1]) < 15) collide = true;
      if (!collide) {
        ctx.font = '600 12px ' + C.font;
        ctx.fillStyle = C.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        for (j = 0; j < series.length; j++) {
          ctx.fillText(val(last, series[j]).toFixed(dp), ex + 10, ys[j]);
        }
      }
    }

    // hover: crosshair snaps to the nearest sample, tooltip lists every series
    if (ch.hoverX === null || S.length <= i0 || ch.hoverX < L - 10 || ch.hoverX > L + pw + 10) {
      ch.tip.hidden = true;
      return;
    }
    var th = t0 + (ch.hoverX - L) / pw * WINDOW_MS;
    var hi2 = lowerBound(S, th);
    if (hi2 >= S.length) hi2 = S.length - 1;
    else if (hi2 > i0 && th - S[hi2 - 1].t < S[hi2].t - th) hi2--;
    if (hi2 < i0) hi2 = i0;
    var hs = S[hi2], hx = X(hs.t);
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.muted;
    vline(ctx, hx, T, T + ph);
    for (j = 0; j < series.length; j++) {
      dot(ctx, hx, Y(val(hs, series[j])), C[series[j].color]);
      ch.rows[j].textContent = val(hs, series[j]).toFixed(dp);
    }
    ch.head.textContent = clockTime(hs.wall) + '  (' + ((hs.t - tNow) / 1000).toFixed(1) + ' s)';
    ch.tip.hidden = false;
    var tw = ch.tip.offsetWidth;
    ch.tip.style.left = (hx + 14 + tw > w ? hx - 14 - tw : hx + 14) + 'px';
  }

  /* =====================================================================
   * CSV recording
   * ===================================================================== */

  function toggleRecording() {
    state.recording = !state.recording;
    updateButtons();
    el.btnRecord.classList.toggle('recording', state.recording);
  }

  function downloadCsv() {
    if (!state.log.length) return;
    var blob = new Blob([toCsv(state.log)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ra_log_' + fileStamp(new Date(state.log[0].wall)) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    state.logSaved = true;
  }

  function clearLog() {
    if (!state.logSaved && !window.confirm(t('confirmClear'))) return;
    state.log = [];
    state.logSaved = true;
    updateStatus();
  }

  /* =====================================================================
   * Wiring
   * ===================================================================== */

  var chartXY = makeChart($('chartXY'), $('tipXY'), [
    { key: 'x', color: 's1', label: 'X' },
    { key: 'y', color: 's2', label: 'Y' }
  ], true);
  var chartA = makeChart($('chartA'), $('tipA'), [
    { key: 'angle', color: 's3', labelKey: 'tipAngle' }
  ]);

  /* ---------- language ---------- */
  function applyLang() {
    document.documentElement.lang = state.lang;
    el.lang.value = state.lang;
    var nodes = document.querySelectorAll('[data-i18n]'), i;
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    nodes = document.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < nodes.length; i++) nodes[i].setAttribute('aria-label', t(nodes[i].getAttribute('data-i18n-aria')));
    [chartXY, chartA].forEach(function (ch) {
      ch.series.forEach(function (d, j) { if (d.labelKey) ch.names[j].textContent = t(d.labelKey); });
    });
    updateButtons();
    if (state.notice) showNotice(state.notice.key, state.notice.arg);
    updateStatus();
    state.dirty = state.tilesDirty = true; // canvas text, "waiting" placeholders
  }

  function setLang(lang) {
    state.lang = I18N[lang] ? lang : DEFAULT_LANG;
    try { localStorage.setItem('ra.lang', state.lang); } catch (e) { /* storage unavailable */ }
    applyLang();
  }

  function frame() {
    var live = state.source !== 'idle';
    if (state.dirty || live) {
      if (state.dirty) drawMap();
      drawChart(chartXY);
      drawChart(chartA);
      state.dirty = false;
    }
    if (state.tilesDirty) { updateTiles(); state.tilesDirty = false; }
    requestAnimationFrame(frame);
  }

  el.btnConnect.addEventListener('click', function () {
    if (state.source === 'serial') disconnectSerial(); else connectSerial();
  });
  el.btnDemo.addEventListener('click', function () {
    if (state.source === 'demo') stopDemo(); else startDemo();
  });
  el.btnResetScale.addEventListener('click', fitScale);
  el.btnRecord.addEventListener('click', toggleRecording);
  el.btnCsv.addEventListener('click', downloadCsv);
  el.btnClearLog.addEventListener('click', clearLog);
  el.tableDetails.addEventListener('toggle', updateStatus);

  el.unit.addEventListener('change', function () {
    state.unit = UNITS[el.unit.value] ? el.unit.value : DEFAULT_UNIT;
    try { localStorage.setItem('ra.unit', state.unit); } catch (e) { /* storage unavailable */ }
    updateUnitLabels();
    state.tilesDirty = true;
    updateStatus(); // refreshes the table if it is open
  });
  el.baud.addEventListener('change', function () {
    try { localStorage.setItem('ra.baud', el.baud.value); } catch (e) { /* storage unavailable */ }
  });
  el.lang.addEventListener('change', function () { setLang(el.lang.value); });

  /* ---------- settings menu (baud, language) ---------- */
  function setSettingsOpen(open, returnFocus) {
    el.settingsPanel.hidden = !open;
    el.btnSettings.setAttribute('aria-expanded', String(open));
    if (!open && returnFocus) el.btnSettings.focus();
  }
  el.btnSettings.addEventListener('click', function () { setSettingsOpen(el.settingsPanel.hidden); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.settingsPanel.hidden) setSettingsOpen(false, true);
  });
  // close on a click or focus move outside the menu
  ['pointerdown', 'focusin'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (!el.settingsPanel.hidden && !el.btnSettings.parentNode.contains(e.target)) setSettingsOpen(false);
    });
  });

  try {
    var savedLang = localStorage.getItem('ra.lang');
    if (savedLang && I18N[savedLang]) state.lang = savedLang;
    var savedUnit = localStorage.getItem('ra.unit');
    // older versions stored free text here; only accept a known unit
    if (savedUnit !== null && UNITS[savedUnit]) state.unit = savedUnit;
    var savedBaud = localStorage.getItem('ra.baud');
    for (var oi = 0; oi < el.baud.options.length; oi++) {
      if (el.baud.options[oi].text === savedBaud) el.baud.selectedIndex = oi;
    }
  } catch (e) { /* storage unavailable */ }
  el.unit.value = state.unit;

  window.addEventListener('beforeunload', function (e) {
    if (state.log.length && !state.logSaved) { e.preventDefault(); e.returnValue = ''; }
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { state.dirty = true; });
    ro.observe(el.map); ro.observe(chartXY.cv); ro.observe(chartA.cv);
  }
  window.addEventListener('resize', function () { state.dirty = true; });

  if (!('serial' in navigator)) {
    el.btnConnect.disabled = true;
    showNotice('errUnsupported');
  }

  readColors();
  updateUnitLabels();
  applyLang();
  setInterval(updateStatus, 500);
  requestAnimationFrame(frame);

  // index.html?demo=1 starts the demo immediately (handy for trying the UI without the board)
  if (/[?&]demo=1\b/.test(location.search)) startDemo();
})();
