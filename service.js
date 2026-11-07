/*
 * TVB service.
 *
 * Started by TizenBrew together with the module ("serviceFile" in package.json)
 * and run inside TizenBrew's own service process, sandboxed with Node's vm module.
 * Only Node built-in modules are used (http, fs, os, crypto).
 *
 * 1) Bookmarks and TV-side API - ONLY on 127.0.0.1:8095 (the TV itself):
 *   GET  /ping             -> { ok, version, node, file, lastError } (diagnostics)
 *   GET  /bookmarks        -> { ok: true, bookmarks: [...] }
 *   POST /bookmarks        -> body { url, title }   -> { ok: true, result: "added" | "exists" | "full" }
 *   PUT  /bookmarks        -> body { bookmarks: [...] } (rename, move, delete) -> { ok: true }
 *   GET  /remote/info      -> { ok, url, password } (shown in the key guide)
 *   GET  /remote/next?after=<id|now> -> long poll: commands sent from the phone
 *   POST /remote/state     -> body { typing, value, label, site } (the phone shows a text box)
 *
 * 2) Phone remote - on the home network, port 8096, protected by a password
 *    (8 characters, new at every start, shown in the key guide on the TV):
 *   GET  /                 -> the remote page (remote.html of this module, via TizenBrew's proxy)
 *   POST /api/cmd          -> body { password, type: "key"|"text", key, text, submit }
 *   POST /api/state        -> body { password, version } -> long poll: TV state
 *   The phone can only send keys and text: it cannot read bookmarks or pages.
 *
 * Written in plain ES5 (the TV runs Node.js v4).
 */
(function () {
  'use strict';

  var VERSION = '0.1.3';
  var PORT = 8095;
  var HOST = '127.0.0.1';
  var REMOTE_PORT = 8096;
  var REMOTE_HOST = '0.0.0.0';
  var DATA_DIR = '/home/owner/share';
  var DATA_FILE = DATA_DIR + '/tvbBookmarks.json';
  var MODULE_PATH = '/module/' + encodeURIComponent('gh/tvbrew-mods/tvb@v' + VERSION) + '/remote.html';
  var MAX_BODY = 256 * 1024;       // bytes (bookmark list)
  var MAX_REMOTE_BODY = 8 * 1024;  // bytes (phone commands)
  var MAX_BOOKMARKS = 120;
  var MAX_TITLE = 80;
  var MAX_URL = 2048;
  var MAX_TEXT = 1000;
  var MAX_QUEUE = 50;
  var POLL_MS = 20000;             // long poll duration
  var MAX_FAILS = 5;               // wrong passwords before a pause
  var LOCK_MS = 60000;

  var http = require('http');
  var fs = require('fs');

  var lastError = '';   // last real problem, reported by /ping (shown by INFO on the home page)

  function log(text, isError) {
    if (isError) {
      lastError = String(text).substring(0, 200);
    }
    try {
      console.log('[TVB service] ' + text);
    } catch (e) { /* ignore */ }
  }

  function errText(e) {
    return e && e.message ? e.message : String(e);
  }

  // ---------------------------------------------------------------- bookmarks
  function cleanList(list) {
    var out = [];
    var seen = {};
    if (!list || typeof list.length !== 'number') {
      return out;
    }
    for (var i = 0; i < list.length && out.length < MAX_BOOKMARKS; i++) {
      var b = list[i];
      if (!b || typeof b.url !== 'string') {
        continue;
      }
      var url = b.url.split('#')[0];
      if (!/^https?:\/\//.test(url) || url.length > MAX_URL || seen[url]) {
        continue;
      }
      seen[url] = true;
      var title = String(b.title || '').replace(/\s+/g, ' ').substring(0, MAX_TITLE);
      out.push({ url: url, title: title });
    }
    return out;
  }

  function readBookmarks() {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        return [];
      }
      return cleanList(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    } catch (e) {
      log('read error: ' + errText(e), true);
      return [];
    }
  }

  // Write to a temporary file first, then rename: the old file is never left half-written
  function writeBookmarks(list) {
    var tmp = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(cleanList(list)), 'utf8');
      fs.renameSync(tmp, DATA_FILE);
      return true;
    } catch (e) {
      log('write error: ' + errText(e), true);
      try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
      return false;
    }
  }

  function nodeVersion() {
    try { return String(process.version); } catch (e) { return '?'; }
  }

  // Can the bookmarks file be written? Checked without changing it.
  function fileStatus() {
    try {
      var W_OK = fs.constants && fs.constants.W_OK !== undefined ? fs.constants.W_OK : fs.W_OK;
      fs.accessSync(fs.existsSync(DATA_FILE) ? DATA_FILE : DATA_DIR, W_OK);
      return (fs.existsSync(DATA_FILE) ? 'writable, ' + readBookmarks().length + ' saved' : 'writable, no file yet');
    } catch (e) {
      return 'NOT writable: ' + errText(e);
    }
  }

  // ---------------------------------------------------------------- remote: state
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: easy to read on the TV
  var password = makePassword();

  function makePassword() {
    var out = '';
    var bytes = null;
    try { bytes = require('crypto').randomBytes(8); } catch (e) { /* fallback below */ }
    for (var i = 0; i < 8; i++) {
      var n = bytes ? bytes[i] : Math.floor(Math.random() * 256);
      out += ALPHABET.charAt(n % ALPHABET.length);
    }
    return out;
  }

  function tvAddress() {
    try {
      var nets = require('os').networkInterfaces();
      for (var name in nets) {
        if (!nets.hasOwnProperty(name)) {
          continue;
        }
        var list = nets[name];
        for (var i = 0; i < list.length; i++) {
          if (list[i].family === 'IPv4' && !list[i].internal) {
            return list[i].address;
          }
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  var queue = [];        // { id, at, type, key, text, submit }
  var nextId = 1;
  var tvWaiters = [];    // long polls from the TV pages
  var phoneWaiters = []; // long polls from the phones
  var tvState = { typing: false, value: '', label: '', site: '', version: 1 };
  var tvSeenAt = 0;      // last time a TV page asked for commands
  var fails = {};        // ip -> { count, until }
  var remoteRunning = false;
  var pageCache = null;

  function commandsAfter(after) {
    var out = [];
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id > after) {
        out.push(queue[i]);
      }
    }
    return out;
  }

  function answerTv(waiter) {
    clearTimeout(waiter.timer);
    send(waiter.res, 200, { ok: true, commands: commandsAfter(waiter.after), last: nextId - 1 });
  }

  function wakeTv() {
    var list = tvWaiters;
    tvWaiters = [];
    for (var i = 0; i < list.length; i++) {
      answerTv(list[i]);
    }
  }

  function phoneState() {
    return {
      ok: true,
      version: tvState.version,
      typing: tvState.typing,
      value: tvState.value,
      label: tvState.label,
      site: tvState.site,
      tvConnected: Date.now() - tvSeenAt < POLL_MS + 8000
    };
  }

  function wakePhones() {
    var list = phoneWaiters;
    phoneWaiters = [];
    for (var i = 0; i < list.length; i++) {
      clearTimeout(list[i].timer);
      send(list[i].res, 200, phoneState());
    }
  }

  function removeWaiter(list, waiter) {
    var i = list.indexOf(waiter);
    if (i >= 0) {
      list.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- http helpers
  function send(res, status, data) {
    try {
      var body = JSON.stringify(data);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store'
      });
      res.end(body);
    } catch (e) { /* connection already closed */ }
  }

  function readBody(req, maxSize, callback) {
    var text = '';
    var size = 0;
    var done = false;
    try { req.setEncoding('utf8'); } catch (e) { /* ignore */ }
    req.on('data', function (chunk) {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > maxSize) {
        done = true;
        callback(new Error('too large'));
        try { req.destroy(); } catch (e) { /* ignore */ }
        return;
      }
      text += String(chunk);
    });
    req.on('end', function () {
      if (done) {
        return;
      }
      done = true;
      try {
        callback(null, JSON.parse(text || '{}'));
      } catch (e) {
        callback(new Error('invalid json'));
      }
    });
    req.on('error', function (e) {
      if (!done) {
        done = true;
        callback(e);
      }
    });
  }

  function queryParam(url, name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(url);
    try {
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) {
      return '';
    }
  }

  // ---------------------------------------------------------------- local API (127.0.0.1)
  function handleLocal(req, res) {
    var url = String(req.url || '');
    var path = url.split('?')[0];

    if (req.method === 'OPTIONS') {
      send(res, 204, {});
      return;
    }
    if (path === '/ping') {
      send(res, 200, { ok: true, version: VERSION, node: nodeVersion(), file: fileStatus(), lastError: lastError,
        remote: remoteRunning });
      return;
    }
    if (path === '/remote/info') {
      var ip = tvAddress();
      send(res, 200, { ok: true, url: ip ? 'http://' + ip + ':' + REMOTE_PORT : '', port: REMOTE_PORT,
        password: password, running: remoteRunning });
      return;
    }
    if (path === '/remote/next' && req.method === 'GET') {
      handleTvPoll(req, res, url);
      return;
    }
    if (path === '/remote/state' && req.method === 'POST') {
      readBody(req, MAX_REMOTE_BODY, function (err, data) {
        if (err || !data) {
          send(res, 400, { ok: false, error: 'invalid request' });
          return;
        }
        tvSeenAt = Date.now();
        tvState = {
          typing: !!data.typing,
          value: String(data.value || '').substring(0, MAX_TEXT),
          label: String(data.label || '').substring(0, 80),
          site: String(data.site || '').substring(0, 80),
          version: tvState.version + 1
        };
        send(res, 200, { ok: true });
        wakePhones();
      });
      return;
    }
    if (path === '/bookmarks') {
      handleBookmarks(req, res);
      return;
    }
    send(res, 404, { ok: false, error: 'not found' });
  }

  function handleTvPoll(req, res, url) {
    var wasConnected = phoneState().tvConnected;
    tvSeenAt = Date.now();
    if (!wasConnected) {
      wakePhones(); // the phones learn that the TV is reachable again
    }
    var afterText = queryParam(url, 'after');
    var after;
    if (afterText === 'now' || afterText === '') {
      // A page that just opened: only the commands of the last moments (sent while it was loading)
      after = nextId - 1;
      for (var i = queue.length - 1; i >= 0 && Date.now() - queue[i].at < 2000; i--) {
        after = queue[i].id - 1;
      }
    } else {
      after = parseInt(afterText, 10) || 0;
    }
    var waiter = { res: res, after: after, timer: null };
    if (commandsAfter(after).length) {
      answerTv(waiter);
      return;
    }
    waiter.timer = setTimeout(function () {
      removeWaiter(tvWaiters, waiter);
      answerTv(waiter);
    }, POLL_MS);
    tvWaiters.push(waiter);
    req.on('close', function () {
      clearTimeout(waiter.timer);
      removeWaiter(tvWaiters, waiter);
    });
  }

  function handleBookmarks(req, res) {
    if (req.method === 'GET') {
      send(res, 200, { ok: true, bookmarks: readBookmarks() });
      return;
    }

    if (req.method === 'POST') {
      readBody(req, MAX_BODY, function (err, data) {
        if (err || !data || typeof data.url !== 'string') {
          send(res, 400, { ok: false, error: 'invalid request' });
          return;
        }
        var url = data.url.split('#')[0];
        if (!/^https?:\/\//.test(url) || url.length > MAX_URL) {
          send(res, 400, { ok: false, error: 'invalid url' });
          return;
        }
        var list = readBookmarks();
        for (var i = 0; i < list.length; i++) {
          if (list[i].url === url) {
            send(res, 200, { ok: true, result: 'exists' });
            return;
          }
        }
        if (list.length >= MAX_BOOKMARKS) {
          send(res, 200, { ok: true, result: 'full' });
          return;
        }
        list.push({ url: url, title: String(data.title || '') });
        if (writeBookmarks(list)) {
          send(res, 200, { ok: true, result: 'added' });
        } else {
          send(res, 500, { ok: false, error: 'write failed' });
        }
      });
      return;
    }

    if (req.method === 'PUT') {
      readBody(req, MAX_BODY, function (err, data) {
        if (err || !data || !data.bookmarks) {
          send(res, 400, { ok: false, error: 'invalid request' });
          return;
        }
        if (writeBookmarks(data.bookmarks)) {
          send(res, 200, { ok: true });
        } else {
          send(res, 500, { ok: false, error: 'write failed' });
        }
      });
      return;
    }

    send(res, 405, { ok: false, error: 'method not allowed' });
  }

  // ---------------------------------------------------------------- phone remote (home network)
  var KEYS = ['up', 'down', 'left', 'right', 'ok', 'back', 'red', 'green', 'yellow', 'blue',
    'tools', 'guide', 'info', 'playpause', 'rewind', 'forward', 'scrollup', 'scrolldown'];

  function clientIp(req) {
    try { return String(req.socket.remoteAddress || '?'); } catch (e) { return '?'; }
  }

  // Password check with a pause after too many wrong attempts. Returns an error text or ''.
  function checkPassword(req, given) {
    var ip = clientIp(req);
    var now = Date.now();
    var f = fails[ip];
    if (f && f.until > now) {
      return 'locked';
    }
    if (String(given || '').toUpperCase() === password) {
      delete fails[ip];
      return '';
    }
    if (!f || f.until) {
      f = { count: 0, until: 0 };
    }
    f.count += 1;
    if (f.count >= MAX_FAILS) {
      f.until = now + LOCK_MS;
    }
    if (Object.keys(fails).length > 200) {
      fails = {}; // keep the table small
    }
    fails[ip] = f;
    return f.until ? 'locked' : 'wrong password';
  }

  function sendPage(res, status, html) {
    try {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch (e) { /* ignore */ }
  }

  // The phone page is remote.html of this module, read through TizenBrew's local proxy
  function servePage(res) {
    if (pageCache) {
      sendPage(res, 200, pageCache);
      return;
    }
    var done = false;
    function fail(why) {
      if (!done) {
        done = true;
        log('remote page error: ' + why, true);
        sendPage(res, 503, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
          '<p style="font-family:sans-serif">TV Browser: pagina non disponibile, riprova tra poco.</p>');
      }
    }
    try {
      var req = http.get({ host: '127.0.0.1', port: 8081, path: MODULE_PATH }, function (r) {
        var text = '';
        try { r.setEncoding('utf8'); } catch (e) { /* ignore */ }
        r.on('data', function (chunk) {
          text += String(chunk);
          if (text.length > 512 * 1024) {
            try { r.destroy(); } catch (e) { /* ignore */ }
            fail('too large');
          }
        });
        r.on('end', function () {
          if (done) {
            return;
          }
          if (r.statusCode !== 200 || text.indexOf('TVB-REMOTE') < 0) {
            fail('status ' + r.statusCode);
            return;
          }
          done = true;
          pageCache = text;
          sendPage(res, 200, text);
        });
        r.on('error', function (e) { fail(errText(e)); });
      });
      req.on('error', function (e) { fail(errText(e)); });
      req.setTimeout(8000, function () {
        try { req.abort(); } catch (e) { /* ignore */ }
        fail('timeout');
      });
    } catch (e) {
      fail(errText(e));
    }
  }

  function handleRemote(req, res) {
    var path = String(req.url || '').split('?')[0];

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      servePage(res);
      return;
    }
    if (req.method !== 'POST' || (path !== '/api/cmd' && path !== '/api/state')) {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }
    readBody(req, MAX_REMOTE_BODY, function (err, data) {
      if (err || !data) {
        send(res, 400, { ok: false, error: 'invalid request' });
        return;
      }
      var problem = checkPassword(req, data.password);
      if (problem) {
        send(res, 403, { ok: false, error: problem });
        return;
      }

      if (path === '/api/cmd') {
        var cmd = { id: nextId, at: Date.now(), type: String(data.type || '') };
        if (cmd.type === 'key' && KEYS.indexOf(String(data.key)) >= 0) {
          cmd.key = String(data.key);
        } else if (cmd.type === 'text' && typeof data.text === 'string') {
          cmd.text = data.text.substring(0, MAX_TEXT);
          cmd.submit = !!data.submit;
        } else if (cmd.type !== 'hello') {
          send(res, 400, { ok: false, error: 'invalid command' });
          return;
        }
        if (cmd.type !== 'hello') { // "hello" only checks the password
          nextId += 1;
          queue.push(cmd);
          if (queue.length > MAX_QUEUE) {
            queue.shift();
          }
          wakeTv();
        }
        send(res, 200, { ok: true, tvConnected: phoneState().tvConnected });
        return;
      }

      // /api/state: answer at once if the phone is behind, otherwise wait for a change
      if (Number(data.version) !== tvState.version) {
        send(res, 200, phoneState());
        return;
      }
      var waiter = { res: res, timer: null };
      waiter.timer = setTimeout(function () {
        removeWaiter(phoneWaiters, waiter);
        send(res, 200, phoneState());
      }, POLL_MS);
      phoneWaiters.push(waiter);
      req.on('close', function () {
        clearTimeout(waiter.timer);
        removeWaiter(phoneWaiters, waiter);
      });
    });
  }

  // ---------------------------------------------------------------- start
  function makeServer(handler, name) {
    var server = http.createServer(function (req, res) {
      try {
        handler(req, res);
      } catch (e) {
        log(name + ' request error: ' + errText(e), true);
        send(res, 500, { ok: false, error: 'internal error' });
      }
    });
    server.on('error', function (e) {
      log(name + ' server error: ' + (e && e.code ? e.code : e), true);
      if (name === 'remote') {
        remoteRunning = false;
      }
    });
    return server;
  }

  // A service started by an older TVB version keeps running inside TizenBrew after the
  // module is updated, and keeps the ports busy. Each version leaves its servers on the shared
  // "process" object, so a newer one can close the old servers before listening.
  function startServers() {
    var local = makeServer(handleLocal, 'local');
    local.listen(PORT, HOST, function () {
      log('listening on ' + HOST + ':' + PORT);
    });
    var remote = makeServer(handleRemote, 'remote');
    remote.listen(REMOTE_PORT, REMOTE_HOST, function () {
      remoteRunning = true;
      log('phone remote on port ' + REMOTE_PORT);
    });
    try { process.__tvbService = { version: VERSION, server: local, remote: remote }; } catch (e) { /* ignore */ }
  }

  try {
    var old = null;
    try { old = process.__tvbService; } catch (e) { /* ignore */ }
    if (old && old.server && old.version !== VERSION) {
      log('closing the service of version ' + old.version);
      var started = false;
      var pending = old.remote ? 2 : 1;
      var startOnce = function () {
        if (!started) {
          started = true;
          try { startServers(); } catch (e) { log('start error: ' + errText(e), true); }
        }
      };
      var oneClosed = function () {
        pending -= 1;
        if (pending <= 0) {
          startOnce();
        }
      };
      try { old.server.close(oneClosed); } catch (e) { oneClosed(); }
      if (old.remote) {
        try { old.remote.close(oneClosed); } catch (e) { oneClosed(); }
      }
      setTimeout(startOnce, 1500); // close() waits for open connections: do not wait forever
    } else if (old && old.server) {
      log('same version already running');
    } else {
      startServers();
    }
  } catch (e) {
    log('start error: ' + errText(e), true);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { version: VERSION };
  }
})();
