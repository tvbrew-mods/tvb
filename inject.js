/*
 * TVB - test module for TizenBrew.
 *
 * Goal: answer as many questions as possible in a single test session.
 *  - Injection: does the script survive navigation, run once per page, run in iframes?
 *  - Remote keys: can keys received inside iframes be handled by the main page?
 *  - RETURN (Back) key handling and exit from the first page.
 *  - TV capabilities: Tizen APIs, video, JS features.
 *  - Media detection: XHR/fetch hooks, <video> elements, resources loaded before injection.
 *  - Feasibility tests for later phases: on-screen keyboard, simulated click,
 *    our own video player (native HLS and hls.js), local service reachability.
 *
 * Written in plain ES5 for the old Chromium engine of Tizen TVs.
 * Everything is wrapped in try/catch so the script can never break the page.
 *
 * Remote keys (handled by the main page, also when an iframe has the focus):
 *   1-5    -> test pages (example.com, Wikipedia, mp4 video, YouTube iframe, HLS demo)
 *   6      -> on-screen keyboard test
 *   7      -> simulated click at the center of the screen
 *   8      -> test player, native HLS
 *   9      -> test player, hls.js
 *   0      -> hide/show the debug overlay
 *   RED    -> next test page        YELLOW -> first test page
 *   GREEN  -> cross-origin test iframe   BLUE -> reload
 *   RETURN -> close panel/player; otherwise previous page; on the first page asks to exit
 * All other keys (arrows, OK, EXIT, Home, volume, media keys...) are never blocked.
 */
(function () {
  'use strict';

  var VERSION = '0.0.2';

  var MAX_ITEMS = 4;          // max lines kept for each list (keys, errors, frames, media)
  var MAX_SEEN_URLS = 300;    // max media URLs remembered to avoid duplicates
  var MAX_VIDEOS_SCANNED = 20;
  var TICK_MS = 1000;         // overlay refresh / page scan interval
  var ATTACH_RETRY_MS = 50;   // retry interval while the document has no root yet
  var ATTACH_MAX_TRIES = 200; // give up after ~10 seconds
  var EXIT_CONFIRM_MS = 5000; // time window to press RETURN again on the first page
  var PLAYER_TIMEOUT_MS = 20000;
  var LOCAL_SERVICE_TIMEOUT_MS = 4000;

  var KEY_RED = 403;
  var KEY_GREEN = 404;
  var KEY_YELLOW = 405;
  var KEY_BLUE = 406;
  var KEY_BACK = 10009;

  var TEST_PAGES = [
    'https://example.com/',
    'https://it.wikipedia.org/',
    'https://www.w3schools.com/html/html5_video.asp',   // mp4 in a <video> element
    'https://www.w3schools.com/html/html_youtube.asp',  // YouTube player in a cross-origin iframe
    'https://hlsjs.video-dev.org/demo/'                 // HLS (m3u8) loaded via XHR/fetch
  ];
  var TEST_FRAME_URL = 'https://example.org/';
  var TEST_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
  var HLSJS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
  var LOCAL_SERVICE_URL = 'http://127.0.0.1:8081/'; // TizenBrew's own local service

  var MEDIA_RE = /\.(m3u8|mpd|mp4|webm|m4s|ts)(\?|#|$)/i;
  var SEGMENT_RE = /\.(m4s|ts)(\?|#|$)/i; // stream segments: counted, only the first one listed

  var w = window;

  // ---------------------------------------------------------------------------
  // Run only on web pages (never on TizenBrew's own screens). about:blank is
  // allowed inside iframes because some players build their content there.
  // ---------------------------------------------------------------------------
  var isTop = true;
  try {
    isTop = (w.top === w.self);
  } catch (e) {
    isTop = false;
  }

  var protocol = '';
  try {
    protocol = w.location.protocol;
  } catch (e) { /* ignore */ }

  if (!(protocol === 'http:' || protocol === 'https:' || (protocol === 'about:' && !isTop))) {
    return;
  }

  // ---------------------------------------------------------------------------
  // Duplicate-run guard: only the first run in a document does the work.
  // ---------------------------------------------------------------------------
  try {
    if (w.__TVB__) {
      w.__TVB__.runs += 1;
      if (typeof w.__TVB__.onRepeat === 'function') {
        w.__TVB__.onRepeat();
      }
      return;
    }
  } catch (e) {
    return;
  }

  var state = {
    version: VERSION,
    runs: 1,
    onRepeat: null
  };

  try {
    w.__TVB__ = state;
  } catch (e) {
    return;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        addError('TVB internal: ' + (e && e.message ? e.message : e));
      }
    };
  }

  function check(fn) {
    try {
      return fn();
    } catch (e) {
      return false;
    }
  }

  function pushLimited(list, item) {
    list.unshift(item);
    if (list.length > MAX_ITEMS) {
      list.length = MAX_ITEMS;
    }
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function clock(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function shorten(text, max) {
    text = String(text);
    return text.length > max ? text.substring(0, max - 3) + '...' : text;
  }

  function yesNo(value) {
    return value ? 'yes' : 'no';
  }

  function currentHost() {
    try {
      return w.location.hostname || w.location.href;
    } catch (e) {
      return '?';
    }
  }

  function currentHref() {
    try {
      return w.location.href;
    } catch (e) {
      return '?';
    }
  }

  function absoluteUrl(url) {
    try {
      var a = document.createElement('a');
      a.href = url;
      return a.href;
    } catch (e) {
      return String(url);
    }
  }

  function hostOf(url) {
    try {
      var a = document.createElement('a');
      a.href = url;
      return a.hostname || shorten(url, 30);
    } catch (e) {
      return '?';
    }
  }

  function getRoot() {
    return document.body || document.documentElement;
  }

  function isEditable(el) {
    if (!el) {
      return false;
    }
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }
    if (tag === 'INPUT') {
      var type = String(el.type || 'text').toLowerCase();
      return type !== 'button' && type !== 'submit' && type !== 'checkbox' &&
        type !== 'radio' && type !== 'range' && type !== 'image' && type !== 'reset';
    }
    return !!el.isContentEditable;
  }

  function describeElement(el) {
    if (!el) {
      return 'nothing';
    }
    var text = '<' + String(el.tagName || '?').toLowerCase();
    if (el.id) {
      text += ' #' + el.id;
    }
    if (typeof el.className === 'string' && el.className) {
      text += ' .' + el.className.split(' ')[0];
    }
    text += '>';
    var label = String(el.textContent || el.value || '').replace(/\s+/g, ' ');
    if (label) {
      text += ' "' + shorten(label, 30) + '"';
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Collected information
  // ---------------------------------------------------------------------------
  var startTime = new Date();
  var startReadyState = '?';
  var startHadBody = false;
  try {
    startReadyState = document.readyState;
    startHadBody = !!document.body;
  } catch (e) { /* ignore */ }

  var keys = [];     // last remote keys
  var errors = [];   // last JS errors
  var frames = [];   // iframes that reported TVB running inside them (main frame only)
  var media = [];    // last detected media URLs
  var mediaSeen = {};
  var mediaSeenCount = 0;
  var mediaTotal = 0;
  var segmentCount = 0;
  var videoCount = 0;
  var iframeCount = 0;
  var hooks = { xhr: false, fetch: false, perf: false };
  var perfIndex = 0;

  // Results of the feasibility tests (shown only once a test has been run)
  var results = {
    localService: 'testing...',
    keyboard: '',
    click: '',
    player: '',
    exit: ''
  };

  function addError(text) {
    pushLimited(errors, clock(new Date()) + ' ' + shorten(text, 100));
    scheduleRender();
  }

  function isFirstPage() {
    // Pages opened from TizenBrew have no web referrer. Pages we navigate to
    // (keys, links) have the previous page as referrer, also after going back.
    var ref = '';
    try {
      ref = document.referrer || '';
    } catch (e) { /* ignore */ }
    return !(ref.indexOf('http:') === 0 || ref.indexOf('https:') === 0);
  }

  // ---------------------------------------------------------------------------
  // Capability detection
  // ---------------------------------------------------------------------------
  function mseType(type) {
    return check(function () {
      return !!(w.MediaSource && w.MediaSource.isTypeSupported(type));
    });
  }

  function detectCapabilities() {
    var video = check(function () { return document.createElement('video'); });
    var hlsNative = check(function () {
      return video ? video.canPlayType('application/vnd.apple.mpegurl') : '';
    });
    // Note: reports "no" also when the page forbids eval (Content Security Policy)
    var es6Syntax = check(function () {
      new Function('let a = 1; const f = (b) => `${a}${b}`; return f(2);');
      return true;
    });
    var fullscreen = check(function () {
      var el = document.documentElement;
      return !!(el.requestFullscreen || el.webkitRequestFullscreen);
    });

    return [
      'UA: ' + shorten(check(function () { return w.navigator.userAgent; }) || '?', 110),
      'Tizen API: tizen ' + yesNo(check(function () { return typeof w.tizen !== 'undefined'; })) +
        ' | webapis ' + yesNo(check(function () { return typeof w.webapis !== 'undefined'; })) +
        ', avplay ' + yesNo(check(function () { return !!w.webapis.avplay; })),
      'Video: MSE ' + yesNo(check(function () { return !!w.MediaSource; })) +
        ', H264 ' + yesNo(mseType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')) +
        ', HEVC ' + yesNo(mseType('video/mp4; codecs="hev1.1.6.L93.B0"')) +
        ', HLS native: ' + (hlsNative || 'no') + ', fullscreen API ' + yesNo(fullscreen),
      'JS: Promise ' + yesNo(check(function () { return typeof w.Promise === 'function'; })) +
        ', fetch ' + yesNo(check(function () { return typeof w.fetch === 'function'; })) +
        ', MutationObserver ' + yesNo(check(function () { return typeof w.MutationObserver === 'function'; })) +
        ', ES6 syntax ' + yesNo(es6Syntax),
      'Screen: ' + check(function () { return w.innerWidth + 'x' + w.innerHeight; }) +
        ' @' + check(function () { return w.devicePixelRatio || 1; }) +
        '  |  history: ' + check(function () { return w.history.length; }) +
        '  |  first page: ' + yesNo(isFirstPage())
    ];
  }

  var capabilities = null; // computed lazily, refreshed once on window load

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------
  var box = null;
  var overlayVisible = true;
  var currentFontSize = 0;

  function baseStyle(s) {
    s.position = 'fixed';
    s.margin = '0';
    s.boxSizing = 'border-box';
    s.fontFamily = 'monospace';
    s.textAlign = 'left';
    s.fontWeight = 'normal';
    s.fontStyle = 'normal';
    s.letterSpacing = 'normal';
    s.textTransform = 'none';
    s.textShadow = 'none';
    s.opacity = '1';
  }

  function createBox() {
    box = document.createElement('div');
    box.setAttribute('data-tvb', 'overlay');
    var s = box.style;
    baseStyle(s);
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    s.whiteSpace = 'pre-wrap';
    s.wordWrap = 'break-word';
    s.color = '#ffffff';
    s.borderRadius = '6px';
    s.lineHeight = '1.3';
    if (isTop) {
      s.top = '10px';
      s.right = '10px';
      s.maxWidth = '52%';
      s.padding = '8px 10px';
      s.background = 'rgba(170, 0, 0, 0.88)';
    } else {
      // Smaller green badge when running inside an iframe
      s.top = '6px';
      s.left = '6px';
      s.maxWidth = '90%';
      s.padding = '4px 8px';
      s.fontSize = '14px';
      s.background = 'rgba(0, 120, 0, 0.88)';
    }
  }

  // Pages with a viewport (e.g. Wikipedia) are scaled: keep the overlay the same size
  function applyScale() {
    if (!isTop || !box) {
      return;
    }
    var width = check(function () { return w.innerWidth; }) || 1920;
    var size = width < 1900 ? Math.max(8, Math.round(14 * width / 1920)) : 14;
    if (size !== currentFontSize) {
      currentFontSize = size;
      box.style.fontSize = size + 'px';
    }
  }

  function attachBox() {
    var root = getRoot();
    if (!root) {
      return false;
    }
    if (!box) {
      createBox();
    }
    if (box.parentNode !== root) {
      root.appendChild(box);
    }
    box.style.display = overlayVisible ? 'block' : 'none';
    applyScale();
    return true;
  }

  function pushList(lines, title, list) {
    lines.push(title + (list.length ? '' : 'none'));
    for (var i = 0; i < list.length; i++) {
      lines.push('  ' + list[i]);
    }
  }

  function buildText() {
    var lines = [];
    if (isTop) {
      lines.push('TVB v' + VERSION + ' active on ' + currentHost() + '  |  runs in this page: ' + state.runs);
      lines.push('URL: ' + shorten(currentHref(), 90));
      lines.push('Start: ' + clock(startTime) + '  readyState: ' + startReadyState +
        '  body: ' + (startHadBody ? 'yes' : 'no'));
      if (!capabilities) {
        capabilities = detectCapabilities();
      }
      for (var c = 0; c < capabilities.length; c++) {
        lines.push(capabilities[c]);
      }
      lines.push('Local service (TizenBrew): ' + results.localService);
      pushList(lines, 'Iframes: ' + iframeCount + ' in page, with TVB: ', frames);
      lines.push('Hooks: xhr ' + yesNo(hooks.xhr) + ', fetch ' + yesNo(hooks.fetch) +
        ', perf ' + yesNo(hooks.perf) + '  |  <video> in page: ' + videoCount);
      pushList(lines, 'Media found (' + mediaTotal + ', segments: ' + segmentCount + '): ', media);
      if (results.keyboard) {
        lines.push('Keyboard: ' + results.keyboard);
      }
      if (results.click) {
        lines.push('Click: ' + results.click);
      }
      if (results.player) {
        lines.push('Player: ' + results.player);
      }
      if (results.exit) {
        lines.push('Exit: ' + results.exit);
      }
      lines.push('Keys: ' + (keys.length ? keys.join(', ') : '-'));
      pushList(lines, 'Errors: ', errors);
      lines.push('1-5 pages | 6 keyboard | 7 click | 8 HLS native | 9 hls.js | 0 hide');
      lines.push('RED next | YELLOW first | GREEN iframe | BLUE reload | RETURN back');
    } else {
      lines.push('TVB v' + VERSION + ' in IFRAME: ' + shorten(currentHost(), 50) +
        '  runs: ' + state.runs + '  media: ' + mediaTotal + '  video: ' + videoCount);
      if (errors.length) {
        lines.push('Last error: ' + errors[0]);
      }
    }
    return lines.join('\n');
  }

  var renderPending = false;

  function render() {
    renderPending = false;
    if (!attachBox()) {
      return;
    }
    var text = buildText();
    if (box.textContent !== text) {
      box.textContent = text;
    }
  }

  function scheduleRender() {
    if (renderPending) {
      return;
    }
    renderPending = true;
    w.setTimeout(safe(render), 30);
  }

  // Short message in the lower part of the screen
  var notice = null;
  var noticeTimer = null;

  function showNotice(text, ms) {
    var root = getRoot();
    if (!root) {
      return;
    }
    if (!notice) {
      notice = document.createElement('div');
      notice.setAttribute('data-tvb', 'notice');
      var s = notice.style;
      baseStyle(s);
      s.left = '50%';
      s.bottom = '8%';
      s.width = '900px';
      s.marginLeft = '-450px';
      s.padding = '16px 20px';
      s.fontSize = '26px';
      s.textAlign = 'center';
      s.color = '#000000';
      s.background = '#ffd600';
      s.borderRadius = '8px';
      s.zIndex = '2147483647';
      s.pointerEvents = 'none';
    }
    notice.textContent = text;
    if (notice.parentNode !== root) {
      root.appendChild(notice);
    }
    if (noticeTimer) {
      w.clearTimeout(noticeTimer);
    }
    noticeTimer = w.setTimeout(safe(hideNotice), ms);
  }

  function hideNotice() {
    if (noticeTimer) {
      w.clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    if (notice && notice.parentNode) {
      notice.parentNode.removeChild(notice);
    }
  }

  // ---------------------------------------------------------------------------
  // Communication between iframes and the main frame
  // ---------------------------------------------------------------------------
  function postToTop(type, data) {
    if (isTop) {
      return;
    }
    try {
      w.top.postMessage({ __tvb: 1, type: type, data: data }, '*');
    } catch (e) { /* ignore */ }
  }

  function reportFrame() {
    postToTop('frame', { host: currentHost(), runs: state.runs, media: mediaTotal });
  }

  // ---------------------------------------------------------------------------
  // Media detection
  // ---------------------------------------------------------------------------
  function addMedia(url, source, fromFrame) {
    if (!url || typeof url !== 'string') {
      return;
    }
    if (mediaSeen[url]) {
      return;
    }
    if (mediaSeenCount >= MAX_SEEN_URLS) {
      mediaSeen = {};
      mediaSeenCount = 0;
    }
    mediaSeen[url] = true;
    mediaSeenCount += 1;
    mediaTotal += 1;
    if (SEGMENT_RE.test(url)) {
      segmentCount += 1;
      if (segmentCount > 1) {
        scheduleRender(); // keep the list for manifests and files, not every segment
        return;
      }
    }
    pushLimited(media, (fromFrame ? 'iframe/' : '') + source + ' ' + shorten(url, 90));
    if (!isTop) {
      postToTop('media', { source: source, url: url });
      reportFrame();
    }
    scheduleRender();
  }

  function installHooks() {
    // XMLHttpRequest: record the URL, then call the original method unchanged
    try {
      var proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
      if (proto && typeof proto.open === 'function') {
        var originalOpen = proto.open;
        proto.open = function (method, url) {
          try {
            var u = String(url);
            if (MEDIA_RE.test(u)) {
              addMedia(absoluteUrl(u), 'xhr');
            }
          } catch (e) { /* never break the request */ }
          return originalOpen.apply(this, arguments);
        };
        hooks.xhr = true;
      }
    } catch (e) { /* ignore */ }

    // fetch: same approach, always calling the original with window as "this"
    try {
      if (typeof w.fetch === 'function') {
        var originalFetch = w.fetch;
        w.fetch = function (input) {
          try {
            var u = typeof input === 'string' ? input : (input && input.url);
            if (u && MEDIA_RE.test(String(u))) {
              addMedia(absoluteUrl(String(u)), 'fetch');
            }
          } catch (e) { /* never break the request */ }
          return originalFetch.apply(w, arguments);
        };
        hooks.fetch = true;
      }
    } catch (e) { /* ignore */ }

    // Resource timing: lists resources downloaded BEFORE the script arrived
    try {
      if (w.performance && typeof w.performance.getEntriesByType === 'function') {
        if (typeof w.performance.setResourceTimingBufferSize === 'function') {
          w.performance.setResourceTimingBufferSize(500);
        }
        hooks.perf = true;
      }
    } catch (e) { /* ignore */ }
  }

  function scanResources() {
    if (!hooks.perf) {
      return;
    }
    var entries = w.performance.getEntriesByType('resource');
    if (entries.length < perfIndex) {
      perfIndex = 0; // the page cleared the buffer
    }
    for (var i = perfIndex; i < entries.length; i++) {
      var name = entries[i].name;
      if (name && MEDIA_RE.test(name)) {
        addMedia(name, 'perf');
      }
    }
    perfIndex = entries.length;
  }

  function scanPage() {
    var videos = document.getElementsByTagName('video');
    videoCount = videos.length;
    for (var i = 0; i < videos.length && i < MAX_VIDEOS_SCANNED; i++) {
      var v = videos[i];
      if (v.getAttribute('data-tvb')) {
        continue; // our own test player
      }
      var src = v.currentSrc || v.src;
      if (src) {
        addMedia(src, src.indexOf('blob:') === 0 ? 'video(MSE blob)' : 'video');
      }
      var sources = v.getElementsByTagName('source');
      for (var j = 0; j < sources.length && j < MAX_VIDEOS_SCANNED; j++) {
        if (sources[j].src) {
          addMedia(sources[j].src, 'source');
        }
      }
    }
    var count = document.getElementsByTagName('iframe').length;
    iframeCount = (testFrame && testFrame.parentNode) ? count - 1 : count;
    scanResources();
  }

  // ---------------------------------------------------------------------------
  // Test: can web pages reach TizenBrew's local service? (needed later for
  // bookmarks/history shared between all websites)
  // ---------------------------------------------------------------------------
  function withTimeout(promise, ms) {
    return new w.Promise(function (resolve, reject) {
      var timer = w.setTimeout(function () {
        reject(new Error('timeout'));
      }, ms);
      promise.then(function (value) {
        w.clearTimeout(timer);
        resolve(value);
      }, function (err) {
        w.clearTimeout(timer);
        reject(err);
      });
    });
  }

  function testLocalService() {
    if (typeof w.fetch !== 'function' || typeof w.Promise !== 'function') {
      results.localService = 'not testable (no fetch/Promise)';
      return;
    }
    var reach = 'testing...';
    var read = 'testing...';
    function update() {
      results.localService = 'reachable ' + reach + ', readable (CORS) ' + read;
      scheduleRender();
    }
    withTimeout(w.fetch(LOCAL_SERVICE_URL, { mode: 'no-cors', cache: 'no-store' }), LOCAL_SERVICE_TIMEOUT_MS)
      .then(function () { reach = 'yes'; update(); }, function (e) {
        reach = 'no (' + shorten(e && e.message ? e.message : e, 40) + ')';
        update();
      });
    withTimeout(w.fetch(LOCAL_SERVICE_URL, { mode: 'cors', cache: 'no-store' }), LOCAL_SERVICE_TIMEOUT_MS)
      .then(function () { read = 'yes'; update(); }, function () { read = 'no'; update(); });
    update();
  }

  // ---------------------------------------------------------------------------
  // Test: on-screen keyboard (key 6)
  // ---------------------------------------------------------------------------
  var keyboardPanel = null;
  var keyboardInput = null;

  function openKeyboardTest() {
    var root = getRoot();
    if (!root || keyboardPanel) {
      return;
    }
    keyboardPanel = document.createElement('div');
    keyboardPanel.setAttribute('data-tvb', 'keyboard');
    var s = keyboardPanel.style;
    baseStyle(s);
    s.left = '50%';
    s.top = '30%';
    s.width = '900px';
    s.marginLeft = '-450px';
    s.padding = '24px';
    s.background = '#ffffff';
    s.color = '#000000';
    s.border = '4px solid #0057b8';
    s.borderRadius = '10px';
    s.zIndex = '2147483646';
    s.fontSize = '24px';

    var label = document.createElement('div');
    label.textContent = 'Keyboard test: type something, then press RETURN to close.';
    label.style.marginBottom = '12px';
    keyboardPanel.appendChild(label);

    keyboardInput = document.createElement('input');
    keyboardInput.type = 'text';
    var is = keyboardInput.style;
    is.width = '100%';
    is.fontSize = '30px';
    is.padding = '8px';
    is.boxSizing = 'border-box';
    is.color = '#000000';
    is.background = '#ffffff';
    is.border = '2px solid #333333';
    keyboardPanel.appendChild(keyboardInput);

    var typedKeys = 0;
    keyboardInput.addEventListener('input', safe(function () {
      results.keyboard = 'open, value: "' + shorten(keyboardInput.value, 40) + '", key events: ' + typedKeys;
      scheduleRender();
    }));
    keyboardInput.addEventListener('keydown', safe(function () {
      typedKeys += 1;
    }));
    keyboardInput.addEventListener('blur', safe(function () {
      if (keyboardInput) {
        results.keyboard += ' (lost focus)';
        scheduleRender();
      }
    }));

    root.appendChild(keyboardPanel);
    keyboardInput.focus();
    results.keyboard = 'open, input focused: ' + yesNo(document.activeElement === keyboardInput) +
      ' (did the TV keyboard appear?)';
    scheduleRender();
  }

  function closeKeyboardTest() {
    if (!keyboardPanel) {
      return;
    }
    var value = keyboardInput ? keyboardInput.value : '';
    keyboardInput = null;
    if (keyboardPanel.parentNode) {
      keyboardPanel.parentNode.removeChild(keyboardPanel);
    }
    keyboardPanel = null;
    results.keyboard = 'closed, final value: "' + shorten(value, 40) + '"';
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Test: simulated click at the center of the screen (key 7)
  // ---------------------------------------------------------------------------
  function showMarker(x, y) {
    var root = getRoot();
    if (!root) {
      return;
    }
    var marker = document.createElement('div');
    marker.setAttribute('data-tvb', 'marker');
    var s = marker.style;
    baseStyle(s);
    s.left = (x - 15) + 'px';
    s.top = (y - 15) + 'px';
    s.width = '30px';
    s.height = '30px';
    s.border = '4px solid #ff00ff';
    s.borderRadius = '50%';
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    root.appendChild(marker);
    w.setTimeout(safe(function () {
      if (marker.parentNode) {
        marker.parentNode.removeChild(marker);
      }
    }), 1500);
  }

  function fireMouse(el, type, x, y) {
    var ev;
    try {
      ev = new w.MouseEvent(type, { bubbles: true, cancelable: true, view: w, clientX: x, clientY: y });
    } catch (e) {
      ev = document.createEvent('MouseEvents');
      ev.initMouseEvent(type, true, true, w, 1, x, y, x, y, false, false, false, false, 0, null);
    }
    el.dispatchEvent(ev);
  }

  function clickCenter() {
    var x = Math.round(w.innerWidth / 2);
    var y = Math.round(w.innerHeight / 2);
    var el = document.elementFromPoint(x, y);
    showMarker(x, y);
    if (!el) {
      results.click = 'nothing at ' + x + ',' + y;
    } else if ((el.tagName || '').toUpperCase() === 'IFRAME') {
      results.click = 'iframe at ' + x + ',' + y + ' (' + hostOf(el.src) + '): cannot click inside from the page';
    } else {
      fireMouse(el, 'mousedown', x, y);
      fireMouse(el, 'mouseup', x, y);
      if (typeof el.click === 'function') {
        el.click();
      } else {
        fireMouse(el, 'click', x, y);
      }
      results.click = describeElement(el) + ' at ' + x + ',' + y + ' -> clicked';
    }
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Test: our own full-screen player (key 8 = native HLS, key 9 = hls.js)
  // ---------------------------------------------------------------------------
  var player = null;

  function setPlayerResult(text) {
    if (player) {
      results.player = player.mode + ': ' + text +
        (player.notes.length ? ' [' + player.notes.join(', ') + ']' : '');
      scheduleRender();
    }
  }

  function openPlayer(mode) {
    var root = getRoot();
    if (!root) {
      return;
    }
    closePlayer();

    var container = document.createElement('div');
    container.setAttribute('data-tvb', 'player');
    var s = container.style;
    baseStyle(s);
    s.left = '0';
    s.top = '0';
    s.width = '100%';
    s.height = '100%';
    s.background = '#000000';
    s.zIndex = '2147483645';

    var video = document.createElement('video');
    video.setAttribute('data-tvb', 'video');
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.background = '#000000';
    container.appendChild(video);
    root.appendChild(container);

    player = {
      mode: mode,
      container: container,
      video: video,
      hls: null,
      started: new Date().getTime(),
      notes: [],
      timer: null
    };
    var current = player;

    // Full screen: must be requested while handling the key press
    try {
      var fs = container.requestFullscreen || container.webkitRequestFullscreen;
      if (fs) {
        var result = fs.call(container);
        current.notes.push('fullscreen requested');
        if (result && typeof result.then === 'function') {
          result.then(null, function () {
            current.notes.push('fullscreen refused');
          });
        }
      } else {
        current.notes.push('no fullscreen API');
      }
    } catch (e) {
      current.notes.push('fullscreen error');
    }

    video.addEventListener('loadedmetadata', safe(function () {
      if (player === current) {
        current.notes.push(video.videoWidth + 'x' + video.videoHeight);
        setPlayerResult('metadata loaded');
      }
    }));
    video.addEventListener('playing', safe(function () {
      if (player === current) {
        var secs = Math.round((new Date().getTime() - current.started) / 100) / 10;
        setPlayerResult('PLAYING after ' + secs + 's' + (video.muted ? ' (muted)' : ' (with sound)'));
      }
    }));
    video.addEventListener('error', safe(function () {
      if (player === current) {
        var code = video.error ? video.error.code : '?';
        setPlayerResult('video error code ' + code);
      }
    }));

    current.timer = w.setTimeout(safe(function () {
      if (player === current && video.paused) {
        setPlayerResult('not playing after ' + (PLAYER_TIMEOUT_MS / 1000) + 's');
      }
    }), PLAYER_TIMEOUT_MS);

    setPlayerResult('loading...');
    if (mode === 'native') {
      video.src = TEST_HLS_URL;
      startPlayback(current);
    } else {
      loadHlsJs(current);
    }
  }

  function startPlayback(current) {
    var video = current.video;
    try {
      var p = video.play();
      if (p && typeof p.then === 'function') {
        p.then(null, function (err) {
          if (player !== current) {
            return;
          }
          var name = err && err.name ? err.name : 'error';
          current.notes.push('play() rejected: ' + name);
          if (name === 'NotAllowedError' && !video.muted) {
            // Autoplay with sound blocked: retry muted
            video.muted = true;
            current.notes.push('retry muted');
            video.play();
          }
          setPlayerResult('play() rejected');
        });
      }
    } catch (e) {
      current.notes.push('play() threw');
      setPlayerResult('play() threw');
    }
  }

  function loadHlsJs(current) {
    function attach() {
      if (player !== current) {
        return;
      }
      if (!w.Hls) {
        setPlayerResult('hls.js not available');
        return;
      }
      if (!w.Hls.isSupported()) {
        setPlayerResult('hls.js says MSE not supported');
        return;
      }
      var hls = new w.Hls();
      current.hls = hls;
      hls.on(w.Hls.Events.ERROR, function (event, data) {
        if (player === current && data && data.fatal) {
          current.notes.push('fatal: ' + data.details);
          setPlayerResult('hls.js fatal error');
        }
      });
      hls.loadSource(TEST_HLS_URL);
      hls.attachMedia(current.video);
      startPlayback(current);
    }

    if (w.Hls) {
      attach();
      return;
    }
    var script = document.createElement('script');
    script.src = HLSJS_URL;
    script.onload = safe(function () {
      current.notes.push('hls.js loaded');
      attach();
    });
    script.onerror = safe(function () {
      setPlayerResult('could not load hls.js (blocked by the site?)');
    });
    setPlayerResult('loading hls.js...');
    (document.head || getRoot()).appendChild(script);
  }

  function closePlayer() {
    if (!player) {
      return;
    }
    var current = player;
    player = null;
    try {
      if (current.timer) {
        w.clearTimeout(current.timer);
      }
      current.video.pause();
      if (current.hls) {
        current.hls.destroy();
      }
      current.video.removeAttribute('src');
      current.video.load();
    } catch (e) { /* ignore */ }
    try {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) {
          exit.call(document);
        }
      }
    } catch (e) { /* ignore */ }
    if (current.container.parentNode) {
      current.container.parentNode.removeChild(current.container);
    }
    results.player += ' (closed)';
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // RETURN on the first page: confirm, then try to exit
  // ---------------------------------------------------------------------------
  var exitPending = false;
  var exitTimer = null;

  function askExit() {
    exitPending = true;
    showNotice('Press RETURN again to exit. Any other key cancels.', EXIT_CONFIRM_MS);
    if (exitTimer) {
      w.clearTimeout(exitTimer);
    }
    exitTimer = w.setTimeout(safe(function () {
      exitPending = false;
    }), EXIT_CONFIRM_MS);
  }

  function cancelExit() {
    exitPending = false;
    if (exitTimer) {
      w.clearTimeout(exitTimer);
      exitTimer = null;
    }
    hideNotice();
  }

  function tryExit() {
    cancelExit();
    results.exit = 'trying window.close()...';
    scheduleRender();
    try {
      w.close();
    } catch (e) {
      results.exit = 'window.close() threw: ' + shorten(e && e.message ? e.message : e, 40);
    }
    // If we are still here, closing did not work
    w.setTimeout(safe(function () {
      if (results.exit.indexOf('trying') === 0) {
        results.exit = 'window.close() did not work';
      }
      showNotice('Exit is not possible from a website: press the EXIT key on the remote.', 4000);
      scheduleRender();
    }), 1000);
  }

  // ---------------------------------------------------------------------------
  // Test iframe (GREEN)
  // ---------------------------------------------------------------------------
  var testFrame = null;

  function toggleTestFrame() {
    if (testFrame && testFrame.parentNode) {
      testFrame.parentNode.removeChild(testFrame);
      testFrame = null;
      return;
    }
    var root = getRoot();
    if (!root) {
      return;
    }
    testFrame = document.createElement('iframe');
    testFrame.setAttribute('data-tvb', 'test-frame');
    testFrame.src = TEST_FRAME_URL;
    var s = testFrame.style;
    s.position = 'fixed';
    s.left = '10px';
    s.bottom = '10px';
    s.width = '640px';
    s.height = '360px';
    s.border = '3px solid #00aa00';
    s.background = '#ffffff';
    s.zIndex = '2147483646';
    root.appendChild(testFrame);
  }

  function nextTestPage() {
    var href = currentHref();
    var index = -1;
    for (var i = 0; i < TEST_PAGES.length; i++) {
      if (href.indexOf(TEST_PAGES[i]) === 0) {
        index = i;
        break;
      }
    }
    if (index === -1 && currentHost() === 'it.wikipedia.org') {
      index = 1;
    }
    return TEST_PAGES[(index + 1) % TEST_PAGES.length];
  }

  // ---------------------------------------------------------------------------
  // Remote keys
  // ---------------------------------------------------------------------------
  function digitOf(code) {
    if (code >= 48 && code <= 57) {
      return code - 48;
    }
    if (code >= 96 && code <= 105) {
      return code - 96; // numeric keypad codes, just in case
    }
    return -1;
  }

  // Keys used by TVB. Everything else is never touched.
  function isShortcut(code) {
    return code === KEY_RED || code === KEY_GREEN || code === KEY_YELLOW ||
      code === KEY_BLUE || code === KEY_BACK || digitOf(code) !== -1;
  }

  // Main page only. Returns true when the key was used.
  function handleKey(code) {
    // Panels first: RETURN closes them, other keys go to them untouched
    if (keyboardPanel) {
      if (code === KEY_BACK) {
        closeKeyboardTest();
        return true;
      }
      return false;
    }
    if (player) {
      if (code === KEY_BACK) {
        closePlayer();
        return true;
      }
      return false;
    }

    if (exitPending) {
      if (code === KEY_BACK) {
        tryExit();
        return true;
      }
      cancelExit(); // any other key cancels and is then handled normally
    }

    if (code === KEY_BACK) {
      if (isFirstPage()) {
        askExit();
      } else {
        w.history.back();
      }
      return true;
    }

    var digit = digitOf(code);
    if (digit >= 1 && digit <= 5) {
      w.location.href = TEST_PAGES[digit - 1];
    } else if (digit === 6) {
      openKeyboardTest();
    } else if (digit === 7) {
      clickCenter();
    } else if (digit === 8) {
      openPlayer('native');
    } else if (digit === 9) {
      openPlayer('hls.js');
    } else if (digit === 0) {
      overlayVisible = !overlayVisible;
      render();
    } else if (code === KEY_RED) {
      w.location.href = nextTestPage();
    } else if (code === KEY_YELLOW) {
      w.location.href = TEST_PAGES[0];
    } else if (code === KEY_GREEN) {
      toggleTestFrame();
    } else if (code === KEY_BLUE) {
      w.location.reload();
    } else {
      return false;
    }
    return true;
  }

  function onKeyDown(ev) {
    var code = ev.keyCode || ev.which || 0;
    var name = ev.key ? ' ' + ev.key : '';
    pushLimited(keys, code + name);
    scheduleRender();

    // Any key other than RETURN cancels a pending exit confirmation
    if (isTop && exitPending && code !== KEY_BACK) {
      cancelExit();
    }

    // While typing in a text field, only RETURN is a shortcut
    var typing = isEditable(document.activeElement) && !keyboardPanel;
    if (!isShortcut(code) || (typing && code !== KEY_BACK)) {
      return;
    }

    if (!isTop) {
      // Inside an iframe: forward the key to the main page, which handles it
      ev.preventDefault();
      postToTop('key', { code: code });
      return;
    }

    if (handleKey(code)) {
      ev.preventDefault();
    }
  }

  try {
    w.addEventListener('keydown', safe(onKeyDown), true);
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------------------
  // Messages from iframes (main frame only)
  // ---------------------------------------------------------------------------
  if (isTop) {
    try {
      w.addEventListener('message', safe(function (ev) {
        var msg = ev && ev.data;
        if (!msg || msg.__tvb !== 1 || !msg.data) {
          return;
        }
        if (msg.type === 'frame') {
          var host = shorten(msg.data.host, 40);
          var label = host + ' (runs: ' + msg.data.runs + ', media: ' + msg.data.media + ')';
          for (var i = 0; i < frames.length; i++) {
            if (frames[i].indexOf(host + ' ') === 0) {
              frames.splice(i, 1);
              break;
            }
          }
          pushLimited(frames, label);
        } else if (msg.type === 'media') {
          addMedia(String(msg.data.url), String(msg.data.source), true);
        } else if (msg.type === 'key') {
          var code = Number(msg.data.code);
          pushLimited(keys, 'iframe:' + code);
          if (isShortcut(code)) {
            handleKey(code);
          }
        }
        scheduleRender();
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Error capture (page errors and our own)
  // ---------------------------------------------------------------------------
  try {
    w.addEventListener('error', safe(function (ev) {
      // Ignore resource load errors (images, scripts...): they have no message
      if (!ev || !ev.message) {
        return;
      }
      var where = '';
      if (ev.filename) {
        var file = String(ev.filename).split('/').pop();
        where = ' (' + shorten(file, 30) + ':' + (ev.lineno || '?') + ')';
      }
      addError(ev.message + where);
    }), true);

    w.addEventListener('unhandledrejection', safe(function (ev) {
      var reason = ev && ev.reason;
      addError('Promise: ' + (reason && reason.message ? reason.message : reason));
    }));
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  installHooks();

  state.onRepeat = safe(function () {
    reportFrame();
    scheduleRender();
  });

  var tries = 0;
  function waitForRoot() {
    if (attachBox()) {
      scanPage();
      render();
      reportFrame();
      return;
    }
    tries += 1;
    if (tries < ATTACH_MAX_TRIES) {
      w.setTimeout(safe(waitForRoot), ATTACH_RETRY_MS);
    }
  }

  safe(waitForRoot)();

  if (isTop) {
    safe(testLocalService)();
  }

  try {
    document.addEventListener('DOMContentLoaded', safe(function () {
      render();
      reportFrame();
    }));
  } catch (e) { /* ignore */ }

  try {
    w.addEventListener('load', safe(function () {
      capabilities = null;
      scheduleRender();
      reportFrame();
    }));
  } catch (e) { /* ignore */ }

  // Light periodic work: scan the page, keep the overlay up to date and attached
  w.setInterval(safe(function () {
    scanPage();
    render();
  }), TICK_MS);
})();
