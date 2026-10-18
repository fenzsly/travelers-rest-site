// Chapter reader: preferences, keyboard navigation, contents panel, progress tracking.
(function () {
  var root = document.documentElement;
  var article = document.getElementById('chapter');
  var slug = article.dataset.slug;
  var num = article.dataset.num;

  function ls(key, value) {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) { return null; }
  }
  function json(key, fallback) { try { return JSON.parse(ls(key)) || fallback; } catch (e) { return fallback; } }

  // ---------- Preferences ----------
  // Phones get slightly bigger text and more line spacing by default (like reading apps).
  var phone = root.classList.contains('immersive');
  var DEFAULTS = { rtheme: '', font: 'serif', size: phone ? 20 : 19, line: phone ? 1.9 : 1.8, width: 800, align: 'left', autonext: 'on' };
  var prefs = Object.assign({}, DEFAULTS, json('reader-prefs', {}));

  // Logged-in readers: settings are also saved on the account, so they follow them to every device.
  var account = window.ACCOUNT;
  var csrfMeta = document.querySelector('meta[name=csrf]');
  var syncTimer = null;
  function syncToAccount() {
    if (!account || !csrfMeta) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      var body = {};
      Object.keys(DEFAULTS).forEach(function (k) { body[k] = prefs[k]; });
      fetch('/account/prefs', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfMeta.content, Accept: 'application/json' },
        body: JSON.stringify(body),
      }).catch(function () {});
    }, 800);
  }
  // First visit after logging in: keep the settings this browser already had.
  if (account && !Object.keys(account.prefs || {}).some(function (k) { return k !== 'theme'; }) && ls('reader-prefs')) syncToAccount();

  function apply() {
    root.dataset.rtheme = prefs.rtheme;
    root.dataset.font = prefs.font;
    root.dataset.align = prefs.align;
    root.style.setProperty('--r-size', prefs.size + 'px');
    root.style.setProperty('--r-line', prefs.line);
    root.style.setProperty('--r-width', prefs.width + 'px');
    document.querySelectorAll('button[data-rtheme]').forEach(function (b) { b.classList.toggle('on', b.dataset.rtheme === prefs.rtheme); });
    document.querySelectorAll('button[data-font]').forEach(function (b) { b.classList.toggle('on', b.dataset.font === prefs.font); });
    document.querySelectorAll('button[data-align]').forEach(function (b) { b.classList.toggle('on', b.dataset.align === prefs.align); });
    document.querySelectorAll('button[data-autonext]').forEach(function (b) { b.classList.toggle('on', b.dataset.autonext === prefs.autonext); });
    root.classList.toggle('no-autonext', prefs.autonext === 'off');
    [['size', 'px'], ['line', ''], ['width', 'px']].forEach(function (p) {
      var input = document.getElementById('s-' + p[0]);
      input.value = prefs[p[0]];
      document.getElementById('o-' + p[0]).textContent = prefs[p[0]] + p[1];
    });
  }
  function save() { ls('reader-prefs', JSON.stringify(prefs)); apply(); syncToAccount(); }

  document.querySelectorAll('button[data-rtheme]').forEach(function (b) { b.addEventListener('click', function () { prefs.rtheme = b.dataset.rtheme; save(); }); });
  document.querySelectorAll('button[data-font]').forEach(function (b) { b.addEventListener('click', function () { prefs.font = b.dataset.font; save(); }); });
  document.querySelectorAll('button[data-align]').forEach(function (b) { b.addEventListener('click', function () { prefs.align = b.dataset.align; save(); }); });
  document.querySelectorAll('button[data-autonext]').forEach(function (b) { b.addEventListener('click', function () { prefs.autonext = b.dataset.autonext; save(); }); });
  ['size', 'line', 'width'].forEach(function (k) {
    document.getElementById('s-' + k).addEventListener('input', function (e) { prefs[k] = Number(e.target.value); save(); });
  });
  document.getElementById('reset-prefs').addEventListener('click', function () { prefs = Object.assign({}, DEFAULTS); save(); });
  apply();

  // ---------- Panels ----------
  function openPanel(name) {
    // Grab any text the reader selected before the panel steals focus.
    var sel = String(window.getSelection ? window.getSelection() : '').trim();
    closePanels();
    var p = document.getElementById('panel-' + name);
    p.hidden = false;
    if (name === 'toc') loadToc();
    if (name === 'report') {
      var quote = document.getElementById('report-quote');
      if (sel && article.contains(window.getSelection().anchorNode)) quote.value = sel.slice(0, 1000);
      document.getElementById('report-form').querySelector('.report-done').hidden = true;
    }
  }
  function closePanels() { document.querySelectorAll('.panel').forEach(function (p) { p.hidden = true; }); }
  document.querySelectorAll('[data-open]').forEach(function (b) { b.addEventListener('click', function () { openPanel(b.dataset.open); }); });
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closePanels); });
  document.querySelectorAll('.panel').forEach(function (p) { p.addEventListener('click', function (e) { if (e.target === p) closePanels(); }); });

  // ---------- Contents ----------
  var tocLoaded = false;
  var tocList = document.getElementById('toc-list');
  var filter = document.querySelector('.toc-filter');
  function loadToc() {
    if (tocLoaded) return scrollToCurrent();
    tocLoaded = true;
    fetch('/novel/' + slug + '/chapters.json').then(function (r) { return r.json(); }).then(function (rows) {
      var read = {};
      json('read:' + slug, []).forEach(function (n) { read[n] = true; });
      tocList.innerHTML = '';
      var lastVol = null;
      rows.forEach(function (c) {
        var n = String(+c.number.toFixed(2));
        if (c.volume && c.volume !== lastVol) {
          var head = document.createElement('li');
          head.className = 'vol-head';
          head.textContent = 'Volume ' + c.volume;
          tocList.appendChild(head);
        }
        lastVol = c.volume;
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.href = '/novel/' + slug + '/c/' + n;
        a.textContent = 'Chapter ' + n + (c.title ? ': ' + c.title : '');
        a.dataset.search = a.textContent.toLowerCase();
        a.dataset.num = n;
        if (n === num) a.className = 'current';
        else if (read[n]) a.className = 'read';
        li.appendChild(a);
        tocList.appendChild(li);
      });
      scrollToCurrent();
    }).catch(function () { tocList.innerHTML = '<li class="muted">Could not load contents.</li>'; });
  }
  function scrollToCurrent() {
    var cur = tocList.querySelector('.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }
  filter.addEventListener('input', function () {
    var q = filter.value.trim().toLowerCase();
    tocList.querySelectorAll('li').forEach(function (li) {
      var a = li.firstChild;
      if (!a || !a.dataset) { li.hidden = !!q; return; }
      li.hidden = q && !(a.dataset.num === q || a.dataset.search.indexOf(q) !== -1);
    });
  });
  filter.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var first = tocList.querySelector('li:not([hidden]) a');
    if (first) location.href = first.href;
  });

  // ---------- Keyboard ----------
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target.tagName;
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || e.target.isContentEditable) {
      if (e.key === 'Escape') closePanels();
      return;
    }
    var link;
    if (e.key === 'ArrowLeft') link = document.querySelector('link[rel=prev]');
    if (e.key === 'ArrowRight') link = document.querySelector('link[rel=next]');
    if (link) { location.href = link.href; return; }
    if (e.key === 'Escape') closePanels();
    if (e.key === 'c' || e.key === 'C') openPanel('toc');
    if (e.key === 's' || e.key === 'S') openPanel('settings');
  });

  // ---------- Progress bar, auto-hiding toolbar ----------
  var bar = document.getElementById('progress');
  var header = document.getElementById('reader-bar');
  var lastY = window.scrollY;
  function onScroll() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.width = (max > 0 ? Math.min(100, (window.scrollY / max) * 100) : 100) + '%';
    var y = window.scrollY;
    header.classList.toggle('hide', y > lastY && y > 120);
    lastY = y;
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- Reactions & reports (without reloading the page) ----------
  var csrfInput = document.querySelector('input[name=_csrf]');
  var reactions = document.getElementById('reactions');
  if (reactions && csrfInput) {
    reactions.addEventListener('click', function (e) {
      var btn = e.target.closest('button.react');
      if (!btn) return;
      e.preventDefault();
      var body = new URLSearchParams({ _csrf: csrfInput.value, emoji: btn.dataset.emoji });
      fetch(reactions.dataset.url, { method: 'POST', body: body, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          reactions.querySelectorAll('button.react').forEach(function (b) {
            b.classList.toggle('on', b.dataset.emoji === d.mine);
            b.querySelector('span').textContent = d.counts[b.dataset.emoji] || '';
          });
        })
        .catch(function () { btn.closest('form').submit(); });
    });
  }
  if (location.hash === '#report-error') { var box = document.querySelector('#report-error details'); if (box) box.open = true; }
  document.querySelectorAll('form[data-report]').forEach(function (reportForm) {
    reportForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new URLSearchParams(new FormData(reportForm));
      if (!data.get('quote').trim() && !data.get('message').trim()) { alert('Please describe the error.'); return; }
      fetch(reportForm.action, { method: 'POST', body: data, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ''); return d; }); })
        .then(function () {
          reportForm.querySelector('.report-done').hidden = false;
          reportForm.querySelector('[name=quote]').value = '';
          reportForm.querySelector('[name=message]').value = '';
          if (reportForm.id === 'report-form') setTimeout(closePanels, 1600);
        })
        .catch(function (err) { alert(err.message || 'Could not send the report. Please try again.'); });
    });
  });

  // ---------- Remember progress (works without an account) ----------
  var progress = json('progress', {});
  progress[slug] = { num: num, title: article.dataset.novelTitle, chapterTitle: article.dataset.chapterTitle || '', at: Date.now() };
  ls('progress', JSON.stringify(progress));
  var read = json('read:' + slug, []);
  if (read.indexOf(num) === -1) { read.push(num); if (read.length > 5000) read.shift(); ls('read:' + slug, JSON.stringify(read)); }
})();

// ---------- Comment replies ----------
// Kept separate from the reader code above, and listening on the whole page,
// so nothing else on the page can stop the Reply buttons from working.
(function () {
  function openReply(btn) {
    var thread = document.getElementById('thread-' + btn.getAttribute('data-root'));
    if (!thread) return;
    var form = thread.querySelector('.reply-form');
    if (!form) return;
    thread.hidden = false;
    thread.classList.remove('collapsed');
    form.hidden = false;
    var box = form.querySelector('textarea');
    var name = btn.getAttribute('data-name');
    var isChain = btn.getAttribute('data-reply') !== btn.getAttribute('data-root');
    // Replying inside a chain: start with @name of the person you're answering.
    if (isChain || !box.value) {
      var mention = '@' + name + ' ';
      if (box.value.indexOf(mention) !== 0) box.value = isChain ? mention + box.value.replace(/^@\S+\s/, '') : box.value;
    }
    form.querySelector('[name=parent_id]').value = btn.getAttribute('data-reply');
    form.scrollIntoView({ block: 'nearest' });
    box.focus();
    try { box.setSelectionRange(box.value.length, box.value.length); } catch (e) {}
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var reply = t.closest('[data-reply]');
    if (reply) { e.preventDefault(); openReply(reply); return; }
    var cancel = t.closest('[data-cancel-reply]');
    if (cancel) {
      e.preventDefault();
      var form = cancel.closest('.reply-form');
      var thread = form.closest('.comment-thread');
      form.hidden = true;
      form.querySelector('textarea').value = '';
      if (!thread.querySelector('.reply-list .comment')) thread.hidden = true;
      return;
    }
    var toggle = t.closest('[data-thread]');
    if (toggle) {
      e.preventDefault();
      var n = toggle.getAttribute('data-count') || (toggle.textContent.match(/\d+/) || [''])[0];
      toggle.setAttribute('data-count', n);
      var collapsed = toggle.closest('.comment-thread').classList.toggle('collapsed');
      toggle.textContent = collapsed ? '▸ Show ' + n + ' replies' : '▾ Hide ' + n + ' replies';
    }
  });
})();

// ---------- Scroll past the end → next chapter ----------
// Not an endless page: the next chapter opens as a normal page, from the top (a fresh page for ads too).
// It only happens after the reader scrolls down through the space below the comments to the very bottom.
(function () {
  // Arrived by scrolling past the previous chapter: always start at the top of this one.
  try {
    if (sessionStorage.getItem('np-top') === location.pathname) { sessionStorage.removeItem('np-top'); window.scrollTo(0, 0); }
  } catch (e) { /* private mode */ }
  var card = document.getElementById('next-pull');
  var space = document.getElementById('next-pull-space');
  if (!card || !space) return;
  var bar = card.querySelector('.np-bar span');
  var hint = card.querySelector('.np-hint');
  var armed = false; // set once the reader is above the space, so landing at the bottom (e.g. reload) never jumps
  var timer = null;
  var going = false;
  function progress() {
    var top = space.getBoundingClientRect().top;
    return Math.max(0, Math.min(1, (window.innerHeight - top) / space.offsetHeight));
  }
  function typing() { var a = document.activeElement; return a && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName); }
  function check() {
    if (going || document.documentElement.classList.contains('no-autonext')) return; // switched off in Reader settings
    var p = progress();
    if (p < 0.4) armed = true;
    bar.style.width = Math.round(p * 100) + '%';
    card.classList.toggle('np-ready', p >= 0.98);
    var atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (armed && atBottom && p >= 0.98 && !typing()) {
      if (!timer) timer = setTimeout(go, 450); // a short pause, so a fling past the end can still be undone
    } else if (timer) { clearTimeout(timer); timer = null; }
  }
  function go() {
    timer = null;
    if (going || !(window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4)) return;
    going = true;
    hint.textContent = 'Opening the next chapter…';
    card.classList.add('np-going');
    window.location.href = card.href;
  }
  window.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  // Coming back with the browser's Back button restores this page from cache: reset it.
  window.addEventListener('pageshow', function (e) { if (e.persisted) { going = false; armed = false; hint.textContent = 'Keep scrolling for the next chapter'; card.classList.remove('np-going'); check(); } });
  check();
})();


// ---------- Immersive reading on phones: double-tap shows/hides the controls ----------
(function () {
  var root = document.documentElement;
  if (!root.classList.contains('immersive')) return;
  var INTERACTIVE = 'a, button, input, textarea, select, label, summary, details, form, .panel, .reader-bar, .react, video, iframe';
  var lastTap = 0;
  var lastX = 0;
  var lastY = 0;
  var hideTimer = null;
  var shownAtY = 0;
  var lastTouchToggle = 0;

  function setUI(on) {
    root.classList.toggle('ui-on', on);
    shownAtY = window.scrollY;
    if (on) hint(false);
  }
  function toggleUI() { setUI(!root.classList.contains('ui-on')); }

  document.addEventListener('touchend', function (e) {
    if (e.changedTouches.length !== 1 || e.target.closest(INTERACTIVE)) return;
    var sel = window.getSelection && String(window.getSelection());
    if (sel) return; // selecting text, not tapping
    var t = e.changedTouches[0];
    var now = Date.now();
    var isDouble = now - lastTap < 320 && Math.abs(t.clientX - lastX) < 40 && Math.abs(t.clientY - lastY) < 40;
    if (isDouble) {
      clearTimeout(hideTimer);
      lastTap = 0;
      lastTouchToggle = now;
      e.preventDefault(); // no zoom
      toggleUI();
      return;
    }
    lastTap = now;
    lastX = t.clientX;
    lastY = t.clientY;
    // A single tap while the controls are showing puts them away (unless it turns out to be a double-tap).
    if (root.classList.contains('ui-on')) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { setUI(false); }, 330);
    }
  }, { passive: false });

  // Mouse / stylus double-click (e.g. a narrow desktop window or a tablet with a keyboard).
  document.addEventListener('dblclick', function (e) {
    if (Date.now() - lastTouchToggle < 600 || e.target.closest(INTERACTIVE)) return;
    if (window.getSelection) window.getSelection().removeAllRanges();
    toggleUI();
  });

  // Scrolling on to read puts the controls away.
  window.addEventListener('scroll', function () {
    if (root.classList.contains('ui-on') && Math.abs(window.scrollY - shownAtY) > 60 && !document.querySelector('.panel:not([hidden])')) setUI(false);
    progress();
  }, { passive: true });

  // Reading progress: the thin line under the top bar. At the very top of a chapter the bar stays visible.
  var fill = document.getElementById('rb-fill');
  function progress() {
    root.classList.toggle('at-top', window.scrollY < 40);
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var art = document.getElementById('chapter');
    // Measure through the end of the chapter text, not the comments below it.
    var end = art ? art.offsetTop + art.offsetHeight - window.innerHeight : max;
    var p = Math.max(0, Math.min(100, Math.round((window.scrollY / Math.max(1, Math.min(end, max))) * 100)));
    if (fill) fill.style.width = p + '%';
  }
  progress();


  // Phone status bar matches the page colour.
  function themeColor() {
    var meta = document.querySelector('meta[name=theme-color]');
    if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
    meta.content = getComputedStyle(document.body).backgroundColor;
  }
  themeColor();
  new MutationObserver(themeColor).observe(root, { attributes: true, attributeFilter: ['data-rtheme', 'data-theme'] });

  // Teach the gesture on the first few chapters.
  var tip = document.getElementById('tap-hint');
  function hint(show) {
    if (!tip) return;
    if (!show) { tip.classList.add('fade'); setTimeout(function () { tip.hidden = true; }, 400); return; }
    tip.hidden = false;
    setTimeout(function () { hint(false); }, 3500);
  }
  try {
    var seen = Number(localStorage.getItem('tap-hint-seen') || 0);
    if (seen < 3) { localStorage.setItem('tap-hint-seen', String(seen + 1)); setTimeout(function () { hint(true); }, 600); }
  } catch (e) {}
})();
