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
    // Logged in: remember the choice on the account too (applies on every device).
    var csrf = document.querySelector('meta[name=csrf]');
    if (window.ACCOUNT && csrf) {
      fetch('/account/prefs', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.content, Accept: 'application/json' },
        body: JSON.stringify({ theme: root.dataset.theme }),
      }).catch(function () {});
    }
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

// ---------- Novel requests: vote without reloading the page ----------
(function () {
  document.querySelectorAll('form[data-vote]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('.vote-btn');
      fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); })
        .then(function (d) {
          btn.classList.toggle('on', d.voted);
          btn.setAttribute('aria-pressed', d.voted ? 'true' : 'false');
          btn.title = d.voted ? 'Remove my vote' : 'Vote for this novel';
          var weekly = /[?&]tab=(all|new)/.test(location.search) ? d.votes : d.week_votes;
          btn.querySelector('[data-count]').textContent = weekly;
        })
        .catch(function (err) { alert(err.message === 'Failed' ? 'Could not save your vote. Please try again.' : err.message); });
    });
  });
})();

// ---------- Live countdown to the weekly leaderboard reset ----------
(function () {
  var el = document.querySelector('[data-countdown]');
  if (!el) return;
  var end = Number(el.dataset.countdown);
  function tick() {
    var s = Math.max(0, Math.floor((end - Date.now()) / 1000));
    if (!s) { el.textContent = 'now — refresh for the new week'; return; }
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    el.textContent = (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
    setTimeout(tick, 30000);
  }
  tick();
})();

// ---------- "Request update" on the novel page without reloading ----------
(function () {
  var form = document.querySelector('form[data-request-update]');
  if (!form) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = form.querySelector('button');
    btn.disabled = true;
    fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Failed'); return d; }); })
      .then(function (d) {
        btn.classList.add('btn-on');
        btn.querySelector('[data-label]').textContent = 'Update requested';
        var count = btn.querySelector('[data-count]');
        count.textContent = d.waiting;
        count.hidden = false;
        btn.title = d.waiting + ' reader' + (d.waiting === 1 ? '' : 's') + ' waiting for new chapters';
      })
      .catch(function (err) { btn.disabled = false; alert(err.message === 'Failed' ? 'Could not send the request. Please try again.' : err.message); });
  });
})();

// ---------- Phones: search button and the bottom tab bar ----------
(function () {
  var topbar = document.querySelector('.topbar');
  var input = document.getElementById('search-input');
  function openSearch() {
    if (!topbar || !input) return;
    var open = !topbar.classList.contains('searching');
    topbar.classList.toggle('searching', open);
    if (open) { window.scrollTo({ top: 0 }); input.focus(); }
  }
  document.querySelectorAll('#search-open, [data-search-open]').forEach(function (b) {
    b.addEventListener('click', function (e) { e.preventDefault(); openSearch(); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && topbar) topbar.classList.remove('searching');
  });
  document.addEventListener('click', function (e) {
    if (topbar && topbar.classList.contains('searching') && !topbar.contains(e.target) && !e.target.closest('[data-search-open]')) topbar.classList.remove('searching');
  });

  // Tuck the tab bar away while scrolling down to read; bring it back when scrolling up.
  var bar = document.getElementById('tabbar');
  if (!bar) return;
  var lastY = window.scrollY;
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      var y = window.scrollY;
      var nearBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 40;
      if (Math.abs(y - lastY) > 6) {
        bar.classList.toggle('hide', y > lastY && y > 80 && !nearBottom);
        lastY = y;
      }
      ticking = false;
    });
  }, { passive: true });
})();
