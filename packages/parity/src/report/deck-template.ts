/**
 * Deck CSS + JS, shared by the renderer and the browsable template.
 *
 * `templates/report-deck.html` is the same CSS and JS in a hand-fillable demo page — open it in a
 * browser to see the components rendered. This module is what `renderDeckHtml` emits, so the
 * published bundle stays self-contained instead of reading a file relative to `dist/`.
 *
 * The two are kept byte-identical by the drift test in `tests/report/deck-html.test.ts`, which
 * fails the moment one is edited without the other. Same split the dark report already uses with
 * `REPORT_CSS`/`REPORT_JS` in `html-template.ts`.
 */

export const DECK_CSS = `
  /* ── design tokens (identical to report-components.html) ───────────────── */
  :root{
    --bg:#ffffff;--ink:#282524;--muted:#78726e;--faint:#a6a09d;
    --border:rgba(40,37,36,0.09);--card:rgba(40,37,36,0.06);
    --soft:#8caa25;--forest:#07401a;--warn:#f0b613;--bad:#d43d3d;
    --lime:#d0ec1a;--lime-tint:#eff6cc;
  }
  *{box-sizing:border-box}
  html,body{height:100%;margin:0;overflow:hidden}
  body{color:var(--ink);background:var(--bg);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  .num{font-family:Georgia,"Times New Roman",serif;letter-spacing:-0.02em;
    font-variant-numeric:tabular-nums}
  .eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
    color:var(--soft)}
  h1,h2,h3{font-weight:400;letter-spacing:-0.02em;margin:0}
  .annotation{color:var(--muted);font-size:14px;margin:6px 0 0}
  .dim{color:var(--faint)}
  .lime-ink{color:var(--forest)}
  code{background:#f4f2ef;padding:1px 5px;border-radius:5px;font-size:11.5px;color:var(--ink)}

  /* ── deck shell ─────────────────────────────────────────────────────────── */
  .deck{display:flex;height:100vh;overflow-x:auto;overflow-y:hidden;
    scroll-snap-type:x mandatory;scroll-behavior:smooth}
  .deck::-webkit-scrollbar{height:0}
  .page{flex:0 0 100vw;width:100vw;height:100vh;scroll-snap-align:start;overflow-y:auto;
    padding:56px 6vw 40px;background:var(--bg)}
  .page:nth-child(even){background:#fdfdfc}
  .page-inner{max-width:1180px;margin:0 auto}
  .page-title{font-size:clamp(1.7rem,3.6vw,2.6rem);margin:6px 0 10px}
  .sub{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:var(--muted);margin:30px 0 10px}

  /* ── top bar ────────────────────────────────────────────────────────────── */
  .nav{position:fixed;top:0;left:0;right:0;z-index:60;display:flex;align-items:center;gap:14px;
    padding:10px 6vw;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);
    border-bottom:1px solid var(--border)}
  .nav .fav{width:22px;height:22px;border-radius:6px;border:1px solid var(--card);
    background:#fff;padding:2px;object-fit:contain}
  .nav b{font-size:13px;font-weight:600}
  .nav .spacer{flex:1}
  .dots{display:flex;gap:6px}
  .dot{width:22px;height:4px;border-radius:999px;background:rgba(40,37,36,.14);border:0;
    padding:0;cursor:pointer}
  .dot[aria-current="true"]{background:var(--forest)}
  .counter{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;
    min-width:44px;text-align:right}
  .lang-toggle{border:1px solid rgba(40,37,36,0.18);background:#fff;border-radius:999px;
    padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink)}
  .lang-toggle:hover{background:#faf9f7}

  /* ── cover ──────────────────────────────────────────────────────────────── */
  .cover{display:flex;align-items:center}
  .cover-h1{font-size:clamp(2.2rem,6vw,4.2rem);line-height:1.02;margin:16px 0}
  .cover-lead{font-size:18px;color:var(--muted);max-width:60ch;line-height:1.6}
  .cover-meta{display:flex;gap:44px;flex-wrap:wrap;margin-top:38px}
  .cover-meta div{display:flex;flex-direction:column}
  .cover-meta b{font-family:Georgia,serif;font-size:2.4rem;letter-spacing:-0.02em;font-weight:400}
  .cover-meta small{color:var(--muted);font-size:12px;margin-top:2px}
  .hint{margin-top:46px;font-size:13px;color:var(--faint)}

  /* ── tiles ──────────────────────────────────────────────────────────────── */
  .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px}
  .tile{display:flex;flex-direction:column;gap:6px;padding:20px;border:1px solid var(--card);
    border-radius:14px;background:#fff}
  .tile-val{font-family:Georgia,serif;font-size:clamp(1.8rem,4vw,2.6rem);line-height:1;
    letter-spacing:-0.02em;font-variant-numeric:tabular-nums}
  .tile-label{font-size:14px}
  .tile-sub{font-size:12px;color:var(--muted)}
  .t-good{color:var(--forest)}.t-warn{color:#8a6708}.t-bad{color:var(--bad)}

  /* ── tables ─────────────────────────────────────────────────────────────── */
  table.grid{width:100%;border-collapse:collapse;font-size:14px;margin-top:10px}
  table.grid th,table.grid td{text-align:left;padding:9px 10px;
    border-bottom:1px solid var(--border);vertical-align:top}
  table.grid thead th{font-size:10px;text-transform:uppercase;letter-spacing:.06em;
    color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--bg)}
  table.compact{font-size:12.5px}
  table.compact td{padding:6px 8px}

  /* ── status pills ───────────────────────────────────────────────────────── */
  .pill{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.03em;
    padding:2px 8px;border-radius:999px;white-space:nowrap}
  .pill-good{background:var(--lime-tint);color:var(--forest)}
  .pill-lime{background:var(--lime);color:var(--forest)}
  .pill-warn{background:rgba(240,182,19,.16);color:#8a6708}
  .pill-bad{background:rgba(212,61,61,.1);color:#a5302f}

  /* ── heat map ───────────────────────────────────────────────────────────── */
  .legend{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 22px;font-size:12px;
    color:var(--muted)}
  .lg{display:flex;align-items:center;gap:7px}
  .lg .cell{width:14px;height:14px;min-height:0;padding:0;border-radius:4px;display:block}
  .zone{margin-bottom:20px}
  .zone-head{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
  .zone-head b{font-size:13px}
  .zone-score{color:var(--faint);font-size:13px;font-family:Georgia,serif}
  .cells{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:7px}
  .cell{min-height:52px;border-radius:9px;padding:9px 11px;display:flex;align-items:center;
    font-size:12px;line-height:1.25;border:1px solid transparent}
  .cell-ok{background:var(--lime-tint);color:var(--forest);border-color:rgba(7,64,26,.10)}
  .cell-new{background:var(--lime);color:var(--forest);border-color:rgba(7,64,26,.22);
    font-weight:600}
  .cell-warn{background:rgba(240,182,19,.18);color:#7d5d07;border-color:rgba(240,182,19,.34)}
  .cell-gap{background:rgba(212,61,61,.09);color:#9d2d2c;border-color:rgba(212,61,61,.2)}

  /* ── side-by-side screenshot frames ─────────────────────────────────────── */
  .side-by-side{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px}
  .side-by-side .shot-view{max-height:70vh;overflow-y:auto}
  /* Phone captures are ~390px wide: kept near that width and taller, so the frame reads
     as a phone instead of an upscaled half-screen. */
  .side-by-side.phones{grid-template-columns:repeat(2,minmax(0,340px));
    justify-content:center;gap:36px}
  .side-by-side.phones .shot-view{max-height:76vh}
  .shot{margin:0;position:relative;border-radius:16px;overflow:hidden;background:#f6f4f1;
    border:1px solid var(--card);
    box-shadow:0 1px 2px rgba(40,37,36,0.04),0 12px 34px rgba(40,37,36,0.08)}
  .shot img{display:block;width:100%;height:auto}
  .shot-view{position:relative}
  .shot-tag{position:absolute;top:12px;left:12px;z-index:3;color:#fff;font-size:11px;
    font-weight:700;letter-spacing:0.04em;padding:4px 10px;border-radius:999px}
  .tag-prod{background:rgba(40,37,36,.6)}
  .tag-cand{background:var(--forest)}
  .shot-missing{min-height:320px;display:flex;align-items:center;justify-content:center;
    color:var(--faint);font-size:13px;text-align:center;padding:24px}

  @media(max-width:900px){.side-by-side{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){.deck{scroll-behavior:auto}}
`;

export const DECK_JS = `
// ── deck paging ───────────────────────────────────────────────────────────────
(function(){
  var deck=document.querySelector(".deck");
  if(!deck) return;
  var pages=[].slice.call(deck.querySelectorAll(".page"));
  var dotsWrap=document.querySelector(".dots");
  var counter=document.querySelector(".counter");

  // Build one dot per page so the markup above stays about content, not chrome.
  var dots=pages.map(function(_,i){
    var b=document.createElement("button");
    b.className="dot"; b.type="button"; b.setAttribute("aria-label",String(i+1));
    b.addEventListener("click",function(){ go(i); });
    if(dotsWrap) dotsWrap.appendChild(b);
    return b;
  });

  // Tracked explicitly: reading scrollLeft mid-smooth-scroll would collapse rapid presses.
  var idx=0;
  function paint(){
    dots.forEach(function(d,j){ d.setAttribute("aria-current",String(j===idx)); });
    if(counter) counter.textContent=(idx+1)+" / "+pages.length;
  }
  function go(i){
    idx=Math.max(0,Math.min(pages.length-1,i));
    pages[idx].scrollIntoView({block:"nearest",inline:"start"});
    paint();
  }

  // Any scrollable ancestor of the pointer keeps its native scroll — screenshot frames and
  // long tables both rely on this. Only once nothing under the cursor can scroll further
  // does the wheel page the deck.
  function canScroll(el,dy){
    while(el&&el!==deck){
      if(el.scrollHeight>el.clientHeight+4){
        var atTop=el.scrollTop<=0;
        var atBottom=el.scrollTop+el.clientHeight>=el.scrollHeight-1;
        if(!((atTop&&dy<0)||(atBottom&&dy>0))) return true;
      }
      el=el.parentElement;
    }
    return false;
  }

  // A whole page per gesture: with \`scroll-snap-type: x mandatory\`, nudging scrollLeft by
  // small wheel deltas gets snapped straight back and the deck never moves.
  var acc=0,lock=false;
  deck.addEventListener("wheel",function(ev){
    if(Math.abs(ev.deltaY)<=Math.abs(ev.deltaX)) return;
    if(canScroll(ev.target,ev.deltaY)) return;
    ev.preventDefault();
    if(lock) return;
    acc+=ev.deltaY;
    if(Math.abs(acc)<40) return;
    var dir=acc>0?1:-1; acc=0;
    if((dir>0&&idx>=pages.length-1)||(dir<0&&idx<=0)) return;
    lock=true; go(idx+dir);
    setTimeout(function(){ lock=false; acc=0; },480);
  },{passive:false});

  addEventListener("keydown",function(ev){
    var step={ArrowRight:1,PageDown:1,ArrowLeft:-1,PageUp:-1}[ev.key];
    if(step){ ev.preventDefault(); go(idx+step); }
    if(ev.key==="Home"){ ev.preventDefault(); go(0); }
    if(ev.key==="End"){ ev.preventDefault(); go(pages.length-1); }
  });

  // Resync after a drag / trackpad swipe, once the snap has settled.
  var settle;
  deck.addEventListener("scroll",function(){
    clearTimeout(settle);
    settle=setTimeout(function(){
      idx=Math.round(deck.scrollLeft/window.innerWidth); paint();
    },120);
  },{passive:true});

  paint();
})();

// ── PT/EN toggle — same contract as report-components.html ───────────────────
(function(){
  var KEY="report-lang", btn=document.getElementById("langToggle");
  function apply(lang){
    document.documentElement.lang=lang;
    document.querySelectorAll(".i18n").forEach(function(e){
      if(e.dataset[lang]!=null) e.textContent=e.dataset[lang];
    });
    document.querySelectorAll(".i18n-html").forEach(function(e){
      if(e.dataset[lang]!=null) e.innerHTML=e.dataset[lang];
    });
    if(btn) btn.textContent = lang==="pt" ? "EN" : "PT";
    try{ localStorage.setItem(KEY,lang) }catch(_){}
  }
  var saved; try{ saved=localStorage.getItem(KEY) }catch(_){}
  apply(saved==="pt"||saved==="en"?saved:"en");
  if(btn) btn.addEventListener("click",function(){
    apply(document.documentElement.lang==="pt"?"en":"pt");
  });
})();
`;
