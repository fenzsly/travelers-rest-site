// Small progressive enhancements for the public site.
(function () {
  var root = document.documentElement;
  function store(key, value) {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch (e) { return null; }
  }

  // Night mode toggle
  var toggle = document.getElementById('theme-toggle');
  function paintToggle() { if (toggle) toggle.textContent = root.dataset.theme === 'dark' ? '☀️' : '🌙'; }
  paintToggle();
  if (toggle) toggle.addEventListener('click', function () {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    store('site-theme', root.dataset.theme);
    paintToggle();
  });

  // "Continue reading" + read markers on the novel page (works for guests via localStorage)
  var cont = document.querySelector('.continue-btn');
  if (cont) {
    var slug = cont.dataset.slug;
    var progress = {};
    try { progress = JSON.parse(store('progress') || '{}'); } catch (e) {}
    var last = (progress[slug] && progress[slug].num) || cont.dataset.serverLast;
    if (last) {
      cont.href = '/novel/' + slug + '/c/' + last;
      cont.textContent = 'Continue · Ch. ' + last;
      cont.hidden = false;
      cont.classList.add('btn-accent');
      var start = document.querySelector('.novel-actions .btn-accent:not(.continue-btn)');
      if (start) start.classList.remove('btn-accent');
    }
    var read = {};
    try { (JSON.parse(store('read:' + slug) || '[]')).forEach(function (n) { read[n] = true; }); } catch (e) {}
    document.querySelectorAll('.chapter-list a[data-num]').forEach(function (a) {
      if (read[a.dataset.num]) a.classList.add('read');
      if (String(last) === a.dataset.num) a.classList.add('last-read');
    });
  }

  // Collapsible long descriptions
  document.querySelectorAll('[data-expand]').forEach(function (btn) {
    var el = document.getElementById(btn.dataset.expand);
    if (!el || el.scrollHeight < 240) return;
    el.classList.add('clamped');
    btn.hidden = false;
    btn.addEventListener('click', function () {
      var clamped = el.classList.toggle('clamped');
      btn.textContent = clamped ? 'Show more ▾' : 'Show less ▴';
    });
  });
})();

// ---------- v2: continue reading, history, copy link, local times, search suggestions ----------
(function () {
  function readJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; } }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ago(ms) {
    var s = Math.max(0, (Date.now() - ms) / 1000);
    var units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (var i = 0; i < units.length; i++) { var n = Math.floor(s / units[i][1]); if (n >= 1) return n + ' ' + units[i][0] + (n > 1 ? 's' : '') + ' ago'; }
    return 'just now';
  }

  function historyEntries() {
    var progress = readJSON('progress', {});
    return Object.keys(progress).map(function (slug) { return Object.assign({ slug: slug }, progress[slug]); })
      .filter(function (e) { return e.num; })
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }
  function renderHistory(container, limit) {
    var items = historyEntries().slice(0, limit || 1e9);
    container.innerHTML = '';
    items.forEach(function (e) {
      var a = el('a', 'continue-item');
      a.href = '/novel/' + encodeURIComponent(e.slug) + '/c/' + e.num;
      a.appendChild(el('strong', null, e.title || e.slug));
      a.appendChild(el('span', null, 'Continue · Chapter ' + e.num + (e.chapterTitle ? ': ' + e.chapterTitle : '')));
      if (e.at) a.appendChild(el('small', null, ago(e.at)));
      container.appendChild(a);
    });
    return items.length;
  }

  var cont = document.getElementById('continue-list');
  if (cont && renderHistory(cont, 6)) document.getElementById('continue-block').hidden = false;

  var hist = document.getElementById('history-list');
  if (hist) {
    var n = renderHistory(hist);
    document.getElementById('history-empty').hidden = n > 0;
    document.getElementById('clear-history').addEventListener('click', function () {
      if (!confirm('Clear your reading history in this browser?')) return;
      try {
        Object.keys(localStorage).forEach(function (k) { if (k === 'progress' || k.indexOf('read:') === 0) localStorage.removeItem(k); });
      } catch (e) {}
      renderHistory(hist);
      document.getElementById('history-empty').hidden = false;
    });
  }

  document.querySelectorAll('[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var done = function () { var t = b.textContent; b.textContent = '✓ Copied'; setTimeout(function () { b.textContent = t; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(b.dataset.copy).then(done); else { prompt('Copy this link:', b.dataset.copy); }
    });
  });

  // Show scheduled release times in the reader's own timezone.
  document.querySelectorAll('[data-ts]').forEach(function (e) {
    var d = new Date(Number(e.dataset.ts) * 1000);
    e.textContent = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  });

  // Search-as-you-type suggestions
  var input = document.getElementById('search-input');
  var box = document.getElementById('search-suggest');
  if (input && box) {
    var timer, active = -1;
    function close() { box.hidden = true; active = -1; }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) return close();
      timer = setTimeout(function () {
        fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); }).then(function (rows) {
          box.innerHTML = '';
          rows.forEach(function (n) {
            var a = el('a');
            a.href = '/novel/' + n.slug;
            var cover = n.cover ? el('img', 'cover-img') : el('div', 'cover-img cover-placeholder');
            if (n.cover) { cover.src = '/uploads/covers/' + n.cover; cover.alt = ''; }
            else cover.style.setProperty('--h', Array.from(n.title).reduce(function (s, c) { return s + c.charCodeAt(0); }, 0) % 360);
            var text = el('div');
            text.appendChild(el('span', null, n.title));
            text.appendChild(el('small', null, n.chapter_count + ' chapters'));
            a.appendChild(cover); a.appendChild(text);
            box.appendChild(a);
          });
          var all = el('a', 'all', rows.length ? 'See all results →' : 'No quick matches. Search all →');
          all.href = '/novels?q=' + encodeURIComponent(q);
          box.appendChild(all);
          box.hidden = false;
          active = -1;
        }).catch(close);
      }, 180);
    });
    input.addEventListener('keydown', function (e) {
      var links = box.hidden ? [] : box.querySelectorAll('a');
      if (!links.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
        links.forEach(function (l, i) { l.classList.toggle('on', i === active); });
      } else if (e.key === 'Enter' && active >= 0) {
        e.preventDefault();
        location.href = links[active].href;
      } else if (e.key === 'Escape') close();
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.search')) close(); });
  }
})();

// ---------- v3: mobile menu, genres dropdown, back to top ----------
(function () {
  var toggle = document.getElementById('menu-toggle');
  var nav = document.querySelector('.mainnav');
  if (toggle && nav) toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
    toggle.textContent = open ? '✕' : '☰';
  });
  document.querySelectorAll('.nav-drop-btn').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); b.parentNode.classList.toggle('open'); });
  });
  document.addEventListener('click', function (e) {
    document.querySelectorAll('.nav-drop.open').forEach(function (d) { if (!d.contains(e.target)) d.classList.remove('open'); });
    document.querySelectorAll('details.dropdown[open], details.usermenu[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  var top = document.getElementById('to-top');
  if (top) {
    window.addEventListener('scroll', function () { top.hidden = window.scrollY < 600; }, { passive: true });
    top.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }
})();
