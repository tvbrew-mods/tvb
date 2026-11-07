/*
 * TVB - TV Browser for TizenBrew.
 *
 * Injected by TizenBrew into every web page (and iframe) opened by the module.
 * Features:
 *  - spatial navigation: the arrow keys highlight links, buttons and fields;
 *    OK activates the highlighted element; the page scrolls when nothing is left
 *  - virtual cursor (TOOLS): arrows move a pointer, OK clicks, edges scroll
 *  - key guide (GUIDE), debug overlay (INFO, hidden by default)
 *  - YELLOW (C): back to the TVB home page, GREEN (B): add the page to the bookmarks
 *  - RED (A): detected video in full screen; play / pause / rewind / fast forward keys
 *  - RETURN: leave full screen, close panels, leave an iframe, or go back
 *  - loading bar, white background for pages that set none
 *  - keys received inside iframes are forwarded to the main page
 *
 * Written in plain ES5 for the old Chromium engine of Tizen TVs.
 * Everything is wrapped in try/catch so the script can never break the page.
 * System keys (EXIT, Home, volume, channel, media keys) are never touched.
 */
(function () {
  'use strict';

  var VERSION = '0.1.1';
  var MODULE_ID = 'gh/tvbrew-mods/tvb@v' + VERSION;
  // TVB home page, served by TizenBrew's local module proxy
  var HOME_URL = 'http://127.0.0.1:8081/module/' + encodeURIComponent(MODULE_ID) + '/home.html';

  var MAX_ITEMS = 5;            // lines kept for each debug list
  var MAX_SEEN_URLS = 300;      // media URLs remembered to avoid duplicates
  var TICK_MS = 1000;           // periodic refresh
  var EXIT_CONFIRM_MS = 5000;
  var BOOKMARK_TIMEOUT_MS = 8000; // the home page retries the service for a few seconds
  var CURSOR_STEP = 14;         // px per key press, multiplied by the acceleration
  var CURSOR_MAX_ACCEL = 5;
  var EDGE_SCROLL = 160;        // px scrolled when the cursor pushes an edge

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13,
    BACK: 10009, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
    TOOLS: 10135, INFO: 457, GUIDE: 458,
    PLAY: 415, PAUSE: 19, REWIND: 412, FAST_FORWARD: 417
  };
  var DIR_BY_KEY = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };
  var SEEK_SECONDS = 10;

  var FOCUSABLE = 'a[href], button, input, select, textarea, summary, iframe, video, ' +
    '[tabindex], [onclick], [role="button"], [role="link"], [role="menuitem"], ' +
    '[role="tab"], [role="option"], [role="checkbox"], [contenteditable="true"]';

  var MEDIA_RE = /\.(m3u8|mpd|mp4|webm|m4s|ts)(\?|#|$)/i;
  var SEGMENT_RE = /\.(m4s|ts)(\?|#|$)/i;

  var ACCENT = '#2f9bff';  // highlight, cursor and loading bar

  // Each row: [keys drawn like the remote buttons, description]
  var GUIDE = [
    [['◀', '▲', '▼', '▶'], 'evidenziano link, pulsanti e campi'],
    [['OK'], 'apre o preme l\'elemento evidenziato'],
    [['TOOLS'], 'cursore: frecce per muoverlo, OK per cliccare'],
    [['B'], 'aggiunge la pagina ai preferiti'],
    [['C'], 'torna alla home'],
    [['A'], 'video a schermo intero'],
    [['▶', 'II'], 'play / pausa del video'],
    [['◀◀', '▶▶'], 'indietro / avanti di 10 secondi'],
    [['RETURN'], 'indietro (esce da schermo intero, guida, riquadri)'],
    [['GUIDE'], 'questa guida'],
    [['INFO'], 'informazioni tecniche (debug)'],
    [['EXIT'], 'esce dall\'app']
  ];
  var CHIP_COLORS = { A: '#d6453f', B: '#3B9B3B', C: '#e0b400', D: '#378ADD', OK: '#ffffff' };

  var w = window;

  // ---------------------------------------------------------------------------
  // Where are we?
  // ---------------------------------------------------------------------------
  var isTop = true;
  try {
    isTop = (w.top === w.self);
  } catch (e) {
    isTop = false;
  }

  var loc = { protocol: '', hostname: '', port: '', pathname: '', href: '' };
  try {
    loc.protocol = w.location.protocol;
    loc.hostname = w.location.hostname;
    loc.port = w.location.port;
    loc.pathname = w.location.pathname;
    loc.href = w.location.href;
  } catch (e) { /* ignore */ }

  // Only web pages. about:blank is allowed in iframes (some players build their content there).
  if (!(loc.protocol === 'http:' || loc.protocol === 'https:' || (loc.protocol === 'about:' && !isTop))) {
    return;
  }

  // Our own home page has its own interface: only signal that injection works.
  if (loc.hostname === '127.0.0.1' && loc.port === '8081' && /\/home\.html$/.test(loc.pathname)) {
    try {
      if (!w.__TVB__) {
        w.__TVB__ = { injected: true, version: VERSION };
      }
    } catch (e) { /* ignore */ }
    return;
  }

  // Duplicate-run guard: only the first run in a document does the work.
  try {
    if (w.__TVB__) {
      w.__TVB__.runs = (w.__TVB__.runs || 1) + 1;
      return;
    }
    w.__TVB__ = { injected: true, version: VERSION, runs: 1 };
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

  function getRoot() {
    return document.body || document.documentElement;
  }

  function viewport() {
    return {
      w: w.innerWidth || document.documentElement.clientWidth || 1920,
      h: w.innerHeight || document.documentElement.clientHeight || 1080
    };
  }

  function inDocument(el) {
    return !!(el && document.documentElement && document.documentElement.contains(el));
  }

  function closestTag(el, tag) {
    while (el && el.nodeType === 1) {
      if (el.tagName === tag) {
        return el;
      }
      el = el.parentNode;
    }
    return null;
  }

  function isEditable(el) {
    if (!el || !el.tagName) {
      return false;
    }
    var tag = el.tagName;
    if (tag === 'TEXTAREA') {
      return true;
    }
    if (tag === 'INPUT') {
      var type = String(el.type || 'text').toLowerCase();
      return type !== 'button' && type !== 'submit' && type !== 'checkbox' && type !== 'radio' &&
        type !== 'range' && type !== 'image' && type !== 'reset' && type !== 'file' && type !== 'color';
    }
    return !!el.isContentEditable;
  }

  function describeElement(el) {
    if (!el || !el.tagName) {
      return 'none';
    }
    var text = '<' + el.tagName.toLowerCase();
    if (el.id) {
      text += ' #' + el.id;
    }
    text += '>';
    var label = String(el.getAttribute('aria-label') || el.textContent || el.value || '').replace(/\s+/g, ' ');
    if (label) {
      text += ' "' + shorten(label, 30) + '"';
    }
    return text;
  }

  function baseStyle(s) {
    s.position = 'fixed';
    s.margin = '0';
    s.boxSizing = 'border-box';
    s.fontFamily = 'sans-serif';
    s.textAlign = 'left';
    s.fontWeight = 'normal';
    s.fontStyle = 'normal';
    s.letterSpacing = 'normal';
    s.textTransform = 'none';
    s.textShadow = 'none';
    s.opacity = '1';
    s.lineHeight = '1.35';
  }

  function makeLayer(name, zIndex) {
    var el = document.createElement('div');
    el.setAttribute('data-tvb', name);
    baseStyle(el.style);
    el.style.zIndex = String(zIndex);
    el.style.pointerEvents = 'none';
    return el;
  }

  // "Liquid glass" look without backdrop blur (not supported by the TV engine):
  // dark frosted tint, light rim, soft shadow. "opacity" keeps text readable over any page.
  function glassStyle(s, opacity) {
    s.background = 'linear-gradient(180deg, rgba(60, 62, 72, ' + opacity + '), rgba(28, 30, 38, ' + opacity + '))';
    s.border = '1px solid rgba(255, 255, 255, 0.16)';
    s.boxShadow = '0 18px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.4)';
    s.textShadow = '0 1px 3px rgba(0, 0, 0, 0.6)';
  }

  // Pages with a viewport (e.g. Wikipedia) are scaled up by the TV: keep our elements the same size
  function scaleFactor() {
    var width = viewport().w;
    return width < 1900 ? width / 1920 : 1;
  }

  function applyScaleTo(el, baseFontPx) {
    if (el) {
      el.style.fontSize = Math.max(9, Math.round(baseFontPx * scaleFactor())) + 'px';
    }
  }

  function attach(el) {
    var root = getRoot();
    if (root && el.parentNode !== root) {
      root.appendChild(el);
    }
    return !!root;
  }

  function detach(el) {
    if (el && el.parentNode) {
      el.parentNode.removeChild(el);
    }
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

  function clickElement(el, x, y) {
    fireMouse(el, 'mousedown', x, y);
    fireMouse(el, 'mouseup', x, y);
    if (typeof el.click === 'function') {
      el.click();
    } else {
      fireMouse(el, 'click', x, y); // e.g. SVG elements
    }
  }

  function isFirstPage() {
    var ref = '';
    try {
      ref = document.referrer || '';
    } catch (e) { /* ignore */ }
    return !(ref.indexOf('http:') === 0 || ref.indexOf('https:') === 0);
  }

  // ---------------------------------------------------------------------------
  // Debug information
  // ---------------------------------------------------------------------------
  var keys = [];
  var errors = [];
  var frames = [];
  var media = [];
  var mediaSeen = {};
  var mediaSeenCount = 0;
  var mediaTotal = 0;
  var segmentCount = 0;

  function addError(text) {
    pushLimited(errors, clock(new Date()) + ' ' + shorten(text, 100));
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Messages between frames
  // ---------------------------------------------------------------------------
  function postTo(target, type, data) {
    try {
      target.postMessage({ __tvb: 1, type: type, data: data || {} }, '*');
    } catch (e) { /* ignore */ }
  }

  function postToTop(type, data) {
    if (!isTop) {
      postTo(w.top, type, data);
    }
  }

  function childFrames() {
    var list = [];
    var nodes = document.getElementsByTagName('iframe');
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].getAttribute('data-tvb')) {
        list.push(nodes[i]);
      }
    }
    return list;
  }

  function frameElementFor(source) {
    var nodes = childFrames();
    for (var i = 0; i < nodes.length; i++) {
      try {
        if (nodes[i].contentWindow === source) {
          return nodes[i];
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function broadcastToFrames(type, data) {
    var nodes = childFrames();
    for (var i = 0; i < nodes.length; i++) {
      try {
        postTo(nodes[i].contentWindow, type, data);
      } catch (e) { /* ignore */ }
    }
  }

  function reportFrame() {
    postToTop('frame', { host: loc.hostname || loc.protocol, media: mediaTotal });
  }

  // ---------------------------------------------------------------------------
  // Notices (bottom of the screen)
  // ---------------------------------------------------------------------------
  var notice = null;
  var noticeTimer = null;

  function showNotice(text, ms) {
    if (!notice) {
      notice = makeLayer('notice', 2147483647);
      var s = notice.style;
      s.left = '50%';
      s.bottom = '6%';
      s.webkitTransform = 'translateX(-50%)';
      s.transform = 'translateX(-50%)';
      s.padding = '12px 26px';
      s.fontSize = '22px';
      s.whiteSpace = 'nowrap';
      s.textAlign = 'center';
      s.color = '#ffffff';
      glassStyle(s, 0.58);
      s.borderRadius = '9999px';
    }
    applyScaleTo(notice, 22);
    notice.textContent = text;
    attach(notice);
    if (noticeTimer) {
      w.clearTimeout(noticeTimer);
    }
    noticeTimer = w.setTimeout(safe(hideNotice), ms || 2500);
  }

  function hideNotice() {
    if (noticeTimer) {
      w.clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    detach(notice);
  }

  // ---------------------------------------------------------------------------
  // Spatial navigation
  // ---------------------------------------------------------------------------
  var current = null;   // highlighted element
  var ring = null;      // highlight drawn on top of the page (page styles are never changed)
  var lastCenter = null;

  function isCandidate(el) {
    if (!el || el.disabled || el.getAttribute('data-tvb')) {
      return false;
    }
    var tag = el.tagName;
    if (tag === 'INPUT' && String(el.type).toLowerCase() === 'hidden') {
      return false;
    }
    var tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && Number(tabindex) < 0) {
      var isNative = tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' ||
        tag === 'TEXTAREA' || tag === 'IFRAME';
      if (!isNative &&!el.hasAttribute('onclick') && !el.getAttribute('role')) {
        return false;
      }
    }
    return true;
  }

  function isVisible(el) {
    var style = w.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }

  // Elements whose position is inside the viewport extended by one screen
  function collectCandidates() {
    var v = viewport();
    var list = [];
    var nodes = document.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isCandidate(el)) {
        continue;
      }
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) {
        continue;
      }
      if (r.bottom < -v.h || r.top > 2 * v.h || r.right < -v.w || r.left > 2 * v.w) {
        continue;
      }
      list.push({ el: el, r: r });
    }
    return list;
  }

  // Not hidden behind something else (only checked for elements on screen)
  function isReachable(item) {
    var v = viewport();
    var r = item.r;
    var x = Math.round(r.left + r.width / 2);
    var y = Math.round(r.top + r.height / 2);
    if (x < 0 || y < 0 || x >= v.w || y >= v.h) {
      return true;
    }
    if (!isVisible(item.el)) {
      return false;
    }
    var hit = document.elementFromPoint(x, y);
    if (!hit) {
      return true;
    }
    if (hit.getAttribute && hit.getAttribute('data-tvb')) {
      return true;
    }
    return hit === item.el || item.el.contains(hit) || hit.contains(item.el);
  }

  function gap(aStart, aEnd, bStart, bEnd) {
    return Math.max(0, Math.max(aStart, bStart) - Math.min(aEnd, bEnd));
  }

  function scoreCandidate(dir, cr, r) {
    var cx = cr.left + cr.width / 2;
    var cy = cr.top + cr.height / 2;
    var rx = r.left + r.width / 2;
    var ry = r.top + r.height / 2;
    var primary;
    var orth;
    var drift;
    if (dir === 'right') {
      if (!(rx > cx + 1 && r.right > cr.right - 1)) { return -1; }
      primary = Math.max(0, r.left - cr.right);
      orth = gap(r.top, r.bottom, cr.top, cr.bottom);
      drift = Math.abs(ry - cy);
    } else if (dir === 'left') {
      if (!(rx < cx - 1 && r.left < cr.left + 1)) { return -1; }
      primary = Math.max(0, cr.left - r.right);
      orth = gap(r.top, r.bottom, cr.top, cr.bottom);
      drift = Math.abs(ry - cy);
    } else if (dir === 'down') {
      if (!(ry > cy + 1 && r.bottom > cr.bottom - 1)) { return -1; }
      primary = Math.max(0, r.top - cr.bottom);
      orth = gap(r.left, r.right, cr.left, cr.right);
      drift = Math.abs(rx - cx);
    } else {
      if (!(ry < cy - 1 && r.top < cr.top + 1)) { return -1; }
      primary = Math.max(0, cr.top - r.bottom);
      orth = gap(r.left, r.right, cr.left, cr.right);
      drift = Math.abs(rx - cx);
    }
    return primary + orth * 4 + drift * 0.1;
  }

  // Starting point: the highlighted element if it is on screen, otherwise a
  // line at the edge of the screen we are moving away from.
  function startRect(dir) {
    var v = viewport();
    if (inDocument(current)) {
      var r = current.getBoundingClientRect();
      var onScreen = r.bottom > 0 && r.top < v.h && r.right > 0 && r.left < v.w;
      // A huge element (e.g. a banner covering the page) would leave nothing "beyond" it:
      // start from a point instead
      var huge = r.width * r.height > 0.3 * v.w * v.h || r.height > 0.6 * v.h;
      if (onScreen && !huge) {
        return r;
      }
      if (onScreen && huge && lastCenter) {
        var px = Math.min(Math.max(lastCenter.x, 0), v.w);
        var py = Math.min(Math.max(lastCenter.y, 0), v.h);
        return { left: px, right: px, top: py, bottom: py, width: 0, height: 0 };
      }
    }
    var x = lastCenter ? Math.min(Math.max(lastCenter.x, 0), v.w) : 0;
    var y = lastCenter ? Math.min(Math.max(lastCenter.y, 0), v.h) : 0;
    if (dir === 'down') { return { left: x, right: x, top: 0, bottom: 0, width: 0, height: 0 }; }
    if (dir === 'up') { return { left: x, right: x, top: v.h, bottom: v.h, width: 0, height: 0 }; }
    if (dir === 'right') { return { left: 0, right: 0, top: y, bottom: y, width: 0, height: 0 }; }
    return { left: v.w, right: v.w, top: y, bottom: y, width: 0, height: 0 };
  }

  // Returns true when an element was highlighted or the page scrolled
  function moveFocus(dir) {
    var cr = startRect(dir);
    var list = collectCandidates();
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i].el;
      if (el === current || (current && (el.contains(current) || current.contains(el)))) {
        continue;
      }
      var score = scoreCandidate(dir, cr, list[i].r);
      if (score >= 0) {
        list[i].score = score;
        scored.push(list[i]);
      }
    }
    scored.sort(function (a, b) { return a.score - b.score; });
    for (var j = 0; j < scored.length && j < 8; j++) {
      if (isReachable(scored[j])) {
        setCurrent(scored[j].el);
        ensureVisible(scored[j].el);
        return true;
      }
    }
    // Everything looked covered (the check can be wrong on some pages): take the nearest anyway
    if (scored.length && scored[0].score < viewport().h) {
      setCurrent(scored[0].el);
      ensureVisible(scored[0].el);
      return true;
    }
    return scrollPage(dir, null);
  }

  function setCurrent(el) {
    current = el;
    if (el) {
      var r = el.getBoundingClientRect();
      lastCenter = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    updateRing();
    scheduleRender();
  }

  function ensureVisible(el) {
    var v = viewport();
    var r = el.getBoundingClientRect();
    var margin = 60;
    if (r.top >= margin && r.bottom <= v.h - margin && r.left >= 0 && r.right <= v.w) {
      return;
    }
    try {
      if (typeof el.scrollIntoViewIfNeeded === 'function') {
        el.scrollIntoViewIfNeeded(true);
      } else {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    } catch (e) {
      try { el.scrollIntoView(false); } catch (e2) { /* ignore */ }
    }
    var r2 = el.getBoundingClientRect();
    lastCenter = { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
    updateRing();
  }

  function scrollableAncestor(el, vertical) {
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      var style = w.getComputedStyle(el);
      var overflow = vertical ? style.overflowY : style.overflowX;
      if (overflow === 'auto' || overflow === 'scroll') {
        if (vertical ? el.scrollHeight > el.clientHeight + 2 : el.scrollWidth > el.clientWidth + 2) {
          return el;
        }
      }
      el = el.parentNode;
    }
    return null;
  }

  // Scroll the area under (x, y) or under the highlighted element.
  // Returns true when something actually moved.
  function scrollPage(dir, point) {
    var v = viewport();
    var vertical = dir === 'up' || dir === 'down';
    var amount = vertical ? Math.round(v.h * 0.5) : Math.round(v.w * 0.5);
    if (point && point.amount) {
      amount = point.amount;
    }
    var dx = dir === 'left' ? -amount : (dir === 'right' ? amount : 0);
    var dy = dir === 'up' ? -amount : (dir === 'down' ? amount : 0);

    var from = null;
    if (point) {
      from = document.elementFromPoint(point.x, point.y);
    } else if (inDocument(current)) {
      from = current;
    } else {
      from = document.elementFromPoint(Math.round(v.w / 2), Math.round(v.h / 2));
    }
    var box = scrollableAncestor(from, vertical);
    if (box) {
      var beforeBox = vertical ? box.scrollTop : box.scrollLeft;
      box.scrollTop += dy;
      box.scrollLeft += dx;
      if ((vertical ? box.scrollTop : box.scrollLeft) !== beforeBox) {
        updateRing();
        return true;
      }
    }
    var beforeX = w.pageXOffset;
    var beforeY = w.pageYOffset;
    w.scrollBy(dx, dy);
    updateRing();
    return w.pageXOffset !== beforeX || w.pageYOffset !== beforeY;
  }

  function updateRing() {
    if (!ring) {
      ring = makeLayer('ring', 2147483646);
      ring.style.border = '4px solid ' + ACCENT;
      ring.style.borderRadius = '6px';
      ring.style.boxShadow = '0 0 0 2px rgba(0, 0, 0, 0.6)';
    }
    // While typing, the ring follows the active text field
    var target = isEditable(document.activeElement) ? document.activeElement : current;
    if (cursorMode || !inDocument(target)) {
      detach(ring);
      return;
    }
    var r = target.getBoundingClientRect();
    var v = viewport();
    if (r.bottom < 0 || r.top > v.h || r.right < 0 || r.left > v.w) {
      detach(ring);
      return;
    }
    var s = ring.style;
    s.left = Math.round(r.left - 5) + 'px';
    s.top = Math.round(r.top - 5) + 'px';
    s.width = Math.round(r.width + 10) + 'px';
    s.height = Math.round(r.height + 10) + 'px';
    attach(ring);
  }

  var ringPending = false;
  function scheduleRing() {
    if (ringPending) {
      return;
    }
    ringPending = true;
    w.setTimeout(safe(function () {
      ringPending = false;
      updateRing();
    }), 30);
  }

  // OK on the highlighted element
  function activate() {
    var el = current;
    if (!inDocument(el)) {
      return false;
    }
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2);
    var y = Math.round(r.top + r.height / 2);
    var tag = el.tagName;
    if (tag === 'IFRAME') {
      enterFrame(el);
    } else if (isEditable(el)) {
      startTyping(el); // the TV keyboard opens
    } else if (tag === 'VIDEO') {
      if (el.paused) {
        try { el.play(); } catch (e) { /* ignore */ }
      } else {
        el.pause();
      }
    } else if (tag === 'SELECT') {
      el.focus();
      fireMouse(el, 'mousedown', x, y);
    } else if (tag === 'A' && el.target === '_blank' && /^https?:/.test(el.href)) {
      navigate(el.href); // never open new windows
    } else {
      if (typeof el.focus === 'function') {
        try { el.focus(); } catch (e) { /* ignore */ }
      }
      clickElement(el, x, y);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Iframes: entering, leaving, clicks delegated from the main page
  // ---------------------------------------------------------------------------
  function enterFrame(frame) {
    try { frame.focus(); } catch (e) { /* ignore */ }
    try { postTo(frame.contentWindow, 'enter', {}); } catch (e) { /* ignore */ }
    showNotice('Dentro il riquadro: RETURN per uscire', 2500);
  }

  function leaveFrame(frame) {
    var active = document.activeElement;
    if (active && active.tagName === 'IFRAME') {
      if (!frame) {
        frame = active;
      }
      try { active.blur(); } catch (e) { /* ignore */ }
    }
    try { w.focus(); } catch (e) { /* ignore */ }
    if (frame) {
      setCurrent(frame);
    }
  }

  function clickAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) {
      return 'nothing';
    }
    if (el.tagName === 'IFRAME') {
      var r = el.getBoundingClientRect();
      var bx = el.clientLeft || 0;
      var by = el.clientTop || 0;
      postTo(el.contentWindow, 'clickAt', { x: Math.round(x - r.left - bx), y: Math.round(y - r.top - by) });
      return 'iframe';
    }
    clickElement(el, x, y);
    if (isEditable(el)) {
      startTyping(el);
    }
    return describeElement(el);
  }

  // ---------------------------------------------------------------------------
  // Text fields. A field counts as "typing" only when the user opened it (OK or
  // cursor click), not when the page focused it by itself (autofocus).
  // ---------------------------------------------------------------------------
  var typingTarget = null;

  function startTyping(el) {
    typingTarget = el;
    try { el.focus(); } catch (e) { /* ignore */ }
    updateRing();
  }

  function isTyping() {
    var active = document.activeElement;
    return !!active && isEditable(active) && active === typingTarget;
  }

  function stopTyping() {
    var active = document.activeElement;
    typingTarget = null;
    if (active && isEditable(active)) {
      try { active.blur(); } catch (e) { /* ignore */ }
    }
    updateRing();
  }

  // ---------------------------------------------------------------------------
  // Virtual cursor
  // ---------------------------------------------------------------------------
  var cursorMode = false;
  var cursorEl = null;
  var cursorPos = null;
  var accel = { key: 0, time: 0, level: 1 };
  var lastHover = 0;

  function drawCursor() {
    if (!cursorEl) {
      cursorEl = makeLayer('cursor', 2147483647);
      var s = cursorEl.style;
      s.width = '30px';
      s.height = '30px';
      s.borderRadius = '50%';
      s.border = '3px solid #ffffff';
      s.background = 'rgba(0, 140, 255, 0.55)';
      s.boxShadow = '0 0 0 2px rgba(0, 0, 0, 0.7)';
    }
    if (!cursorMode) {
      detach(cursorEl);
      return;
    }
    cursorEl.style.left = Math.round(cursorPos.x - 15) + 'px';
    cursorEl.style.top = Math.round(cursorPos.y - 15) + 'px';
    attach(cursorEl);
  }

  function setCursorMode(on) {
    cursorMode = on;
    if (on) {
      var v = viewport();
      if (!cursorPos) {
        cursorPos = lastCenter ? { x: lastCenter.x, y: lastCenter.y } : { x: v.w / 2, y: v.h / 2 };
      }
      cursorPos.x = Math.min(Math.max(cursorPos.x, 0), v.w - 1);
      cursorPos.y = Math.min(Math.max(cursorPos.y, 0), v.h - 1);
      leaveFrame(null);
    } else if (cursorPos) {
      lastCenter = { x: cursorPos.x, y: cursorPos.y };
    }
    drawCursor();
    updateRing();
    broadcastToFrames('mode', { cursor: cursorMode });
    showNotice(on ? 'Cursore attivo: frecce per muoverlo, OK per cliccare' : 'Cursore disattivato', 2200);
    scheduleRender();
  }

  function moveCursor(code) {
    var now = new Date().getTime();
    if (accel.key === code && now - accel.time < 250) {
      accel.level = Math.min(CURSOR_MAX_ACCEL, accel.level + 0.5);
    } else {
      accel.level = 1;
    }
    accel.key = code;
    accel.time = now;

    var step = CURSOR_STEP * accel.level;
    var v = viewport();
    var dir = DIR_BY_KEY[code];
    var dx = dir === 'left' ? -step : (dir === 'right' ? step : 0);
    var dy = dir === 'up' ? -step : (dir === 'down' ? step : 0);
    var nx = cursorPos.x + dx;
    var ny = cursorPos.y + dy;

    // Pushing against an edge scrolls the area under the cursor
    if (nx < 0 || nx > v.w - 1 || ny < 0 || ny > v.h - 1) {
      scrollPage(dir, { x: Math.round(cursorPos.x), y: Math.round(cursorPos.y), amount: EDGE_SCROLL });
    }
    cursorPos.x = Math.min(Math.max(nx, 0), v.w - 1);
    cursorPos.y = Math.min(Math.max(ny, 0), v.h - 1);
    drawCursor();

    // Hover effects (menus that open on mouse over), at most every 120 ms
    if (now - lastHover > 120) {
      lastHover = now;
      var el = document.elementFromPoint(Math.round(cursorPos.x), Math.round(cursorPos.y));
      if (el && el.tagName !== 'IFRAME') {
        fireMouse(el, 'mousemove', cursorPos.x, cursorPos.y);
        fireMouse(el, 'mouseover', cursorPos.x, cursorPos.y);
      }
    }
  }

  function cursorClick() {
    var result = clickAt(Math.round(cursorPos.x), Math.round(cursorPos.y));
    cursorFlash();
    scheduleRender();
    return result;
  }

  function cursorFlash() {
    if (!cursorEl) {
      return;
    }
    cursorEl.style.background = 'rgba(255, 214, 0, 0.9)';
    w.setTimeout(safe(function () {
      if (cursorEl) {
        cursorEl.style.background = 'rgba(0, 140, 255, 0.55)';
      }
    }), 180);
  }

  // ---------------------------------------------------------------------------
  // Key guide
  // ---------------------------------------------------------------------------
  var guide = null;

  function openGuide() {
    if (guide) {
      return;
    }
    guide = makeLayer('guide', 2147483647);
    var s = guide.style;
    var k = scaleFactor();
    s.left = '50%';
    s.top = '50%';
    s.webkitTransform = 'translate(-50%, -50%)';
    s.transform = 'translate(-50%, -50%)';
    s.width = Math.round(1150 * k) + 'px';
    s.padding = Math.round(28 * k) + 'px ' + Math.round(36 * k) + 'px';
    s.color = '#ffffff';
    glassStyle(s, 0.84); // sites can be bright and busy: a bit more tint than the home
    s.borderRadius = Math.round(28 * k) + 'px';
    s.fontSize = Math.round(24 * k) + 'px';

    var title = document.createElement('div');
    title.textContent = 'TV Browser - tasti';
    title.style.fontSize = Math.round(32 * k) + 'px';
    title.style.marginBottom = Math.round(16 * k) + 'px';
    guide.appendChild(title);

    for (var i = 0; i < GUIDE.length; i++) {
      var row = document.createElement('div');
      row.style.margin = Math.round(7 * k) + 'px 0';
      var keysBox = document.createElement('span');
      keysBox.style.display = 'inline-block';
      keysBox.style.width = Math.round(300 * k) + 'px';
      for (var c = 0; c < GUIDE[i][0].length; c++) {
        keysBox.appendChild(makeChip(GUIDE[i][0][c], k));
      }
      var d = document.createElement('span');
      d.textContent = GUIDE[i][1];
      d.style.color = '#d8dae3';
      row.appendChild(keysBox);
      row.appendChild(d);
      guide.appendChild(row);
    }
    var foot = document.createElement('div');
    foot.textContent = 'GUIDE o RETURN per chiudere  -  v' + VERSION;
    foot.style.marginTop = Math.round(16 * k) + 'px';
    foot.style.fontSize = Math.round(19 * k) + 'px';
    foot.style.color = '#c3c5cd';
    guide.appendChild(foot);
    attach(guide);
  }

  // A key drawn like the remote button
  function makeChip(label, k) {
    var chip = document.createElement('span');
    var s = chip.style;
    s.display = 'inline-block';
    s.minWidth = Math.round(34 * k) + 'px';
    s.padding = Math.round(3 * k) + 'px ' + Math.round(9 * k) + 'px';
    s.marginRight = Math.round(6 * k) + 'px';
    s.borderRadius = Math.round(7 * k) + 'px';
    s.textAlign = 'center';
    s.fontSize = Math.round(20 * k) + 'px';
    s.background = CHIP_COLORS[label] || '#3a3d46';
    s.color = (label === 'OK' || label === 'C') ? '#000000' : '#ffffff';
    chip.textContent = label;
    return chip;
  }

  function closeGuide() {
    detach(guide);
    guide = null;
  }

  // ---------------------------------------------------------------------------
  // Bookmarks: saved by the home page (fixed origin), never in the website
  // ---------------------------------------------------------------------------
  var pendingAdd = null;

  function bookmarkUrl(mode) {
    var title = '';
    try {
      title = document.title || loc.hostname;
    } catch (e) { /* ignore */ }
    return HOME_URL + '?mode=' + mode + '&add=' + encodeURIComponent(w.location.href) +
      '&title=' + encodeURIComponent(shorten(title, 100));
  }

  function addBookmark() {
    if (!/^https?:/.test(w.location.href)) {
      showNotice('Questa pagina non può essere aggiunta ai preferiti', 2500);
      return;
    }
    if (pendingAdd) {
      return;
    }
    // First try without leaving the page: the home page in a hidden frame
    var frame = document.createElement('iframe');
    frame.setAttribute('data-tvb', 'bookmark-frame');
    var s = frame.style;
    s.position = 'fixed';
    s.left = '-10px';
    s.top = '-10px';
    s.width = '1px';
    s.height = '1px';
    s.opacity = '0';
    s.border = '0';
    s.pointerEvents = 'none';
    frame.src = bookmarkUrl('frame');
    pendingAdd = {
      frame: frame,
      timer: w.setTimeout(safe(bookmarkFallback), BOOKMARK_TIMEOUT_MS)
    };
    attach(frame);
  }

  function finishBookmark(result) {
    if (!pendingAdd) {
      return;
    }
    if (result === 'noservice') {
      // The bookmark service did not answer: save through the home page instead
      bookmarkFallback();
      return;
    }
    w.clearTimeout(pendingAdd.timer);
    detach(pendingAdd.frame);
    pendingAdd = null;
    if (result === 'exists') {
      showNotice('Già nei preferiti', 2500);
    } else if (result === 'added') {
      showNotice('Aggiunto ai preferiti', 2500);
    } else if (result === 'full') {
      showNotice('Troppi preferiti: eliminane qualcuno dalla home', 3000);
    } else {
      showNotice('Impossibile salvare il preferito', 3000);
    }
  }

  // The site blocked the hidden frame: save through the home page and come back
  function bookmarkFallback() {
    if (!pendingAdd) {
      return;
    }
    w.clearTimeout(pendingAdd.timer);
    detach(pendingAdd.frame);
    pendingAdd = null;
    navigate(bookmarkUrl('nav'));
  }

  // ---------------------------------------------------------------------------
  // Loading bar (top of the screen)
  // ---------------------------------------------------------------------------
  var loadBar = null;
  var loadTimer = null;
  var loadWidth = 0;

  function showLoadBar() {
    if (!isTop) {
      return;
    }
    if (!loadBar) {
      loadBar = makeLayer('loadbar', 2147483647);
      loadBar.style.left = '0';
      loadBar.style.top = '0';
      loadBar.style.height = Math.max(3, Math.round(5 * scaleFactor())) + 'px';
      loadBar.style.background = ACCENT;
    }
    loadWidth = Math.max(loadWidth, 10);
    loadBar.style.width = loadWidth + '%';
    attach(loadBar);
    if (!loadTimer) {
      loadTimer = w.setInterval(safe(function () {
        loadWidth = loadWidth + (90 - loadWidth) * 0.12;
        loadBar.style.width = Math.round(loadWidth) + '%';
      }), 250);
      // Never stay on screen forever
      w.setTimeout(safe(hideLoadBar), 30000);
    }
  }

  function hideLoadBar() {
    if (loadTimer) {
      w.clearInterval(loadTimer);
      loadTimer = null;
    }
    if (loadBar && loadBar.parentNode) {
      loadBar.style.width = '100%';
      w.setTimeout(safe(function () {
        detach(loadBar);
        loadWidth = 0;
      }), 250);
    }
  }

  function navigate(url) {
    showLoadBar();
    w.location.href = url;
  }

  // ---------------------------------------------------------------------------
  // RETURN on the first page
  // ---------------------------------------------------------------------------
  var exitPending = false;
  var exitTimer = null;

  function askExit() {
    exitPending = true;
    showNotice('Per uscire premi EXIT sul telecomando', EXIT_CONFIRM_MS);
    if (exitTimer) {
      w.clearTimeout(exitTimer);
    }
    exitTimer = w.setTimeout(safe(function () {
      exitPending = false;
    }), EXIT_CONFIRM_MS);
  }

  // ---------------------------------------------------------------------------
  // Debug overlay (key 0) and error indicator
  // ---------------------------------------------------------------------------
  var debugVisible = false;
  var debugBox = null;
  var errorDot = null;

  function buildDebugText() {
    var lines = [];
    lines.push('TVB v' + VERSION + ' on ' + (loc.hostname || '?') + '  |  runs: ' + (w.__TVB__ ? w.__TVB__.runs : '?'));
    lines.push('URL: ' + shorten(w.location.href, 90));
    lines.push('Mode: ' + (cursorMode ? 'cursor' : 'highlight') + '  |  current: ' + describeElement(current));
    lines.push('Typing: ' + (isTyping() ? 'yes' : 'no') + '  |  active: ' + describeElement(document.activeElement));
    lines.push('Viewport: ' + viewport().w + 'x' + viewport().h + '  |  first page: ' + (isFirstPage() ? 'yes' : 'no') +
      '  |  white bg: ' + (whiteBackgroundApplied ? 'applied' : 'no'));
    lines.push('Video: ' + describeVideo());
    lines.push('Iframes: ' + childFrames().length + ', with TVB: ' + (frames.length ? frames.join(', ') : 'none'));
    lines.push('Media found (' + mediaTotal + ', segments: ' + segmentCount + '):' + (media.length ? '' : ' none'));
    for (var i = 0; i < media.length; i++) {
      lines.push('  ' + media[i]);
    }
    lines.push('Keys: ' + (keys.length ? keys.join(', ') : '-'));
    lines.push('Errors:' + (errors.length ? '' : ' none'));
    for (var j = 0; j < errors.length; j++) {
      lines.push('  ' + errors[j]);
    }
    return lines.join('\n');
  }

  function render() {
    renderPending = false;
    if (!isTop) {
      return;
    }
    if (debugVisible) {
      if (!debugBox) {
        debugBox = makeLayer('debug', 2147483647);
        var s = debugBox.style;
        s.top = '10px';
        s.right = '10px';
        s.maxWidth = '55%';
        s.padding = '8px 10px';
        s.fontFamily = 'monospace';
        s.fontSize = '15px';
        s.whiteSpace = 'pre-wrap';
        s.wordWrap = 'break-word';
        s.color = '#ffffff';
        s.background = 'rgba(150, 0, 0, 0.9)';
        s.borderRadius = '6px';
      }
      var text = buildDebugText();
      if (debugBox.textContent !== text) {
        debugBox.textContent = text;
      }
      attach(debugBox);
    } else {
      detach(debugBox);
    }

    if (!errorDot) {
      errorDot = makeLayer('error-dot', 2147483647);
      var d = errorDot.style;
      d.top = '12px';
      d.right = '12px';
      d.width = '16px';
      d.height = '16px';
      d.borderRadius = '50%';
      d.background = '#e24b4a';
      d.border = '2px solid #ffffff';
    }
    if (errors.length && !debugVisible) {
      attach(errorDot);
    } else {
      detach(errorDot);
    }
  }

  var renderPending = false;
  function scheduleRender() {
    if (renderPending || !isTop) {
      return;
    }
    renderPending = true;
    w.setTimeout(safe(render), 50);
  }

  // ---------------------------------------------------------------------------
  // Pages that set no background (modern CSS the TV does not understand) would
  // show TizenBrew's black window behind dark text: use white, like browsers do.
  // ---------------------------------------------------------------------------
  var whiteBackgroundApplied = false;

  function isTransparent(color) {
    return !color || color === 'transparent' || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(color);
  }

  function fixBackground() {
    if (!isTop || whiteBackgroundApplied || !document.documentElement || !document.body) {
      return;
    }
    var htmlBg = w.getComputedStyle(document.documentElement).backgroundColor;
    var bodyBg = w.getComputedStyle(document.body).backgroundColor;
    var htmlImg = w.getComputedStyle(document.documentElement).backgroundImage;
    var bodyImg = w.getComputedStyle(document.body).backgroundImage;
    if (isTransparent(htmlBg) && isTransparent(bodyBg) && htmlImg === 'none' && bodyImg === 'none') {
      document.documentElement.style.backgroundColor = '#ffffff';
      whiteBackgroundApplied = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Videos: "video detected" message, A = full screen, media keys
  // ---------------------------------------------------------------------------
  var videoEl = null;       // detected video in this document
  var videoFrame = null;    // (main page) iframe that reported a playing video
  var pseudoFull = null;    // { el, style } when full screen is simulated with CSS
  var announced = false;    // message shown once per page

  function pickVideo() {
    var best = null;
    var bestArea = 0;
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) {
      var v = videos[i];
      if (v.getAttribute('data-tvb')) {
        continue;
      }
      var r = v.getBoundingClientRect();
      var area = r.width * r.height + (v.paused ? 0 : 1e9); // playing videos first
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function describeVideo() {
    if (videoEl) {
      return (videoEl.paused ? 'paused' : 'playing') + ' ' + Math.round(videoEl.currentTime || 0) + 's' +
        (fullscreenElement() || pseudoFull ? ' (full screen)' : '');
    }
    return videoFrame ? 'in iframe' : 'none';
  }

  function onVideoPlaying(ev) {
    var v = ev && ev.target;
    if (!v || v.tagName !== 'VIDEO' || (v.getAttribute && v.getAttribute('data-tvb'))) {
      return;
    }
    videoEl = v;
    if (isTop) {
      videoFrame = null;
      announceVideo();
    } else {
      postToTop('video', { playing: true });
    }
    scheduleRender();
  }

  function announceVideo() {
    if (announced || fullscreenElement() || pseudoFull) {
      return;
    }
    announced = true;
    showNotice('Video rilevato: premi A (rosso) per lo schermo intero', 4000);
  }

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function requestFull(el) {
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    if (!fn) {
      return false;
    }
    try {
      var result = fn.call(el);
      if (result && typeof result.then === 'function') {
        result.then(null, function () {
          if (!fullscreenElement()) {
            pseudoFullscreen(el);
          }
        });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // Full screen simulated with CSS (when the real one is refused)
  function pseudoFullscreen(el) {
    if (pseudoFull) {
      return;
    }
    pseudoFull = { el: el, style: el.getAttribute('style') };
    var s = el.style;
    s.position = 'fixed';
    s.left = '0';
    s.top = '0';
    s.width = '100%';
    s.height = '100%';
    s.maxWidth = 'none';
    s.maxHeight = 'none';
    s.zIndex = '2147483640';
    s.background = '#000000';
    s.margin = '0';
  }

  function exitFull() {
    if (pseudoFull) {
      if (pseudoFull.style === null) {
        pseudoFull.el.removeAttribute('style');
      } else {
        pseudoFull.el.setAttribute('style', pseudoFull.style);
      }
      pseudoFull = null;
      if (isTop) {
        broadcastToFrames('videoExit', {});
      }
      return true;
    }
    if (fullscreenElement()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen;
      if (exit) {
        try { exit.call(document); } catch (e) { /* ignore */ }
      }
      return true;
    }
    return false;
  }

  // Key A on the main page
  function videoFullscreen() {
    if (videoFrame && inDocument(videoFrame)) {
      // Video inside an iframe: make the whole frame full screen, and ask the frame to fill it with the video
      videoFrame.setAttribute('allowfullscreen', 'true');
      if (!requestFull(videoFrame)) {
        pseudoFullscreen(videoFrame);
      }
      postTo(videoFrame.contentWindow, 'videoFill', {});
      return;
    }
    var v = (videoEl && inDocument(videoEl)) ? videoEl : pickVideo();
    if (!v) {
      showNotice('Nessun video rilevato in questa pagina', 2500);
      return;
    }
    videoEl = v;
    if (!requestFull(v)) {
      pseudoFullscreen(v);
    }
  }

  // Play / pause / seek, on our video or forwarded to the iframe that has it
  function videoCommand(cmd) {
    if (isTop && videoFrame && inDocument(videoFrame) && !(videoEl && inDocument(videoEl))) {
      postTo(videoFrame.contentWindow, 'videoCmd', { cmd: cmd });
      return true;
    }
    var v = (videoEl && inDocument(videoEl)) ? videoEl : null;
    if (!v) {
      return false;
    }
    try {
      if (cmd === 'play') {
        v.play();
      } else if (cmd === 'pause') {
        v.pause();
      } else if (cmd === 'rewind') {
        v.currentTime = Math.max(0, v.currentTime - SEEK_SECONDS);
      } else if (cmd === 'forward') {
        v.currentTime = Math.min(v.duration || v.currentTime + SEEK_SECONDS, v.currentTime + SEEK_SECONDS);
      }
    } catch (e) { /* ignore */ }
    return true;
  }

  var MEDIA_COMMANDS = { 415: 'play', 19: 'pause', 412: 'rewind', 417: 'forward' };

  // ---------------------------------------------------------------------------
  // Media detection (debug now, "extract video" later)
  // ---------------------------------------------------------------------------
  function addMedia(url, source, fromFrame) {
    if (!url || typeof url !== 'string' || mediaSeen[url]) {
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
        scheduleRender();
        return;
      }
    }
    pushLimited(media, (fromFrame ? 'iframe/' : '') + source + ' ' + shorten(url, 90));
    if (!isTop) {
      postToTop('media', { source: source, url: url });
    }
    scheduleRender();
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

  function installHooks() {
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
      }
    } catch (e) { /* ignore */ }

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
      }
    } catch (e) { /* ignore */ }
  }

  var perfIndex = 0;
  function scanPage() {
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length && i < 20; i++) {
      var src = videos[i].currentSrc || videos[i].src;
      if (src) {
        addMedia(src, src.indexOf('blob:') === 0 ? 'video(MSE blob)' : 'video');
      }
    }
    if (w.performance && typeof w.performance.getEntriesByType === 'function') {
      var entries = w.performance.getEntriesByType('resource');
      if (entries.length < perfIndex) {
        perfIndex = 0;
      }
      for (var j = perfIndex; j < entries.length; j++) {
        if (entries[j].name && MEDIA_RE.test(entries[j].name)) {
          addMedia(entries[j].name, 'perf');
        }
      }
      perfIndex = entries.length;
    }
  }

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  // Keys always handled by the main page (forwarded from iframes)
  function isGlobalKey(code) {
    return code === KEY.BACK || code === KEY.GREEN || code === KEY.YELLOW || code === KEY.RED ||
      code === KEY.TOOLS || code === KEY.INFO || code === KEY.GUIDE;
  }

  function isNavKey(code) {
    return !!DIR_BY_KEY[code] || code === KEY.OK;
  }

  // Main page. "fromFrame" is null for keys pressed in the main page, or
  // { frame: <iframe element or null> } for keys forwarded by an iframe.
  // Returns true when the key was used.
  function handleKey(code, fromFrame) {
    if (guide) {
      if (code === KEY.GUIDE || code === KEY.BACK) {
        closeGuide();
        return true;
      }
      return isNavKey(code); // the page stays still while the guide is open
    }

    if (code === KEY.BACK && exitFull()) {
      return true;
    }

    var active = document.activeElement;
    var typing = !fromFrame && isTyping();

    // A text field focused by the page itself (autofocus) must not trap the keys
    if (!fromFrame && !typing && isEditable(active) && (DIR_BY_KEY[code] || code === KEY.BACK)) {
      try { active.blur(); } catch (e) { /* ignore */ }
      if (code === KEY.BACK) {
        updateRing();
        return true;
      }
    }

    if (code === KEY.BACK) {
      if (typing) {
        stopTyping();
        return true;
      }
      if (fromFrame || (active && active.tagName === 'IFRAME')) {
        leaveFrame(fromFrame ? fromFrame.frame : null);
        return true;
      }
      if (exitPending) {
        return true;
      }
      if (isFirstPage()) {
        askExit();
      } else {
        showLoadBar();
        w.history.back();
      }
      return true;
    }

    // Our keys work even while typing (they are not characters)
    if (code === KEY.TOOLS) {
      if (typing) { stopTyping(); }
      setCursorMode(!cursorMode);
      return true;
    }
    if (code === KEY.GUIDE) {
      openGuide();
      return true;
    }
    if (code === KEY.INFO) {
      debugVisible = !debugVisible;
      render();
      return true;
    }
    if (code === KEY.YELLOW) {
      navigate(HOME_URL);
      return true;
    }
    if (code === KEY.GREEN) {
      addBookmark();
      return true;
    }
    if (code === KEY.RED) {
      videoFullscreen();
      return true;
    }
    if (MEDIA_COMMANDS[code]) {
      videoCommand(MEDIA_COMMANDS[code]);
      return false; // let the site react to its media keys too
    }

    if (typing) {
      // Up/down leave the field; letters, digits, OK, left/right belong to the field
      if (code === KEY.UP || code === KEY.DOWN) {
        stopTyping();
        if (!cursorMode) {
          moveFocus(DIR_BY_KEY[code]);
        }
        return true;
      }
      return false;
    }

    if (DIR_BY_KEY[code]) {
      if (cursorMode) {
        moveCursor(code);
      } else {
        moveFocus(DIR_BY_KEY[code]);
      }
      return true;
    }
    if (code === KEY.OK) {
      if (cursorMode) {
        cursorClick();
        return true;
      }
      return activate();
    }
    return false;
  }

  // Iframe. Returns true when the key was used.
  var frameCursorMode = false;
  function handleFrameKey(code) {
    if (MEDIA_COMMANDS[code]) {
      videoCommand(MEDIA_COMMANDS[code]); // the video is here
      return false;
    }
    if (code === KEY.BACK && exitFull()) {
      return true;
    }
    if (isGlobalKey(code) || (frameCursorMode && isNavKey(code))) {
      if (isTyping() && code === KEY.BACK) {
        stopTyping();
        return true;
      }
      postToTop('key', { code: code });
      return true;
    }
    if (isTyping()) {
      return false;
    }
    if (DIR_BY_KEY[code]) {
      var dir = DIR_BY_KEY[code];
      if (isEditable(document.activeElement)) {
        try { document.activeElement.blur(); } catch (e) { /* ignore */ }
      }
      if (!moveFocus(dir)) {
        postToTop('navEdge', { dir: dir }); // nothing more here: continue in the main page
      }
      return true;
    }
    if (code === KEY.OK) {
      return activate();
    }
    return false;
  }

  function onKeyDown(ev) {
    var code = ev.keyCode || ev.which || 0;
    pushLimited(keys, code + (ev.key ? ' ' + ev.key : ''));
    scheduleRender();
    var used = isTop ? handleKey(code, null) : handleFrameKey(code);
    if (used) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  // Never open new windows from links: open them in the same page
  function onClick(ev) {
    var a = closestTag(ev.target, 'A');
    if (a && a.target === '_blank' && /^https?:/.test(a.href || '')) {
      ev.preventDefault();
      navigate(a.href);
    }
  }

  function onMessage(ev) {
    var msg = ev && ev.data;
    if (!msg) {
      return;
    }
    // Answer from the home page in the hidden bookmark frame
    if (msg.__tvbHome === 1) {
      if (pendingAdd && ev.source === pendingAdd.frame.contentWindow) {
        finishBookmark(String(msg.result));
      }
      return;
    }
    if (msg.__tvb !== 1 || !msg.data) {
      return;
    }
    var data = msg.data;
    if (isTop) {
      var frame = frameElementFor(ev.source);
      if (msg.type === 'frame') {
        var label = shorten(String(data.host), 40);
        for (var i = 0; i < frames.length; i++) {
          if (frames[i] === label) {
            frames.splice(i, 1);
            break;
          }
        }
        pushLimited(frames, label);
        if (frame && cursorMode) {
          postTo(frame.contentWindow, 'mode', { cursor: true });
        }
      } else if (msg.type === 'media') {
        addMedia(String(data.url), String(data.source), true);
      } else if (msg.type === 'key') {
        var code = Number(data.code);
        pushLimited(keys, 'iframe:' + code);
        handleKey(code, { frame: frame });
      } else if (msg.type === 'navEdge') {
        leaveFrame(frame);
        if (!cursorMode) {
          moveFocus(String(data.dir));
        }
      } else if (msg.type === 'video') {
        if (frame && !(videoEl && inDocument(videoEl) && !videoEl.paused)) {
          videoFrame = frame;
          announceVideo();
        }
      }
      scheduleRender();
      return;
    }
    // Inside an iframe: messages from the page that contains us
    if (msg.type === 'mode') {
      frameCursorMode = !!data.cursor;
      broadcastToFrames('mode', data);
    } else if (msg.type === 'clickAt') {
      clickAt(Number(data.x), Number(data.y));
    } else if (msg.type === 'enter') {
      if (!inDocument(current)) {
        moveFocus('down');
      } else {
        updateRing();
      }
    } else if (msg.type === 'videoFill') {
      // The main page put this frame in full screen: fill it with the video
      var v = (videoEl && inDocument(videoEl)) ? videoEl : pickVideo();
      if (v) {
        videoEl = v;
        pseudoFullscreen(v);
      }
    } else if (msg.type === 'videoExit') {
      exitFull();
    } else if (msg.type === 'videoCmd') {
      videoCommand(String(data.cmd));
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  try {
    w.addEventListener('keydown', safe(onKeyDown), true);
    document.addEventListener('click', safe(onClick), true);
    document.addEventListener('playing', safe(onVideoPlaying), true); // media events do not bubble: capture
    w.addEventListener('message', safe(onMessage));
    w.addEventListener('scroll', safe(scheduleRing), true);
    w.addEventListener('resize', safe(scheduleRing));
    w.addEventListener('beforeunload', safe(showLoadBar));
    w.addEventListener('error', safe(function (ev) {
      if (!ev || !ev.message) {
        return; // resource load errors
      }
      var file = ev.filename ? ' (' + shorten(String(ev.filename).split('/').pop(), 30) + ':' + (ev.lineno || '?') + ')' : '';
      addError(ev.message + file);
    }), true);
    var leaveFull = safe(function () {
      if (!fullscreenElement() && isTop && videoFrame) {
        broadcastToFrames('videoExit', {});
      }
    });
    document.addEventListener('fullscreenchange', leaveFull);
    document.addEventListener('webkitfullscreenchange', leaveFull);
  } catch (e) { /* ignore */ }

  installHooks();
  reportFrame();

  // The page may still be loading when we arrive
  try {
    if (isTop && document.readyState !== 'complete') {
      showLoadBar();
    }
    document.addEventListener('DOMContentLoaded', safe(function () {
      reportFrame();
      fixBackground();
    }));
    w.addEventListener('load', safe(function () {
      reportFrame();
      fixBackground();
      hideLoadBar();
    }));
  } catch (e) { /* ignore */ }

  var ticks = 0;
  w.setInterval(safe(function () {
    ticks += 1;
    scanPage();
    if (current && !inDocument(current)) {
      current = null;
    }
    if (ticks <= 5) {
      fixBackground();
    }
    if (videoEl && !inDocument(videoEl)) {
      videoEl = null;
    }
    // A video that was already playing before we arrived
    if (!videoEl) {
      var v = pickVideo();
      if (v && !v.paused) {
        onVideoPlaying({ target: v });
      }
    }
    if (document.readyState === 'complete' && loadTimer && ticks > 2) {
      hideLoadBar();
    }
    updateRing();
    if (cursorMode) {
      drawCursor();
    }
    if (debugVisible || errors.length) {
      render();
    }
  }), TICK_MS);
})();
