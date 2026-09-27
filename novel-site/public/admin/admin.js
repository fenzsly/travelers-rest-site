// Shared helpers: local times and date pickers that submit exact timestamps.
(function () {
  var fmt = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  document.querySelectorAll('.local-time[data-ts], .local-time[data-iso]').forEach(function (e) {
    var d = e.dataset.ts ? new Date(Number(e.dataset.ts) * 1000) : new Date(e.dataset.iso);
    if (!isNaN(d)) e.textContent = d.toLocaleString(undefined, fmt);
  });
  function toLocalInput(d) { var z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); }
  // <input type=datetime-local class=dt-local data-target=NAME> writes unix seconds into the hidden input NAME.
  document.querySelectorAll('.dt-local').forEach(function (input) {
    var form = input.closest('form');
    var hidden = form.querySelector('input[type=hidden][name="' + input.dataset.target + '"]');
    if (input.dataset.initial) input.value = toLocalInput(new Date(Number(input.dataset.initial) * 1000));
    else if (!input.value) { var d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); input.value = toLocalInput(d); }
    function sync() { var t = new Date(input.value).getTime(); hidden.value = isNaN(t) ? '' : Math.round(t / 1000); }
    input.addEventListener('input', sync);
    if (!input.closest('[hidden]')) sync();
  });
  // "Fix in editor" from a reader report: select the reported text in the chapter editor.
  var find = new URLSearchParams(location.search).get('find');
  var editor = document.querySelector('.chapter-editor textarea[name=content]');
  if (find && editor) {
    var at = editor.value.indexOf(find);
    if (at === -1) at = editor.value.toLowerCase().indexOf(find.toLowerCase().slice(0, 40));
    if (at !== -1) {
      editor.focus();
      editor.setSelectionRange(at, at + find.length);
      // Scroll the textarea so the selection is visible.
      var before = editor.value.slice(0, at).split('\n').length;
      editor.scrollTop = Math.max(0, (before - 3) * parseFloat(getComputedStyle(editor).lineHeight || 22));
    }
  }

  var toggle = document.getElementById('sched-toggle');
  if (toggle) {
    var box = document.getElementById('sched-box');
    var hidden = toggle.closest('form').querySelector('input[name=publish_at]');
    var picker = box.querySelector('.dt-local');
    toggle.addEventListener('change', function () {
      box.hidden = !toggle.checked;
      if (toggle.checked) { var t = new Date(picker.value).getTime(); hidden.value = isNaN(t) ? '' : Math.round(t / 1000); }
      else hidden.value = '';
    });
  }
})();

// Admin panel interactions: cover preview, chapter table inline editing, batch uploader.
(function () {
  var csrfMeta = document.querySelector('meta[name=csrf]');
  var CSRF = csrfMeta ? csrfMeta.content : '';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function postJSON(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': CSRF },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('Request failed (' + r.status + ')'));
        return data;
      });
    });
  }
  function fmtNum(n) { return String(+Number(n).toFixed(2)); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---------- Cover preview ----------
  var coverInput = $('#cover-input');
  if (coverInput) {
    var drop = $('#cover-drop');
    coverInput.addEventListener('change', function () {
      var f = coverInput.files[0];
      if (!f) return;
      var img = $('#cover-preview');
      img.src = URL.createObjectURL(f);
      img.hidden = false;
      $('#cover-hint').hidden = true;
    });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function () { drop.classList.remove('over'); }); });
  }

  // ---------- Chapter table ----------
  var bulkForm = $('#bulk-form');
  if (bulkForm) {
    var checks = $$('.row-check', bulkForm);
    var all = $('#check-all');
    var countEl = $('#sel-count');
    var lastClicked = null;
    function refresh() { countEl.textContent = checks.filter(function (c) { return c.checked; }).length; }
    all.addEventListener('change', function () { checks.forEach(function (c) { c.checked = all.checked; }); refresh(); });
    checks.forEach(function (c, i) {
      c.addEventListener('click', function (e) {
        // Shift-click selects a range.
        if (e.shiftKey && lastClicked !== null) {
          var a = Math.min(lastClicked, i), b = Math.max(lastClicked, i);
          for (var k = a; k <= b; k++) checks[k].checked = c.checked;
        }
        lastClicked = i;
        refresh();
      });
    });
    bulkForm.addEventListener('submit', function (e) {
      var btn = e.submitter;
      var selected = checks.filter(function (c) { return c.checked; }).length;
      if (btn && !btn.hasAttribute('data-no-selection') && !selected) {
        e.preventDefault();
        alert('Select some chapters first (tick the boxes on the left, shift-click for a range).');
        return;
      }
      if (btn && btn.dataset.confirm && !confirm(btn.dataset.confirm)) e.preventDefault();
    });

    var url = bulkForm.dataset.updateUrl;
    $$('.inline-edit', bulkForm).forEach(function (input) {
      input.dataset.orig = input.value;
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = input.dataset.orig; input.blur(); }
      });
      input.addEventListener('blur', function () {
        if (input.value === input.dataset.orig) return;
        var body = { action: 'update', id: input.dataset.id };
        body[input.dataset.field] = input.value;
        postJSON(url, body).then(function () {
          input.dataset.orig = input.value;
          input.classList.remove('bad');
          input.classList.add('saved');
          setTimeout(function () { input.classList.remove('saved'); }, 1200);
        }).catch(function (err) {
          input.classList.add('bad');
          alert(err.message);
          input.value = input.dataset.orig;
          setTimeout(function () { input.classList.remove('bad'); }, 1500);
        });
      });
    });
  }

  // ---------- Batch uploader ----------
  var up = $('#uploader');
  if (!up) return;

  var state = { mode: 'files', chapters: [], existing: {} };
  var statusEl = $('#parse-status');
  var body = $('#preview-body');

  $$('.mode-tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.mode = b.dataset.mode;
      $$('.mode-tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      $$('.mode-pane').forEach(function (p) { p.hidden = p.dataset.pane !== state.mode; });
    });
  });

  function setStatus(text, isErr) {
    statusEl.hidden = !text;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('err', !!isErr);
  }

  var ACCEPT = /\.(txt|text|md|markdown|html?|xhtml|docx|zip|epub)$/i;
  function sendForParsing(files, text) {
    var fd = new FormData();
    fd.append('_csrf', CSRF);
    fd.append('mode', state.mode);
    fd.append('pattern', $('#pattern').value);
    if (text != null) fd.append('text', text);
    var skipped = 0;
    (files || []).forEach(function (f) {
      // Keep folder names (e.g. "Volume 2/ch01.txt") so volumes can be detected.
      if (ACCEPT.test(f.name)) fd.append('files', f, f.webkitRelativePath || f.name); else skipped++;
    });
    if (files && files.length && skipped === files.length) {
      setStatus('None of those files are supported. Use .txt, .docx, .md, .html, .zip or .epub.', true);
      return;
    }
    setStatus('Reading ' + (files ? (files.length - skipped) + ' file(s)' : 'text') + '…');
    fetch(up.dataset.parseUrl, { method: 'POST', body: fd, credentials: 'same-origin', headers: { 'X-CSRF-Token': CSRF, Accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Upload failed'); return d; }); })
      .then(function (data) {
        state.existing = {};
        data.existing.forEach(function (n) { state.existing[fmtNum(n)] = true; });
        var added = data.chapters.map(function (c) { return { number: c.number, volume: c.volume || '', title: c.title, content: c.content, words: c.wordCount, source: c.source, include: true }; });
        state.chapters = state.chapters.concat(added);
        var msg = added.length ? 'Found ' + added.length + ' chapter' + (added.length === 1 ? '' : 's') + '.' : 'No chapters found. Check the file format or heading pattern.';
        if (skipped) msg += ' Skipped ' + skipped + ' unsupported file(s).';
        setStatus(msg, !added.length);
        showErrors(data.errors);
        render();
      })
      .catch(function (err) { setStatus(err.message, true); });
  }

  function showErrors(errors) {
    var el = $('#parse-errors');
    el.hidden = !errors || !errors.length;
    el.innerHTML = (errors || []).map(function (e) { return '⚠ ' + escapeHtml(e); }).join('<br>');
  }

  function wireDrop(zone, input) {
    input.addEventListener('change', function () { if (input.files.length) sendForParsing(Array.prototype.slice.call(input.files)); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function () { zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      if (e.dataTransfer.files.length) sendForParsing(Array.prototype.slice.call(e.dataTransfer.files));
    });
  }
  wireDrop($('#dropzone'), $('#file-input'));
  wireDrop($('#dropzone-split'), $('#split-input'));
  var folderInput = $('#folder-input');
  $('#pick-folder').addEventListener('click', function () { folderInput.click(); });
  folderInput.addEventListener('change', function () { if (folderInput.files.length) sendForParsing(Array.prototype.slice.call(folderInput.files)); folderInput.value = ''; });
  $('#paste-go').addEventListener('click', function () {
    var text = $('#paste-text').value;
    if (!text.trim()) return setStatus('Paste some text first.', true);
    sendForParsing(null, text);
  });

  // ----- Preview table -----
  function statusFor(c, counts) {
    var n = Number(c.number);
    if (!isFinite(n) || n < 0 || String(c.number).trim() === '') return ['bad', 'Invalid #'];
    if (counts[fmtNum(n)] > 1) return ['dup', 'Duplicate #'];
    if (state.existing[fmtNum(n)]) return ['exists', $('#on-conflict').value === 'overwrite' ? 'Will replace' : 'Exists, skip'];
    return ['new', 'New'];
  }

  function render() {
    $('#step-2').hidden = state.chapters.length === 0;
    var counts = {};
    state.chapters.forEach(function (c) { if (c.include) { var k = fmtNum(c.number); counts[k] = (counts[k] || 0) + 1; } });
    var html = state.chapters.map(function (c, i) {
      var st = c.include ? statusFor(c, counts) : ['', 'Excluded'];
      return '<tr data-i="' + i + '" class="' + (c.include ? '' : 'excluded') + '">' +
        '<td><input type="checkbox" class="pv-inc"' + (c.include ? ' checked' : '') + '></td>' +
        '<td><input class="pv-num num-input" value="' + escapeHtml(c.number) + '" inputmode="decimal"></td>' +
        '<td><input class="pv-vol num-input" value="' + escapeHtml(c.volume) + '" inputmode="numeric" placeholder="—"></td>' +
        '<td><input class="pv-title" value="' + escapeHtml(c.title) + '" placeholder="(no title)"></td>' +
        '<td class="right muted">' + Number(c.words).toLocaleString('en-US') + '</td>' +
        '<td class="src" title="' + escapeHtml(c.source) + '">' + escapeHtml(c.source) + '</td>' +
        '<td>' + (st[0] ? '<span class="tag tag-' + st[0] + '">' + st[1] + '</span>' : '<span class="muted small">' + st[1] + '</span>') + '</td>' +
        '<td class="right nowrap"><button type="button" class="btn btn-sm pv-view">👁 Preview</button> <button type="button" class="btn btn-sm btn-ghost pv-del" title="Remove">✕</button></td>' +
        '</tr>';
    }).join('');
    body.innerHTML = html;
    var inc = state.chapters.filter(function (c) { return c.include; });
    var words = inc.reduce(function (a, c) { return a + Number(c.words || 0); }, 0);
    var nums = inc.map(function (c) { return Number(c.number); }).filter(isFinite);
    $('#summary').textContent = inc.length + ' selected · ' + words.toLocaleString('en-US') + ' words' +
      (nums.length ? ' · chapters ' + fmtNum(Math.min.apply(null, nums)) + '–' + fmtNum(Math.max.apply(null, nums)) : '');
    $('#publish-count').textContent = inc.length;
    $('#pv-all').checked = inc.length === state.chapters.length;
    if ($('#renumber-from').value === '' && nums.length) $('#renumber-from').value = fmtNum(Math.min.apply(null, nums));
  }

  body.addEventListener('change', function (e) {
    var tr = e.target.closest('tr');
    var c = state.chapters[tr.dataset.i];
    if (e.target.classList.contains('pv-inc')) c.include = e.target.checked;
    if (e.target.classList.contains('pv-num')) c.number = e.target.value;
    if (e.target.classList.contains('pv-title')) c.title = e.target.value;
    if (e.target.classList.contains('pv-vol')) c.volume = e.target.value.trim();
    render();
  });
  body.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    var c = state.chapters[tr.dataset.i];
    if (e.target.classList.contains('pv-del')) { state.chapters.splice(Number(tr.dataset.i), 1); render(); }
    if (e.target.classList.contains('pv-view')) {
      $('#dlg-title').textContent = (c.volume ? 'Vol. ' + c.volume + ' · ' : '') + 'Chapter ' + c.number + (c.title ? ': ' + c.title : '');
      // Content was sanitized on the server during parsing.
      $('#dlg-body').innerHTML = c.content;
      $('#preview-dialog').showModal();
    }
  });
  $('#pv-all').addEventListener('change', function (e) { state.chapters.forEach(function (c) { c.include = e.target.checked; }); render(); });
  $('#on-conflict').addEventListener('change', render);
  $('#sort-go').addEventListener('click', function () {
    state.chapters.sort(function (a, b) { return Number(a.number) - Number(b.number); });
    render();
  });
  $('#renumber-go').addEventListener('click', function () {
    var start = Number($('#renumber-from').value);
    if (!isFinite(start)) return alert('Enter a starting number.');
    state.chapters.filter(function (c) { return c.include; }).forEach(function (c, i) { c.number = start + i; });
    render();
  });
  $('#strip-go').addEventListener('click', function () {
    state.chapters.forEach(function (c) {
      c.title = String(c.title).replace(/^\s*(chapter|ch\.?|episode|ep\.?)\s*\d+(\.\d+)?\s*[:.\-–—|]?\s*/i, '').trim();
    });
    render();
  });
  function reset() {
    state.chapters = [];
    $('#renumber-from').value = '';
    setStatus('');
    showErrors([]);
    render();
  }
  $('#clear-go').addEventListener('click', function () { if (confirm('Discard this preview?')) reset(); });

  // ----- Gradual release -----
  var relRadios = $$('input[name=release]');
  var relStart = $('#rel-start'), relEvery = $('#rel-every');
  function toLocalInput(d) { var z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); }
  function scheduling() { return relRadios.some(function (r) { return r.checked && r.value === 'schedule'; }); }
  function releasePlan() {
    if (!scheduling()) return null;
    var start = new Date(relStart.value).getTime() / 1000;
    var every = Number(relEvery.value);
    if (!isFinite(start) || start < Date.now() / 1000) { alert('Pick a first release time in the future.'); return false; }
    if (!isFinite(every) || every < 0) { alert('Enter how many hours between releases.'); return false; }
    return { start: start, every: every };
  }
  function releaseTime(index) {
    var plan = releasePlan();
    return plan ? Math.round(plan.start + index * plan.every * 3600) : null;
  }
  function updateRelSummary() {
    var n = state.chapters.filter(function (c) { return c.include; }).length;
    var plan = scheduling() && relStart.value ? { start: new Date(relStart.value).getTime() / 1000, every: Number(relEvery.value) } : null;
    var el = $('#rel-summary');
    if (!plan || !n || !isFinite(plan.start)) { el.textContent = ''; return; }
    var last = new Date((plan.start + (n - 1) * plan.every * 3600) * 1000);
    el.textContent = n + ' chapters, last one on ' + last.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '.';
  }
  relRadios.forEach(function (r) {
    r.addEventListener('change', function () {
      $('#release-sched').hidden = !scheduling();
      if (scheduling() && !relStart.value) { var d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0); relStart.value = toLocalInput(d); }
      updateRelSummary();
    });
  });
  relStart.addEventListener('input', updateRelSummary);
  relEvery.addEventListener('input', updateRelSummary);
  body.addEventListener('change', updateRelSummary);

  // ----- Publish (sent in batches so huge uploads don't hit request limits) -----
  $('#publish-go').addEventListener('click', function () {
    var list = state.chapters.filter(function (c) { return c.include; });
    if (!list.length) return alert('No chapters selected.');
    var counts = {};
    list.forEach(function (c) { var k = fmtNum(c.number); counts[k] = (counts[k] || 0) + 1; });
    var bad = list.filter(function (c) { var s = statusFor(c, counts)[0]; return s === 'bad' || s === 'dup'; });
    if (bad.length) return alert(bad.length + ' chapter(s) have an invalid or duplicate number. Fix the red rows first.');

    var sched = releasePlan();
    if (sched === false) return;
    var btn = this;
    btn.disabled = true;
    var prog = $('#publish-progress');
    prog.hidden = false;
    var fill = $('.progress-fill', prog), label = $('span', prog);
    var BATCH = 50;
    var total = { created: 0, updated: 0, skipped: [], invalid: [], scheduled: 0 };
    var onConflict = $('#on-conflict').value;
    var i = 0;
    function next() {
      if (i >= list.length) return done();
      var slice = list.slice(i, i + BATCH).map(function (c, k) { return { number: Number(c.number), volume: c.volume === '' ? null : Number(c.volume), title: c.title, content: c.content, publish_at: releaseTime(i + k) }; });
      label.textContent = 'Publishing ' + Math.min(i + BATCH, list.length) + ' / ' + list.length + '…';
      postJSON(up.dataset.commitUrl, { chapters: slice, onConflict: onConflict }).then(function (r) {
        total.created += r.created; total.updated += r.updated; total.scheduled += r.scheduled || 0;
        total.skipped = total.skipped.concat(r.skipped); total.invalid = total.invalid.concat(r.invalid);
        i += BATCH;
        fill.style.width = Math.round(Math.min(i, list.length) / list.length * 100) + '%';
        next();
      }).catch(function (err) {
        btn.disabled = false;
        label.textContent = 'Error: ' + err.message + ' (' + (total.created + total.updated) + ' chapters were saved before this.)';
      });
    }
    function done() {
      btn.disabled = false;
      prog.hidden = true;
      fill.style.width = '0';
      var parts = [];
      if (total.created) parts.push('<strong>' + total.created + '</strong> new chapter' + (total.created === 1 ? '' : 's') + ' published');
      if (total.updated) parts.push('<strong>' + total.updated + '</strong> replaced');
      if (total.skipped.length) parts.push(total.skipped.length + ' skipped because they already existed (' + total.skipped.slice(0, 10).map(fmtNum).join(', ') + (total.skipped.length > 10 ? '…' : '') + ')');
      if (total.invalid.length) parts.push(total.invalid.length + ' rejected (empty or invalid)');
      if (total.scheduled) parts.push('<strong>' + total.scheduled + '</strong> scheduled for later release');
      $('#result-text').innerHTML = (parts.join(', ') || 'Nothing changed') + '.';
      var firstNum = Math.min.apply(null, list.map(function (c) { return Number(c.number); }));
      $('#result-read').href = up.dataset.readUrl + fmtNum(firstNum);
      $('#step-1').hidden = true;
      $('#step-2').hidden = true;
      $('#step-3').hidden = false;
      window.scrollTo(0, 0);
    }
    next();
  });

  $('#again-go').addEventListener('click', function () {
    $('#step-3').hidden = true;
    $('#step-1').hidden = false;
    reset();
  });

  // Warn before leaving with an unpublished preview.
  window.addEventListener('beforeunload', function (e) {
    if (state.chapters.length && $('#step-3').hidden) { e.preventDefault(); e.returnValue = ''; }
  });
})();
