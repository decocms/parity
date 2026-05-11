export const REPORT_CSS = `
  :root[data-theme="dark"], :root {
    --surface-base: #0b0e14;
    --surface-elevated: #131720;
    --surface-overlay: #1a1f2b;
    --surface-sidebar: #0f131c;
    --border-default: #232a37;
    --border-strong: #2f3847;
    --text-primary: #e6e8eb;
    --text-secondary: #c2c8d3;
    --text-muted: #8a93a6;
    --accent-action: #4f7df3;
    --accent-prod: #36b3ff;
    --accent-cand: #b86eff;
    --state-good: #2ec27e;
    --state-warn: #f5a623;
    --state-bad: #e5484d;
    --state-info: #36b3ff;
    --shadow-card: 0 1px 3px rgba(0,0,0,0.3);
    /* legacy tokens (mapped for backwards compat) */
    --bg: var(--surface-base);
    --bg-card: var(--surface-elevated);
    --bg-elevated: var(--surface-overlay);
    --border: var(--border-default);
    --fg: var(--text-primary);
    --fg-muted: var(--text-muted);
    --accent: var(--accent-action);
    --green: var(--state-good);
    --yellow: var(--state-warn);
    --red: var(--state-bad);
    --critical: var(--state-bad);
    --high: var(--state-warn);
    --medium: #f2c94c;
    --low: var(--text-muted);
  }
  :root[data-theme="light"] {
    --surface-base: #f7f8fb;
    --surface-elevated: #ffffff;
    --surface-overlay: #eef1f6;
    --surface-sidebar: #ffffff;
    --border-default: #d6dae3;
    --border-strong: #b9bfca;
    --text-primary: #0e1217;
    --text-secondary: #3a414f;
    --text-muted: #6b7588;
    --accent-action: #2456cf;
    --accent-prod: #1c8ed8;
    --accent-cand: #8a48d2;
    --state-good: #16895a;
    --state-warn: #c5800a;
    --state-bad: #b8242a;
    --shadow-card: 0 1px 2px rgba(15,20,30,0.06), 0 4px 12px rgba(15,20,30,0.05);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; min-height: 100vh; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--surface-base);
    color: var(--text-primary);
    line-height: 1.5;
  }
  a { color: var(--accent-action); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout grid */
  .app {
    display: grid;
    grid-template-columns: 240px 1fr;
    grid-template-rows: auto 1fr;
    grid-template-areas: "side header" "side main";
    min-height: 100vh;
  }
  .app-header {
    grid-area: header;
    background: var(--surface-elevated);
    border-bottom: 1px solid var(--border-default);
    padding: 14px 28px;
    position: sticky;
    top: 0;
    z-index: 50;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .app-header h1 {
    font-size: 16px;
    margin: 0;
    font-weight: 600;
    color: var(--text-primary);
  }
  .app-header .urls {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .app-header .url-prod::before { content: "●"; color: var(--accent-prod); margin-right: 6px; }
  .app-header .url-cand::before { content: "●"; color: var(--accent-cand); margin-right: 6px; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  .action-btn {
    background: var(--surface-overlay);
    border: 1px solid var(--border-default);
    color: var(--text-secondary);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .action-btn:hover { color: var(--text-primary); border-color: var(--accent-action); }

  .app-sidebar {
    grid-area: side;
    background: var(--surface-sidebar);
    border-right: 1px solid var(--border-default);
    padding: 20px 0;
    position: sticky;
    top: 0;
    align-self: start;
    height: 100vh;
    overflow-y: auto;
  }
  .sidebar-brand {
    padding: 0 20px 16px 20px;
    border-bottom: 1px solid var(--border-default);
    margin-bottom: 12px;
  }
  .sidebar-brand strong { font-size: 14px; color: var(--text-primary); display: block; }
  .sidebar-brand small { font-size: 11px; color: var(--text-muted); font-family: "SF Mono", Menlo, monospace; }
  .sidebar-nav { display: flex; flex-direction: column; padding: 0 8px; }
  .nav-item {
    padding: 9px 12px;
    border-radius: 6px;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 10px;
    user-select: none;
    margin-bottom: 2px;
    transition: background 0.15s, color 0.15s;
  }
  .nav-item:hover { background: var(--surface-overlay); color: var(--text-primary); }
  .nav-item.active {
    background: var(--surface-overlay);
    color: var(--text-primary);
    box-shadow: inset 2px 0 0 var(--accent-action);
  }
  .nav-item .icon { font-size: 14px; opacity: 0.9; width: 18px; text-align: center; }
  .nav-item .label { flex: 1; }
  .nav-item .count {
    background: var(--surface-base);
    border: 1px solid var(--border-default);
    color: var(--text-muted);
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 10px;
    font-variant-numeric: tabular-nums;
  }
  .nav-item.active .count { background: var(--accent-action); border-color: var(--accent-action); color: white; }
  .sidebar-footer {
    padding: 16px 20px;
    border-top: 1px solid var(--border-default);
    margin-top: 16px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .app-main {
    grid-area: main;
    padding: 28px 32px;
    max-width: 1280px;
    width: 100%;
  }

  .panel { display: none; animation: fadein 0.2s ease; }
  .panel.active { display: block; }
  @keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* Dashboard v2 — Migration Health hero */
  .dash-hero {
    background: var(--surface-elevated);
    border: 1px solid var(--border-default);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: var(--shadow-card);
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 32px;
    align-items: center;
  }
  .health-score {
    width: 140px;
    height: 140px;
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    background: var(--surface-overlay);
  }
  .health-score::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(var(--ring-color, var(--state-bad)) var(--ring-deg, 0deg), var(--border-default) 0);
    z-index: 0;
  }
  .health-score::after {
    content: "";
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    background: var(--surface-elevated);
    z-index: 1;
  }
  .health-score .score-num, .health-score .score-label {
    position: relative; z-index: 2;
  }
  .health-score .score-num {
    font-size: 46px; font-weight: 700; line-height: 1;
    color: var(--text-primary);
  }
  .health-score .score-num small {
    font-size: 14px; color: var(--text-muted); font-weight: 400;
  }
  .health-score .score-label {
    font-size: 10px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    margin-top: 4px;
  }
  .dash-hero-info { display: flex; flex-direction: column; gap: 8px; }
  .dash-hero-info .verdict-text {
    font-size: 20px; font-weight: 700;
  }
  .dash-hero-info .verdict-text.pass { color: var(--state-good); }
  .dash-hero-info .verdict-text.warn { color: var(--state-warn); }
  .dash-hero-info .verdict-text.fail { color: var(--state-bad); }
  .dash-hero-info .verdict-sub { color: var(--text-secondary); font-size: 14px; }
  .dash-hero-info .verdict-meta { color: var(--text-muted); font-size: 12px; margin-top: 8px; display: flex; gap: 16px; flex-wrap: wrap; }
  .dash-hero-info .verdict-meta span strong { color: var(--text-primary); font-weight: 600; }

  /* Metric tiles */
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .tile {
    background: var(--surface-elevated);
    border: 1px solid var(--border-default);
    border-radius: 12px;
    padding: 16px;
    box-shadow: var(--shadow-card);
    cursor: pointer;
    transition: transform 0.15s, border-color 0.15s;
    text-decoration: none;
    color: inherit;
    display: block;
  }
  .tile:hover { transform: translateY(-2px); border-color: var(--accent-action); text-decoration: none; }
  .tile .tile-icon { font-size: 18px; margin-bottom: 8px; }
  .tile .tile-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .tile .tile-value { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .tile .tile-meta { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
  .tile.state-pass { border-left: 3px solid var(--state-good); }
  .tile.state-warn { border-left: 3px solid var(--state-warn); }
  .tile.state-fail { border-left: 3px solid var(--state-bad); }
  .tile.state-info { border-left: 3px solid var(--state-info); }

  /* Cards */
  .card {
    background: var(--surface-elevated);
    border: 1px solid var(--border-default);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: var(--shadow-card);
  }
  .card h2 { font-size: 15px; margin: 0 0 12px 0; font-weight: 600; }
  .card .hint { font-size: 12px; color: var(--text-muted); margin-top: -6px; margin-bottom: 12px; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border-default); }
  th { color: var(--text-muted); font-weight: 500; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

  .status-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-pass { background: rgba(46, 194, 126, 0.15); color: var(--state-good); }
  .status-warn { background: rgba(245, 166, 35, 0.15); color: var(--state-warn); }
  .status-fail { background: rgba(229, 72, 77, 0.15); color: var(--state-bad); }
  .status-skipped { background: rgba(138, 147, 166, 0.15); color: var(--text-muted); }

  /* Issue card v2 */
  .issue {
    border-left: 3px solid var(--border-default);
    padding: 14px 16px;
    margin-bottom: 12px;
    background: var(--surface-elevated);
    border-radius: 8px;
    box-shadow: var(--shadow-card);
  }
  .issue.sev-critical { border-left-color: var(--state-bad); }
  .issue.sev-high { border-left-color: var(--state-warn); }
  .issue.sev-medium { border-left-color: #f2c94c; }
  .issue.sev-low { border-left-color: var(--text-muted); }
  .issue-tags { display: flex; gap: 6px; margin-bottom: 6px; flex-wrap: wrap; }
  .tag { font-size: 10px; padding: 2px 8px; border-radius: 4px; background: var(--surface-overlay); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; }
  .tag.sev-critical { background: rgba(229,72,77,0.15); color: var(--state-bad); }
  .tag.sev-high { background: rgba(245,166,35,0.15); color: var(--state-warn); }
  .tag.sev-medium { background: rgba(242,201,76,0.15); color: #f2c94c; }
  .tag.sev-low { background: rgba(138,147,166,0.15); color: var(--text-muted); }
  .tag.tag-mono { font-family: "SF Mono", Menlo, monospace; text-transform: none; }
  .tag.tag-page { background: rgba(79,125,243,0.15); color: #88aaff; }
  .issue h3 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.4; }
  .issue-section { margin-top: 10px; border-top: 1px solid var(--border-default); padding-top: 8px; }
  .issue-section summary { cursor: pointer; display: flex; align-items: center; justify-content: space-between; list-style: none; padding: 4px 0; }
  .issue-section summary::-webkit-details-marker { display: none; }
  .issue-section summary::before { content: "▶"; color: var(--text-muted); font-size: 9px; margin-right: 8px; display: inline-block; transition: transform .15s; }
  .issue-section[open] summary::before { transform: rotate(90deg); }
  .issue-section .section-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; flex: 1; font-weight: 600; }
  .issue-section .details, .issue-section .repro, .issue-section .fix {
    margin-top: 8px; font-size: 13px; white-space: pre-wrap;
    background: var(--surface-overlay); padding: 10px 12px; border-radius: 6px;
    font-family: "SF Mono", Menlo, Monaco, Consolas, monospace;
    overflow-x: auto;
  }
  .copy-btn { background: var(--surface-overlay); border: 1px solid var(--border-default); color: var(--text-muted); font-size: 10px; padding: 2px 8px; border-radius: 4px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.05em; }
  .copy-btn:hover { color: var(--text-primary); border-color: var(--accent-action); }
  .copy-btn.copied { color: var(--state-good); border-color: var(--state-good); }

  /* Screenshot pairs */
  .ss-pair { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 12px; }
  .ss-pair figure { margin: 0; }
  .ss-pair img { width: 100%; border: 1px solid var(--border-default); border-radius: 6px; background: white; }
  .ss-pair figcaption { font-size: 11px; color: var(--text-muted); margin-top: 4px; text-align: center; }

  /* Vitals table */
  .vitals-table td.metric-name { font-weight: 600; }
  .delta-good { color: var(--state-good); font-weight: 600; }
  .delta-bad { color: var(--state-bad); font-weight: 600; }
  .delta-neutral { color: var(--text-muted); }

  /* Side-by-side iframes */
  .sbs-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .sbs-toolbar button { background: var(--surface-overlay); color: var(--text-primary); border: 1px solid var(--border-default); padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .sbs-toolbar button.active { background: var(--accent-action); color: white; border-color: var(--accent-action); }
  .sbs-toolbar button:hover { border-color: var(--accent-action); }
  .sbs-toolbar .label { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
  .sbs-toolbar .toolbar-right { margin-left: auto; font-size: 11px; color: var(--text-muted); }
  .sbs-container { display: flex; gap: 16px; justify-content: center; align-items: flex-start; }
  .sbs-frame { display: flex; flex-direction: column; flex-shrink: 0; }
  .sbs-frame .frame-title { text-align: center; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
  .sbs-frame .frame-url { text-align: center; font-size: 11px; color: var(--text-muted); margin-bottom: 8px; word-break: break-all; max-width: 375px; }
  .sbs-iframe { width: 375px; height: 78vh; border: 1px solid var(--border-default); border-radius: 12px; background: white; }

  /* LLM Prompt panel */
  .prompt-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .prompt-toolbar button { background: var(--accent-action); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .prompt-toolbar button:hover { opacity: 0.9; }
  .prompt-toolbar button.secondary { background: var(--surface-overlay); color: var(--text-primary); border: 1px solid var(--border-default); }
  .prompt-toolbar .feedback { font-size: 12px; color: var(--state-good); margin-left: 8px; opacity: 0; transition: opacity 0.2s; }
  .prompt-toolbar .feedback.show { opacity: 1; }
  .prompt-toolbar .right { margin-left: auto; font-size: 12px; color: var(--text-muted); }
  .prompt-md { background: var(--surface-overlay); border: 1px solid var(--border-default); border-radius: 8px; padding: 16px; max-height: 75vh; overflow-y: auto; font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.6; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; user-select: text; }

  /* Cache hero (also in Cache tab) */
  .hero-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 12px; }
  .hero-stat { background: var(--surface-overlay); border-radius: 10px; padding: 16px; text-align: center; }
  .hero-stat .big-num { font-size: 36px; font-weight: 700; line-height: 1; }
  .hero-stat .big-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .hero-stat .hero-meta { font-size: 12px; color: var(--text-muted); margin-top: 6px; }

  /* Network/cache tables */
  .net-toolbar { display: flex; gap: 8px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
  .net-input { background: var(--surface-overlay); color: var(--text-primary); border: 1px solid var(--border-default); padding: 6px 10px; border-radius: 6px; font-size: 12px; min-width: 140px; }
  .net-input:focus { outline: 1px solid var(--accent-action); }
  .net-count { font-size: 11px; color: var(--text-muted); margin-left: auto; }
  .net-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .net-table th, .net-table td { padding: 6px 10px; border-bottom: 1px solid var(--border-default); text-align: left; }
  .net-table th { color: var(--text-muted); font-weight: 500; cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--surface-elevated); z-index: 1; }
  .net-table th:hover { color: var(--text-primary); }
  .net-table th.sort-asc::after { content: " ▲"; color: var(--accent-action); font-size: 9px; }
  .net-table th.sort-desc::after { content: " ▼"; color: var(--accent-action); font-size: 9px; }
  .net-table td.num, .net-table th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .net-table tr.opp-row td { background: rgba(229,72,77,0.04); }
  .url-cell { max-width: 540px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .url-cell a { color: var(--accent-action); text-decoration: none; }
  .url-cell a:hover { text-decoration: underline; }
  .net-cat { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; background: var(--surface-overlay); color: var(--text-muted); }
  .net-cat.cat-document { background: rgba(79,125,243,0.15); color: #88aaff; }
  .net-cat.cat-static-asset { background: rgba(46,194,126,0.15); color: var(--state-good); }
  .net-cat.cat-image { background: rgba(245,166,35,0.15); color: var(--state-warn); }
  .net-cat.cat-font { background: rgba(184,110,255,0.15); color: var(--accent-cand); }
  .net-cat.cat-api { background: rgba(54,179,255,0.15); color: var(--state-info); }
  .net-cat.cat-third-party { background: rgba(138,147,166,0.15); color: var(--text-muted); }
  .net-cat.cat-other { background: var(--surface-overlay); color: var(--text-muted); }
  .net-cache { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .cache-hit { background: rgba(46,194,126,0.15); color: var(--state-good); }
  .cache-miss { background: rgba(229,72,77,0.15); color: var(--state-bad); }
  .cache-bypass { background: rgba(138,147,166,0.15); color: var(--text-muted); }
  .cat-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .cat-table th, .cat-table td { padding: 8px 10px; border-bottom: 1px solid var(--border-default); text-align: left; }
  .cat-table th { color: var(--text-muted); font-weight: 500; }
  .cat-table th.num, .cat-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .dim { color: var(--text-muted); }

  pre, code { font-family: "SF Mono", Menlo, Monaco, Consolas, monospace; font-size: 12px; }
  pre { background: var(--surface-overlay); padding: 12px; border-radius: 6px; overflow-x: auto; }
  .empty { text-align: center; color: var(--text-muted); padding: 40px; font-style: italic; }

  /* Help modal (keyboard shortcuts) */
  .help-modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none;
    align-items: center; justify-content: center; z-index: 100; padding: 24px;
  }
  .help-modal.open { display: flex; }
  .help-modal .modal-inner {
    background: var(--surface-elevated); border: 1px solid var(--border-default);
    border-radius: 12px; padding: 24px; max-width: 480px; width: 100%;
  }
  .help-modal h3 { margin: 0 0 16px 0; }
  .help-modal table { width: 100%; }
  .help-modal kbd {
    background: var(--surface-overlay); border: 1px solid var(--border-default);
    padding: 2px 8px; border-radius: 4px; font-family: monospace; font-size: 11px;
  }

  /* Mobile responsive */
  @media (max-width: 880px) {
    .app { grid-template-columns: 1fr; grid-template-areas: "header" "side" "main"; }
    .app-sidebar { height: auto; position: static; }
    .sidebar-nav { flex-direction: row; overflow-x: auto; padding: 0 8px; }
    .nav-item { white-space: nowrap; margin-right: 4px; margin-bottom: 0; }
    .sidebar-brand, .sidebar-footer { display: none; }
    .app-main { padding: 16px; }
    .dash-hero { grid-template-columns: 1fr; gap: 16px; text-align: center; }
    .health-score { margin: 0 auto; }
  }

  /* Print */
  @media print {
    .app { grid-template-columns: 1fr; grid-template-areas: "header" "main"; }
    .app-sidebar, .header-actions { display: none; }
    .panel { display: block !important; page-break-after: always; }
    .card { box-shadow: none; break-inside: avoid; }
  }
`.trim();

export const REPORT_JS = `
  (function() {
    // ---- Tab/panel switching ----
    var navItems = document.querySelectorAll('[data-tab]');
    var panels = document.querySelectorAll('[data-panel]');
    var tabOrder = Array.from(navItems).map(function(t){ return t.dataset.tab; });

    function activate(name) {
      if (!name) return;
      navItems.forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === name);
      });
      panels.forEach(function(p) {
        p.classList.toggle('active', p.dataset.panel === name);
      });
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    }
    navItems.forEach(function(t) {
      t.addEventListener('click', function() { activate(t.dataset.tab); });
    });
    var hash = (location.hash || '#summary').slice(1);
    activate(tabOrder.includes(hash) ? hash : tabOrder[0]);

    // ---- Keyboard shortcuts ----
    function activeTabIndex() {
      var active = document.querySelector('[data-tab].active');
      return active ? tabOrder.indexOf(active.dataset.tab) : 0;
    }
    document.addEventListener('keydown', function(ev) {
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'SELECT')) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var idx = activeTabIndex();
      if (ev.key === '[') { ev.preventDefault(); activate(tabOrder[(idx - 1 + tabOrder.length) % tabOrder.length]); }
      else if (ev.key === ']') { ev.preventDefault(); activate(tabOrder[(idx + 1) % tabOrder.length]); }
      else if (ev.key === '?' || (ev.shiftKey && ev.key === '?')) { ev.preventDefault(); toggleHelp(true); }
      else if (ev.key === 'Escape') { toggleHelp(false); }
      else if (ev.key === '/') {
        var firstInput = document.querySelector('.panel.active input[type="search"], .panel.active input.net-input');
        if (firstInput) { ev.preventDefault(); firstInput.focus(); }
      }
      else if (ev.key === 't' || ev.key === 'T') { toggleTheme(); }
    });

    // ---- Theme toggle (persists in localStorage) ----
    function toggleTheme() {
      var cur = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('parity-theme', next); } catch (e) {}
      var btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = next === 'dark' ? '☀ Light' : '🌙 Dark';
    }
    try {
      var saved = localStorage.getItem('parity-theme');
      if (saved === 'light' || saved === 'dark') {
        document.documentElement.setAttribute('data-theme', saved);
        var btn0 = document.getElementById('theme-toggle');
        if (btn0) btn0.textContent = saved === 'dark' ? '☀ Light' : '🌙 Dark';
      }
    } catch (e) {}
    var tBtn = document.getElementById('theme-toggle');
    if (tBtn) tBtn.addEventListener('click', toggleTheme);

    // ---- Help modal ----
    function toggleHelp(open) {
      var m = document.getElementById('help-modal');
      if (!m) return;
      m.classList.toggle('open', open);
    }
    var hBtn = document.getElementById('help-btn');
    if (hBtn) hBtn.addEventListener('click', function() { toggleHelp(true); });
    var hClose = document.getElementById('help-close');
    if (hClose) hClose.addEventListener('click', function() { toggleHelp(false); });
    var hModal = document.getElementById('help-modal');
    if (hModal) hModal.addEventListener('click', function(e) {
      if (e.target === hModal) toggleHelp(false);
    });

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
        if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(done);
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
      var syncing = false;
      function attachScroll(src, dst) {
        try {
          src.contentWindow.addEventListener('scroll', function() {
            if (!syncEnabled || syncing) return;
            syncing = true;
            try { dst.contentWindow.scrollTo(src.contentWindow.scrollX, src.contentWindow.scrollY); } catch (e) {}
            setTimeout(function() { syncing = false; }, 30);
          }, { passive: true });
        } catch (e) {}
      }
      function tryAttach() {
        attachScroll(iframeProd, iframeCand);
        attachScroll(iframeCand, iframeProd);
      }
      iframeProd.addEventListener('load', tryAttach);
      iframeCand.addEventListener('load', tryAttach);
      if (sbsState.pairs.length > 0) load(0);
    }
  })();
`.trim();
