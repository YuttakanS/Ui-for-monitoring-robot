(function () {
  'use strict';

  /* =====================================================================
   * Pure logic (no DOM) - also loadable from Node for testing
   * ===================================================================== */

  // Firmware line format:  Quadrant 3: -33.84, -47.30, -23.71, 0.00
  //                        Quadrant <n>: <x>, <y>, <heading>[, <z>]
  // (cm, cm, degrees, cm; the third value is the robot's heading, kept in the
  // CSV column incidence_angle_deg). z (up) is optional: copy.ino sends it,
  // older firmware (copy2) does not, and then z = 0 (on the floor). hasZ
  // tells the two apart.
  var LINE_RE = /^Quadrant\s*(\d+)\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?:\s*,\s*(-?\d+(?:\.\d+)?))?$/i;

  function parseLine(raw) {
    var m = LINE_RE.exec(String(raw).trim());
    if (!m) return null;
    var hasZ = m[5] !== undefined;
    return { quadrant: +m[1], x: +m[2], y: +m[3], angle: +m[4], z: hasZ ? +m[5] : 0, hasZ: hasZ };
  }

  // The raw RSS line that copy.ino prints in mode 1 / 3 for the calibration
  // page: "0.0000, 0.0000, 0.9100, ..., " (N_LED x N_PD = 27 numbers). This
  // page has no use for it, but it is not a broken line either, so it is
  // skipped without counting a parse error (over WiFi both pages can be open
  // while the board is in mode 3).
  var RSS_RE = /^-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?){26}\s*,?$/;
  function isRssLine(raw) { return RSS_RE.test(String(raw).trim()); }

  // The board's reply to the command "LED <n> <0|1>": "# LED <n> <0|1>".
  // Returns { led, on } or null for any other line.
  var ACK_RE = /^#\s*LED\s+(\d+)\s+([01])\b/i;
  function parseLedAck(raw) {
    var m = ACK_RE.exec(String(raw).trim());
    return m ? { led: +m[1], on: m[2] === '1' } : null;
  }

  // The row the CSV log keeps for a parsed sample: raw values as the board
  // sent them (cm, z not shifted by the page's z zero, which only changes
  // what is shown). s.zRaw is z as sent; s.z may already be shifted.
  function logEntry(s, source) {
    return {
      wall: s.wall, t: s.t, quadrant: s.quadrant, x: s.x, y: s.y, angle: s.angle, source: source,
      z: s.zRaw !== undefined ? s.zRaw : s.z, hasZ: s.hasZ
    };
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
    // z is the last column so the earlier columns keep their place; it is
    // empty when the board did not send z (not 0, so the CSV stays raw)
    var out = ['timestamp_iso,t_ms,quadrant,x,y,incidence_angle_deg,source,z'];
    var t0 = rows.length ? rows[0].t : 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push([
        new Date(r.wall).toISOString(), Math.round(r.t - t0),
        r.quadrant, r.x, r.y, r.angle, r.source, r.hasZ ? r.z : ''
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
      wifiConnect: 'เชื่อมต่อ WiFi',
      wifiDisconnect: 'ตัด WiFi',
      wifiHostField: 'ที่อยู่หุ่น (WiFi)',
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
      statusOnWifi: 'เชื่อมต่อ WiFi แล้ว',
      statusWifiWait: 'กำลังติดต่อหุ่นทาง WiFi…',
      mapTitle: 'แผนที่ตำแหน่ง (มุมมองบน)',
      trail: 'เส้นทาง (จุด)',
      off: 'ปิด',
      mapAria: 'แผนที่ 2 มิติแสดงตำแหน่งหุ่นยนต์เทียบกับ LED 9 ดวง',
      mapTitle3d: 'แผนที่ตำแหน่ง (3 มิติ)',
      cam3d: 'กล้อง',
      camFree: 'อิสระ',
      camThird: 'บุคคลที่ 3 (ตามหลังหุ่น)',
      camFirst: 'บุคคลที่ 1 (จากตัวหุ่น)',
      map3dAria: 'ภาพ 3 มิติของ LED 9 ดวงที่ความสูงจริงและหุ่นยนต์บนพื้น',
      viewLabel: 'มุมมองแผนที่',
      resetView: 'รีเซ็ตมุมมอง',
      no3d: 'เบราว์เซอร์นี้แสดง 3D (WebGL) ไม่ได้',
      waiting: 'รอข้อมูล…',
      hintTitle: 'ยังไม่มีข้อมูล',
      hintStep1: '1. ต่อบอร์ดเข้ากับคอมพิวเตอร์ผ่าน USB',
      hintStep2: '2. กด "เชื่อมต่อ Serial" แล้วเลือกพอร์ตของบอร์ด',
      hintDemo: 'หรือกด Demo เพื่อทดลองด้วยข้อมูลจำลอง',
      hintNoSerial: 'เบราว์เซอร์นี้ใช้ Serial ไม่ได้ — กด Demo เพื่อทดลองด้วยข้อมูลจำลอง',
      hintWifi: 'หรือต่อคอมเข้า WiFi ของหุ่น แล้วกด "เชื่อมต่อ WiFi"',
      hintWaitWifi1: 'ตรวจว่าคอมต่อ WiFi ของหุ่นอยู่ และที่อยู่ในเมนูตั้งค่าถูกต้อง',
      hintWaitTitle: 'เชื่อมต่อแล้ว — กำลังรอข้อมูล',
      hintWait1: 'ตรวจว่า baud rate ในเมนูตั้งค่าตรงกับที่บอร์ดใช้',
      hintWait2: 'บอร์ดต้องส่งบรรทัดแบบ  Quadrant 1: x, y, มุม',
      distLed: 'ระยะจาก LED 4 (origin)',
      zNone: 'บอร์ดยังไม่ส่งค่า z (ถือว่าอยู่บนพื้น)',
      zZero: 'ตั้งศูนย์ z ที่นี่',
      zZeroReset: 'ล้างศูนย์',
      zZeroNote: 'ศูนย์ z: {n} (CSV ยังเป็นค่าดิบ)',
      zBar: 'Z',
      orientation: 'ทิศของหุ่น (Orientation)',
      compassAria: 'เข็มทิศแสดงทิศที่หุ่นหัน',
      headingCW: '0° = หันไป +X · ค่าบวก = หมุนตามเข็มนาฬิกา',
      headingCCW: '0° = หันไป +X · ค่าบวก = หมุนทวนเข็มนาฬิกา',
      lastReading: 'ค่าล่าสุดเมื่อ',
      legRobot: 'หุ่นยนต์',
      ledOff: 'ปิด',
      ledTitle: 'เปิด/ปิด LED',
      ledNoteOffline: 'ยังไม่ได้ต่อบอร์ด — มีผลกับแผนที่เท่านั้น จะส่งให้บอร์ดตอนเชื่อมต่อ',
      ledSynced: 'บอร์ดรับคำสั่งแล้ว',
      ledPending: 'รอบอร์ดยืนยัน… (firmware ต้องรองรับคำสั่ง LED)',
      legTrail: 'เส้นทาง',
      legVec: 'ทิศที่หุ่นหัน',
      vecParts: 'แตกเวกเตอร์',
      vecTitle: 'ทิศที่หุ่นหัน (เวกเตอร์หนึ่งหน่วย)',
      vecNote: 'จากมุมที่บอร์ดส่งมา (Z = 0)',
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
      errWifi: 'ติดต่อหุ่นที่ {n} ไม่ได้ — ตรวจว่าคอมต่อ WiFi ของหุ่น (เช่น RA-Robot) อยู่ และหุ่นเปิดอยู่ กำลังลองใหม่เอง…',
      errWifiClosed: 'หุ่นที่ {n} ไม่ตอบเป็นข้อมูลที่อ่านได้ — ตรวจที่อยู่ในเมนูตั้งค่า แล้วกด "เชื่อมต่อ WiFi" ใหม่',
      errWifiHost: 'ที่อยู่หุ่นไม่ถูกต้อง: {n} (ตัวอย่าง 192.168.42.1)',
      reconnect: 'เชื่อมต่อใหม่',
      errUnsupported: 'เบราว์เซอร์นี้ไม่รองรับ Web Serial จึงเชื่อมต่อบอร์ดไม่ได้ — ให้เปิดหน้านี้ด้วย Google Chrome หรือ Microsoft Edge (เวอร์ชัน 89 ขึ้นไป) บนคอมพิวเตอร์ ระหว่างนี้ยังกด Demo ดูข้อมูลจำลองได้',
      errInsecure: 'หน้านี้เปิดผ่านที่อยู่ที่ไม่ปลอดภัย เบราว์เซอร์จึงปิด Web Serial — ให้เปิดไฟล์ index.html โดยตรง หรือเปิดผ่าน http://localhost หรือ https:// แทน',
      connectDisabled: 'ใช้ไม่ได้ในเบราว์เซอร์นี้ — ดูคำแนะนำด้านล่าง'
    },
    en: {
      connect: 'Connect Serial',
      disconnect: 'Disconnect',
      wifiConnect: 'Connect WiFi',
      wifiDisconnect: 'Disconnect WiFi',
      wifiHostField: 'Robot address (WiFi)',
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
      statusOnWifi: 'WiFi connected',
      statusWifiWait: 'Reaching the robot over WiFi…',
      mapTitle: 'Position map (top view)',
      trail: 'Trail (points)',
      off: 'Off',
      mapAria: '2D map of the robot position relative to the 9 LEDs',
      mapTitle3d: 'Position map (3D)',
      cam3d: 'Camera',
      camFree: 'Free',
      camThird: 'Third person (behind the robot)',
      camFirst: 'First person (from the robot)',
      map3dAria: '3D view of the 9 LEDs at their real height and the robot on the floor',
      viewLabel: 'Map view',
      resetView: 'Reset view',
      no3d: 'This browser cannot show 3D (WebGL)',
      waiting: 'Waiting for data…',
      hintTitle: 'No data yet',
      hintStep1: '1. Plug the board in over USB',
      hintStep2: '2. Press "Connect Serial" and pick its port',
      hintDemo: 'Or press Demo to try with simulated data',
      hintNoSerial: 'This browser can\'t use Serial — press Demo to try with simulated data',
      hintWifi: 'Or join the robot\'s WiFi and press "Connect WiFi"',
      hintWaitWifi1: 'Check that this computer is on the robot\'s WiFi and the address in Settings is right',
      hintWaitTitle: 'Connected — waiting for data',
      hintWait1: 'Check that the baud rate in Settings matches the board',
      hintWait2: 'The board must send lines like  Quadrant 1: x, y, angle',
      distLed: 'Distance from LED 4 (origin)',
      zNone: 'The board sends no z yet (taken as on the floor)',
      zZero: 'Zero z here',
      zZeroReset: 'Clear zero',
      zZeroNote: 'z zero: {n} (the CSV stays raw)',
      zBar: 'Z',
      orientation: 'Orientation',
      compassAria: 'Compass showing where the robot faces',
      headingCW: '0° = facing +X · positive = clockwise',
      headingCCW: '0° = facing +X · positive = counter-clockwise',
      lastReading: 'Last reading at',
      legRobot: 'Robot',
      ledOff: 'off',
      ledTitle: 'LED on/off',
      ledNoteOffline: 'Board not connected — affects the map only; sent to the board on connect',
      ledSynced: 'Board confirmed',
      ledPending: 'Waiting for the board to confirm… (needs firmware with LED commands)',
      legTrail: 'Trail',
      legVec: 'Heading',
      vecParts: 'Split vector',
      vecTitle: 'Heading (unit vector)',
      vecNote: 'From the angle the board sends (Z = 0)',
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
      errWifi: 'Can\'t reach the robot at {n} — check that this computer is on the robot\'s WiFi (e.g. RA-Robot) and the robot is on. Retrying…',
      errWifiClosed: 'The robot at {n} did not answer with readable data — check the address in Settings and press "Connect WiFi" again.',
      errWifiHost: 'Not a valid robot address: {n} (e.g. 192.168.42.1)',
      reconnect: 'Reconnect',
      errUnsupported: 'This browser does not support Web Serial, so it can\'t connect to the board — open this page in Google Chrome or Microsoft Edge (version 89 or later) on a computer. Demo still works in the meantime.',
      errInsecure: 'This page was opened from an insecure address, so the browser turns Web Serial off — open index.html directly, or through http://localhost or https:// instead.',
      connectDisabled: 'Not available in this browser — see the message below'
    }
  };
  var DEFAULT_LANG = 'th';

  // LEDs in firmware coordinates [x, y, label, on]: a 3x3 grid centred on
  // LED 4 at the origin, numbered 8 7 6 / 5 4 3 / 2 1 0 from the top left.
  // Change LED_SPACING if the layout changes.
  // on = false draws the LED as switched off; keep it in step with the
  // firmware's LED_ON (tests/app.test.js checks positions and on/off
  // against copy.ino).
  var LED_SPACING = 50;    // cm between neighbouring LEDs
  var LEDS = [
    [-LED_SPACING, LED_SPACING, '8', true], [0, LED_SPACING, '7', true], [LED_SPACING, LED_SPACING, '6', false],
    [-LED_SPACING, 0, '5', false], [0, 0, '4', false], [LED_SPACING, 0, '3', false], // only LED 1, 2, 7, 8 on for now
    [-LED_SPACING, -LED_SPACING, '2', true], [0, -LED_SPACING, '1', true], [LED_SPACING, -LED_SPACING, '0', false]
  ];

  function translate(lang, key, n) {
    var dict = I18N[lang] || I18N[DEFAULT_LANG];
    var s = dict[key] !== undefined ? dict[key] : I18N[DEFAULT_LANG][key];
    if (s === undefined) return key;
    return n === undefined ? s : s.replace('{n}', function () { return String(n); });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseLine: parseLine, isRssLine: isRssLine, parseLedAck: parseLedAck, logEntry: logEntry, createLineSplitter: createLineSplitter,
      quadrantOf: quadrantOf, wrapDeg: wrapDeg,
      niceStep: niceStep, niceCeil: niceCeil, fmtTick: fmtTick,
      fileStamp: fileStamp, toCsv: toCsv, I18N: I18N, translate: translate, UNITS: UNITS, LEDS: LEDS
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
  // LED on/off as chosen on the page (label -> bool). Starts from the `on`
  // flags above, then the saved choice; sent to the board as "LED <n> <0|1>".
  var ledOn = {};
  var ledFw = {}; // what the board last confirmed ("# LED <n> <0|1>")
  LEDS.forEach(function (L) { ledOn[L[2]] = L[3]; });
  // centre of the map view (firmware coordinates): the middle of the LED grid
  var VIEW_C = [0, 0];
  // Orientation = the 3rd value (degrees). The firmware turns the photodiode
  // directions by Omega0 = R(-theta), so on this map (+X right, +Y up) a larger
  // angle turns the robot clockwise, and 0 deg = photodiode 1 facing +X.
  // If the real robot turns the other way, set HEADING_SIGN = 1; if it faces
  // another way at 0 deg, set HEADING_OFFSET (deg, counter-clockwise).
  var HEADING_SIGN = -1;
  var HEADING_OFFSET = 0;
  // firmware angle -> map angle, counter-clockwise from +X
  function mapHeading(deg) { return wrapDeg(HEADING_SIGN * deg + HEADING_OFFSET); }
  // unit vector of the heading on the map: x = cos(theta), y = sin(theta),
  // theta = map heading (deg, counter-clockwise from +X)
  function headingVec(fwDeg) {
    var d = mapHeading(fwDeg), a = d * Math.PI / 180;
    return { deg: d, x: Math.cos(a), y: Math.sin(a) };
  }
  function fmtVec(v) { var s = v.toFixed(2); return s === '-0.00' ? '0.00' : s; }

  // The arrow drawn on the robot: the way it faces (the firmware's orientation,
  // 3rd value) as a level unit vector (z = 0), whether it moves or not. It
  // used to follow the direction of motion; the user asked for the heading
  // (2026-11-19).
  function dirVec() {
    var s = state.latest;
    if (!s) return null;
    var hv = headingVec(s.angle);
    return { x: hv.x, y: hv.y, z: 0 };
  }
  function setLine(ln, x1, y1, x2, y2) {
    ln.setAttribute('x1', x1.toFixed(1)); ln.setAttribute('y1', y1.toFixed(1));
    ln.setAttribute('x2', x2.toFixed(1)); ln.setAttribute('y2', y2.toFixed(1));
  }

  // Fixed map half-width (cm): the LED area (100 x 100 cm) plus a 25 cm margin
  // for the LED labels. The map never rescales; a robot outside the view is
  // pinned to the edge.
  var MAP_RANGE = LED_SPACING * 1.5;

  var state = {
    source: 'idle',        // idle | serial | demo
    samples: [],
    latest: null,
    unit: DEFAULT_UNIT,    // display unit only (key of UNITS)
    trailN: 100,           // map trail length in samples; 0 = off
    mapView: '2d',         // '2d' | '3d'
    cam3d: 'free',         // 3D camera: 'free' (orbit) | 'third' | 'first' person
    vecParts: true,        // show the heading vector's X / Y / Z parts
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
    zZero: 0,              // cm subtracted from z on screen (not in the CSV); not saved
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
    btnConnect: $('btnConnect'), btnWifi: $('btnWifi'), wifiHost: $('wifiHost'), btnDemo: $('btnDemo'), baud: $('baud'), unit: $('unit'), lang: $('lang'), theme: $('theme'),
    btnSettings: $('btnSettings'), settingsPanel: $('settingsPanel'), trailN: $('trailN'),
    btnPause: $('btnPause'), rangeRadios: document.querySelectorAll('input[name=range]'),
    statusDot: $('statusDot'), statusText: $('statusText'), rate: $('rate'), notice: $('notice'),
    map: $('map'), map2dWrap: $('map2dWrap'), map3d: $('map3d'), btnReset3d: $('btnReset3d'),
    viewRadios: document.querySelectorAll('input[name=mapView]'), legQuad: $('legQuad'),
    btnVecParts: $('btnVecParts'), legVecParts: $('legVecParts'),
    cam3d: $('cam3d'), cam3dField: $('cam3dField'),
    mapTitle: document.querySelector('[data-i18n=mapTitle]'),
    valX: $('valX'), valY: $('valY'), valZ: $('valZ'), mmZ: $('mmZ'),
    zZeroRow: $('zZeroRow'), btnZZero: $('btnZZero'), btnZZeroReset: $('btnZZeroReset'), zZeroNote: $('zZeroNote'), valQ: $('valQ'), valR: $('valR'),
    valH: $('valH'), cNeedle: $('cNeedle'), headingNote: $('headingNote'),
    cComp: $('cComp'), cVx: $('cVx'), cVy: $('cVy'), cDashX: $('cDashX'), cDashY: $('cDashY'), hComp: $('hComp'),
    qMini: $('qMini'), mmX: $('mmX'), mmY: $('mmY'), mmR: $('mmR'), lastTime: $('lastTime'),
    btnRecord: $('btnRecord'), recCount: $('recCount'), recEvery: $('recEvery'), btnCsv: $('btnCsv'), btnClearLog: $('btnClearLog'),
    tableDetails: $('tableDetails'), tableBody: $('tableBody'),
    lastRaw: $('lastRaw'), errCount: $('errCount'), lastAge: $('lastAge'),
    noticeText: $('noticeText'), noticeAction: $('noticeAction'),
    recBadge: $('recBadge'), recTime: $('recTime'), recHeader: $('recHeader'), recHeaderTime: $('recHeaderTime'),
    ledGrid: $('ledGrid'), ledNote: $('ledNote')
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
    // "#" lines are replies from the board, not data (not counted as errors)
    if (line.charAt(0) === '#') {
      var ack = parseLedAck(line);
      if (ack) { ledFw[ack.led] = ack.on; updateLedUI(); }
      return;
    }
    var s = parseLine(line);
    if (!s) { if (!isRssLine(line)) state.parseErrors++; return; }

    s.t = performance.now();
    s.wall = Date.now();
    // z as sent (kept for the CSV); s.z is shown relative to the z zero
    s.zRaw = s.z;
    if (s.hasZ) s.z -= state.zZero;
    state.samples.push(s);
    state.latest = s;
    addStats(s);

    // trim in chunks of 1000 so the array copy happens rarely
    if (state.samples.length > MAX_SAMPLES + 1000) state.samples.splice(0, state.samples.length - MAX_SAMPLES);


    if (state.recording && keepForLog(s.t)) {
      state.log.push(logEntry(s, state.source)); // raw, not shifted by the z zero
      state.logSaved = false;
    }
    state.dirty = state.tilesDirty = true;
  }

  function addStats(s) {
    var v = { x: s.x, y: s.y, z: s.z, r: Math.hypot(s.x, s.y), angle: s.angle };
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

  // reading a real board, over USB serial or WiFi (not idle, not Demo)
  function isLive() { return state.source === 'serial' || state.source === 'wifi'; }

  function updateButtons() {
    el.btnConnect.textContent = t(state.source === 'serial' ? 'disconnect' : 'connect');
    el.btnWifi.textContent = t(state.source === 'wifi' ? 'wifiDisconnect' : 'wifiConnect');
    el.btnDemo.textContent = t(state.source === 'demo' ? 'demoStop' : 'demo');
    el.btnRecord.textContent = t(state.recording ? 'recStop' : 'recStart');
    el.btnPause.textContent = t(state.paused ? 'resume' : 'pause');
  }

  function setSource(src) {
    state.source = src;
    updateButtons();
    el.btnDemo.disabled = src === 'serial' || src === 'wifi';
    el.btnConnect.disabled = !HAS_SERIAL || src === 'wifi';
    el.btnWifi.disabled = src === 'serial';
    el.baud.disabled = src === 'serial';
    el.wifiHost.disabled = src === 'wifi';
    state.dirty = true;
    updateStatus();
    updateLedUI();
  }

  /* ---------- LED on/off: page -> board ---------- */
  // Writes are chained so two quick toggles never fight over the writer lock.
  var sendChain = Promise.resolve();
  function sendSerial(text) {
    if (state.source === 'wifi') { if (wifi) wifi.send(text); return; }
    var p = port;
    if (!p || !p.writable) return;
    sendChain = sendChain.then(async function () {
      var w = p.writable.getWriter();
      try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
    }).catch(function () { /* port gone; the read loop reports it */ });
  }
  function sendLed(label) { sendSerial('LED ' + label + ' ' + (ledOn[label] ? 1 : 0) + '\n'); }
  function sendAllLeds() { LEDS.forEach(function (L) { sendLed(L[2]); }); }

  function buildLedButtons() {
    LEDS.forEach(function (L) { // LEDS order is the grid order: 8 7 / 5 4 / 2 1
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn led-btn';
      b.dataset.led = L[2];
      b.innerHTML = '<span class="led-dot" aria-hidden="true"></span>LED ' + L[2];
      b.addEventListener('click', function () { toggleLed(L[2]); });
      el.ledGrid.appendChild(b);
    });
  }

  function toggleLed(label) {
    ledOn[label] = !ledOn[label];
    try { localStorage.setItem('ra.leds', JSON.stringify(ledOn)); } catch (e) { /* storage unavailable */ }
    sendLed(label);
    updateLedUI();
    state.dirty = true;
  }

  function updateLedUI() {
    var btns = el.ledGrid.querySelectorAll('.led-btn'), synced = true;
    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].dataset.led;
      btns[i].setAttribute('aria-pressed', ledOn[label] ? 'true' : 'false');
      if (ledFw[label] !== ledOn[label]) synced = false;
    }
    el.ledNote.textContent = t(!isLive() ? 'ledNoteOffline' : synced ? 'ledSynced' : 'ledPending');
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
    ledFw = {}; // nothing confirmed by this board yet
    setSource('serial');
    readLoop();
    sendAllLeds(); // bring the board in line with the switches on the page
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
   * WiFi (task #3) - the robot's access point, wifi-link.js
   * ===================================================================== */

  var wifi = null;      // RAWifi.openWifi() handle while state.source === 'wifi'
  var wifiUp = false;   // event stream open (false while connecting / retrying)

  function connectWifi() {
    var host = el.wifiHost.value;
    if (!window.RAWifi || !RAWifi.normalizeHost(host)) { showNotice('errWifiHost', host); return; }
    RAWifi.saveHost(host);
    stopDemo();
    clearData();
    showNotice('');
    ledFw = {};
    wifiUp = false;
    var link = RAWifi.openWifi(host, {
      onLine: feedLine,
      onOpen: function () {
        if (wifi !== link) return;
        wifiUp = true;
        showNotice('');
        ledFw = {};      // the robot may have restarted: confirm the LEDs again
        sendAllLeds();
        updateStatus(); updateLedUI();
      },
      onError: function (kind) {
        if (wifi !== link) return;
        wifiUp = false;
        if (kind === 'closed') { disconnectWifi(); showNotice('errWifiClosed', link.base); }
        else showNotice('errWifi', link.base);
        updateStatus();
      }
    });
    wifi = link;
    setSource('wifi');
  }

  function disconnectWifi() {
    if (wifi) wifi.close();
    wifi = null;
    wifiUp = false;
    if (state.source === 'wifi') setSource('idle');
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
      // firmware frame: the LED area is x and y in [-50, 50]
      var x = 40 * Math.cos(t * 0.35) + (Math.random() - 0.5) * 1.2;
      var y = 40 * Math.sin(t * 0.55) + (Math.random() - 0.5) * 1.2;
      var z = 15 - 15 * Math.cos(t * 0.4) + Math.random() * 0.4; // 0..30 cm, up and down
      // face the direction of travel (derivative of the path above)
      var mh = Math.atan2(40 * 0.55 * Math.cos(t * 0.55), -40 * 0.35 * Math.sin(t * 0.35)) * 180 / Math.PI;
      var a = wrapDeg((mh - HEADING_OFFSET) * HEADING_SIGN) + (Math.random() - 0.5) * 0.6;
      var q = quadrantOf(x, y);
      var line = 'Quadrant ' + q + ': ' + x.toFixed(2) + ', ' + y.toFixed(2) + ', ' + a.toFixed(2) + ', ' + z.toFixed(2) + '\r\n';
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
    } else if (state.source === 'wifi') {
      cls = wifiUp && !stale ? 'dot on' : 'dot warn';
      text = t(!wifiUp ? 'statusWifiWait' : stale ? 'statusStale' : 'statusOnWifi');
    }
    el.statusDot.className = cls;
    setText(el.statusText, text);

    setText(el.errCount, state.parseErrors.toLocaleString('en-US'));
    el.errCount.classList.toggle('bad', state.parseErrors > 0);
    setText(el.lastAge, state.latest ? ageText(performance.now() - state.latest.t) : '—');
    el.lastAge.classList.toggle('bad', isLive() && stale);

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
    var values = [el.valX, el.valY, el.valZ, el.valQ, el.valR, el.valH];
    for (var i = 0; i < values.length; i++) {
      values[i].classList.toggle('empty', !s);
      if (!s) values[i].textContent = t('waiting');
    }
    var cells = el.qMini.querySelectorAll('rect');
    for (i = 0; i < cells.length; i++) cells[i].classList.toggle('on', !!s && +cells[i].dataset.q === s.quadrant);
    el.qMini.style.visibility = s ? 'visible' : 'hidden';
    if (!s) {
      el.mmX.textContent = el.mmY.textContent = el.mmZ.textContent = el.mmR.textContent = '';
      el.lastTime.textContent = '—';
      el.cNeedle.style.visibility = 'hidden';
      el.cComp.style.visibility = 'hidden';
      el.hComp.textContent = '';
      return;
    }
    var st = state.stats;
    function mm(lo, hi) { return t('min') + ' ' + lo + '  ·  ' + t('max') + ' ' + hi; }
    el.mmX.textContent = mm(fmtLen(st.x.min), fmtLen(st.x.max));
    el.mmY.textContent = mm(fmtLen(st.y.min), fmtLen(st.y.max));
    el.mmR.textContent = mm(fmtLen(st.r.min), fmtLen(st.r.max));
    el.mmZ.textContent = s.hasZ ? mm(fmtLen(st.z.min), fmtLen(st.z.max)) : t('zNone');
    el.zZeroRow.hidden = !s.hasZ;
    el.btnZZeroReset.hidden = state.zZero === 0;
    el.zZeroNote.textContent = state.zZero === 0 ? '' : t('zZeroNote', fmtLen(state.zZero) + (state.unit ? ' ' + state.unit : ''));
    el.lastTime.textContent = clockTime(s.wall) + '.' + String(s.wall % 1000).padStart(3, '0');
    el.valX.textContent = fmtLen(s.x);
    el.valY.textContent = fmtLen(s.y);
    el.valZ.textContent = fmtLen(s.z);
    el.valQ.textContent = 'Q' + s.quadrant;
    el.valR.textContent = fmtLen(Math.hypot(s.x, s.y));

    // Compass: the value is the firmware's raw angle; the needle points the way
    // the robot faces on the map (SVG rotates clockwise, so negate).
    el.valH.textContent = s.angle.toFixed(2) + '°';
    el.cNeedle.style.visibility = 'visible';
    el.cNeedle.setAttribute('transform', 'rotate(' + (-mapHeading(s.angle)).toFixed(2) + ' 70 70)');
    // X / Y parts of the heading vector (seen from above) and
    // its X / Y / Z values; hidden when "Split vector" is off
    var mv = dirVec(), R = 42, tx = 70 + R * mv.x, ty = 70 - R * mv.y;
    setLine(el.cVx, 70, 70, tx, 70);
    setLine(el.cVy, 70, 70, 70, ty);
    setLine(el.cDashX, tx, 70, tx, ty);
    setLine(el.cDashY, 70, ty, tx, ty);
    el.cComp.style.visibility = state.vecParts ? 'visible' : 'hidden';
    el.hComp.hidden = !state.vecParts;
    el.hComp.innerHTML = '<b>' + t('vecTitle') + '</b><br>' +
      '<span class="vp"><span class="key" style="--k:var(--s1)"></span>X = ' + fmtVec(mv.x) + '</span>' +
      '<span class="vp"><span class="key" style="--k:var(--s2)"></span>Y = ' + fmtVec(mv.y) + '</span>' +
      '<span class="vp"><span class="key" style="--k:var(--s3)"></span>Z = ' + fmtVec(mv.z) + '</span><br>' +
      t('vecNote');
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
        s.quadrant, fmtLen(s.x), fmtLen(s.y), s.hasZ ? fmtLen(s.z) : '—'].forEach(function (v) {
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
   * 2D map (top view): 3x3 LED grid centred on LED 4 (the origin), robot at (x, y)
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
    // the direction arrow is drawn separately, with its parts (drawHeadingVec)
    // photodiodes at the face centres; photodiode 1 (front) highlighted
    for (var p = 0; p < 3; p++) {
      var ang = p * 2 * Math.PI / 3, d = r * c60 * 0.62;
      ctx.fillStyle = p === 0 ? C.s3 : C.surface;
      ctx.beginPath(); ctx.arc(d * Math.cos(ang), -d * Math.sin(ang), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // Heading vector from the robot's centre (main colour). Seen from above
  // only its X / Y projection can be drawn; with "Split vector" on, the X part
  // (blue, along +X) and Y part (orange, along +Y) are drawn with dashed lines
  // closing the rectangle, and Z is written next to the robot (up / down arrow).
  function drawHeadingVec(ctx, x, y, mk, v, parts) {
    var L = 64 * mk, ex = x + L * v.x, ey = y - L * v.y;
    function arrow(x0, y0, x1, y1, col, wdt) {
      var dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
      if (len < 3) return;
      var ux = dx / len, uy = dy / len, hl = Math.min(9, len * 0.6) * (wdt / 3 + 0.4);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = wdt; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hl * 0.8, y1 - uy * hl * 0.8); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * hl - uy * hl * 0.5, y1 - uy * hl + ux * hl * 0.5);
      ctx.lineTo(x1 - ux * hl + uy * hl * 0.5, y1 - uy * hl - ux * hl * 0.5);
      ctx.closePath(); ctx.fill();
    }
    ctx.save();
    ctx.font = '600 11px ' + C.font;
    function tag(text, tx, ty, col, align, base) {
      ctx.textAlign = align; ctx.textBaseline = base;
      var tw = ctx.measureText(text).width, bx = align === 'left' ? tx : align === 'right' ? tx - tw : tx - tw / 2;
      var by = base === 'top' ? ty : base === 'bottom' ? ty - 13 : ty - 6.5;
      ctx.fillStyle = C.surface; ctx.globalAlpha *= 0.85;
      ctx.fillRect(bx - 3, by - 1, tw + 6, 15);
      ctx.globalAlpha /= 0.85;
      ctx.fillStyle = col; ctx.fillText(text, tx, ty);
    }
    if (parts) {
      ctx.setLineDash([4, 4]); ctx.strokeStyle = C.muted; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(ex, y); ctx.lineTo(ex, ey); ctx.moveTo(x, ey); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.setLineDash([]);
      arrow(x, y, ex, y, C.s1, 2.5);
      arrow(x, y, x, ey, C.s2, 2.5);
    }
    arrow(x, y, ex, ey, C.text, 3);
    if (parts) {
      tag('X ' + fmtVec(v.x), ex, y + (v.y >= 0 ? 5 : -5), C.s1, 'center', v.y >= 0 ? 'top' : 'bottom');
      tag('Y ' + fmtVec(v.y), x + (v.x >= 0 ? -6 : 6), ey, C.s2, v.x >= 0 ? 'right' : 'left', 'middle');
      // Z: beside the robot, on the side away from the vector (the coordinate
      // label sits above or below, so this stays clear of both)
      var zt = 'Z ' + fmtVec(v.z) + (v.z > 0.005 ? ' \u2191' : v.z < -0.005 ? ' \u2193' : '');
      tag(zt, x + (v.x >= 0 ? -22 : 22) * mk, y, C.s3, v.x >= 0 ? 'right' : 'left', 'middle');
    }
    ctx.restore();
  }

  function drawMap() {
    var f = fitCanvas(el.map), ctx = f.ctx, w = f.w, h = f.h;
    ctx.clearRect(0, 0, w, h);
    var pad = w < 400 ? 28 : 36; // room for tick labels; tighter on phones
    var s = state.latest;
    // height bar on the right while the board sends z; the map moves left for it
    var barW = s && s.hasZ ? (w < 400 ? 40 : 52) : 0;
    var half = (Math.min(w - barW, h) - pad * 2) / 2;
    if (half < 40) return;
    var cx = (w - barW) / 2, cy = h / 2;
    // markers shrink on small maps (phones) so they don't cover each other
    var mk = Math.max(0.55, Math.min(1, half / 230));
    // Grid and ticks work in the display unit; sample values (cm) go through f.
    // Factors are powers of 10, so a "nice" cm range stays nice in mm and m.
    var f = unitInfo().f;
    var R = MAP_RANGE * f;
    var k = half / R;
    // Firmware coordinates as on paper: +X right, +Y up (viewed from the Q3/Q4 side).
    var vx = VIEW_C[0] * f, vy = VIEW_C[1] * f; // view centre in the display unit
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
    // phones: tick labels would run together, so step by half the LED spacing
    if (w < 400 && R / step > 5) step = LED_SPACING * f / 2;
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

    // LEDs with their numbers: corner LEDs label outward from the grid's centre;
    // LEDs on the middle row or column get a centred label (above on the middle
    // row) so it stays clear of the axis-end labels at the frame edge.
    ctx.font = '600 ' + (mk < 0.8 ? 11 : 12) + 'px ' + C.font;
    for (var li = 0; li < LEDS.length; li++) {
      var ex = PX(LEDS[li][0] * f), ey = PY(LEDS[li][1] * f), on = ledOn[LEDS[li][2]];
      ctx.fillStyle = C.surface;
      ctx.beginPath(); ctx.arc(ex, ey, 9 * mk, 0, Math.PI * 2); ctx.fill();
      if (on) {
        ctx.fillStyle = C.led;
        ctx.beginPath(); ctx.arc(ex, ey, 7 * mk, 0, Math.PI * 2); ctx.fill();
      } else { // switched off: hollow grey ring
        ctx.strokeStyle = C.muted; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(ex, ey, 6 * mk, 0, Math.PI * 2); ctx.stroke();
      }
      var dx = Math.sign(LEDS[li][0] - VIEW_C[0]), dy = LEDS[li][1] < VIEW_C[1] ? -1 : 1;
      if (LEDS[li][1] === VIEW_C[1]) dx = 0;
      ctx.fillStyle = on ? C.text2 : C.muted;
      ctx.textAlign = dx < 0 ? 'right' : dx > 0 ? 'left' : 'center';
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
      var hv = dirVec();
      drawHeadingVec(ctx, rx, ry, mk, hv, state.vecParts);
      ctx.globalAlpha = 1;
      var label = '(' + fmtLen(s.x) + ', ' + fmtLen(s.y) + ')';
      ctx.font = '600 12px ' + C.font;
      var tw = ctx.measureText(label).width;
      var lx = Math.max(4 + tw / 2, Math.min(w - 4 - tw / 2, rx));
      var gap = 12 + 18 * mk;
      // on the side away from the heading vector so it doesn't cover it
      var above = hv.y < 0 ? ry - gap > 12 : ry + gap > h - 12;
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

    if (barW) drawZBar(ctx, Rt + 14, T, B, s.z, f);
    drawMapCrosshair(ctx, cx, cy, half, k, w, h, vx, vy);
  }

  // Height bar: fixed scale from Z_BAR[0] to Z_BAR[1] cm (the firmware's
  // Z_MIN / Z_MAX), filled from 0 to the z shown (after the z zero).
  var Z_BAR = [0, 80];
  function drawZBar(ctx, x, T, B, z, f) {
    var lo = Z_BAR[0], hi = Z_BAR[1];
    function PZ(v) { return B - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (B - T); }
    var tw = 10, tx = x; // track
    ctx.save();
    ctx.fillStyle = C.grid;
    ctx.beginPath(); ctx.roundRect(tx, T, tw, B - T, 3); ctx.fill();
    // ticks every 20 cm, labelled in the display unit
    ctx.font = '11px ' + C.font;
    ctx.fillStyle = C.muted;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (var v = 0; v <= hi; v += 20) {
      ctx.fillRect(tx + tw, Math.round(PZ(v)), 4, 1);
      ctx.fillText(fmtTick(v * f, 20 * f), tx + tw + 6, PZ(v));
    }
    // fill from 0 to z
    var y0 = PZ(0), yz = PZ(z);
    ctx.fillStyle = C.s3;
    ctx.fillRect(tx, Math.min(y0, yz), tw, Math.max(2, Math.abs(yz - y0)));
    // marker, with a notch when z is past the end of the scale
    ctx.fillStyle = C.text;
    ctx.fillRect(tx - 3, Math.round(yz) - 1, tw + 6, 2);
    if (z > hi || z < lo) {
      var dir = z > hi ? -1 : 1;
      ctx.beginPath(); ctx.moveTo(tx + tw / 2, yz + dir * 8); ctx.lineTo(tx - 1, yz + dir * 2); ctx.lineTo(tx + tw + 1, yz + dir * 2); ctx.fill();
    }
    ctx.font = '600 12px ' + C.font;
    ctx.fillStyle = C.text2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(t('zBar'), tx + tw / 2, T - 6);
    ctx.restore();
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
    if (state.source === 'wifi') return [t('hintWaitTitle'), t('hintWaitWifi1'), t('hintWait2')];
    if (!HAS_SERIAL) return [t('hintTitle'), t('hintNoSerial'), t('hintWifi')];
    return [t('hintTitle'), t('hintStep1'), t('hintStep2'), t('hintWifi'), t('hintDemo')];
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

  /* ---------- z zero ---------- */
  // Show z relative to where the robot stands now: the mean raw z of the last
  // second becomes 0. Only the screen changes; the CSV keeps the raw z.
  function zeroZ() {
    var S = state.samples, n = 0, sum = 0;
    if (!S.length) return;
    var tEnd = S[S.length - 1].t;
    for (var i = S.length - 1; i >= 0 && S[i].t >= tEnd - 1000; i--) {
      if (!S[i].hasZ) continue;
      sum += S[i].zRaw; n++;
    }
    if (n) setZZero(sum / n);
  }
  function setZZero(v) {
    var d = v - state.zZero;
    if (!d) return;
    state.samples.forEach(function (s) { if (s.hasZ) s.z -= d; });
    if (state.stats) { state.stats.z.min -= d; state.stats.z.max -= d; }
    state.zZero = v;
    state.dirty = state.tilesDirty = true;
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
    { key: 'y', color: 's2', label: 'Y' },
    { key: 'z', color: 's3', label: 'Z' }
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
    updateLedUI();
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

  /* =====================================================================
   * 3D view (three.js): the LED grid at its real height, the robot on the
   * floor. Firmware coordinates in cm with +Z up. Built on first use.
   * ===================================================================== */

  // Heights from the floor (z = 0), in cm. Photodiodes are 1 cm above the floor
  // and the LEDs 92 cm above the photodiodes (firmware p(k, 2) = 0.920 m).
  // The models come from Maya (models/build_models.py -> models/models.js).
  var MODELS = window.RA_MODELS || null;
  var PD_HEIGHT = MODELS ? MODELS.meta.pdHeight : 1;
  var LED_HEIGHT = MODELS ? MODELS.meta.ledZ : PD_HEIGHT + 92;
  // fallback robot when the models are missing (drawn size only)
  var ROBOT_R = MODELS ? 2 * MODELS.meta.robotInradius : 10.4;
  var ROBOT_H = MODELS ? MODELS.meta.robotHeight : 3;
  var TRAIL_MAX = 1000;    // largest trail option
  var HAS_3D = (function () {
    if (!window.THREE || !THREE.OrbitControls) return false;
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  })();
  var v3 = null;

  function init3d() {
    var T = THREE;
    var renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.map3d.appendChild(renderer.domElement);
    var scene = new T.Scene();
    var camera = new T.PerspectiveCamera(40, 1, 1, 5000);
    camera.up.set(0, 0, 1); // +Z up, like the real room
    var controls = new T.OrbitControls(camera, renderer.domElement);
    controls.maxPolarAngle = Math.PI * 0.495; // stay above the floor
    controls.minDistance = 60;
    controls.maxDistance = 900;
    scene.add(new T.AmbientLight(0xffffff, 0.7));
    var sun = new T.DirectionalLight(0xffffff, 0.6);
    sun.position.set(-80, -120, 200);
    scene.add(sun);

    // grid, axes and LEDs; rebuilt when colours, unit, language or LEDs change
    var statics = new T.Group();
    scene.add(statics);

    // robot: triangular pyramid, one face per photodiode. Face normals at 0
    // and +-120 deg (local); photodiode 1's face looks along local +X (= heading).
    var robot = new T.Group();
    var base = [60, 180, 300].map(function (d) {
      var a = d * Math.PI / 180;
      return [ROBOT_R * Math.cos(a), ROBOT_R * Math.sin(a), 0];
    });
    var apex = [0, 0, ROBOT_H], tri = [], i;
    for (i = 0; i < 3; i++) tri.push(base[i], base[(i + 1) % 3], apex); // sides
    tri.push(base[0], base[2], base[1]);                                // bottom
    var flat = [];
    tri.forEach(function (p) { flat.push(p[0], p[1], p[2]); });
    var g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(flat, 3));
    g.computeVertexNormals();
    var body = new T.Mesh(g, new T.MeshLambertMaterial({ flatShading: true }));
    body.material.name = 'ra_body';
    var parts = loadModels3d();
    robot.add(parts && parts.robot ? parts.robot : body);
    robot.visible = false;
    scene.add(robot);

    var tg = new T.BufferGeometry();
    tg.setAttribute('position', new T.BufferAttribute(new Float32Array(TRAIL_MAX * 3), 3));
    var trail = new T.Line(tg, new T.LineBasicMaterial({ transparent: true, opacity: 0.8 }));
    trail.frustumCulled = false;
    scene.add(trail);

    // origin -> robot line on the floor (the distance shown in the side panel)
    var rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.BufferAttribute(new Float32Array(6), 3));
    var toOrigin = new T.Line(rg, new T.LineBasicMaterial());
    toOrigin.frustumCulled = false;
    scene.add(toOrigin);

    // when the robot is off the floor: dashed line straight down and its spot on the floor
    var dg = new T.BufferGeometry();
    dg.setAttribute('position', new T.BufferAttribute(new Float32Array(6), 3));
    var drop = new T.Line(dg, new T.LineDashedMaterial({ dashSize: 2, gapSize: 2 }));
    drop.frustumCulled = false;
    drop.visible = false;
    scene.add(drop);
    var shadow = new T.Mesh(new T.CircleGeometry(ROBOT_R * 0.8, 24),
      new T.MeshBasicMaterial({ transparent: true, opacity: 0.18, depthWrite: false }));
    shadow.visible = false;
    scene.add(shadow);

    v3 = { renderer: renderer, scene: scene, camera: camera, controls: controls, statics: statics, drop: drop, shadow: shadow,
      robot: robot, trail: trail, toOrigin: toOrigin, labels: [], parts: parts, vec: null,
      sig: '', w: 0, h: 0, needs: true };
    controls.addEventListener('change', function () { v3.needs = true; });
    v3.vec = makeVec3d(); // heading vector; drawn level, not turned with the robot
    reset3dView();
    apply3dCam();
  }

  /* ---------- 3D camera that follows the robot ---------- */
  // third: behind and above the robot, looking past it the way it faces.
  // first: at the robot, looking the way it faces, tilted up towards the LEDs.
  // Lengths in cm (scene units), angles in degrees.
  var CAM3D = {
    free: { fov: 40 },
    third: { fov: 40, back: 95, up: 60, ahead: 30 },
    first: { fov: 75, eye: ROBOT_H + 2, pitch: 14 }
  };
  var CAM_EASE = 0.15; // share of the remaining way the camera moves per frame

  // Apply state.cam3d to the camera and controls (when the 3D view exists).
  function apply3dCam() {
    if (!v3) return;
    var free = state.cam3d === 'free';
    v3.controls.enabled = free;
    v3.follow = null; // start from the robot's pose, not from the last follow
    v3.camera.fov = CAM3D[state.cam3d].fov;
    v3.camera.updateProjectionMatrix();
    if (v3.h) size3dLabels(); // label size depends on the field of view
    if (free) reset3dView();
    v3.needs = true;
  }

  function setCam3d(mode, save) {
    state.cam3d = CAM3D[mode] ? mode : 'free';
    el.cam3d.value = state.cam3d;
    el.btnReset3d.hidden = state.mapView !== '3d' || state.cam3d !== 'free';
    apply3dCam();
    if (save) {
      try { localStorage.setItem('ra.cam3d', state.cam3d); } catch (e) { /* storage unavailable */ }
    }
  }

  // Move the camera with the robot. Position and heading are eased, so the
  // view glides between samples instead of jumping with every line from the
  // board. Returns true while the camera has not caught up yet.
  function follow3d(s) {
    var mode = state.cam3d;
    if (mode === 'free' || !s) return false;
    var yaw = mapHeading(s.angle) * Math.PI / 180, f = v3.follow;
    if (!f) f = v3.follow = { x: s.x, y: s.y, z: s.z, yaw: yaw };
    var dyaw = Math.atan2(Math.sin(yaw - f.yaw), Math.cos(yaw - f.yaw)); // shortest way round
    f.x += (s.x - f.x) * CAM_EASE;
    f.y += (s.y - f.y) * CAM_EASE;
    f.z += (s.z - f.z) * CAM_EASE;
    f.yaw += dyaw * CAM_EASE;
    var hx = Math.cos(f.yaw), hy = Math.sin(f.yaw), cam = v3.camera, c = CAM3D[mode];
    if (mode === 'first') {
      // the robot and its heading vector would fill the view from inside
      v3.robot.visible = v3.vec.group.visible = false;
      var ez = f.z + c.eye;
      cam.position.set(f.x, f.y, ez);
      cam.lookAt(f.x + hx * 100, f.y + hy * 100, ez + 100 * Math.tan(c.pitch * Math.PI / 180));
    } else {
      cam.position.set(f.x - hx * c.back, f.y - hy * c.back, f.z + c.up);
      cam.lookAt(f.x + hx * c.ahead, f.y + hy * c.ahead, f.z + ROBOT_H);
    }
    return Math.abs(dyaw) > 0.002 || Math.abs(s.x - f.x) + Math.abs(s.y - f.y) + Math.abs(s.z - f.z) > 0.05;
  }

  // Parse the Maya models (OBJ text). Their geometry is shared by every copy,
  // so it is marked to survive dispose3(). Returns null if unavailable.
  function loadModels3d() {
    if (!MODELS || !THREE.OBJLoader) return null;
    try {
      var loader = new THREE.OBJLoader(), out = {};
      ['robot', 'led', 'frame'].forEach(function (k) {
        out[k] = loader.parse(MODELS.obj[k]);
        out[k].traverse(function (o) { if (o.geometry) o.geometry.userData.shared = true; });
      });
      return out;
    } catch (e) {
      return null;
    }
  }

  // Give every mesh under obj a Lambert material coloured by the Maya
  // material name (cols: name -> CSS colour); unknown names use `fallback`.
  function paint3(obj, cols, fallback, opts) {
    obj.traverse(function (o) {
      if (!o.isMesh) return;
      var list = Array.isArray(o.material) ? o.material : [o.material];
      var mats = list.map(function (m) {
        var nm = new THREE.MeshLambertMaterial({ color: color3(cols[m.name] || fallback) });
        nm.name = m.name;
        if (opts && opts.opacity < 1) { nm.transparent = true; nm.opacity = opts.opacity; }
        if (opts && opts.emissive && opts.emissive[m.name]) nm.emissive = color3(opts.emissive[m.name]);
        if (m.dispose) m.dispose();
        return nm;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });
  }

  // Heading vector in 3D, NOT turned with the robot, so its X, Y
  // and Z parts stay on the room's axes. Length VEC_LEN cm. The dashed lines
  // drop from its tip to the floor plane and run from there to the X / Y tips.
  var VEC_LEN = 28;
  function makeVec3d() {
    var T = THREE, g = new T.Group(), o = new T.Vector3();
    var main = new T.ArrowHelper(new T.Vector3(1, 0, 0), o, VEC_LEN, 0x000000, 6, 4);
    var ax = new T.ArrowHelper(new T.Vector3(1, 0, 0), o, VEC_LEN, 0x000000, 4, 3);
    var ay = new T.ArrowHelper(new T.Vector3(0, 1, 0), o, VEC_LEN, 0x000000, 4, 3);
    var az = new T.ArrowHelper(new T.Vector3(0, 0, 1), o, VEC_LEN, 0x000000, 4, 3);
    var dg = new T.BufferGeometry();
    dg.setAttribute('position', new T.BufferAttribute(new Float32Array(18), 3));
    var dash = new T.LineSegments(dg, new T.LineDashedMaterial({ dashSize: 1.5, gapSize: 1.5 }));
    dash.frustumCulled = false;
    var lx = dynLabel3(), ly = dynLabel3(), lz = dynLabel3();
    [main, ax, ay, az, dash, lx, ly, lz].forEach(function (m) { g.add(m); });
    g.visible = false;
    v3.scene.add(g);
    return { group: g, main: main, ax: ax, ay: ay, az: az, dash: dash, lx: lx, ly: ly, lz: lz };
  }

  // a label whose text changes (redrawn only when the text does)
  function dynLabel3() {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    sp.userData = { cv: cv, tex: tex, text: '', css: '#888', px: 13 * 64 / 48, aspect: 4 };
    sp.renderOrder = 11;
    return sp;
  }

  function setDynLabel(sp, text) {
    if (sp.userData.text === text) return;
    var u = sp.userData, ctx = u.cv.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = '700 44px ' + C.font;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 10; ctx.strokeStyle = C.surface; ctx.lineJoin = 'round';
    ctx.strokeText(text, 128, 32);
    ctx.fillStyle = u.css;
    ctx.fillText(text, 128, 32);
    u.tex.needsUpdate = true;
    u.text = text;
  }

  function update3dVec(s) {
    var V = v3.vec, v = dirVec(), T = THREE, parts = state.vecParts;
    V.group.position.set(s.x, s.y, s.z + ROBOT_H + 1.5);
    V.main.setDirection(new T.Vector3(v.x, v.y, v.z));
    [['ax', 'x', new T.Vector3(1, 0, 0)], ['ay', 'y', new T.Vector3(0, 1, 0)], ['az', 'z', new T.Vector3(0, 0, 1)]]
      .forEach(function (a) {
        var arr = V[a[0]], c = v[a[1]], len = VEC_LEN * Math.abs(c);
        arr.visible = parts && len > 2;
        if (!arr.visible) return;
        arr.setDirection(a[2].multiplyScalar(c >= 0 ? 1 : -1));
        arr.setLength(len, Math.min(4, len * 0.5), 3);
      });
    var ex = VEC_LEN * v.x, ey = VEC_LEN * v.y, ez = VEC_LEN * v.z, p = V.dash.geometry.attributes.position;
    p.setXYZ(0, ex, ey, ez); p.setXYZ(1, ex, ey, 0);   // tip down to the floor plane
    p.setXYZ(2, ex, ey, 0); p.setXYZ(3, ex, 0, 0);     // across to the X tip
    p.setXYZ(4, ex, ey, 0); p.setXYZ(5, 0, ey, 0);     // across to the Y tip
    p.needsUpdate = true;
    V.dash.computeLineDistances();
    V.dash.visible = V.lx.visible = V.ly.visible = V.lz.visible = parts;
    setDynLabel(V.lx, 'X ' + fmtVec(v.x));
    setDynLabel(V.ly, 'Y ' + fmtVec(v.y));
    setDynLabel(V.lz, 'Z ' + fmtVec(v.z));
    V.lx.position.set(ex, v.y >= 0 ? -4 : 4, 0);
    V.ly.position.set(v.x >= 0 ? -8 : 8, ey, 0);
    V.lz.position.set(v.x >= 0 ? -8 : 8, 0, ez + (v.z >= 0 ? 3 : -3));
  }

  function reset3dView() {
    // looking in from the -Y side (Q3/Q4), the side the 2D map is drawn from
    v3.camera.position.set(130, -285, 205);
    v3.controls.target.set(0, 0, 35);
    v3.controls.update();
    v3.needs = true;
  }

  function color3(css) { return new THREE.Color(css || '#888888'); }

  // Text label that always faces the camera and keeps the same size on screen
  // (px = text height in CSS px; see size3dLabels). Anchored at its bottom
  // centre when `above` is set, otherwise at its centre.
  function label3(text, css, px, weight, above) {
    var h = px;
    var fpx = 48, cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    var font = (weight || '600') + ' ' + fpx + 'px ' + C.font;
    ctx.font = font;
    cv.width = Math.ceil(ctx.measureText(text).width) + 16;
    cv.height = fpx + 16;
    ctx.font = font; // resizing the canvas resets the context
    ctx.fillStyle = css;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, cv.height / 2);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    sp.userData.px = h * cv.height / fpx; // canvas has padding around the text
    sp.userData.aspect = cv.width / cv.height;
    if (above) sp.center.set(0.5, 0);
    sp.renderOrder = 10;
    v3.labels.push(sp);
    return sp;
  }

  // Without size attenuation a sprite of scale s is s * P[1][1] / 2 of the
  // viewport height tall, so s = 2 * px / (P[1][1] * viewport height).
  function size3dLabels() {
    var k = 2 / (v3.camera.projectionMatrix.elements[5] * v3.h);
    v3.labels.concat(v3.vec ? [v3.vec.lx, v3.vec.ly, v3.vec.lz] : []).forEach(function (sp) {
      var s = sp.userData.px * k;
      sp.scale.set(s * sp.userData.aspect, s, 1);
    });
  }

  function lines3(pts, css, dashed) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    var m = dashed
      ? new THREE.LineDashedMaterial({ color: color3(css), dashSize: 3, gapSize: 3, transparent: true, opacity: 0.7 })
      : new THREE.LineBasicMaterial({ color: color3(css) });
    var l = new THREE.LineSegments(g, m);
    if (dashed) l.computeLineDistances();
    return l;
  }

  function dispose3(obj) {
    obj.traverse(function (o) {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }

  function build3dStatics() {
    var T = THREE, G = v3.statics, R = MAP_RANGE, f = unitInfo().f, i, v, pts;
    for (i = G.children.length - 1; i >= 0; i--) { dispose3(G.children[i]); G.remove(G.children[i]); }
    v3.labels = [];

    // floor grid every 10 cm over the same area as the 2D map
    pts = [];
    for (v = -R; v <= R + 1e-9; v += 10) {
      if (Math.abs(v) < 1e-9) continue; // the axes are drawn on their own
      pts.push(v, -R, 0, v, R, 0, -R, v, 0, R, v, 0);
    }
    G.add(lines3(pts, C.grid));

    // axes: X and Y on the floor, Z up past the LEDs (colours match the X/Y series)
    var zTop = LED_HEIGHT + 20;
    G.add(lines3([-R, 0, 0, R, 0, 0], C.s1));
    G.add(lines3([0, -R, 0, 0, R, 0], C.s2));
    G.add(lines3([0, 0, 0, 0, 0, zTop], C.s3));
    var off = 8;
    [['+X', R + off, 0, 0, C.s1], ['−X', -R - off, 0, 0, C.s1],
     ['+Y', 0, R + off, 0, C.s2], ['−Y', 0, -R - off, 0, C.s2],
     ['+Z', 0, 0, zTop + off, C.s3]].forEach(function (a) {
      var sp = label3(a[0], a[4], 15, '700');
      sp.position.set(a[1], a[2], a[3]);
      G.add(sp);
    });

    // ticks in the display unit: +-50 on the floor axes, every 25 cm up Z
    pts = [];
    function tick(text, x, y, z, css) {
      var sp = label3(text, css || C.muted, 11, '500');
      sp.position.set(x, y, z);
      G.add(sp);
    }
    [-50, 50].forEach(function (d) {
      pts.push(d, -2, 0, d, 2, 0, -2, d, 0, 2, d, 0);
      tick(fmtTick(d * f, 25 * f), d, -6, 0);
      tick(fmtTick(d * f, 25 * f), -7, d, 0);
    });
    for (v = 25; v < LED_HEIGHT; v += 25) {
      pts.push(-2, 0, v, 2, 0, v);
      tick(fmtTick(v * f, 25 * f), -7, 0, v);
    }
    pts.push(-2, 0, LED_HEIGHT, 2, 0, LED_HEIGHT);
    tick(fmtTick(LED_HEIGHT * f, f), -7, 0, LED_HEIGHT, C.led); // LED height above the floor
    G.add(lines3(pts, C.muted));

    // the frame that holds the LEDs (Maya model); without it, thin lines
    // join the LEDs at z = LED_HEIGHT (8--7--6 / 5--4--3 / 2--1--0)
    var P = v3.parts;
    if (P && P.frame) {
      var fr = P.frame.clone();
      paint3(fr, {}, C.muted, { opacity: 0.35 });
      fr.traverse(function (o) { if (o.isMesh) o.material.depthWrite = false; }); // see-through
      G.add(fr);
    }
    pts = [];
    for (v = -LED_SPACING; v <= LED_SPACING; v += LED_SPACING) {
      pts.push(-LED_SPACING, v, LED_HEIGHT, LED_SPACING, v, LED_HEIGHT);
      pts.push(v, -LED_SPACING, LED_HEIGHT, v, LED_SPACING, LED_HEIGHT);
    }
    if (!(P && P.frame)) G.add(lines3(pts, C.axis));

    // LEDs (Maya model: housing + lens; lens lit when on, grey when off), or a
    // sphere / grey wireframe without the model; dashed drop line to the floor
    var drop = [];
    LEDS.forEach(function (L) {
      var on = ledOn[L[2]];
      // the bulb (lit sphere / grey wireframe) shows on/off from any angle;
      // the Maya housing sits on top of it
      var m = new T.Mesh(new T.SphereGeometry(on ? 2.8 : 2.4, 20, 14),
        new T.MeshBasicMaterial(on ? { color: color3(C.led) } : { color: color3(C.muted), wireframe: true }));
      m.position.set(L[0], L[1], LED_HEIGHT);
      if (P && P.led) {
        var hs = P.led.clone();
        paint3(hs, { ra_led_housing: C.axis, ra_led_lens: on ? C.led : C.muted }, C.muted);
        hs.position.set(L[0], L[1], LED_HEIGHT + 1.2); // housing above the bulb
        G.add(hs);
      }
      G.add(m);
      var sp = label3('LED ' + L[2] + (on ? '' : ' (' + t('ledOff') + ')'), on ? C.text2 : C.muted, 12, '600', true);
      sp.position.set(L[0], L[1], LED_HEIGHT + 5);
      G.add(sp);
      drop.push(L[0], L[1], LED_HEIGHT - 1.5, L[0], L[1], 0);
      var dot = new T.Mesh(new T.RingGeometry(1.2, 2, 20), new T.MeshBasicMaterial({ color: color3(C.muted), side: T.DoubleSide }));
      dot.position.set(L[0], L[1], 0.05);
      G.add(dot);
    });
    G.add(lines3(drop, C.muted, true));

    paint3(v3.robot, { ra_body: C.text, ra_pd: C.muted, ra_pd1: C.s3 }, C.text);
    v3.robot.traverse(function (o) { if (o.isMesh) o.material.flatShading = true; });
    v3.vec.main.setColor(color3(C.text));
    v3.vec.ax.setColor(color3(C.s1));
    v3.vec.ay.setColor(color3(C.s2));
    v3.vec.az.setColor(color3(C.s3));
    v3.vec.lz.userData.css = C.s3;
    v3.vec.dash.material.color = color3(C.muted);
    v3.vec.lx.userData.css = C.s1; v3.vec.ly.userData.css = C.s2;
    v3.vec.lx.userData.text = v3.vec.ly.userData.text = v3.vec.lz.userData.text = ''; // redraw in the new colours
    v3.trail.material.color = color3(C.text2);
    v3.toOrigin.material.color = color3(C.text2);
    v3.drop.material.color = color3(C.s3);
    v3.shadow.material.color = color3(C.text);
  }

  function render3d() {
    var box = el.map3d.getBoundingClientRect(), w = Math.round(box.width), h = Math.round(box.height);
    if (w < 10 || h < 10) return;
    var relabel = false;
    if (w !== v3.w || h !== v3.h) {
      v3.renderer.setSize(w, h, false);
      v3.camera.aspect = w / h;
      v3.camera.updateProjectionMatrix();
      v3.w = w; v3.h = h;
      relabel = true;
    }
    var sig = JSON.stringify([C, state.unit, state.lang, ledOn]);
    if (sig !== v3.sig) { build3dStatics(); v3.sig = sig; relabel = true; }
    if (relabel) size3dLabels();

    var s = state.latest;
    v3.robot.visible = v3.toOrigin.visible = v3.vec.group.visible = !!s;
    if (!s) v3.drop.visible = v3.shadow.visible = false;
    if (s) {
      v3.robot.position.set(s.x, s.y, s.z);
      update3dVec(s);
      var dp = v3.drop.geometry.attributes.position;
      dp.setXYZ(0, s.x, s.y, s.z);
      dp.setXYZ(1, s.x, s.y, 0.1);
      dp.needsUpdate = true;
      v3.drop.computeLineDistances();
      v3.drop.visible = v3.shadow.visible = s.z > 0.5;
      v3.shadow.position.set(s.x, s.y, 0.08);
      v3.robot.rotation.z = mapHeading(s.angle) * Math.PI / 180;
      var op = v3.toOrigin.geometry.attributes.position;
      op.setXYZ(0, 0, 0, 0.1);
      op.setXYZ(1, s.x, s.y, 0.1);
      op.needsUpdate = true;
    }
    var S = state.samples, n = Math.min(state.trailN, S.length, TRAIL_MAX);
    var tp = v3.trail.geometry.attributes.position;
    for (var i = 0; i < n; i++) {
      var q = S[S.length - n + i];
      tp.setXYZ(i, q.x, q.y, q.z + 0.1);
    }
    tp.needsUpdate = true;
    v3.trail.geometry.setDrawRange(0, n);
    var moving = follow3d(s);
    v3.renderer.render(v3.scene, v3.camera);
    v3.needs = moving; // keep drawing until the camera has caught up
  }

  function setVecParts(on, save) {
    state.vecParts = !!on;
    el.btnVecParts.setAttribute('aria-pressed', String(state.vecParts));
    el.legVecParts.hidden = !state.vecParts;
    if (v3) v3.needs = true;
    state.dirty = state.tilesDirty = true;
    if (save) {
      try { localStorage.setItem('ra.vecParts', state.vecParts ? '1' : '0'); } catch (e) { /* storage unavailable */ }
    }
  }

  function setMapView(view, save) {
    if (view === '3d' && !HAS_3D) view = '2d';
    state.mapView = view === '3d' ? '3d' : '2d';
    var is3d = state.mapView === '3d';
    if (is3d && !v3) init3d();
    el.map2dWrap.hidden = is3d;
    el.map3d.hidden = !is3d;
    el.btnReset3d.hidden = !is3d || state.cam3d !== 'free';
    el.cam3dField.hidden = !is3d;
    el.legQuad.hidden = is3d; // the quadrant highlight is 2D only
    el.mapTitle.setAttribute('data-i18n', is3d ? 'mapTitle3d' : 'mapTitle');
    el.mapTitle.textContent = t(is3d ? 'mapTitle3d' : 'mapTitle');
    for (var i = 0; i < el.viewRadios.length; i++) el.viewRadios[i].checked = el.viewRadios[i].value === state.mapView;
    if (v3) v3.needs = true;
    state.dirty = true;
    if (save) {
      try { localStorage.setItem('ra.mapView', state.mapView); } catch (e) { /* storage unavailable */ }
    }
  }

  function frame() {
    var live = state.source !== 'idle';
    if (state.dirty || live) {
      if (state.dirty && state.mapView === '2d') drawMap();
      drawChart(chartXY);
      if (v3 && state.dirty) v3.needs = true;
      state.dirty = false;
    }
    if (state.tilesDirty) { updateTiles(); state.tilesDirty = false; }
    if (v3 && state.mapView === '3d' && v3.needs) render3d();
    requestAnimationFrame(frame);
  }

  el.btnConnect.addEventListener('click', function () {
    if (state.source === 'serial') disconnectSerial(); else connectSerial();
  });
  el.btnWifi.addEventListener('click', function () {
    if (state.source === 'wifi') disconnectWifi(); else connectWifi();
  });
  el.wifiHost.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && state.source !== 'wifi' && state.source !== 'serial') { e.preventDefault(); connectWifi(); }
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
  el.btnZZero.addEventListener('click', zeroZ);
  el.btnZZeroReset.addEventListener('click', function () { setZZero(0); });
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
    if (localStorage.getItem('ra.mapView') === '3d') state.mapView = '3d';
    var savedCam = localStorage.getItem('ra.cam3d');
    if (savedCam === 'third' || savedCam === 'first') state.cam3d = savedCam;
    if (localStorage.getItem('ra.vecParts') === '0') state.vecParts = false;
    var savedTrail = localStorage.getItem('ra.trail');
    for (oi = 0; oi < el.trailN.options.length; oi++) {
      if (el.trailN.options[oi].value === savedTrail) state.trailN = +savedTrail;
    }
    var savedEvery = parseFloat(localStorage.getItem('ra.recEvery'));
    if (isFinite(savedEvery) && savedEvery > 0) state.recEvery = savedEvery;
  } catch (e) { /* storage unavailable */ }
  el.recEvery.value = String(state.recEvery);
  el.wifiHost.value = window.RAWifi ? RAWifi.savedHost() : '192.168.42.1';
  var savedTheme = null;
  try { savedTheme = localStorage.getItem('ra.theme'); } catch (e) { /* storage unavailable */ }
  setTheme(savedTheme, false);
  try {
    var savedLeds = JSON.parse(localStorage.getItem('ra.leds') || 'null');
    if (savedLeds) LEDS.forEach(function (L) { if (typeof savedLeds[L[2]] === 'boolean') ledOn[L[2]] = savedLeds[L[2]]; });
  } catch (e) { /* storage unavailable or bad JSON */ }
  buildLedButtons();
  // the compass note follows the sign convention above
  el.headingNote.setAttribute('data-i18n', HEADING_SIGN < 0 ? 'headingCW' : 'headingCCW');
  el.unit.value = state.unit;
  el.trailN.value = String(state.trailN);
  setChartRange(state.chartRange);
  for (var vi = 0; vi < el.viewRadios.length; vi++) {
    el.viewRadios[vi].addEventListener('change', function (e) { if (e.target.checked) setMapView(e.target.value, true); });
    if (el.viewRadios[vi].value === '3d' && !HAS_3D) {
      el.viewRadios[vi].disabled = true;
      el.viewRadios[vi].parentNode.title = t('no3d');
    }
  }
  el.btnReset3d.addEventListener('click', function () { if (v3) reset3dView(); });
  el.cam3d.addEventListener('change', function () { setCam3d(el.cam3d.value, true); });
  el.cam3d.value = state.cam3d;
  el.btnVecParts.addEventListener('click', function () { setVecParts(!state.vecParts, true); });
  setVecParts(state.vecParts, false);

  window.addEventListener('beforeunload', function (e) {
    if (state.log.length && !state.logSaved) { e.preventDefault(); e.returnValue = ''; }
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
  }
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () { state.dirty = true; });
    ro.observe(el.map); ro.observe(el.map3d); ro.observe(chartXY.cv);
  }
  window.addEventListener('resize', function () { state.dirty = true; });

  if (!HAS_SERIAL) {
    el.btnConnect.disabled = true;
    el.btnConnect.setAttribute('aria-describedby', 'noticeText');
    el.btnConnect.title = t('connectDisabled');
    // Chrome/Edge hide Web Serial on insecure pages (e.g. http://192.168...),
    // which needs a different fix than switching browsers. WiFi still works.
    showNotice(window.isSecureContext === false ? 'errInsecure' : 'errUnsupported');
  }

  readColors();
  updateUnitLabels();
  applyLang();
  setMapView(state.mapView, false); // after applyLang, so the title is in the right language
  setInterval(updateStatus, 500);
  requestAnimationFrame(frame);

  // index.html?demo=1 starts the demo immediately (handy for trying the UI without the board)
  if (/[?&]demo=1\b/.test(location.search)) startDemo();
})();
