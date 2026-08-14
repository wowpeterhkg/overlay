/* @idnerd/overlay UI — dev-only, injected by the Vite plugin or mounted by
   the extension. Vanilla JS, no build step needed at runtime. Never present
   in production builds (the plugin is serve-only). */
// A node is "overlay-owned" if it's an element carrying one of our own
// ovl-* classes (pin, hilite, float, bubble, ...) — i.e. DOM churn we
// created ourselves, not something the host app rendered.
export function isOverlayOwned(node) {
  if (!node || node.nodeType !== 1) return false;
  var cls = node.className;
  if (typeof cls !== 'string') return false;
  return cls.indexOf('ovl-') !== -1;
}

// A mutation is "internal" (ignored — never triggers a pins re-render) when
// it's entirely inside our own DOM: the target is inside root, the target
// itself is one of our own elements (ovl-* class), or every added/removed
// node is overlay-owned (pin/hilite/float churn on document.body). This is
// what stops renderPins' own remove+append cycle from feeding back into
// itself (cause (a) of the pin-flash bug) while still reacting to genuine
// app DOM changes.
export function isExternalMutation(m, rootEl) {
  if (rootEl.contains(m.target)) return false;
  if (isOverlayOwned(m.target)) return false;
  if (m.type === 'childList') {
    var nodes = Array.prototype.slice.call(m.addedNodes).concat(Array.prototype.slice.call(m.removedNodes));
    if (nodes.length && nodes.every(isOverlayOwned)) return false;
  }
  return true;
}

export function mountOverlay(opts) {
  var store = opts.store;
  var PRESET = opts.preset;
  var HOTKEY = opts.hotkey || 'Alt+A';
  var ROOT_ID = 'overlay-root';
  var enrich = opts.enrich || null;
  var getShot = opts.getShot || null;
  function applyEnrich(tag, target) {
    if (!enrich) return;
    Promise.resolve().then(function () { return enrich(tag, target); })
      .then(function (patch) { if (patch && Object.keys(patch).length) { store.update(tag.id, patch); render(); } })
      .catch(function () { /* enrichment is best-effort — tag already saved */ });
  }

  var destroyed = false; // set true by destroy(); guards render()/renderPins() against
                         // async callbacks (enrich patches, getShot, etc.) that resolve
                         // after teardown and would otherwise resurrect body-level DOM
                         // (pins, highlight box) even though root itself was removed.
  var addMode = false;
  var panelOpen = true;
  var expandedId = null;
  var tab = 'page'; // 'page' | 'all'
  var hovered = null;     // last element under cursor while add-mode armed
  var floatNoteId = null; // note whose bubble is open (Show = toggle)
  var hi = null;          // single floating highlight box (leak-proof)

  function route() { return location.pathname + location.search; }
  function uid() { return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function isPage(n) { return n.scope === 'page'; }
  function findNote(id) { return store.list().filter(function (x) { return x.id === id; })[0]; }

  // ---- selector engine: prefer data-testid, else short structural path ----
  function describe(target) {
    var textHint = (target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    var testidEl = target.closest('[data-testid]');
    if (testidEl) {
      return { selector: '[data-testid="' + testidEl.getAttribute('data-testid') + '"]', testid: testidEl.getAttribute('data-testid'), textHint: textHint };
    }
    return { selector: cssPath(target), testid: null, textHint: textHint };
  }
  function cssPath(node) {
    if (node.id) return '#' + CSS.escape(node.id);
    var parts = [];
    for (var depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      var tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      var parent = node.parentElement;
      if (parent) {
        var sib = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (sib.length > 1) tag += ':nth-of-type(' + (sib.indexOf(node) + 1) + ')';
      }
      parts.unshift(tag);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function resolve(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }

  // ---- target highlighting: hover peek (dashed) + Show flash (solid + scroll)
  function peek(sel, on) { if (on) showHi(resolve(sel)); else hideHi(); }
  function flashTarget(sel) {
    var t = resolve(sel); if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.style.outline = '2px solid #C44545'; t.style.outlineOffset = '2px';
    setTimeout(function () { t.style.outline = ''; t.style.outlineOffset = ''; }, 1200);
  }
  // Single floating highlight box, positioned over the hovered/peeked element.
  // It never touches the app's own styles, so a highlight can't "stick" — a
  // per-element outline mutation could leak boxes all over the page.
  function ensureHi() { if (!hi) { hi = el('div', 'ovl-hilite'); document.body.appendChild(hi); } return hi; }
  function showHi(t) {
    if (!t || !t.getBoundingClientRect) { hideHi(); return; }
    var r = t.getBoundingClientRect();
    if (!r.width && !r.height) { hideHi(); return; }
    var h = ensureHi();
    h.style.left = r.left + 'px'; h.style.top = r.top + 'px';
    h.style.width = r.width + 'px'; h.style.height = r.height + 'px';
    h.style.display = 'block';
  }
  function hideHi() { if (hi) hi.style.display = 'none'; }

  // ---- floating card (composer / bubble), anchored beside a target rect.
  // Lives on <body> (not the overlay root) so panel re-renders don't kill it.
  var floatEl = null;
  function closeFloat() { if (floatEl) { floatEl.remove(); floatEl = null; } floatNoteId = null; }
  function openFloat() {
    closeFloat();
    var card = el('div', 'ovl-float');
    // keep composer/bubble clicks from reaching the app's outside-click handlers
    ['pointerdown', 'mousedown', 'click'].forEach(function (ev) { card.addEventListener(ev, function (e) { e.stopPropagation(); }); });
    document.body.appendChild(card);
    floatEl = card;
    return card;
  }
  function placeFloat(card, rect) {
    var x = rect.left + Math.min(rect.width, 16) + 14;
    var y = rect.top - 6;
    var w = card.offsetWidth || 252;
    var h = card.offsetHeight || 90;
    if (x + w > window.innerWidth - 8) x = Math.max(8, rect.left - w - 10);
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    if (y < 8) y = 8;
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }
  function fallbackRect() {
    return { left: window.innerWidth / 2 - 126, top: window.innerHeight / 3, width: 0 };
  }

  // Inline composer beside the element — replaces window.prompt for both
  // create and edit (prompt dialogs can be suppressed by the browser).
  function openComposer(rect, selector, initial, onSave) {
    var card = openFloat();
    card.appendChild(el('div', 'ovl-meta', selector));
    var ta = document.createElement('textarea');
    ta.className = 'ovl-ta';
    ta.value = initial || '';
    ta.placeholder = 'What should change here?';
    card.appendChild(ta);
    var acts = el('div', 'ovl-float-acts');
    var cancel = el('button', 'ovl-mini', 'Cancel');
    cancel.onclick = closeFloat;
    var saveB = el('button', 'ovl-act ovl-act-primary', 'Save');
    saveB.style.padding = '3px 12px';
    saveB.onclick = function () {
      var v = ta.value.trim();
      closeFloat();
      if (v) onSave(v);
    };
    acts.appendChild(cancel); acts.appendChild(saveB);
    card.appendChild(acts);
    placeFloat(card, rect);
    ta.focus();
    ta.addEventListener('keydown', function (e) {
      e.stopPropagation(); // keep app hotkeys + overlay Esc handler out of typing
      if (e.key === 'Escape') closeFloat();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveB.onclick();
    });
  }

  // Per-tag screenshot preview + copy-to-clipboard. Silent absence: no
  // getShot wired, no screenshotId on the tag, or no Clipboard Image support
  // (insecure context, old browser) → just don't render the well, rather
  // than showing a broken control.
  function buildShotWell(tag) {
    if (!getShot || !tag.screenshotId || !navigator.clipboard || !window.ClipboardItem || !window.isSecureContext) return null;
    var well = el('div', 'ovl-shot');
    var loader = el('div', 'ovl-shot-load', '…fetching shot');
    well.appendChild(loader);
    Promise.resolve(getShot(tag)).then(function (shot) {
      if (!shot || !shot.dataUrl) { well.remove(); return; }
      well.innerHTML = '';
      if (shot.cropped === false) well.appendChild(el('span', 'ovl-shot-flag', 'uncropped'));
      var img = document.createElement('img');
      img.src = shot.dataUrl;
      well.appendChild(img);
      var acts = el('div', 'ovl-shot-acts');
      var copyB = el('button', 'ovl-shot-copy', 'copy png');
      copyB.onclick = function (e) {
        e.stopPropagation();
        fetch(shot.dataUrl).then(function (r) { return r.blob(); }).then(function (b) {
          return navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
        }).then(function () {
          copyB.textContent = 'copied ✓'; copyB.classList.add('ok');
          setTimeout(function () { copyB.textContent = 'copy png'; copyB.classList.remove('ok'); }, 1400);
        }, function () {
          copyB.textContent = 'copy failed';
          setTimeout(function () { copyB.textContent = 'copy png'; }, 1400);
        });
      };
      acts.appendChild(copyB);
      well.appendChild(acts);
    }, function () { well.remove(); });
    return well;
  }

  // Comment bubble beside the pin (pin click / panel "Show"). Page notes have no
  // element, so they anchor to a fallback rect near the top of the viewport.
  function showBubble(n) {
    var pg = isPage(n);
    var t = pg ? null : resolve(n.selector);
    if (t) flashTarget(n.selector);
    var rect = t ? t.getBoundingClientRect() : fallbackRect();
    var card = openFloat();
    floatNoteId = n.id;
    var x = el('button', 'ovl-x', '✕');
    x.onclick = closeFloat;
    card.appendChild(x);
    card.appendChild(el('div', 'ovl-meta', '#' + (store.openTags().indexOf(n) + 1) + '  ' + (pg ? '(whole page)' : n.selector)));
    card.appendChild(el('div', 'ovl-bubble-note', n.note));
    var well = buildShotWell(n);
    if (well) card.appendChild(well);
    var acts = el('div', 'ovl-float-acts');
    var ed = el('button', 'ovl-mini', 'Edit');
    ed.onclick = function () { editNote(n.id); };
    var del = el('button', 'ovl-mini ovl-mini-danger', 'Delete');
    del.onclick = function () { closeFloat(); delNote(n.id); };
    acts.appendChild(ed); acts.appendChild(del);
    card.appendChild(acts);
    placeFloat(card, rect);
  }
  // Show is a toggle: clicking again while this note's bubble is open hides it.
  function toggleBubble(n) {
    if (floatEl && floatNoteId === n.id) { closeFloat(); return; }
    showBubble(n);
  }

  // ---- export blob (preset fix-prompt, then open tags grouped by route) ----
  function exportBlob() {
    var notes = store.openTags();
    var byRoute = {};
    notes.forEach(function (n, i) { (byRoute[n.route] = byRoute[n.route] || []).push({ n: n, i: i + 1 }); });
    var lines = [PRESET, ''];
    Object.keys(byRoute).forEach(function (r) {
      lines.push('route ' + r);
      byRoute[r].forEach(function (o) {
        if (isPage(o.n)) { lines.push('  #' + o.i + ' id=' + o.n.id + ' sel=(whole page)  "' + o.n.note + '"'); return; }
        var t = o.n.textHint ? ' text="' + o.n.textHint + '"' : '';
        lines.push('  #' + o.i + ' id=' + o.n.id + ' sel=' + o.n.selector + t + '  "' + o.n.note + '"');
      });
    });
    return lines.join('\n');
  }

  // ---- styles + root container ----
  var css =
    '#' + ROOT_ID + '{position:fixed;z-index:2147483000;font:13px Geist,system-ui,sans-serif;color:#1B1A18}' +
    '#' + ROOT_ID + ' *{box-sizing:border-box;font-family:inherit}' +
    '@keyframes ovl-arm{0%,100%{box-shadow:0 2px 10px rgba(196,69,69,.35)}50%{box-shadow:0 2px 18px rgba(196,69,69,.7)}}' +
    '@keyframes ovl-pop{from{transform:translate(-50%,-50%) scale(.4);opacity:0}to{transform:translate(-50%,-50%) scale(1);opacity:1}}' +
    '.ovl-fab{position:fixed;bottom:16px;right:16px;background:#1B1A18;color:#fff;border:0;border-radius:999px;padding:10px 14px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);font-size:13px}' +
    '.ovl-fab.armed{background:#C44545;animation:ovl-arm 1.2s ease-in-out infinite}' +
    '.ovl-panel{position:fixed;bottom:64px;right:16px;width:316px;background:#FBFAF7;border:1px solid #D4CFC2;border-radius:12px;box-shadow:0 12px 40px rgba(27,26,24,.22);overflow:hidden}' +
    '.ovl-bar{display:flex;gap:6px;align-items:center;padding:8px;border-bottom:1px solid #E2DED4;background:#F6F4EF}' +
    '.ovl-act{border:1px solid #D4CFC2;background:#EFECE4;color:#1B1A18;border-radius:7px;padding:4px 10px;cursor:pointer;font-size:12px;line-height:1.4;white-space:nowrap}' +
    '.ovl-act:hover{background:#E6E2D8}' +
    '.ovl-act-primary{background:#1B1A18;border-color:#1B1A18;color:#fff}' +
    '.ovl-act-primary:hover{background:#33312d}' +
    '.ovl-act-danger{margin-left:auto;background:transparent;border-color:transparent;color:#C44545}' +
    '.ovl-act-danger:hover{background:#F3E3E3;border-color:#E4C6C6}' +
    '.ovl-tabs{display:flex;border-bottom:1px solid #E2DED4;background:#FBFAF7}' +
    '.ovl-tab{flex:1;border:0;background:transparent;padding:7px 4px 6px;cursor:pointer;font-family:ui-monospace,Consolas,monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8E8880;border-bottom:2px solid transparent}' +
    '.ovl-tab.on{color:#1B1A18;border-bottom-color:#C44545}' +
    '.ovl-list{max-height:46vh;overflow:auto;padding:5px}' +
    '.ovl-row{border-radius:8px;padding:6px 8px;cursor:pointer}' +
    '.ovl-row:hover{background:#F1EEE6}' +
    '.ovl-row.open{background:#F4F1EA}' +
    '.ovl-rowhead{display:flex;align-items:baseline;gap:8px;min-width:0}' +
    '.ovl-num{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#C44545;flex:none;width:22px}' +
    '.ovl-warn .ovl-num{color:#C58A2E}' +
    '.ovl-txt{font-size:12.5px;color:#1B1A18;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}' +
    '.ovl-row.open .ovl-txt{white-space:normal}' +
    '.ovl-chip{flex:none;max-width:84px;font-family:ui-monospace,Consolas,monospace;font-size:9.5px;color:#8E8880;background:#EFECE4;border-radius:5px;padding:1px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.ovl-det{margin:6px 0 2px 30px}' +
    '.ovl-meta{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:#8E8880;word-break:break-all;margin-bottom:2px}' +
    '.ovl-warn .ovl-meta{color:#C58A2E}' +
    '.ovl-acts{display:flex;gap:4px;margin-top:6px}' +
    '.ovl-mini{border:1px solid #D4CFC2;background:#FBFAF7;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:11px;color:#555049}' +
    '.ovl-mini:hover{background:#EFECE4}' +
    '.ovl-mini-danger{color:#C44545;border-color:#E4C6C6}' +
    '.ovl-empty{padding:22px 12px;text-align:center;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8E8880;white-space:pre-line}' +
    '.ovl-pin{position:fixed;z-index:2147483000;width:20px;height:20px;border-radius:999px;background:#C44545;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;cursor:pointer;transform:translate(-50%,-50%);box-shadow:0 1px 4px rgba(0,0,0,.3);animation:ovl-pop .18s ease-out}' +
    '.ovl-pin-page{border-radius:4px;background:#33312d;transform:none;box-shadow:0 1px 5px rgba(0,0,0,.4)}' +
    '.ovl-pin-agent{background:#3B6FB5}' +
    '.ovl-hilite{position:fixed;z-index:2147482990;pointer-events:none;border:2px dashed #C44545;border-radius:4px;box-shadow:0 0 0 2px rgba(196,69,69,.15);display:none}' +
    '@keyframes ovl-fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}' +
    '.ovl-float{position:fixed;z-index:2147483001;width:252px;background:#FBFAF7;border:1px solid #D4CFC2;border-radius:10px;box-shadow:0 10px 34px rgba(27,26,24,.25);padding:8px;font:13px Geist,system-ui,sans-serif;color:#1B1A18;animation:ovl-fade .12s ease-out}' +
    '.ovl-float .ovl-meta{margin:0 16px 6px 0}' +
    '.ovl-ta{width:100%;min-height:52px;resize:vertical;border:1px solid #D4CFC2;border-radius:7px;background:#fff;padding:6px 8px;font-size:12.5px;font-family:inherit;color:#1B1A18;outline:none}' +
    '.ovl-ta:focus{border-color:#8E8880}' +
    '.ovl-float-acts{display:flex;gap:6px;margin-top:6px;justify-content:flex-end}' +
    '.ovl-bubble-note{font-size:12.5px;color:#1B1A18;margin:2px 0 4px;overflow-wrap:break-word}' +
    '.ovl-x{position:absolute;top:4px;right:6px;border:0;background:none;color:#8E8880;cursor:pointer;font-size:12px;padding:2px}' +
    '.ovl-unanch{color:#C58A2E}' +
    '.ovl-shot{position:relative;margin:4px 0 6px;border:1px solid #D4CFC2;border-radius:7px;background:#F1EEE6;overflow:hidden}' +
    '.ovl-shot img{display:block;width:100%;max-height:110px;object-fit:contain}' +
    '.ovl-shot-acts{position:absolute;right:4px;bottom:4px;display:flex;gap:4px;opacity:0;transition:opacity .12s ease}' +
    '.ovl-shot:hover .ovl-shot-acts{opacity:1}' +
    '.ovl-shot-copy{border:1px solid #D4CFC2;background:rgba(251,250,247,.94);border-radius:6px;padding:2px 8px;cursor:pointer;font-family:ui-monospace,Consolas,monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:#555049}' +
    '.ovl-shot-copy:hover{background:#EFECE4}' +
    '.ovl-shot-copy.ok{color:#1B1A18;border-color:#1B1A18}' +
    '.ovl-shot-flag{position:absolute;left:4px;top:4px;font-family:ui-monospace,Consolas,monospace;font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:#C58A2E;background:rgba(251,250,247,.9);border-radius:5px;padding:1px 5px}' +
    '.ovl-shot-load{padding:14px;text-align:center;font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#8E8880}';
  if (!document.getElementById(ROOT_ID + '-style')) {
    var style = document.createElement('style'); style.id = ROOT_ID + '-style'; style.textContent = css; document.head.appendChild(style);
  }
  var root = document.getElementById(ROOT_ID);
  if (!root) { root = document.createElement('div'); root.id = ROOT_ID; document.body.appendChild(root); }
  // Panel interactions must NOT reach the app's outside-click handlers (apps
  // often close dropdowns on a document mousedown). Swallow pointer events at
  // the root so clicking +Add never collapses an open dropdown.
  ['pointerdown', 'mousedown', 'click'].forEach(function (ev) {
    root.addEventListener(ev, function (e) { e.stopPropagation(); });
  });

  // ---- add mode ----
  // Arm with the toolbar button OR the hotkey. The hotkey never clicks the panel,
  // so an open dropdown/popover stays open. While armed the hovered element
  // highlights; capture with Enter (no click, keeps transient UI open) or a
  // click (capture-phase, so the element's own handler never fires).
  function arm() {
    addMode = true; render();
    document.addEventListener('click', onPick, true);
    document.addEventListener('mousemove', onHover, true);
  }
  function disarm() {
    addMode = false;
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('mousemove', onHover, true);
    hideHi(); hovered = null;
    render();
  }
  function onHover(e) {
    // over our own UI (panel / highlight / pin / float) → no target, hide the box
    if (root.contains(e.target) || e.target === hi || (e.target.classList && e.target.classList.contains('ovl-pin')) || (floatEl && floatEl.contains(e.target))) { hideHi(); hovered = null; return; }
    hovered = e.target; showHi(hovered);
  }
  function onPick(e) {
    if (root.contains(e.target) || (e.target.classList && e.target.classList.contains('ovl-pin'))) return;
    e.preventDefault(); e.stopPropagation();
    captureEl(e.target);
  }
  function captureEl(target) {
    var d = describe(target);
    var rect = target.getBoundingClientRect();
    disarm();
    openComposer(rect, d.selector, '', function (v) {
      var tag = { id: uid(), route: route(), scope: 'element', selector: d.selector, testid: d.testid, textHint: d.textHint, note: v, createdAt: Date.now() };
      store.add(tag); render();
      applyEnrich(tag, target);
    });
  }
  function addPageNote() {
    openComposer(fallbackRect(), '(whole page)', '', function (v) {
      var tag = { id: uid(), route: route(), scope: 'page', selector: null, testid: null, textHint: '', note: v, createdAt: Date.now() };
      store.add(tag); render();
      applyEnrich(tag, null);
    });
  }

  // ---- note ops ----
  function editNote(id) {
    var n = findNote(id); if (!n) return;
    var t = resolve(n.selector);
    var rect = (t && n.route === route()) ? t.getBoundingClientRect() : fallbackRect();
    openComposer(rect, n.selector, n.note, function (v) { store.update(id, { note: v }); render(); });
  }
  function delNote(id) { store.removeById(id); render(); }
  function clearAll() { if (confirm('Delete all ' + store.list().length + ' tags?')) { store.clear(); render(); } }
  function copy() {
    var blob = exportBlob();
    var count = store.openTags().length;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(blob).then(function () { alert('Copied ' + count + ' tag(s).'); }, function () { fallbackCopy(blob, count); });
    } else { fallbackCopy(blob, count); }
  }
  function fallbackCopy(blob, count) {
    var ta = document.createElement('textarea'); ta.value = blob; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); alert('Copied ' + count + ' tag(s).'); } catch (e) { window.prompt('Copy manually:', blob); }
    ta.remove();
  }

  // ---- render ----
  function buildRow(n, cur, notes) {
    var i = notes.indexOf(n); // open-tags # — matches pins and the Copy blob
    var onPage = n.route === cur;
    var pg = isPage(n);
    var anchored = pg || !onPage || !!resolve(n.selector);
    var open = expandedId === n.id;
    var row = el('div', 'ovl-row' + (open ? ' open' : '') + (anchored ? '' : ' ovl-warn'));
    var head = el('div', 'ovl-rowhead');
    head.appendChild(el('span', 'ovl-num', '#' + (i + 1)));
    head.appendChild(el('span', 'ovl-txt', n.note));
    if (tab === 'all') head.appendChild(el('span', 'ovl-chip', onPage ? 'here' : n.route));
    else if (pg) head.appendChild(el('span', 'ovl-chip', 'page'));
    row.appendChild(head);
    if (open) {
      var det = el('div', 'ovl-det');
      det.appendChild(el('div', 'ovl-meta', (pg ? '(whole page)' : n.selector) + (anchored ? '' : '  (unanchored)')));
      det.appendChild(el('div', 'ovl-meta', n.route + (onPage ? '' : '  (other page)')));
      var shotWell = buildShotWell(n);
      if (shotWell) det.appendChild(shotWell);
      var acts = el('div', 'ovl-acts');
      if (onPage && (pg || resolve(n.selector))) {
        var show = el('button', 'ovl-mini', 'Show');
        show.onclick = function (e) { e.stopPropagation(); toggleBubble(n); };
        acts.appendChild(show);
      }
      var ed = el('button', 'ovl-mini', 'Edit');
      ed.onclick = function (e) { e.stopPropagation(); editNote(n.id); };
      var del = el('button', 'ovl-mini ovl-mini-danger', 'Delete');
      del.onclick = function (e) { e.stopPropagation(); delNote(n.id); };
      acts.appendChild(ed); acts.appendChild(del);
      det.appendChild(acts);
      row.appendChild(det);
    }
    row.onclick = function () { expandedId = open ? null : n.id; render(); };
    row.onmouseenter = function () { if (onPage && !pg) peek(n.selector, true); };
    row.onmouseleave = function () { if (onPage && !pg) peek(n.selector, false); };
    return row;
  }

  function render() {
    if (destroyed) return;
    var notes = store.openTags();
    root.innerHTML = '';
    // A peek box shown on row-hover leaks if its row is removed or the list
    // rebuilds (delete / tab switch / route change) — mouseleave never fires.
    // Any re-render outside active add-mode clears it. Add-mode's box is driven
    // by onHover, so leave it alone.
    if (!addMode) hideHi();
    var fab = el('button', 'ovl-fab' + (addMode ? ' armed' : ''), addMode ? '✕ hover + Enter or click (Esc)' : '💬 ' + notes.length);
    fab.onclick = function () { if (addMode) { disarm(); } else { panelOpen = !panelOpen; render(); } };
    root.appendChild(fab);
    if (panelOpen) {
      var cur = route();
      var pageNotes = notes.filter(function (n) { return n.route === cur; });
      var panel = el('div', 'ovl-panel');

      // toolbar — one row
      var bar = el('div', 'ovl-bar');
      var addBtn = el('button', 'ovl-act ovl-act-primary', '＋ Add');
      addBtn.title = 'Tag an element. Shortcut: ' + HOTKEY + ' arms without closing dropdowns — then hover + Enter, or click. Esc cancels.';
      addBtn.onclick = arm;
      var pageBtn = el('button', 'ovl-act', '▭ Page');
      pageBtn.title = 'Tag the whole page / layout (not tied to one element)';
      pageBtn.onclick = addPageNote;
      var copyBtn = el('button', 'ovl-act', 'Copy ' + notes.length);
      copyBtn.title = 'Copy ALL tags (every page) + fix prompt for your AI agent';
      copyBtn.onclick = copy;
      var clrBtn = el('button', 'ovl-act ovl-act-danger', 'Clear');
      clrBtn.title = 'Delete all tags';
      clrBtn.onclick = clearAll;
      bar.appendChild(addBtn); bar.appendChild(pageBtn); bar.appendChild(copyBtn); bar.appendChild(clrBtn);
      panel.appendChild(bar);

      // tabs
      var tabs = el('div', 'ovl-tabs');
      [['page', 'This page (' + pageNotes.length + ')'], ['all', 'All (' + notes.length + ')']].forEach(function (t) {
        var b = el('button', 'ovl-tab' + (tab === t[0] ? ' on' : ''), t[1]);
        b.onclick = function () { tab = t[0]; render(); };
        tabs.appendChild(b);
      });
      panel.appendChild(tabs);

      // list — collapsed rows, click to expand
      var list = el('div', 'ovl-list');
      var shown = tab === 'page' ? pageNotes : notes;
      if (shown.length === 0) {
        list.appendChild(el('div', 'ovl-empty', tab === 'page'
          ? 'No tags on this page.\n＋ Add, then click an element.'
          : 'No tags yet.'));
      } else {
        shown.forEach(function (n) { list.appendChild(buildRow(n, cur, notes)); });
      }
      panel.appendChild(list);
      root.appendChild(panel);
    }
    renderPins();
  }
  // Reconciled by tag id: existing pin nodes are updated in place (no
  // remove/re-append) so a MutationObserver watching document.body never
  // sees pin churn as a DOM mutation — that self-loop was cause (a) of the
  // pin-flash bug. Keying off data-ovl-id also means an unrelated app
  // re-render doesn't nuke+recreate pins that didn't actually change.
  function renderPins() {
    var existing = {};
    Array.prototype.slice.call(document.querySelectorAll('.ovl-pin')).forEach(function (p) {
      existing[p.getAttribute('data-ovl-id')] = p;
    });
    var seen = {};
    var pageStack = 0;
    store.openTags().forEach(function (n, i) {
      if (n.route !== route()) return; // pins are page-bound; other pages' tags stay panel-only
      if (isPage(n)) { // page tags have no element — fixed square badge stacked top-left
        var ppin = placePin(existing, n, 'ovl-pin ovl-pin-page', String(i + 1));
        ppin.style.left = '14px';
        ppin.style.top = (86 + pageStack * 28) + 'px';
        ppin.title = n.note;
        seen[n.id] = true;
        pageStack++;
        return;
      }
      var t = resolve(n.selector); if (!t) return;
      var r = t.getBoundingClientRect();
      var pin = placePin(existing, n, 'ovl-pin' + (n.origin === 'agent' ? ' ovl-pin-agent' : ''), String(i + 1));
      pin.style.left = (r.left + Math.min(r.width, 16)) + 'px';
      pin.style.top = r.top + 'px';
      pin.title = n.note;
      seen[n.id] = true;
    });
    Object.keys(existing).forEach(function (id) { if (!seen[id]) existing[id].remove(); });
  }
  // Reuse the existing DOM node for a tag id if present (updating its class
  // + label in place); otherwise create + append it. `onclick` is cheap to
  // rebind every pass and keeps the closure over the current `n`.
  function placePin(existing, n, cls, label) {
    var pin = existing[n.id];
    if (!pin) {
      pin = el('div', cls, label);
      pin.setAttribute('data-ovl-id', n.id);
      document.body.appendChild(pin);
    } else {
      pin.className = cls;
      pin.textContent = label;
    }
    pin.onclick = function () { toggleBubble(n); };
    return pin;
  }

  // SPA route changes don't reload the page — watch the location and
  // re-render so pins follow their own page.
  var lastRoute = route();
  var routeTimer = setInterval(function () {
    if (route() !== lastRoute) { lastRoute = route(); render(); }
  }, 500);
  function onPopstate() { lastRoute = route(); render(); }
  window.addEventListener('popstate', onPopstate);

  // Hotkey: '<Modifier>+<key>' (default Alt+A) toggles add-mode without
  // clicking the panel → open dropdowns stay open.
  // While armed: Enter captures the hovered element; Esc cancels.
  var hk = HOTKEY.split('+');
  var hkMod = (hk[0] || 'alt').toLowerCase();
  var hkKey = (hk[1] || 'a').toLowerCase();
  function hotkeyDown(e) {
    if (hkMod === 'alt') return e.altKey;
    if (hkMod === 'ctrl') return e.ctrlKey;
    if (hkMod === 'shift') return e.shiftKey;
    if (hkMod === 'meta') return e.metaKey;
    return false;
  }
  function onKeydown(e) {
    var tag = (e.target && e.target.tagName) || '';
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable);
    if (!typing && hotkeyDown(e) && e.key.toLowerCase() === hkKey) {
      e.preventDefault();
      if (addMode) disarm(); else arm();
      return;
    }
    if (addMode) {
      if (e.key === 'Escape') disarm();
      else if (e.key === 'Enter' && hovered) { e.preventDefault(); captureEl(hovered); }
    }
  }
  document.addEventListener('keydown', onKeydown);

  window.addEventListener('scroll', renderPins, true);
  window.addEventListener('resize', renderPins);
  // The plugin injects us before the app framework mounts, so selectors may
  // not resolve at init time (pins would stay missing until a scroll/route
  // event). Re-render pins, debounced, as the app's DOM appears/changes.
  var moT = null;
  var observer = new MutationObserver(function (muts) {
    var external = muts.some(function (m) { return isExternalMutation(m, root); });
    if (!external) return;
    clearTimeout(moT);
    moT = setTimeout(renderPins, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  render();

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    window.removeEventListener('scroll', renderPins, true);
    window.removeEventListener('resize', renderPins);
    window.removeEventListener('popstate', onPopstate);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('mousemove', onHover, true);
    observer.disconnect();
    clearTimeout(moT);
    clearInterval(routeTimer);
    if (addMode) disarm();
    closeFloat();
    if (hi) { hi.remove(); hi = null; }
    // Sweeps ALL .ovl-pin nodes in the document, not just this instance's own —
    // safe only under the singleton assumption that one mountOverlay is live at
    // a time. Callers (e.g. the extension's content.ts) are responsible for the
    // double-mount guard; destroy() itself does not defend against overlap.
    Array.prototype.slice.call(document.querySelectorAll('.ovl-pin')).forEach(function (p) { p.remove(); });
    if (root && root.parentNode) root.remove();
  }

  return {
    toggle: function () { panelOpen = !panelOpen; render(); },
    render: render,
    destroy: destroy,
    _captureForTest: function (target, note) {
      var d = describe(target);
      var tag = { id: uid(), route: route(), scope: 'element', selector: d.selector, testid: d.testid, textHint: d.textHint, note: note, createdAt: Date.now() };
      store.add(tag); render();
      applyEnrich(tag, target);
    },
  };
}
