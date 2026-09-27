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
