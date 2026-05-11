export const REPORT_CSS = `
  :root {
    --bg: #0b0e14;
    --bg-card: #131720;
    --bg-elevated: #1a1f2b;
    --border: #232a37;
    --fg: #e6e8eb;
    --fg-muted: #8a93a6;
    --accent: #4f7df3;
    --green: #2ec27e;
    --yellow: #f5a623;
    --red: #e5484d;
    --critical: #e5484d;
    --high: #f5a623;
    --medium: #f2c94c;
    --low: #8a93a6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    line-height: 1.5;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    padding: 20px 32px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  header .urls { font-size: 13px; color: var(--fg-muted); margin-top: 4px; }
  header .meta-right { font-size: 12px; color: var(--fg-muted); }

  .layout { padding: 24px 32px; max-width: 1400px; margin: 0 auto; }

  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
    overflow-x: auto;
  }
  .tab {
    padding: 12px 18px;
    cursor: pointer;
    color: var(--fg-muted);
    border-bottom: 2px solid transparent;
    font-size: 14px;
    white-space: nowrap;
    user-select: none;
  }
  .tab.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .tab .badge {
    display: inline-block;
    background: var(--bg-elevated);
    padding: 2px 8px;
    border-radius: 10px;
    margin-left: 6px;
    font-size: 11px;
  }
  .panel { display: none; }
  .panel.active { display: block; }

  /* Verdict bar — single horizontal banner with status + score + counters */
  .verdict-bar {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 16px;
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  .verdict-status {
    font-size: 18px;
    font-weight: 700;
    padding: 8px 16px;
    border-radius: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .verdict-status.pass { background: rgba(46, 194, 126, 0.15); color: var(--green); }
  .verdict-status.warn { background: rgba(245, 166, 35, 0.15); color: var(--yellow); }
  .verdict-status.fail { background: rgba(229, 72, 77, 0.15); color: var(--red); }
  .verdict-score {
    display: flex;
    flex-direction: column;
  }
  .verdict-score .num {
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
  }
  .verdict-score .lbl {
    font-size: 11px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 4px;
  }
  .verdict-sep { width: 1px; height: 32px; background: var(--border); }
  .verdict-counts {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .count-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-elevated);
    border-radius: 8px;
    font-size: 13px;
  }
  .count-pill .num { font-weight: 700; font-size: 16px; }
  .count-pill .dot {
    display: inline-block;
    width: 10px; height: 10px; border-radius: 50%;
  }
  .dot.critical { background: var(--critical); }
  .dot.high { background: var(--high); }
  .dot.medium { background: var(--medium); }
  .dot.low { background: var(--low); }
  .verdict-checks {
    margin-left: auto;
    color: var(--fg-muted);
    font-size: 13px;
  }
  .verdict-checks .green { color: var(--green); font-weight: 600; }
  .verdict-checks .red { color: var(--red); font-weight: 600; }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 16px; margin: 0 0 12px 0; font-weight: 600; }
  .card .hint { font-size: 12px; color: var(--fg-muted); margin-top: -8px; margin-bottom: 12px; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-muted); font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-pass { background: rgba(46, 194, 126, 0.15); color: var(--green); }
  .status-warn { background: rgba(245, 166, 35, 0.15); color: var(--yellow); }
  .status-fail { background: rgba(229, 72, 77, 0.15); color: var(--red); }
  .status-skipped { background: rgba(138, 147, 166, 0.15); color: var(--fg-muted); }

  /* Issue card */
  .issue {
    border-left: 3px solid var(--border);
    padding: 14px 16px;
    margin-bottom: 12px;
    background: var(--bg-card);
    border-radius: 8px;
  }
  .issue.sev-critical { border-left-color: var(--critical); }
  .issue.sev-high { border-left-color: var(--high); }
  .issue.sev-medium { border-left-color: var(--medium); }
  .issue.sev-low { border-left-color: var(--low); }
  .issue-tags {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--bg-elevated);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .tag.sev-critical { background: rgba(229, 72, 77, 0.15); color: var(--critical); }
  .tag.sev-high { background: rgba(245, 166, 35, 0.15); color: var(--high); }
  .tag.sev-medium { background: rgba(242, 201, 76, 0.15); color: var(--medium); }
  .tag.sev-low { background: rgba(138, 147, 166, 0.15); color: var(--low); }
  .issue h3 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.4; }
  .issue .details, .issue .repro, .issue .fix {
    margin-top: 10px;
    font-size: 13px;
    color: var(--fg);
    white-space: pre-wrap;
    background: var(--bg-elevated);
    padding: 10px 12px;
    border-radius: 6px;
    font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
  }
  .issue .label {
    font-size: 11px;
    color: var(--fg-muted);
    text-transform: uppercase;
    margin-top: 10px;
    margin-bottom: 4px;
    letter-spacing: 0.04em;
  }

  /* Screenshot pairs */
  .ss-pair {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
    margin-top: 12px;
  }
  .ss-pair figure { margin: 0; }
  .ss-pair img {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: white;
  }
  .ss-pair figcaption { font-size: 11px; color: var(--fg-muted); margin-top: 4px; text-align: center; }

  /* Vitals table */
  .vitals-table td.metric-name { font-weight: 600; }
  .delta-good { color: var(--green); font-weight: 600; }
  .delta-bad { color: var(--red); font-weight: 600; }
  .delta-neutral { color: var(--fg-muted); }

  /* Side-by-side iframes */
  .sbs-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .sbs-toolbar button {
    background: var(--bg-elevated);
    color: var(--fg);
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }
  .sbs-toolbar button.active { background: var(--accent); color: white; }
  .sbs-toolbar button:hover { border-color: var(--accent); }
  .sbs-toolbar input[type="checkbox"] { margin: 0 4px; }
  .sbs-toolbar .label {
    font-size: 12px;
    color: var(--fg-muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sbs-toolbar .toolbar-right { margin-left: auto; font-size: 11px; color: var(--fg-muted); }

  .sbs-container {
    display: flex;
    gap: 16px;
    justify-content: center;
    align-items: flex-start;
  }
  .sbs-frame {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }
  .sbs-frame .frame-title {
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sbs-frame .frame-url {
    text-align: center;
    font-size: 11px;
    color: var(--fg-muted);
    margin-bottom: 8px;
    word-break: break-all;
    max-width: 375px;
  }
  .sbs-iframe {
    width: 375px;
    height: 80vh;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: white;
  }
  .sbs-warning {
    background: rgba(245, 166, 35, 0.12);
    border: 1px solid var(--yellow);
    color: var(--yellow);
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 12px;
    font-size: 13px;
  }

  /* LLM Prompt panel */
  .prompt-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .prompt-toolbar button {
    background: var(--accent);
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .prompt-toolbar button:hover { opacity: 0.9; }
  .prompt-toolbar button.secondary {
    background: var(--bg-elevated);
    color: var(--fg);
    border: 1px solid var(--border);
  }
  .prompt-toolbar .feedback {
    font-size: 12px;
    color: var(--green);
    margin-left: 8px;
    opacity: 0;
    transition: opacity 0.2s;
  }
  .prompt-toolbar .feedback.show { opacity: 1; }
  .prompt-toolbar .right { margin-left: auto; font-size: 12px; color: var(--fg-muted); }
  .prompt-md {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    max-height: 75vh;
    overflow-y: auto;
    font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }

  /* Issue card v2 — collapsible sections, copy buttons */
  .issue-tags .tag-mono { font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; text-transform: none; }
  .issue-tags .tag-page { background: rgba(79,125,243,0.15); color: #88aaff; }
  .issue-section { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
  .issue-section summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; list-style: none; padding: 4px 0; }
  .issue-section summary::-webkit-details-marker { display: none; }
  .issue-section summary::before { content: "▶"; color: var(--fg-muted); font-size: 9px; margin-right: 8px; display: inline-block; transition: transform .15s; }
  .issue-section[open] summary::before { transform: rotate(90deg); }
  .issue-section .section-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.04em; flex: 1; font-weight: 600; }
  .copy-btn { background: var(--bg-elevated); border: 1px solid var(--border); color: var(--fg-muted); font-size: 10px; padding: 2px 8px; border-radius: 4px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; }
  .copy-btn:hover { color: var(--fg); border-color: var(--accent); }
  .copy-btn.copied { color: var(--green); border-color: var(--green); }

  /* Cache hero */
  .cache-hero .hero-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 12px; }
  .hero-stat { background: var(--bg-elevated); border-radius: 10px; padding: 16px; text-align: center; }
  .hero-stat .big-num { font-size: 36px; font-weight: 700; line-height: 1; color: var(--fg); margin-bottom: 4px; }
  .hero-stat .big-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .hero-stat .hero-meta { font-size: 12px; color: var(--fg-muted); margin-top: 6px; }

  /* Network/cache tables */
  .net-toolbar { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  .net-input { background: var(--bg-elevated); color: var(--fg); border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px; font-size: 12px; min-width: 140px; }
  .net-input:focus { outline: 1px solid var(--accent); }
  .net-count { font-size: 11px; color: var(--fg-muted); margin-left: auto; }
  .net-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .net-table th, .net-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .net-table th { color: var(--fg-muted); font-weight: 500; cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--bg-card); z-index: 1; }
  .net-table th:hover { color: var(--fg); }
  .net-table th.sort-asc::after { content: " ▲"; color: var(--accent); font-size: 9px; }
  .net-table th.sort-desc::after { content: " ▼"; color: var(--accent); font-size: 9px; }
  .net-table td.num, .net-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .net-table tr.opp-row td { background: rgba(229,72,77,0.04); }
  .url-cell { max-width: 540px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url-cell a { color: var(--accent); text-decoration: none; }
  .url-cell a:hover { text-decoration: underline; }
  .net-cat { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; background: var(--bg-elevated); color: var(--fg-muted); }
  .net-cat.cat-document { background: rgba(79,125,243,0.15); color: #88aaff; }
  .net-cat.cat-static-asset { background: rgba(46,194,126,0.15); color: var(--green); }
  .net-cat.cat-image { background: rgba(245,166,35,0.15); color: var(--yellow); }
  .net-cat.cat-font { background: rgba(184,110,255,0.15); color: #b86eff; }
  .net-cat.cat-api { background: rgba(54,179,255,0.15); color: #36b3ff; }
  .net-cat.cat-third-party { background: rgba(138,147,166,0.15); color: var(--fg-muted); }
  .net-cat.cat-other { background: var(--bg-elevated); color: var(--fg-muted); }
  .net-cache { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .cache-hit { background: rgba(46,194,126,0.15); color: var(--green); }
  .cache-miss { background: rgba(229,72,77,0.15); color: var(--red); }
  .cache-bypass { background: rgba(138,147,166,0.15); color: var(--fg-muted); }
  .cat-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cat-table th, .cat-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  .cat-table th { color: var(--fg-muted); font-weight: 500; }
  .cat-table th.num, .cat-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: var(--fg-muted); }

  pre, code { font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; font-size: 12px; }
  pre {
    background: var(--bg-elevated);
    padding: 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  .empty {
    text-align: center;
    color: var(--fg-muted);
    padding: 40px;
    font-style: italic;
  }
`.trim();

export const REPORT_JS = `
  (function() {
    var tabs = document.querySelectorAll('[data-tab]');
    var panels = document.querySelectorAll('[data-panel]');
    function activate(name) {
      tabs.forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === name);
      });
      panels.forEach(function(p) {
        p.classList.toggle('active', p.dataset.panel === name);
      });
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    }
    tabs.forEach(function(t) {
      t.addEventListener('click', function() { activate(t.dataset.tab); });
    });
    var hash = (location.hash || '#summary').slice(1);
    activate(hash);

    // ---- Generic copy button (works for any [data-copy-target]) ----
    document.addEventListener('click', function(ev) {
      var t = ev.target;
      if (!t || !t.dataset || !t.dataset.copyTarget) return;
      var src = document.getElementById(t.dataset.copyTarget);
      if (!src) return;
      var text = src.textContent || '';
      var done = function() {
        var orig = t.textContent;
        t.classList.add('copied');
        t.textContent = '✓ copiado';
        setTimeout(function() {
          t.textContent = orig;
          t.classList.remove('copied');
        }, 1500);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(done);
      else done();
    });

    // ---- Network table: sort + filter + search ----
    (function() {
      var table = document.getElementById('net-table');
      if (!table) return;
      var tbody = table.querySelector('tbody');
      var allRows = Array.from(tbody.querySelectorAll('tr'));
      var search = document.getElementById('net-search');
      var fCat = document.getElementById('net-filter-cat');
      var fCache = document.getElementById('net-filter-cache');
      var count = document.getElementById('net-count');
      var sortKey = null;
      var sortDir = 1;

      function applyFilters() {
        var q = (search && search.value || '').toLowerCase();
        var cat = fCat ? fCat.value : '';
        var cache = fCache ? fCache.value : '';
        var visible = 0;
        for (var i = 0; i < allRows.length; i++) {
          var row = allRows[i];
          var url = row.dataset.url || '';
          var rCat = row.dataset.cat || '';
          var rCache = row.dataset.decision || '';
          var hideQ = q && url.indexOf(q) === -1;
          var hideCat = cat && rCat !== cat;
          var hideCache = false;
          if (cache === 'hit') hideCache = rCache !== 'hit';
          else if (cache === 'miss') hideCache = rCache !== 'miss' && rCache !== 'unknown';
          else if (cache === 'bypass') hideCache = rCache !== 'bypass';
          var hide = hideQ || hideCat || hideCache;
          row.style.display = hide ? 'none' : '';
          if (!hide) visible++;
        }
        if (count) count.textContent = visible + ' / ' + allRows.length + ' rows';
      }

      function sortBy(key) {
        if (sortKey === key) sortDir = -sortDir;
        else { sortKey = key; sortDir = 1; }
        var sorted = allRows.slice().sort(function(a, b) {
          var va, vb;
          if (key === 'bytes' || key === 'status') {
            va = Number(a.dataset[key]) || 0;
            vb = Number(b.dataset[key]) || 0;
          } else if (key === 'url') {
            va = a.dataset.url || '';
            vb = b.dataset.url || '';
          } else {
            va = a.dataset[key === 'cat' ? 'cat' : 'decision'] || '';
            vb = b.dataset[key === 'cat' ? 'cat' : 'decision'] || '';
          }
          if (va < vb) return -1 * sortDir;
          if (va > vb) return 1 * sortDir;
          return 0;
        });
        for (var i = 0; i < sorted.length; i++) tbody.appendChild(sorted[i]);
        var headers = table.querySelectorAll('th[data-sort]');
        for (var h = 0; h < headers.length; h++) {
          headers[h].classList.remove('sort-asc', 'sort-desc');
          if (headers[h].dataset.sort === key) {
            headers[h].classList.add(sortDir > 0 ? 'sort-asc' : 'sort-desc');
          }
        }
      }

      var headers = table.querySelectorAll('th[data-sort]');
      for (var h = 0; h < headers.length; h++) {
        headers[h].addEventListener('click', function(e) {
          sortBy(e.currentTarget.dataset.sort);
        });
      }
      if (search) search.addEventListener('input', applyFilters);
      if (fCat) fCat.addEventListener('change', applyFilters);
      if (fCache) fCache.addEventListener('change', applyFilters);
    })();

    // ---- LLM Prompt: copy + download ----
    var copyBtn = document.getElementById('prompt-copy');
    var dlBtn = document.getElementById('prompt-download');
    var promptEl = document.getElementById('prompt-md');
    var feedback = document.getElementById('prompt-feedback');
    if (copyBtn && promptEl) {
      copyBtn.addEventListener('click', function() {
        var text = promptEl.textContent || '';
        var done = function() {
          feedback.textContent = '✓ copiado!';
          feedback.classList.add('show');
          setTimeout(function() { feedback.classList.remove('show'); }, 2000);
        };
        if (navigator.clipboard) {
          navigator.clipboard.writeText(text).then(done).catch(function() {
            // Fallback: select+execCommand
            var range = document.createRange();
            range.selectNodeContents(promptEl);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            try { document.execCommand('copy'); done(); } catch (e) {}
            sel.removeAllRanges();
          });
        }
      });
    }
    if (dlBtn && promptEl) {
      dlBtn.addEventListener('click', function() {
        var text = promptEl.textContent || '';
        var blob = new Blob([text], { type: 'text/markdown' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'parity-prompt.md';
        a.click();
        setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
      });
    }

    // ---- Side-by-side iframe controller ----
    var sbsState = window.__parity_sbs || {};
    if (sbsState.pairs && sbsState.pairs.length > 0) {
      var current = 0;
      var syncEnabled = true;
      var btns = document.querySelectorAll('[data-sbs-btn]');
      var iframeProd = document.getElementById('sbs-prod');
      var iframeCand = document.getElementById('sbs-cand');
      var urlProdEl = document.getElementById('sbs-url-prod');
      var urlCandEl = document.getElementById('sbs-url-cand');
      var syncToggle = document.getElementById('sbs-sync');

      function load(idx) {
        current = idx;
        var pair = sbsState.pairs[idx];
        if (!pair) return;
        iframeProd.src = pair.prodUrl;
        iframeCand.src = pair.candUrl;
        urlProdEl.textContent = pair.prodUrl;
        urlCandEl.textContent = pair.candUrl;
        btns.forEach(function(b) {
          b.classList.toggle('active', b.dataset.sbsBtn === String(idx));
        });
      }
      btns.forEach(function(b) {
        b.addEventListener('click', function() { load(Number(b.dataset.sbsBtn)); });
      });
      if (syncToggle) {
        syncToggle.addEventListener('change', function() { syncEnabled = syncToggle.checked; });
      }

      // Scroll sync (best-effort; cross-origin iframes will silently no-op)
      var syncing = false;
      function attachScroll(src, dst) {
        try {
          src.contentWindow.addEventListener('scroll', function() {
            if (!syncEnabled || syncing) return;
            syncing = true;
            try {
              dst.contentWindow.scrollTo(src.contentWindow.scrollX, src.contentWindow.scrollY);
            } catch (e) {}
            setTimeout(function() { syncing = false; }, 30);
          }, { passive: true });
        } catch (e) {
          /* cross-origin: scroll sync not possible */
        }
      }
      function tryAttach() {
        attachScroll(iframeProd, iframeCand);
        attachScroll(iframeCand, iframeProd);
      }
      iframeProd.addEventListener('load', tryAttach);
      iframeCand.addEventListener('load', tryAttach);

      // Initial load
      if (sbsState.pairs.length > 0) load(0);
    }
  })();
`.trim();
