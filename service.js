/*
 * TVB bookmark service.
 *
 * Started by TizenBrew together with the module ("serviceFile" in package.json)
 * and run inside TizenBrew's own service process, sandboxed with Node's vm module.
 * Only Node built-in modules are used (http, fs, path).
 *
 * Listens ONLY on 127.0.0.1 (the TV itself), never on the network.
 *   GET  /bookmarks        -> { ok: true, bookmarks: [...] }
 *   POST /bookmarks        -> body { url, title }   -> { ok: true, result: "added" | "exists" | "full" }
 *   PUT  /bookmarks        -> body { bookmarks: [...] } (rename, move, delete) -> { ok: true }
 *   GET  /ping             -> { ok: true, version, node, file, lastError } (diagnostics)
 * Bookmarks are kept in a JSON file next to TizenBrew's own configuration.
 *
 * Written in plain ES5 (the TV may run an old Node.js version).
 */
(function () {
  'use strict';

  var VERSION = '0.1.2';
  var PORT = 8095;
  var HOST = '127.0.0.1';
  var DATA_DIR = '/home/owner/share';
  var DATA_FILE = DATA_DIR + '/tvbBookmarks.json';
  var MAX_BODY = 256 * 1024;       // bytes
  var MAX_BOOKMARKS = 120;
  var MAX_TITLE = 80;
  var MAX_URL = 2048;

  var http = require('http');
  var fs = require('fs');

  var lastError = '';   // last read/write problem, reported by /ping (shown by INFO on the home page)

  function log(text) {
    lastError = String(text).substring(0, 200);
    try {
      console.log('[TVB service] ' + text);
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- data
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
      log('read error: ' + (e && e.message ? e.message : e));
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
      log('write error: ' + (e && e.message ? e.message : e));
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
      return 'NOT writable: ' + (e && e.message ? e.message : e);
    }
  }

  // ---------------------------------------------------------------- http
  function send(res, status, data) {
    var body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  function readBody(req, callback) {
    var text = '';
    var size = 0;
    var done = false;
    try { req.setEncoding('utf8'); } catch (e) { /* ignore */ }
    req.on('data', function (chunk) {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY) {
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

  function handle(req, res) {
    var path = String(req.url || '').split('?')[0];

    if (req.method === 'OPTIONS') {
      send(res, 204, {});
      return;
    }
    if (path === '/ping') {
      send(res, 200, { ok: true, version: VERSION, node: nodeVersion(), file: fileStatus(), lastError: lastError });
      return;
    }
    if (path !== '/bookmarks') {
      send(res, 404, { ok: false, error: 'not found' });
      return;
    }

    if (req.method === 'GET') {
      send(res, 200, { ok: true, bookmarks: readBookmarks() });
      return;
    }

    if (req.method === 'POST') {
      readBody(req, function (err, data) {
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
      readBody(req, function (err, data) {
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

  // ---------------------------------------------------------------- start
  try {
    var server = http.createServer(function (req, res) {
      try {
        handle(req, res);
      } catch (e) {
        log('request error: ' + e.message);
        try { send(res, 500, { ok: false, error: 'internal error' }); } catch (e2) { /* ignore */ }
      }
    });
    server.on('error', function (e) {
      // Already running (e.g. started twice): nothing to do
      log('server error: ' + (e && e.code ? e.code : e));
    });
    server.listen(PORT, HOST, function () {
      log('listening on ' + HOST + ':' + PORT);
    });
  } catch (e) {
    log('start error: ' + e.message);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { version: VERSION };
  }
})();
