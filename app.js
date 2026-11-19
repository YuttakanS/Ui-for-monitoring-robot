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

  // Standard numbering: Q1 = +x,+y, then counter-clockwise.
  function quadrantOf(x, y) { return x >= 0 ? (y >= 0 ? 1 : 4) : (y >= 0 ? 2 : 3); }

  function wrapDeg(a) { return ((a + 180) % 360 + 360) % 360 - 180; }

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
      themeField: 'ธีม',
      themeAuto: 'ตามระบบ',
      themeLight: 'สว่าง',
      themeDark: 'มืด',
      settings: 'ตั้งค่า',
      statusIdle: 'ยังไม่เชื่อมต่อ',
      statusDemo: 'Demo (ข้อมูลจำลอง)',
      statusStale: 'เชื่อมต่อแล้ว — ยังไม่มีข้อมูลที่อ่านได้',
      statusOn: 'เชื่อมต่อ Serial แล้ว',
      mapTitle: 'แผนที่ตำแหน่ง (มุมมองบน)',
      trail: 'เส้นทาง (จุด)',
      off: 'ปิด',
      mapAria: 'แผนที่ 2 มิติแสดงตำแหน่งหุ่นยนต์เทียบกับ LED 6 ดวง',
      waiting: 'รอข้อมูล…',
      hintTitle: 'ยังไม่มีข้อมูล',
      hintStep1: '1. ต่อบอร์ดเข้ากับคอมพิวเตอร์ผ่าน USB',
      hintStep2: '2. กด "เชื่อมต่อ Serial" แล้วเลือกพอร์ตของบอร์ด',
      hintDemo: 'หรือกด Demo เพื่อทดลองด้วยข้อมูลจำลอง',
      hintNoSerial: 'เบราว์เซอร์นี้ใช้ Serial ไม่ได้ — กด Demo เพื่อทดลองด้วยข้อมูลจำลอง',
      hintWaitTitle: 'เชื่อมต่อแล้ว — กำลังรอข้อมูล',
      hintWait1: 'ตรวจว่า baud rate ในเมนูตั้งค่าตรงกับที่บอร์ดใช้',
      hintWait2: 'บอร์ดต้องส่งบรรทัดแบบ  Quadrant 1: x, y, มุม',
      distLed: 'ระยะจาก LED 4 (origin)',
      orientation: 'ทิศของหุ่น (Orientation)',
      compassAria: 'เข็มทิศแสดงทิศที่หุ่นหัน',
      headingCW: '0° = หันไป +X · ค่าบวก = หมุนตามเข็มนาฬิกา',
      headingCCW: '0° = หันไป +X · ค่าบวก = หมุนทวนเข็มนาฬิกา',
      lastReading: 'ค่าล่าสุดเมื่อ',
      legRobot: 'หุ่นยนต์',
      ledOff: 'ปิด',
      legTrail: 'เส้นทาง',
      legQuad: 'ควอดรันต์ปัจจุบัน',
      min: 'ต่ำสุด',
      max: 'สูงสุด',
      angle: 'มุมตกกระทบ',
      gaugeAria: 'หน้าปัดมุมตกกระทบ',
      recTitle: 'บันทึกข้อมูล',
      recEvery: 'เก็บทุก (วินาที)',
      recEveryNote: '0 = ทุกบรรทัด',
      recStart: '● เริ่มบันทึก',
      recStop: '■ หยุดบันทึก',
      rows: '{n} แถว',
      csv: 'ดาวน์โหลด CSV',
      clear: 'ล้าง',
      confirmClear: 'ข้อมูลที่บันทึกไว้ {n} แถวยังไม่ได้ดาวน์โหลด ต้องการล้างทิ้งหรือไม่? ลบแล้วกู้คืนไม่ได้',
      confirmClearSaved: 'ล้างข้อมูลที่บันทึกไว้ {n} แถวหรือไม่? (ดาวน์โหลด CSV ไปแล้ว)',
      chartXYTitle: 'ตำแหน่งตามเวลา',
      chartATitle: 'มุมตกกระทบตามเวลา',
      chartXYAria: 'กราฟ X และ Y ตามเวลา',
      chartAAria: 'กราฟมุมตกกระทบตามเวลา',
      chartControls: 'ตัวควบคุมกราฟเวลา',
      range: 'ช่วงเวลา',
      all: 'ทั้งหมด',
      pause: '❚❚ หยุดกราฟชั่วคราว',
      resume: '▶ เล่นกราฟต่อ',
      tipAngle: 'มุมตกกระทบ (°)',
      tableTitle: 'ตารางค่าล่าสุด (20 แถว)',
      thTime: 'เวลา',
      thAngle: 'มุมตกกระทบ (°)',
      lastRaw: 'บรรทัดล่าสุดจาก serial:',
      statRate: 'อัตรา',
      statErr: 'อ่านไม่ได้',
      statLast: 'ข้อมูลล่าสุด',
      justNow: 'เมื่อสักครู่',
      secAgo: '{n} วินาทีก่อน',
      minAgo: '{n} นาทีก่อน',
      errBusy: 'เปิดพอร์ตไม่ได้ — พอร์ตอาจถูกโปรแกรมอื่นใช้อยู่ ให้ปิด Serial Monitor ของ Arduino IDE แล้วลองใหม่',
      errOpen: 'เปิดพอร์ตไม่ได้: {n}',
      errLost: 'การเชื่อมต่อหลุด — สายอาจถูกถอดหรือบอร์ดรีเซ็ต เสียบบอร์ดกลับแล้วกด "เชื่อมต่อใหม่"',
      errLostBack: 'พบบอร์ดเสียบกลับมาแล้ว — กด "เชื่อมต่อใหม่" เพื่ออ่านข้อมูลต่อ',
      reconnect: 'เชื่อมต่อใหม่',
      errUnsupported: 'เบราว์เซอร์นี้ไม่รองรับ Web Serial จึงเชื่อมต่อบอร์ดไม่ได้ — ให้เปิดหน้านี้ด้วย Google Chrome หรือ Microsoft Edge (เวอร์ชัน 89 ขึ้นไป) บนคอมพิวเตอร์ ระหว่างนี้ยังกด Demo ดูข้อมูลจำลองได้',
      errInsecure: 'หน้านี้เปิดผ่านที่อยู่ที่ไม่ปลอดภัย เบราว์เซอร์จึงปิด Web Serial — ให้เปิดไฟล์ index.html โดยตรง หรือเปิดผ่าน http://localhost หรือ https:// แทน',
      connectDisabled: 'ใช้ไม่ได้ในเบราว์เซอร์นี้ — ดูคำแนะนำด้านล่าง'
    },
    en: {
      connect: 'Connect Serial',
      disconnect: 'Disconnect',
      demo: 'Demo',
      demoStop: 'Stop demo',
      unitField: 'Unit',
      langField: 'Language',
      themeField: 'Theme',
      themeAuto: 'System',
      themeLight: 'Light',
      themeDark: 'Dark',
      settings: 'Settings',
      statusIdle: 'Not connected',
      statusDemo: 'Demo (simulated data)',
      statusStale: 'Connected — no readable data yet',
      statusOn: 'Serial connected',
      mapTitle: 'Position map (top view)',
      trail: 'Trail (points)',
      off: 'Off',
      mapAria: '2D map of the robot position relative to the 6 LEDs',
      waiting: 'Waiting for data…',
      hintTitle: 'No data yet',
      hintStep1: '1. Plug the board in over USB',
      hintStep2: '2. Press "Connect Serial" and pick its port',
      hintDemo: 'Or press Demo to try with simulated data',
      hintNoSerial: 'This browser can\'t use Serial — press Demo to try with simulated data',
      hintWaitTitle: 'Connected — waiting for data',
      hintWait1: 'Check that the baud rate in Settings matches the board',
      hintWait2: 'The board must send lines like  Quadrant 1: x, y, angle',
      distLed: 'Distance from LED 4 (origin)',
      orientation: 'Orientation',
      compassAria: 'Compass showing where the robot faces',
      headingCW: '0° = facing +X · positive = clockwise',
      headingCCW: '0° = facing +X · positive = counter-clockwise',
      lastReading: 'Last reading at',
      legRobot: 'Robot',
      ledOff: 'off',
      legTrail: 'Trail',
      legQuad: 'Current quadrant',
      min: 'min',
      max: 'max',
      angle: 'Incidence angle',
      gaugeAria: 'Incidence angle dial',
      recTitle: 'Recording',
      recEvery: 'Keep one row every (s)',
      recEveryNote: '0 = every line',
      recStart: '● Start recording',
      recStop: '■ Stop recording',
      rows: '{n} rows',
      csv: 'Download CSV',
      clear: 'Clear',
      confirmClear: 'The {n} recorded rows have not been downloaded yet. Clear them anyway? This cannot be undone.',
      confirmClearSaved: 'Clear the {n} recorded rows? (The CSV was already downloaded.)',
      chartXYTitle: 'Position over time',
      chartATitle: 'Incidence angle over time',
      chartXYAria: 'Chart of X and Y over time',
      chartAAria: 'Chart of the incidence angle over time',
      chartControls: 'Time chart controls',
      range: 'Range',
      all: 'All',
      pause: '❚❚ Pause charts',
      resume: '▶ Resume charts',
      tipAngle: 'Incidence angle (°)',
      tableTitle: 'Latest values (20 rows)',
      thTime: 'Time',
      thAngle: 'Incidence angle (°)',
      lastRaw: 'Last line from serial:',
      statRate: 'Rate',
      statErr: 'Unreadable',
      statLast: 'Last data',
      justNow: 'just now',
      secAgo: '{n} s ago',
      minAgo: '{n} min ago',
      errBusy: 'Could not open the port — another program may be using it. Close the Arduino IDE Serial Monitor and try again.',
      errOpen: 'Could not open the port: {n}',
      errLost: 'Connection lost — the cable may be unplugged or the board was reset. Plug it back in and press Reconnect.',
      errLostBack: 'The board is plugged back in — press Reconnect to continue.',
      reconnect: 'Reconnect',
      errUnsupported: 'This browser does not support Web Serial, so it can\'t connect to the board — open this page in Google Chrome or Microsoft Edge (version 89 or later) on a computer. Demo still works in the meantime.',
      errInsecure: 'This page was opened from an insecure address, so the browser turns Web Serial off — open index.html directly, or through http://localhost or https:// instead.',
      connectDisabled: 'Not available in this browser — see the message below'
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
      quadrantOf: quadrantOf, wrapDeg: wrapDeg,
      niceStep: niceStep, niceCeil: niceCeil, fmtTick: fmtTick,
      fileStamp: fileStamp, toCsv: toCsv, I18N: I18N, translate: translate, UNITS: UNITS
    };
  }
  if (typeof document === 'undefined') return;

  /* =====================================================================
   * App state
   * ===================================================================== */

  var CHART_RANGES = [10000, 60000, 0]; // time chart window in ms; 0 = whole session
  var MIN_SPAN_MS = 10000; // narrowest x span for "All" while the session is short
  // History kept for the whole session, capped so a long run can't exhaust
  // memory: ~1 h at 20 Hz. Oldest samples go first.
  var MAX_SAMPLES = 72000;
  // Break the line only on a real dropout. Must stay well above 1000 ms: a hidden
  // tab throttles the Demo timer to ~1 sample/s, which must still draw as one line.
  var GAP_MS = 2500;
  // LEDs in firmware coordinates [x, y, label, on]: 2 columns x 3 rows covering
  // Q2 and Q3, with LED 4 at the origin. Change LED_SPACING if the layout changes.
  // on = false draws the LED as switched off; keep it in step with the
  // firmware's LED_ON.
  var LED_SPACING = 50;    // cm between neighbouring LEDs
  var LEDS = [
    [-LED_SPACING, LED_SPACING, '8', true], [0, LED_SPACING, '7', true],
    [-LED_SPACING, 0, '5', false], [0, 0, '4', false], // LED 4, 5 off for now
    [-LED_SPACING, -LED_SPACING, '2', true], [0, -LED_SPACING, '1', true]
  ];
  // the map is centred on the LED area (firmware coordinates), not on the origin
  var VIEW_C = [-LED_SPACING / 2, 0];
  // Orientation = the 3rd value (degrees). The firmware turns the photodiode
  // directions by Omega0 = R(-theta), so on this map (+X right, +Y up) a larger
  // angle turns the robot clockwise, and 0 deg = photodiode 1 facing +X.
  // If the real robot turns the other way, set HEADING_SIGN = 1; if it faces
  // another way at 0 deg, set HEADING_OFFSET (deg, counter-clockwise).
  var HEADING_SIGN = -1;
  var HEADING_OFFSET = 0;
  // firmware angle -> map angle, counter-clockwise from +X
  function mapHeading(deg) { return wrapDeg(HEADING_SIGN * deg + HEADING_OFFSET); }

  // Fixed map half-width (cm): the LED area (100 cm tall) plus a margin. The map
  // never rescales; a robot outside the view is pinned to the edge.
  var MAP_RANGE = LED_SPACING * 1.25;

  var state = {
    source: 'idle',        // idle | serial | demo
    samples: [],
    latest: null,
    unit: DEFAULT_UNIT,    // display unit only (key of UNITS)
    trailN: 100,           // map trail length in samples; 0 = off
    mapHover: null,        // pointer position over the map canvas (CSS px) or null
    stats: null,           // session min/max per field, reset with the data
    chartRange: 60000,     // one of CHART_RANGES
    paused: false,         // time charts frozen at pausedAt (data keeps arriving)
    pausedAt: 0,
    lang: DEFAULT_LANG,
    notice: null,          // { key, arg } so it can be re-rendered on language change
    parseErrors: 0,
    lastRaw: '',
    recording: false,
    recSince: 0,           // performance.now() when the current recording run started
    recElapsed: 0,         // ms recorded in earlier runs (since the last Clear)
    recEvery: 0,           // keep one row every this many seconds; 0 = every line
    recSlot: -1,           // index of the last interval a row was kept for
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
    btnConnect: $('btnConnect'), btnDemo: $('btnDemo'), baud: $('baud'), unit: $('unit'), lang: $('lang'), theme: $('theme'),
    btnSettings: $('btnSettings'), settingsPanel: $('settingsPanel'), trailN: $('trailN'),
    btnPause: $('btnPause'), rangeRadios: document.querySelectorAll('input[name=range]'),
    statusDot: $('statusDot'), statusText: $('statusText'), rate: $('rate'), notice: $('notice'),
    map: $('map'),
    valX: $('valX'), valY: $('valY'), valQ: $('valQ'), valR: $('valR'),
    valH: $('valH'), cNeedle: $('cNeedle'), headingNote: $('headingNote'),
    qMini: $('qMini'), mmX: $('mmX'), mmY: $('mmY'), mmR: $('mmR'), lastTime: $('lastTime'),
    btnRecord: $('btnRecord'), recCount: $('recCount'), recEvery: $('recEvery'), btnCsv: $('btnCsv'), btnClearLog: $('btnClearLog'),
    tableDetails: $('tableDetails'), tableBody: $('tableBody'),
    lastRaw: $('lastRaw'), errCount: $('errCount'), lastAge: $('lastAge'),
    noticeText: $('noticeText'), noticeAction: $('noticeAction'),
    recBadge: $('recBadge'), recTime: $('recTime'), recHeader: $('recHeader'), recHeaderTime: $('recHeaderTime')
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
    addStats(s);

    // trim in chunks of 1000 so the array copy happens rarely
    if (state.samples.length > MAX_SAMPLES + 1000) state.samples.splice(0, state.samples.length - MAX_SAMPLES);


    if (state.recording && keepForLog(s.t)) {
      state.log.push({
        wall: s.wall, t: s.t, quadrant: s.quadrant, x: s.x, y: s.y, angle: s.angle, source: state.source
      });
      state.logSaved = false;
    }
    state.dirty = state.tilesDirty = true;
  }

  function addStats(s) {
    var v = { x: s.x, y: s.y, r: Math.hypot(s.x, s.y), angle: s.angle };
    if (!state.stats) {
      state.stats = {};
      for (var k0 in v) state.stats[k0] = { min: v[k0], max: v[k0] };
      return;
    }
    for (var k in v) {
      if (v[k] < state.stats[k].min) state.stats[k].min = v[k];
      if (v[k] > state.stats[k].max) state.stats[k].max = v[k];
    }
  }

  function clearData() {
    state.samples = [];
    state.latest = null;
    state.stats = null;
    if (state.paused) setPaused(false);
    state.parseErrors = 0;
    state.lastRaw = '';
    state.dirty = state.tilesDirty = true;
  }

  /* =====================================================================
   * Serial (Web Serial API)
   * ===================================================================== */

  // checked by value rather than with `in`, in case a browser keeps the property but leaves it unset
  var HAS_SERIAL = !!navigator.serial;
  var port = null, reader = null, keepReading = false;
  var lastPort = null; // the port used last, so Reconnect can reopen it without the picker

  // action: optional button in the banner ('reconnect')
  function showNotice(key, arg, action) {
    state.notice = key ? { key: key, arg: arg, action: action || null } : null;
    el.noticeText.textContent = key ? t(key, arg) : '';
    el.noticeAction.hidden = !(key && action);
    if (key && action) el.noticeAction.textContent = t(action);
    el.notice.hidden = !key;
  }

  function updateButtons() {
    el.btnConnect.textContent = t(state.source === 'serial' ? 'disconnect' : 'connect');
    el.btnDemo.textContent = t(state.source === 'demo' ? 'demoStop' : 'demo');
    el.btnRecord.textContent = t(state.recording ? 'recStop' : 'recStart');
    el.btnPause.textContent = t(state.paused ? 'resume' : 'pause');
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
    await openPort(p, null);
  }

  // Reopen the last board without the port picker when the browser still has
  // permission for it; fall back to the picker otherwise.
  async function reconnectSerial() {
    var ports = [];
    try { ports = await navigator.serial.getPorts(); } catch (e) { /* treat as none */ }
    var p = null;
    if (lastPort && ports.indexOf(lastPort) >= 0) p = lastPort;
    if (!p && lastPort && lastPort.getInfo) {
      var want = lastPort.getInfo();
      for (var i = 0; i < ports.length && !p; i++) {
        var info = ports[i].getInfo ? ports[i].getInfo() : {};
        if (info.usbVendorId === want.usbVendorId && info.usbProductId === want.usbProductId) p = ports[i];
      }
    }
    if (!p && ports.length === 1) p = ports[0];
    if (!p) { connectSerial(); return; }
    showNotice('');
    await openPort(p, 'reconnect');
  }

  // retryAction: keep a Reconnect button on the error banner when reconnecting
  async function openPort(p, retryAction) {
    try {
      await p.open({ baudRate: Number(el.baud.value) });
    } catch (e) {
      if (e && (e.name === 'NetworkError' || e.name === 'InvalidStateError')) showNotice('errBusy', undefined, retryAction);
      else showNotice('errOpen', e && e.message ? e.message : String(e), retryAction);
      return;
    }
    lastPort = p;
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
    if (lost) showNotice('errLost', undefined, 'reconnect');
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
      // firmware frame: the LED area is x in [-50, 0], y in [-50, 50]
      var x = -25 + 19 * Math.cos(t * 0.35) + (Math.random() - 0.5) * 1.2;
      var y = 40 * Math.sin(t * 0.55) + (Math.random() - 0.5) * 1.2;
      // face the direction of travel (derivative of the path above)
      var mh = Math.atan2(40 * 0.55 * Math.cos(t * 0.55), -19 * 0.35 * Math.sin(t * 0.35)) * 180 / Math.PI;
      var a = wrapDeg((mh - HEADING_OFFSET) * HEADING_SIGN) + (Math.random() - 0.5) * 0.6;
      var q = quadrantOf(x, y);
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

  function ageText(ms) {
    var sec = ms / 1000;
    if (sec < 1) return t('justNow');
    if (sec < 60) return t('secAgo', Math.floor(sec));
    return t('minAgo', Math.floor(sec / 60));
  }

  // only touch the DOM when the text changes (the status text is a live region)
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

  function updateStatus() {
    var hz = state.source === 'idle' ? 0 : currentRate();
    setText(el.rate, hz + ' Hz');

    var stale = !state.latest || performance.now() - state.latest.t > 2000;
    var cls = 'dot', text = t('statusIdle');
    if (state.source === 'demo') { cls = 'dot demo'; text = t('statusDemo'); }
    else if (state.source === 'serial') {
      cls = stale ? 'dot warn' : 'dot on';
      text = t(stale ? 'statusStale' : 'statusOn');
    }
    el.statusDot.className = cls;
    setText(el.statusText, text);

    setText(el.errCount, state.parseErrors.toLocaleString('en-US'));
    el.errCount.classList.toggle('bad', state.parseErrors > 0);
    setText(el.lastAge, state.latest ? ageText(performance.now() - state.latest.t) : '—');
    el.lastAge.classList.toggle('bad', state.source === 'serial' && stale);

    setText(el.lastRaw, state.lastRaw || '—');

    var recTime = fmtDuration(recDuration());
    setText(el.recCount, t('rows', state.log.length.toLocaleString('en-US')) +
      (state.log.length || state.recording ? '  ·  ' + recTime : ''));
    el.recBadge.hidden = el.recHeader.hidden = !state.recording;
    setText(el.recTime, recTime);
    setText(el.recHeaderTime, recTime);
    el.btnCsv.disabled = el.btnClearLog.disabled = state.log.length === 0;

    if (el.tableDetails.open) updateTable();
  }

  function updateTiles() {
    var s = state.latest;
    var values = [el.valX, el.valY, el.valQ, el.valR, el.valH];
    for (var i = 0; i < values.length; i++) {
      values[i].classList.toggle('empty', !s);
      if (!s) values[i].textContent = t('waiting');
    }
    var cells = el.qMini.querySelectorAll('rect');
    for (i = 0; i < cells.length; i++) cells[i].classList.toggle('on', !!s && +cells[i].dataset.q === s.quadrant);
    el.qMini.style.visibility = s ? 'visible' : 'hidden';
    if (!s) {
      el.mmX.textContent = el.mmY.textContent = el.mmR.textContent = '';
      el.lastTime.textContent = '—';
      el.cNeedle.style.visibility = 'hidden';
      return;
    }
    var st = state.stats;
    function mm(lo, hi) { return t('min') + ' ' + lo + '  ·  ' + t('max') + ' ' + hi; }
    el.mmX.textContent = mm(fmtLen(st.x.min), fmtLen(st.x.max));
    el.mmY.textContent = mm(fmtLen(st.y.min), fmtLen(st.y.max));
    el.mmR.textContent = mm(fmtLen(st.r.min), fmtLen(st.r.max));
    el.lastTime.textContent = clockTime(s.wall) + '.' + String(s.wall % 1000).padStart(3, '0');
    el.valX.textContent = fmtLen(s.x);
    el.valY.textContent = fmtLen(s.y);
    el.valQ.textContent = 'Q' + s.quadrant;
    el.valR.textContent = fmtLen(Math.hypot(s.x, s.y));

    // Compass: the value is the firmware's raw angle; the needle points the way
    // the robot faces on the map (SVG rotates clockwise, so negate).
    el.valH.textContent = s.angle.toFixed(2) + '°';
    el.cNeedle.style.visibility = 'visible';
    el.cNeedle.setAttribute('transform', 'rotate(' + (-mapHeading(s.angle)).toFixed(2) + ' 70 70)');
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
        s.quadrant, fmtLen(s.x), fmtLen(s.y)].forEach(function (v) {
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
   * 2D map (top view): 2x2 LED square centred on the origin, robot at (x, y)
   * ===================================================================== */

  // Top view of the triangular pyramid: one photodiode per side face, face
  // normals at 0 and ±120 deg. Photodiode 1's face points along `heading`
  // (map degrees, counter-clockwise from +X) and carries the arrow.
  function drawRobot(ctx, x, y, scale, heading) {
    var r = 17, c60 = 0.5, s60 = Math.sqrt(3) / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.rotate(-heading * Math.PI / 180); // canvas y points down
    function body() {
      ctx.beginPath();
      ctx.moveTo(r * c60, -r * s60); ctx.lineTo(r * c60, r * s60); ctx.lineTo(-r, 0);
      ctx.closePath();
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = C.surface; ctx.lineWidth = 7; body(); ctx.stroke(); // halo over grid lines
    ctx.fillStyle = C.text; body(); ctx.fill();
    // heading arrow from the front face
    ctx.strokeStyle = C.s3; ctx.fillStyle = C.s3; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(r * c60, 0); ctx.lineTo(r + 9, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r + 16, 0); ctx.lineTo(r + 7, -6); ctx.lineTo(r + 7, 6); ctx.closePath(); ctx.fill();
    // photodiodes at the face centres; photodiode 1 (front) highlighted
    for (var p = 0; p < 3; p++) {
      var ang = p * 2 * Math.PI / 3, d = r * c60 * 0.62;
      ctx.fillStyle = p === 0 ? C.s3 : C.surface;
      ctx.beginPath(); ctx.arc(d * Math.cos(ang), -d * Math.sin(ang), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawMap() {
    var f = fitCanvas(el.map), ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var pad = w < 400 ? 28 : 36; // room for tick labels; tighter on phones
    var half = (Math.min(w, h) - pad * 2) / 2;
    if (half < 40) return;
    var cx = w / 2, cy = h / 2;
    // markers shrink on small maps (phones) so they don't cover each other
    var mk = Math.max(0.55, Math.min(1, half / 230));
    // Grid and ticks work in the display unit; sample values (cm) go through f.
    // Factors are powers of 10, so a "nice" cm range stays nice in mm and m.
    var f = unitInfo().f;
    var R = MAP_RANGE * f;
    var k = half / R;
    // Firmware coordinates as on paper: +X right, +Y up (viewed from the Q3/Q4 side).
    var vx = VIEW_C[0] * f, vy = VIEW_C[1] * f; // view centre in the display unit
    var s = state.latest;
    function PX(x) { return cx + (x - vx) * k; }
    function PY(y) { return cy - (y - vy) * k; }
    var L = cx - half, Rt = cx + half, T = cy - half, B = cy + half;
    var x0 = PX(0), y0 = PY(0);
    // origin clamped to the frame, for quadrant areas and axis labels
    var ox = Math.max(L, Math.min(Rt, x0)), oy = Math.max(T, Math.min(B, y0));

    // Quadrant of the latest sample (standard numbering), clipped to the view.
    var qRect = {
      1: [ox, T, Rt - ox, oy - T], 2: [L, T, ox - L, oy - T],
      3: [L, oy, ox - L, B - oy], 4: [ox, oy, Rt - ox, B - oy]
    };
    var qr = s && qRect[s.quadrant];
    if (qr && (qr[2] < 2 || qr[3] < 2)) qr = null; // quadrant out of view
    if (qr) {
      ctx.save();
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = C.text;
      ctx.fillRect(qr[0], qr[1], qr[2], qr[3]);
      ctx.restore();
    }

    // Grid + tick labels
    var step = niceStep(2 * R, 10);
    // keep the LEDs on grid lines while the view is zoomed in on them
    var ledTicks = LED_SPACING * f / step;
    if (R < 4 * LED_SPACING * f && Math.abs(ledTicks - Math.round(ledTicks)) > 1e-6) step /= 2;
    ctx.lineWidth = 1;
    ctx.font = '11px ' + C.font;
    ctx.fillStyle = C.muted;
    ctx.strokeStyle = C.grid;
    var i, v;
    for (i = Math.ceil((vx - R) / step - 1e-9); i <= Math.floor((vx + R) / step + 1e-9); i++) {
      v = i * step;
      if (i !== 0) vline(ctx, PX(v), T, B);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(fmtTick(v, step), PX(v), B + 7);
    }
    for (i = Math.ceil((vy - R) / step - 1e-9); i <= Math.floor((vy + R) / step + 1e-9); i++) {
      v = i * step;
      if (i !== 0) hline(ctx, L, Rt, PY(v));
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmtTick(v, step), L - 7, PY(v));
    }
    ctx.strokeRect(Math.round(L) + 0.5, Math.round(T) + 0.5, Math.round(half * 2), Math.round(half * 2));

    // Axes through the origin (when it is in view)
    ctx.strokeStyle = C.axis;
    if (x0 >= L && x0 <= Rt) vline(ctx, x0, T, B);
    if (y0 >= T && y0 <= B) hline(ctx, L, Rt, y0);
    // direction labels at both ends of each axis
    ctx.fillStyle = C.text2;
    ctx.font = '600 12px ' + C.font;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right'; ctx.fillText('+X', Rt - 6, oy - 5);
    ctx.textAlign = 'left'; ctx.fillText('−X', L + 6, oy - 5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top'; ctx.fillText('+Y', ox + 6, T + 6);
    ctx.textBaseline = 'bottom'; ctx.fillText('−Y', ox + 6, B - 6);
    ctx.font = '11px ' + C.font;

    // Quadrant labels in the outer corners
    // smaller labels tucked further into the corners on small maps, clear of the corner LEDs
    var qi = mk < 0.8 ? 6 : 10, qf = mk < 0.8 ? 11 : 13;
    var qPos = {
      1: [cx + half - qi, cy - half + qi, 'right', 'top'],
      2: [cx - half + qi, cy - half + qi, 'left', 'top'],
      3: [cx - half + qi, cy + half - qi, 'left', 'bottom'],
      4: [cx + half - qi, cy + half - qi, 'right', 'bottom']
    };
    var corner = { 1: [vx + R, vy + R], 2: [vx - R, vy + R], 3: [vx - R, vy - R], 4: [vx + R, vy - R] };
    for (var q = 1; q <= 4; q++) {
      if (quadrantOf(corner[q][0], corner[q][1]) !== q) continue; // corner lies in another quadrant
      var active = s && s.quadrant === q;
      ctx.font = (active ? '600 ' : '') + qf + 'px ' + C.font;
      ctx.textAlign = qPos[q][2]; ctx.textBaseline = qPos[q][3];
      if (active) {
        // active label as a filled pill, so it doesn't rely on weight alone
        var ph = qf + 9, pp = qi < 10 ? 4 : 6;
        var qw = ctx.measureText('Q' + q).width + 2 * pp, qx = qPos[q][2] === 'right' ? qPos[q][0] - qw + pp : qPos[q][0] - pp;
        var qy = qPos[q][3] === 'top' ? qPos[q][1] - 3 : qPos[q][1] - ph + 3;
        ctx.fillStyle = C.text;
        ctx.beginPath(); ctx.roundRect(qx, qy, qw, ph, ph / 2); ctx.fill();
        ctx.fillStyle = C.surface;
      } else ctx.fillStyle = C.muted;
      ctx.fillText('Q' + q, qPos[q][0], qPos[q][1]);
    }

    // active quadrant outline, drawn over the grid
    if (qr) {
      ctx.strokeStyle = C.text2;
      ctx.lineWidth = 2;
      ctx.strokeRect(qr[0] + 1, qr[1] + 1, qr[2] - 2, qr[3] - 2);
      ctx.lineWidth = 1;
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(L, T, half * 2, half * 2); ctx.clip(); // keep marks inside the frame
    if (s) drawTrail(ctx, PX, PY, f);

    var rpx = s ? PX(s.x * f) : 0, rpy = s ? PY(s.y * f) : 0; // robot on screen

    // origin -> robot line (the distance shown in the side panel)
    if (s) {
      ctx.strokeStyle = C.text2;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(rpx, rpy); ctx.stroke();
    }
    ctx.restore();

    // LEDs with their numbers, placed outward from the square's centre
    ctx.font = '600 ' + (mk < 0.8 ? 11 : 12) + 'px ' + C.font;
    for (var li = 0; li < LEDS.length; li++) {
      var ex = PX(LEDS[li][0] * f), ey = PY(LEDS[li][1] * f), on = LEDS[li][3];
      ctx.fillStyle = C.surface;
      ctx.beginPath(); ctx.arc(ex, ey, 9 * mk, 0, Math.PI * 2); ctx.fill();
      if (on) {
        ctx.fillStyle = C.led;
        ctx.beginPath(); ctx.arc(ex, ey, 7 * mk, 0, Math.PI * 2); ctx.fill();
      } else { // switched off: hollow grey ring
        ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ex, ey, 6 * mk, 0, Math.PI * 2); ctx.stroke();
      }
      var dx = LEDS[li][0] < VIEW_C[0] ? -1 : 1, dy = LEDS[li][1] < VIEW_C[1] ? -1 : 1;
      ctx.fillStyle = on ? C.text2 : C.muted;
      ctx.textAlign = dx < 0 ? 'right' : 'left';
      ctx.textBaseline = dy < 0 ? 'top' : 'bottom';
      ctx.fillText('LED ' + LEDS[li][2] + (on ? '' : ' (' + t('ledOff') + ')'), ex + dx * 9 * mk, ey - dy * 9 * mk);
    }

    // Robot + coordinate label
    if (s) {
      // pinned to the frame edge (and faded) when it is outside the fixed view
      var rx = Math.max(L, Math.min(Rt, rpx)), ry = Math.max(T, Math.min(B, rpy));
      var outside = rx !== rpx || ry !== rpy;
      if (outside) ctx.globalAlpha = 0.45;
      drawRobot(ctx, rx, ry, mk, mapHeading(s.angle));
      ctx.globalAlpha = 1;
      var label = '(' + fmtLen(s.x) + ', ' + fmtLen(s.y) + ')';
      ctx.font = '600 12px ' + C.font;
      var tw = ctx.measureText(label).width;
      var lx = Math.max(4 + tw / 2, Math.min(w - 4 - tw / 2, rx));
      var gap = 12 + 18 * mk;
      var above = ry - gap > 12;
      var ly = above ? ry - gap : ry + gap;
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

    drawMapCrosshair(ctx, cx, cy, half, k, w, h, vx, vy);
  }

  // Hover: dashed crosshair and the X, Y (selected unit) under the pointer.
  function drawMapCrosshair(ctx, cx, cy, half, k, w, h, vx, vy) {
    var p = state.mapHover;
    if (!p || Math.abs(p.x - cx) > half || Math.abs(p.y - cy) > half) return;
    var u = unitInfo();
    ctx.save();
    ctx.strokeStyle = C.text2;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    vline(ctx, p.x, cy - half, cy + half);
    hline(ctx, cx - half, cx + half, p.y);
    ctx.setLineDash([]);

    var label = 'X ' + ((p.x - cx) / k + vx).toFixed(u.d) + '   Y ' + ((cy - p.y) / k + vy).toFixed(u.d) +
      (state.unit ? '  ' + state.unit : '');
    ctx.font = '600 12px ' + C.font;
    var tw = ctx.measureText(label).width, bw = tw + 16, bh = 24;
    var bx = p.x + 12 + bw > w - 4 ? p.x - 12 - bw : p.x + 12;
    var by = p.y + 12 + bh > h - 4 ? p.y - 12 - bh : p.y + 12;
    ctx.fillStyle = C.text;
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 5); ctx.fill();
    ctx.fillStyle = C.surface;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 8, by + bh / 2);
    ctx.restore();
  }

  // Last N positions; each segment fades with age (oldest ~transparent).
  // A real dropout (GAP_MS) breaks the trail instead of drawing a jump.
  function drawTrail(ctx, PX, PY, f) {
    var S = state.samples, n = Math.min(state.trailN, S.length);
    if (n < 2) return;
    var i0 = S.length - n;
    ctx.save();
    ctx.strokeStyle = C.text2;
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    for (var i = i0 + 1; i < S.length; i++) {
      if (S[i].t - S[i - 1].t > GAP_MS) continue;
      ctx.globalAlpha = 0.05 + 0.6 * (i - i0) / (n - 1);
      ctx.beginPath();
      ctx.moveTo(PX(S[i - 1].x * f), PY(S[i - 1].y * f));
      ctx.lineTo(PX(S[i].x * f), PY(S[i].y * f));
      ctx.stroke();
    }
    ctx.restore();
  }

  // Next-step guidance shown on the empty map; depends on what the user can do now.
  function hintLines() {
    if (state.source === 'serial') return [t('hintWaitTitle'), t('hintWait1'), t('hintWait2')];
    if (!HAS_SERIAL) return [t('hintTitle'), t('hintNoSerial')];
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

  /* =====================================================================
   * Time charts (10 s / 60 s / whole session, with pause)
   * ===================================================================== */

  function lowerBound(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].t < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Right edge of the charts: frozen while paused; scrolls with the clock
  // while a source is live; when idle it stops at the last sample so the
  // history stays readable.
  function chartWindow() {
    var S = state.samples, tNow;
    if (state.paused) tNow = state.pausedAt;
    else if (state.source !== 'idle' || !state.latest) tNow = performance.now();
    else tNow = state.latest.t;
    var span = state.chartRange || Math.max(MIN_SPAN_MS, S.length ? tNow - S[0].t : 0);
    return { tNow: tNow, t0: tNow - span, span: span };
  }

  // x-axis tick spacing (s): first step that gives at most 7 ticks
  var TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  function tickStep(totalSec) {
    for (var i = 0; i < TICK_STEPS.length; i++) if (totalSec / TICK_STEPS[i] <= 7) return TICK_STEPS[i];
    return TICK_STEPS[TICK_STEPS.length - 1];
  }
  function fmtAgo(sec) {
    if (sec === 0) return '0s';
    return sec >= 60 && sec % 60 === 0 ? '-' + sec / 60 + 'm' : '-' + sec + 's';
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
    var L = 48, Rm = 78, T = 12, B = 24, pw = w - L - Rm, ph = h - T - B;
    if (pw < 40 || ph < 40) { ch.tip.hidden = true; return; }

    var S = state.samples, series = ch.series;
    var win = chartWindow(), tNow = win.tNow, t0 = win.t0, span = win.span;
    // [i0, iEnd): samples inside the window; while paused, newer ones are excluded
    var i0 = lowerBound(S, t0), iEnd = lowerBound(S, tNow + 1e-6), i, j, v;
    var sf = ch.scaled ? unitInfo().f : 1, dp = ch.scaled ? unitInfo().d : 2;
    function val(sample, d) { return sample[d.key] * sf; }

    // y range over what is visible, snapped to clean numbers
    var lo = Infinity, hi = -Infinity;
    for (i = i0; i < iEnd; i++) {
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
    function X(t) { return L + (t - t0) / span * pw; }
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
    var ts = tickStep(span / 1000);
    for (var sec = 0; sec * 1000 <= span + 1; sec += ts) {
      ctx.fillText(fmtAgo(sec), L + pw - sec * 1000 / span * pw, T + ph + 8);
    }

    // lines; with more than ~2 samples per pixel column (long "All" sessions)
    // each column is drawn as its min..max, which looks the same and keeps
    // the path at ~2 points per pixel however long the session is
    var bucket = iEnd - i0 > pw * 2;
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    for (j = 0; j < series.length; j++) {
      ctx.strokeStyle = C[series[j].color];
      ctx.beginPath();
      if (bucket) drawBucketed(ctx, S, i0, iEnd, series[j], X, Y, val);
      else {
        var prev = -Infinity;
        for (i = i0; i < iEnd; i++) {
          var px = X(S[i].t), py = Y(val(S[i], series[j]));
          if (S[i].t - prev > GAP_MS) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          prev = S[i].t;
        }
      }
      ctx.stroke();
    }

    // end markers + value labels (skipped when two labels would collide)
    if (iEnd > i0) {
      var last = S[iEnd - 1], ex = X(last.t), ys = [];
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
          // name + value at the line end, so series are told apart without colour
          ctx.fillText((series[j].label ? series[j].label + ' ' : '') + val(last, series[j]).toFixed(dp) +
            (series[j].suffix || ''), ex + 10, ys[j]);
        }
      }
    }

    // hover: crosshair snaps to the nearest sample, tooltip lists every series
    if (ch.hoverX === null || iEnd <= i0 || ch.hoverX < L - 10 || ch.hoverX > L + pw + 10) {
      ch.tip.hidden = true;
      return;
    }
    var th = t0 + (ch.hoverX - L) / pw * span;
    var hi2 = lowerBound(S, th);
    if (hi2 >= iEnd) hi2 = iEnd - 1;
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

  // One vertical min..max stroke per pixel column, joined column to column.
  function drawBucketed(ctx, S, i0, iEnd, d, X, Y, val) {
    var col = null, mn = 0, mx = 0, lastY = 0, prevT = -Infinity;
    function flush() { if (col !== null) { ctx.lineTo(col, mn); ctx.lineTo(col, mx); ctx.lineTo(col, lastY); } }
    for (var i = i0; i < iEnd; i++) {
      var c = Math.round(X(S[i].t)), y = Y(val(S[i], d));
      if (S[i].t - prevT > GAP_MS) { flush(); ctx.moveTo(c, y); col = c; mn = mx = y; }
      else if (c !== col) { flush(); col = c; mn = mx = y; }
      else { if (y < mn) mn = y; if (y > mx) mx = y; }
      lastY = y;
      prevT = S[i].t;
    }
    flush();
  }

  function setPaused(p) {
    if (p) state.pausedAt = chartWindow().tNow; // read before freezing
    state.paused = p;
    el.btnPause.textContent = t(p ? 'resume' : 'pause');
    el.btnPause.setAttribute('aria-pressed', String(p));
    state.dirty = true;
  }

  /* =====================================================================
   * CSV recording
   * ===================================================================== */

  function toggleRecording() {
    var now = performance.now();
    if (state.recording) state.recElapsed += now - state.recSince;
    else { state.recSince = now; state.recSlot = -1; }
    state.recording = !state.recording;
    el.recEvery.disabled = state.recording; // one interval per run keeps the file consistent
    updateButtons();
    el.btnRecord.classList.toggle('recording', state.recording);
    updateStatus();
  }

  // With an interval set, keep only the first line that arrives in each
  // n-second slot (counted from when this run started). The row is the raw
  // line, not an average, so the CSV stays raw. Slots are fixed, so the
  // spacing does not drift by the 20 Hz line period.
  function keepForLog(t) {
    if (!(state.recEvery > 0)) return true;
    var slot = Math.floor((t - state.recSince) / (state.recEvery * 1000));
    if (slot <= state.recSlot) return false;
    state.recSlot = slot;
    return true;
  }

  // total time spent recording (stopping and starting again adds up)
  function recDuration() {
    return state.recElapsed + (state.recording ? performance.now() - state.recSince : 0);
  }

  function fmtDuration(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s % 60);
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

  // always asks first; the wording warns harder when the rows were never downloaded
  function clearLog() {
    var n = state.log.length.toLocaleString('en-US');
    if (!window.confirm(t(state.logSaved ? 'confirmClearSaved' : 'confirmClear', n))) return;
    state.log = [];
    state.logSaved = true;
    state.recElapsed = 0;
    state.recSince = performance.now();
    updateStatus();
  }

  /* =====================================================================
   * Wiring
   * ===================================================================== */

  var chartXY = makeChart($('chartXY'), $('tipXY'), [
    { key: 'x', color: 's1', label: 'X' },
    { key: 'y', color: 's2', label: 'Y' }
  ], true);
  // The incidence angle is still parsed, kept in samples and exported to CSV,
  // but not shown on screen for now.

  /* ---------- language ---------- */
  function applyLang() {
    document.documentElement.lang = state.lang;
    el.lang.value = state.lang;
    var nodes = document.querySelectorAll('[data-i18n]'), i;
    for (i = 0; i < nodes.length; i++) nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    nodes = document.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < nodes.length; i++) nodes[i].setAttribute('aria-label', t(nodes[i].getAttribute('data-i18n-aria')));
    [chartXY].forEach(function (ch) {
      ch.series.forEach(function (d, j) { if (d.labelKey) ch.names[j].textContent = t(d.labelKey); });
    });
    updateButtons();
    if (state.notice) showNotice(state.notice.key, state.notice.arg, state.notice.action);
    if (!HAS_SERIAL) el.btnConnect.title = t('connectDisabled');
    updateStatus();
    state.dirty = state.tilesDirty = true; // canvas text, "waiting" placeholders
  }

  function setLang(lang) {
    state.lang = I18N[lang] ? lang : DEFAULT_LANG;
    try { localStorage.setItem('ra.lang', state.lang); } catch (e) { /* storage unavailable */ }
    applyLang();
  }

  /* ---------- theme: auto (follow the OS) | light | dark ---------- */
  var THEMES = ['auto', 'light', 'dark'];
  function setTheme(theme, save) {
    if (THEMES.indexOf(theme) < 0) theme = 'auto';
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    el.theme.value = theme;
    if (save) {
      try { localStorage.setItem('ra.theme', theme); } catch (e) { /* storage unavailable */ }
    }
    readColors(); // canvases take their colours from the CSS variables
  }

  function frame() {
    var live = state.source !== 'idle';
    if (state.dirty || live) {
      if (state.dirty) drawMap();
      drawChart(chartXY);
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
  el.noticeAction.addEventListener('click', function () {
    if (state.notice && state.notice.action === 'reconnect') reconnectSerial();
  });
  // a board plugged back in while the "connection lost" banner is up
  if (HAS_SERIAL) {
    navigator.serial.addEventListener('connect', function () {
      if (state.source === 'idle' && state.notice && state.notice.key === 'errLost') showNotice('errLostBack', undefined, 'reconnect');
    });
  }
  el.map.addEventListener('pointermove', function (e) {
    var b = el.map.getBoundingClientRect();
    state.mapHover = { x: e.clientX - b.left, y: e.clientY - b.top };
    state.dirty = true;
  });
  el.map.addEventListener('pointerleave', function () { state.mapHover = null; state.dirty = true; });
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
  el.btnPause.addEventListener('click', function () { setPaused(!state.paused); });
  function setChartRange(ms) {
    state.chartRange = CHART_RANGES.indexOf(ms) >= 0 ? ms : 60000;
    for (var i = 0; i < el.rangeRadios.length; i++) {
      el.rangeRadios[i].checked = (el.rangeRadios[i].value === 'all' ? 0 : +el.rangeRadios[i].value) === state.chartRange;
    }
    state.dirty = true;
  }
  for (var ri = 0; ri < el.rangeRadios.length; ri++) {
    el.rangeRadios[ri].addEventListener('change', function (e) {
      setChartRange(e.target.value === 'all' ? 0 : +e.target.value);
      try { localStorage.setItem('ra.range', String(state.chartRange)); } catch (err) { /* storage unavailable */ }
    });
  }

  el.trailN.addEventListener('change', function () {
    state.trailN = Math.max(0, parseInt(el.trailN.value, 10) || 0);
    try { localStorage.setItem('ra.trail', String(state.trailN)); } catch (e) { /* storage unavailable */ }
    state.dirty = true;
  });
  el.baud.addEventListener('change', function () {
    try { localStorage.setItem('ra.baud', el.baud.value); } catch (e) { /* storage unavailable */ }
  });
  el.recEvery.addEventListener('change', function () {
    var v = parseFloat(el.recEvery.value);
    state.recEvery = isFinite(v) && v > 0 ? v : 0;
    el.recEvery.value = String(state.recEvery);
    try { localStorage.setItem('ra.recEvery', String(state.recEvery)); } catch (e) { /* storage unavailable */ }
  });
  el.lang.addEventListener('change', function () { setLang(el.lang.value); });
  el.theme.addEventListener('change', function () { setTheme(el.theme.value, true); });

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
    var savedRange = localStorage.getItem('ra.range');
    if (savedRange !== null && CHART_RANGES.indexOf(+savedRange) >= 0) state.chartRange = +savedRange;
    var savedTrail = localStorage.getItem('ra.trail');
    for (oi = 0; oi < el.trailN.options.length; oi++) {
      if (el.trailN.options[oi].value === savedTrail) state.trailN = +savedTrail;
    }
    var savedEvery = parseFloat(localStorage.getItem('ra.recEvery'));
    if (isFinite(savedEvery) && savedEvery > 0) state.recEvery = savedEvery;
  } catch (e) { /* storage unavailable */ }
  el.recEvery.value = String(state.recEvery);
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('ra.theme'); } catch (e) { /* storage unavailable */ }
  setTheme(savedTheme, false);
  // the compass note follows the sign convention above
  el.headingNote.setAttribute('data-i18n', HEADING_SIGN < 0 ? 'headingCW' : 'headingCCW');
  el.unit.value = state.unit;
  el.trailN.value = String(state.trailN);
  setChartRange(state.chartRange);

  window.addEventListener('beforeunload', function (e) {
    if (state.log.length && !state.logSaved) { e.preventDefault(); e.returnValue = ''; }
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { state.dirty = true; });
    ro.observe(el.map); ro.observe(chartXY.cv);
  }
  window.addEventListener('resize', function () { state.dirty = true; });

  if (!HAS_SERIAL) {
    el.btnConnect.disabled = true;
    el.btnConnect.setAttribute('aria-describedby', 'noticeText');
    el.btnConnect.title = t('connectDisabled');
    // Chrome/Edge hide Web Serial on insecure pages (e.g. http://192.168...),
    // which needs a different fix than switching browsers.
    showNotice(window.isSecureContext === false ? 'errInsecure' : 'errUnsupported');
  }

  readColors();
  updateUnitLabels();
  applyLang();
  setInterval(updateStatus, 500);
  requestAnimationFrame(frame);

  // index.html?demo=1 starts the demo immediately (handy for trying the UI without the board)
  if (/[?&]demo=1\b/.test(location.search)) startDemo();
})();
