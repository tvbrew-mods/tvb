/*
 * TVB - injection test module for TizenBrew.
 *
 * Goal: answer as many questions as possible in a single test session.
 *  - Does the script survive navigation to another domain?
 *  - How many times does it run in the same page?
 *  - Does it also run inside iframes (including cross-origin ones)?
 *  - What does the TV's web engine support (Tizen APIs, video, JS)?
 *  - Can video streams be detected (XHR/fetch hooks, <video> elements)?
 *
 * Written in plain ES5 for the old Chromium engine of Tizen TVs.
 * Everything is wrapped in try/catch so the script can never break the page.
 *
 * Remote keys (main frame only):
 *   RED    (403) -> next test page (example.com > Wikipedia > mp4 video >
 *                   YouTube iframe > HLS demo > back to the start)
 *   GREEN  (404) -> open/close a cross-origin test iframe (example.org)
 *   YELLOW (405) -> back to the first test page (example.com)
 *   BLUE   (406) -> reload the page
 * All other keys are only displayed, never blocked.
 */
(function () {
  'use strict';

  var VERSION = '0.0.1';
  // 'start' = injected with evaluateScriptOnDocumentStart: true
  // 'late'  = injected after the execution context is created (flag false)
  // The release script sets this value for each published variant.
  var VARIANT = 'start';

  var MAX_ITEMS = 5;          // max lines kept for each list (keys, errors, frames, media)
  var MAX_SEEN_URLS = 300;    // max media URLs remembered to avoid duplicates
  var MAX_VIDEOS_SCANNED = 20;
  var TICK_MS = 1000;         // overlay refresh / <video> scan interval
  var ATTACH_RETRY_MS = 50;   // retry interval while the document has no root yet
  var ATTACH_MAX_TRIES = 200; // give up after ~10 seconds

  var KEY_RED = 403;
  var KEY_GREEN = 404;
  var KEY_YELLOW = 405;
  var KEY_BLUE = 406;

  var TEST_PAGES = [
    'https://example.com/',
    'https://it.wikipedia.org/',
    'https://www.w3schools.com/html/html5_video.asp',   // mp4 in a <video> element
    'https://www.w3schools.com/html/html_youtube.asp',  // YouTube player in a cross-origin iframe
    'https://hlsjs.video-dev.org/demo/'                 // HLS (m3u8) loaded via XHR/fetch
  ];
  var TEST_FRAME_URL = 'https://example.org/';

  var MEDIA_RE = /\.(m3u8|mpd|mp4|webm|m4s|ts)(\?|#|$)/i;

  var w = window;

  // ---------------------------------------------------------------------------
  // Duplicate-run guard. TizenBrew registers the script again on every new
  // execution context, so the same document may receive it several times.
  // Only the first run does the work; later runs just increase the counter.
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

  function chromiumVersion() {
    try {
      var m = /Chrome\/(\d+)/.exec(w.navigator.userAgent);
      return m ? m[1] : 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  // ---------------------------------------------------------------------------
  // Collected information
  // ---------------------------------------------------------------------------
  var isTop = true;
  try {
    isTop = (w.top === w.self);
  } catch (e) {
    isTop = false;
  }

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
  var videoCount = 0;
  var iframeCount = 0;
  var hooks = { xhr: false, fetch: false };

  function addError(text) {
    pushLimited(errors, clock(new Date()) + ' ' + shorten(text, 100));
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Capability detection: what the TV's web engine supports, to plan the next
  // phases (native Samsung player, hls.js, needed polyfills).
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

    return [
      'Tizen API: tizen ' + yesNo(check(function () { return typeof w.tizen !== 'undefined'; })) +
        ', tvinputdevice ' + yesNo(check(function () { return !!w.tizen.tvinputdevice; })) +
        ' | webapis ' + yesNo(check(function () { return typeof w.webapis !== 'undefined'; })) +
        ', avplay ' + yesNo(check(function () { return !!w.webapis.avplay; })),
      'Video: MSE ' + yesNo(check(function () { return !!w.MediaSource; })) +
        ', H264 ' + yesNo(mseType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')) +
        ', HEVC ' + yesNo(mseType('video/mp4; codecs="hev1.1.6.L93.B0"')) +
        ', HLS native: ' + (hlsNative || 'no'),
      'JS: Promise ' + yesNo(check(function () { return typeof w.Promise === 'function'; })) +
        ', fetch ' + yesNo(check(function () { return typeof w.fetch === 'function'; })) +
        ', MutationObserver ' + yesNo(check(function () { return typeof w.MutationObserver === 'function'; })) +
        ', ES6 syntax ' + yesNo(es6Syntax),
      'Screen: ' + check(function () { return w.innerWidth + 'x' + w.innerHeight; }) +
        ' @' + check(function () { return w.devicePixelRatio || 1; })
    ];
  }

  var capabilities = null; // computed lazily, refreshed once on window load

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------
  var box = null;

  function createBox() {
    box = document.createElement('div');
    box.setAttribute('data-tvb', 'overlay');
    var s = box.style;
    s.position = 'fixed';
    s.zIndex = '2147483647';
    s.pointerEvents = 'none';
    s.whiteSpace = 'pre-wrap';
    s.wordWrap = 'break-word';
    s.fontFamily = 'monospace';
    s.color = '#ffffff';
    s.margin = '0';
    s.borderRadius = '6px';
    s.boxSizing = 'border-box';
    // Reset styles the page might make us inherit
    s.textAlign = 'left';
    s.fontWeight = 'normal';
    s.fontStyle = 'normal';
    s.letterSpacing = 'normal';
    s.textTransform = 'none';
    s.textShadow = 'none';
    s.opacity = '1';
    if (isTop) {
      s.top = '10px';
      s.right = '10px';
      s.maxWidth = '50%';
      s.padding = '8px 10px';
      s.fontSize = '15px';
      s.lineHeight = '1.3';
      s.background = 'rgba(170, 0, 0, 0.88)';
    } else {
      // Smaller green badge when running inside an iframe
      s.top = '6px';
      s.left = '6px';
      s.maxWidth = '90%';
      s.padding = '4px 8px';
      s.fontSize = '14px';
      s.lineHeight = '1.3';
      s.background = 'rgba(0, 120, 0, 0.88)';
    }
  }

  // Attach (or re-attach) the overlay. Pages may replace <body>, so this is
  // checked again on every tick.
  function attachBox() {
    var root = document.body || document.documentElement;
    if (!root) {
      return false;
    }
    if (!box) {
      createBox();
    }
    if (box.parentNode !== root) {
      root.appendChild(box);
    }
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
      lines.push('TVB v' + VERSION + ' (' + VARIANT + ') active on ' + currentHost());
      lines.push('URL: ' + shorten(currentHref(), 90));
      lines.push('Runs in this page: ' + state.runs);
      lines.push('Start: ' + clock(startTime) + '  readyState: ' + startReadyState +
        '  body: ' + (startHadBody ? 'yes' : 'no'));
      lines.push('Chromium: ' + chromiumVersion() + '  |  main frame');
      if (!capabilities) {
        capabilities = detectCapabilities();
      }
      for (var c = 0; c < capabilities.length; c++) {
        lines.push(capabilities[c]);
      }
      pushList(lines, 'Iframes: ' + iframeCount + ' in page, with TVB: ', frames);
      lines.push('Hooks: xhr ' + yesNo(hooks.xhr) + ', fetch ' + yesNo(hooks.fetch) +
        '  |  <video> in page: ' + videoCount);
      pushList(lines, 'Media found (' + mediaTotal + '): ', media);
      lines.push('Keys: ' + (keys.length ? keys.join(', ') : '-'));
      pushList(lines, 'Errors: ', errors);
      lines.push('RED next page | GREEN test iframe | YELLOW first page | BLUE reload');
    } else {
      lines.push('TVB v' + VERSION + ' (' + VARIANT + ') in IFRAME: ' +
        shorten(currentHost(), 50) + '  runs: ' + state.runs +
        '  media: ' + mediaTotal + '  video: ' + videoCount);
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

  // Coalesce many updates into a single render
  function scheduleRender() {
    if (renderPending) {
      return;
    }
    renderPending = true;
    w.setTimeout(safe(render), 30);
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
  // Media detection (preview of the "extract video" feature)
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
  }

  // Look at <video>/<source> elements and count iframes (runs on every tick)
  function scanPage() {
    var videos = document.getElementsByTagName('video');
    videoCount = videos.length;
    for (var i = 0; i < videos.length && i < MAX_VIDEOS_SCANNED; i++) {
      var v = videos[i];
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
          pushLimited(keys, 'iframe:' + msg.data.code);
        }
        scheduleRender();
      }));
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Remote keys
  // ---------------------------------------------------------------------------
  var testFrame = null;

  function toggleTestFrame() {
    if (testFrame && testFrame.parentNode) {
      testFrame.parentNode.removeChild(testFrame);
      testFrame = null;
      return;
    }
    var root = document.body || document.documentElement;
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
    // Wikipedia: any article counts as the Wikipedia step
    if (index === -1 && currentHost() === 'it.wikipedia.org') {
      index = 1;
    }
    return TEST_PAGES[(index + 1) % TEST_PAGES.length];
  }

  function onKeyDown(ev) {
    var code = ev.keyCode || ev.which || 0;
    var name = ev.key ? ' ' + ev.key : '';
    pushLimited(keys, code + name);
    scheduleRender();

    if (!isTop) {
      // Inside an iframe: only report the key, never act on it
      postToTop('key', { code: code });
      return;
    }

    if (code === KEY_RED) {
      ev.preventDefault();
      w.location.href = nextTestPage();
    } else if (code === KEY_GREEN) {
      ev.preventDefault();
      toggleTestFrame();
    } else if (code === KEY_YELLOW) {
      ev.preventDefault();
      w.location.href = TEST_PAGES[0];
    } else if (code === KEY_BLUE) {
      ev.preventDefault();
      w.location.reload();
    }
    // Any other key (arrows, OK, Back, Home, volume...) is left untouched.
  }

  try {
    w.addEventListener('keydown', safe(onKeyDown), true);
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

  try {
    document.addEventListener('DOMContentLoaded', safe(function () {
      render();
      reportFrame();
    }));
  } catch (e) { /* ignore */ }

  // Some objects (e.g. window.tizen) may only appear after the page loads:
  // detect capabilities again once everything is loaded.
  try {
    w.addEventListener('load', safe(function () {
      capabilities = null;
      scheduleRender();
      reportFrame();
    }));
  } catch (e) { /* ignore */ }

  // Light periodic work: scan <video> elements, keep the URL up to date
  // (single-page sites) and re-attach the overlay if the page removed it.
  w.setInterval(safe(function () {
    scanPage();
    render();
  }), TICK_MS);
})();
