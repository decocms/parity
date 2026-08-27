#!/usr/bin/env python3
"""Generator scaffold for a stakeholder report.

Why a generator and not hand-written HTML: every number gets challenged and half
need a correction. Here that is one edit and a re-run.

Each page is its own string in `pages`, so editing one cannot break another.
Copy this next to the report, fill in the readers, run it.
"""
import base64
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = HERE                      # where deck.css / deck.js live
OUT = os.environ.get("REPORT_OUT", "report.html")
SHAPE = os.environ.get("REPORT_SHAPE", "deck")   # deck | onepager


# ── readers: every number comes from here, never from a literal ──────────────

def sh(cmd: str) -> str:
    """Run a command and return stdout. Fails loudly — a silent empty string
    becomes a zero in the report, which is worse than a crash."""
    return subprocess.run(cmd, shell=True, capture_output=True, check=True,
                          text=True).stdout


def merged_prs(repo: str, authors: list[str], since: str) -> list[dict]:
    """Merged PRs, scoped to the team and the engagement window.

    Scoping matters: a repo older than the engagement inflates every
    'how long / how much' number in the report.
    """
    raw = sh(f'gh pr list --repo {repo} --state merged --limit 300 '
             f'--json number,title,author,mergedAt,baseRefName,url')
    return [p for p in json.loads(raw)
            if p["author"]["login"] in authors and p["mergedAt"] >= since]


def parity_report(output_dir: str) -> dict | None:
    """Newest parity report.json under <output_dir>/runs/*/."""
    import glob
    runs = sorted(glob.glob(f"{output_dir}/runs/*/report.json"))
    return json.load(open(runs[-1])) if runs else None


def embed(path: str) -> str:
    """Inline an image as a data URI. Compress before calling this — see the
    capture recipe in SKILL.md. Keep the whole report under ~1.5 MB."""
    mime = "image/jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "image/png"
    return f"data:{mime};base64,{base64.b64encode(open(path, 'rb').read()).decode()}"


# ── components ───────────────────────────────────────────────────────────────

def tile(value, label, sub, tone="t-ink") -> str:
    return (f'<div class="tile"><div class="tile-val {tone}">{value}</div>'
            f'<div class="tile-label">{label}</div><div class="tile-sub">{sub}</div></div>')


def table(cols: list[str], rows: list[list[str]], cls: str = "grid") -> str:
    head = "".join(f"<th>{c}</th>" for c in cols)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="{cls}"><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'


def rubric(rows: list[tuple]) -> tuple[str, int, int]:
    """Completeness rubric: (name, weight, before, after, note).

    Never publish a bare 'X% → Y%'. Publishing the weights is what makes the
    number survive a challenge, and it shows where the remaining work is.
    """
    before = round(sum(w * b / 100 for _, w, b, _, _ in rows))
    after = round(sum(w * a / 100 for _, w, _, a, _ in rows))
    body = "".join(
        f"<tr><td><b>{n}</b><br/><span class='small'>{note}</span></td>"
        f"<td class='num'>{w}%</td>"
        f"<td class='num' style='color:var(--faint)'>{b}%</td>"
        f"<td class='num' style='color:var(--forest);font-weight:600'>{a}%</td></tr>"
        for n, w, b, a, note in rows)
    html = (f'<table class="grid"><thead><tr><th>Frente</th><th>Peso</th>'
            f'<th>Antes</th><th>Depois</th></tr></thead><tbody>{body}</tbody>'
            f'<tfoot><tr><td><b>Ponderado</b></td><td class="num">100%</td>'
            f'<td class="num" style="color:var(--faint);font-weight:600">{before}%</td>'
            f'<td class="num" style="color:var(--forest);font-weight:600">{after}%</td>'
            f'</tr></tfoot></table>')
    return html, before, after


def finding_row(text: str, severity: str, bucket: str, task_url: str | None) -> list[str]:
    """One triaged finding. `bucket` is defect | content | false-positive —
    never let the headline count include the last two."""
    sev = f'<span class="pill {"pill-bad" if severity == "critical" else "pill-warn"}">{severity}</span>'
    label = {"defect": '<span class="pill pill-bad">defeito</span>',
             "content": '<span class="pill pill-warn">conteúdo</span>',
             "false-positive": '<span class="pill pill-good">falso positivo</span>'}[bucket]
    task = f'<a class="pill pill-good" href="{task_url}">task</a>' if task_url else "—"
    return [text, sev, label, task]


# ── assembly ─────────────────────────────────────────────────────────────────

pages: list[str] = []

pages.append(f"""
  <p class="eyebrow">Report · WINDOW</p>
  <h1 class="cover-h1">site.example.com</h1>
  <p class="cover-lead">One sentence on what changed.</p>
  <p class="hint">→ scroll sideways, or use the arrow keys</p>
""")

# ... one pages.append(f\"\"\"...\"\"\") per topic ...

PROVENANCE = """
  <b>Procedência.</b> Where each class of number came from — repo and author
  filter, board, capture tool and build type, parity target URL. The completeness
  estimate is a judgement with declared weights, not a measurement.
"""


def render() -> str:
    css = open(f"{ASSETS}/deck.css").read()
    js = open(f"{ASSETS}/deck.js").read()
    secs = "".join(
        f'<section class="page{" cover" if i == 1 else ""}" id="p{i}">'
        f'<div class="page-inner">{inner}</div></section>'
        for i, inner in enumerate(pages, 1))
    dots = "".join(f'<button class="dot" aria-label="{i}"></button>'
                   for i in range(1, len(pages) + 1))
    return f"""<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>deco × CLIENT — report</title>
<style>{css}</style></head><body>
<div class="nav"><b>deco × CLIENT</b><span class="spacer"></span>
<div class="dots">{dots}</div><span class="counter"></span></div>
<main class="deck">{secs}</main>
<div class="method">{PROVENANCE}</div>
<script>{js}</script>
</body></html>
"""


html = render()
open(OUT, "w").write(html)

# Self-check. A slice edit in a generator silently eats a `pages.append`
# wrapper and drops a whole page, so assert instead of trusting.
assert html.count('<section class="page') == len(pages), "page count drifted"
assert html.count('class="dot"') == len(pages), "dot count != page count"
# style/script are deliberately excluded: their content is arbitrary text and
# a stray "<style>" in a comment produces a false alarm.
for tag in ("section", "div", "table", "tr", "td", "figure", "p", "span"):
    opened = len(re.findall(rf"<{tag}[\s>]", html))
    closed = html.count(f"</{tag}>")
    assert opened == closed, f"unbalanced <{tag}>: {opened} open, {closed} closed"
assert "REPLACE_ME" not in html and "capture pending" not in html or SHAPE == "draft", \
    "placeholder text left in a non-draft report"

print(f"{OUT} — {len(pages)} pages, {len(html) // 1024} KB", file=sys.stderr)
