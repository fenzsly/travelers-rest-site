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
  var DEFAULTS = { rtheme: '', font: 'serif', size: 19, line: 1.8, width: 800, align: 'left' };
  var prefs = Object.assign({}, DEFAULTS, json('reader-prefs', {}));

  function apply() {
    root.dataset.rtheme = prefs.rtheme;
    root.dataset.font = prefs.font;
    root.dataset.align = prefs.align;
    root.style.setProperty('--r-size', prefs.size + 'px');
    root.style.setProperty('--r-line', prefs.line);
    root.style.setProperty('--r-width', prefs.width + 'px');
    document.querySelectorAll('[data-rtheme]').forEach(function (b) { b.classList.toggle('on', b.dataset.rtheme === prefs.rtheme); });
    document.querySelectorAll('[data-font]').forEach(function (b) { b.classList.toggle('on', b.dataset.font === prefs.font); });
    document.querySelectorAll('[data-align]').forEach(function (b) { b.classList.toggle('on', b.dataset.align === prefs.align); });
    [['size', 'px'], ['line', ''], ['width', 'px']].forEach(function (p) {
      var input = document.getElementById('s-' + p[0]);
      input.value = prefs[p[0]];
      document.getElementById('o-' + p[0]).textContent = prefs[p[0]] + p[1];
    });
  }
  function save() { ls('reader-prefs', JSON.stringify(prefs)); apply(); }

  document.querySelectorAll('[data-rtheme]').forEach(function (b) { b.addEventListener('click', function () { prefs.rtheme = b.dataset.rtheme; save(); }); });
  document.querySelectorAll('button[data-font]').forEach(function (b) { b.addEventListener('click', function () { prefs.font = b.dataset.font; save(); }); });
  document.querySelectorAll('button[data-align]').forEach(function (b) { b.addEventListener('click', function () { prefs.align = b.dataset.align; save(); }); });
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
  var reportForm = document.getElementById('report-form');
  if (reportForm) {
    reportForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new URLSearchParams(new FormData(reportForm));
      if (!data.get('quote').trim() && !data.get('message').trim()) { alert('Please describe the problem.'); return; }
      fetch(reportForm.action, { method: 'POST', body: data, headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(); })
        .then(function () {
          reportForm.querySelector('.report-done').hidden = false;
          reportForm.querySelector('[name=quote]').value = '';
          reportForm.querySelector('[name=message]').value = '';
          setTimeout(closePanels, 1600);
        })
        .catch(function () { alert('Could not send the report. Please try again.'); });
    });
  }

  // ---------- Remember progress (works without an account) ----------
  var progress = json('progress', {});
  progress[slug] = { num: num, title: article.dataset.novelTitle, chapterTitle: article.dataset.chapterTitle || '', at: Date.now() };
  ls('progress', JSON.stringify(progress));
  var read = json('read:' + slug, []);
  if (read.indexOf(num) === -1) { read.push(num); if (read.length > 5000) read.shift(); ls('read:' + slug, JSON.stringify(read)); }
})();
