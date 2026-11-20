/* WiFi link to the robot (task #3), shared by index.html and calibrate.html.
 *
 * The Pico W (firmware/copy/copy.ino with USE_WIFI 1) runs an access point
 * and a small HTTP server:
 *   GET /events   Server-Sent Events, one "data: <line>" per output line
 *                 (the same lines as on USB serial)
 *   GET /cmd?c=   one command line, e.g. "LED 4 1" (answer 204)
 * The pages feed the lines into the same parser as serial.
 *
 * Loads in the browser (window.RAWifi) and in Node (require) for the tests.
 */
(function (root) {
  'use strict';

  var DEFAULT_HOST = '192.168.42.1';   // WIFI_IP in copy.ino
  var STORE = 'ra.wifi.host';

  // "192.168.42.1", "http://192.168.42.1/", "robot.local:8080" ->
  // "http://192.168.42.1" etc. (no path). Empty -> the default address.
  // null for something that is not a host.
  function normalizeHost(text) {
    var s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) s = DEFAULT_HOST;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.protocol + '//' + u.host;
  }

  // URL that sends one command line
  function cmdUrl(base, line) {
    return base + '/cmd?c=' + encodeURIComponent(String(line).replace(/[\r\n]+/g, ''));
  }

  // Opens the event stream. handlers:
  //   onLine(line)    every line the board sends
  //   onOpen()        connected (again: EventSource reconnects by itself)
  //   onError(state)  'retrying' (dropped or not reachable yet; trying again)
  //                   or 'closed' (gave up, e.g. not the robot)
  //   EventSource / fetch: stand-ins for the tests
  // Returns { base, send(text), close() }. send() takes text with one or more
  // lines (as written to serial) and sends them one at a time, in order.
  function openWifi(host, handlers) {
    var h = handlers || {};
    var base = normalizeHost(host);
    if (!base) throw new Error('bad host: ' + host);
    var ES = h.EventSource || root.EventSource;
    var fetchFn = h.fetch || (root.fetch && root.fetch.bind(root));
    var es = new ES(base + '/events');
    var closed = false;
    es.onopen = function () { if (!closed && h.onOpen) h.onOpen(); };
    es.onmessage = function (e) {
      if (closed || !h.onLine) return;
      String(e.data).split(/\r?\n/).forEach(function (l) { h.onLine(l); });
    };
    es.onerror = function () {
      if (closed || !h.onError) return;
      h.onError(es.readyState === 2 ? 'closed' : 'retrying');   // 2 = EventSource.CLOSED
    };
    var chain = Promise.resolve();
    return {
      base: base,
      send: function (text) {
        String(text).split(/\r?\n/).forEach(function (line) {
          if (!line.trim()) return;
          chain = chain.then(function () {
            return fetchFn(cmdUrl(base, line), { cache: 'no-store' });
          }).catch(function () { /* robot not reachable: the event stream reports it */ });
        });
        return chain;
      },
      close: function () { closed = true; es.close(); }
    };
  }

  // The address typed last (localStorage), or the default.
  function savedHost() {
    try { return (root.localStorage && root.localStorage.getItem(STORE)) || DEFAULT_HOST; } catch (e) { return DEFAULT_HOST; }
  }
  function saveHost(text) {
    try { if (root.localStorage) root.localStorage.setItem(STORE, String(text).trim()); } catch (e) { /* storage unavailable */ }
  }

  var api = {
    DEFAULT_HOST: DEFAULT_HOST, normalizeHost: normalizeHost, cmdUrl: cmdUrl,
    openWifi: openWifi, savedHost: savedHost, saveHost: saveHost
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RAWifi = api;
})(this);
