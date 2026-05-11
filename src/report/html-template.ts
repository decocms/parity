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
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  header h1 { font-size: 18px; margin: 0; }
  header .urls { font-size: 13px; color: var(--fg-muted); }
  .layout { padding: 24px 32px; max-width: 1400px; margin: 0 auto; }
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
    overflow-x: auto;
  }
  .tab {
    padding: 12px 20px;
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
  .score-block {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 24px;
    align-items: center;
  }
  .score-circle {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 160px;
    height: 160px;
    border-radius: 50%;
    border: 6px solid var(--accent);
    margin: 0 auto;
  }
  .score-circle .score { font-size: 48px; font-weight: 700; }
  .score-circle .label { font-size: 12px; color: var(--fg-muted); text-transform: uppercase; }
  .score-circle.pass { border-color: var(--green); }
  .score-circle.warn { border-color: var(--yellow); }
  .score-circle.fail { border-color: var(--red); }
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .badge-sev {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: var(--bg-elevated);
    border-radius: 8px;
    font-size: 13px;
  }
  .badge-sev .dot {
    display: inline-block;
    width: 8px; height: 8px; border-radius: 50%;
  }
  .badge-sev .count { font-weight: 600; }
  .dot.critical { background: var(--critical); }
  .dot.high { background: var(--high); }
  .dot.medium { background: var(--medium); }
  .dot.low { background: var(--low); }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }
  .card h2 { font-size: 16px; margin: 0 0 12px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-muted); font-weight: 500; }
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
  .issue {
    border-left: 3px solid var(--border);
    padding: 12px 16px;
    margin-bottom: 12px;
    background: var(--bg-card);
    border-radius: 8px;
  }
  .issue.sev-critical { border-left-color: var(--critical); }
  .issue.sev-high { border-left-color: var(--high); }
  .issue.sev-medium { border-left-color: var(--medium); }
  .issue.sev-low { border-left-color: var(--low); }
  .issue h3 { margin: 0 0 4px 0; font-size: 14px; }
  .issue .meta { font-size: 12px; color: var(--fg-muted); }
  .issue .details, .issue .repro, .issue .fix {
    margin-top: 8px;
    font-size: 13px;
    color: var(--fg);
    white-space: pre-wrap;
    background: var(--bg-elevated);
    padding: 8px 12px;
    border-radius: 6px;
  }
  .issue .label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; margin-bottom: 4px; }
  .ss-pair {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
    margin-top: 12px;
  }
  .ss-pair img {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: white;
  }
  .ss-pair figcaption { font-size: 11px; color: var(--fg-muted); margin-top: 4px; text-align: center; }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
  }
  .metric {
    background: var(--bg-elevated);
    padding: 12px;
    border-radius: 8px;
  }
  .metric .label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; }
  .metric .val { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .metric .delta { font-size: 12px; margin-top: 2px; }
  .metric .delta.up { color: var(--red); }
  .metric .delta.down { color: var(--green); }
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
  })();
`.trim();
