---
name: stakeholder-report
description: How to build a defensible HTML report from a migration — deck or executive one-pager. Load when asked for a report, a deck, a status page, or a before/after for a client. Carries the design kit, the page components, the capture recipe, and the evidence rules.
---

# Stakeholder Report

Two shapes, same kit:

| Shape | For | Layout | Depth |
|---|---|---|---|
| **deck** | working team, client tech lead | lateral scroll, one topic per page | every finding, every card link |
| **one-pager** | executive sponsor | single vertical page | the five numbers that decide something |

Assets in `assets/`: `deck.css` (design kit), `deck.js` (deck shell),
`deck-template.html` (runnable skeleton), `build.py` (generator scaffold),
`capture.md` (working capture scripts).

## Generate it from a script — always

Write a generator (`build.py` or `build.ts`) that reads the real sources and
emits the HTML. Never hand-write the final file.

The reason is not tidiness. Every number in a report gets challenged, and half
of them turn out to need a correction — a wrong date, a metric that measured the
wrong thing, a count the client wants dropped. With a generator that is one edit
and a re-run. With hand-written HTML it is a hunt through 1 MB of markup, and the
second correction reintroduces the first bug.

Keep each page as its own string in a `pages` list, so editing one page cannot
break another. Read numbers from files (`report.json`, `gh pr list --json`, the
board API) rather than typing them in.

> **Slice carefully when editing a generator.** Replacing a region by index
> (`s[:i0] + novo + s[i1:]`) will silently eat the `pages.append(f"""` wrapper
> and drop a whole page. After every generator edit, assert the page count.

## Evidence rules — the part that makes it defensible

**Verify every tool claim before it enters the report.** Parity, Lighthouse and
LLM-written summaries all produce confident wrong statements. In one real run,
`plp-pagination` reported `?page=2` and `?page=3` as HTTP 404 — the tool had
invented the route `/383`, and the real collection returned 200. A single
unverified finding in front of a client costs more than the whole report gains.

**Never measure a local candidate.** Running the candidate on `localhost`
without the production env produces findings that are pure artifact. In one run,
66 of 187 findings came from `GTM_CONTAINER_ID` being unset — the placeholder
container made every analytics beacon and third-party script look divergent, and
dropped the `console` module from 100 to 78. Measure the deployed candidate.
Verify with `curl -s <url> | grep -oE "GTM-[A-Z0-9]{6,}"` on both sides.

**Triage every finding into three buckets**, and show the buckets:

| Bucket | Meaning | Goes in the report as |
|---|---|---|
| defect | real, reproducible | a row with a linked task |
| content difference | catalog / CMS differ between sides | labelled, not counted as a defect |
| false positive | the tool is wrong | labelled, with why |

Never let the headline count include the last two. A "4 critical" tile where 3
are content differences is a number that collapses under one question. Split it:
`1 defect` + `3 content differences`.

**The visual module is not comparable** when the two sides serve different
catalogs or CMS content. Say so once, plainly, and do not quote its verdicts as
regressions.

**Label what is not measured yet.** If a fix is open in a PR and the after-number
has not been collected, the report says so. Present the before as measured and
the improvement as in flight.

**Footer with provenance.** One short paragraph: where each class of number came
from. It converts "trust me" into "check me".

## Editorial rules

Executives read the nouns and the numbers. Everything else is friction.

**Cut the flourish.** Kill lines whose job is to sound good rather than say
something. Real examples that had to be removed: *"o número não é opinião, é
conta"*, *"Não é demonstração"*, *"Onde a produção tem bug, a POC nasce sem
ele"*, *"foi exatamente o que aconteceu antes"*. Each was true and each was
noise.

**Objective over dramatic.** `"O que mudou de verdade"` → `"Conclusão da
compra"`. `"Que a jornada de compra volte a quebrar sem ninguém perceber"` →
`"Regressão no fluxo de compra sem detecção"`.

**Cut repetition, including structural repetition.** A section title that the
first sentence repeats. A number in the heading that sits in the table below. A
whole section that another section already covers — merge it. On the last pass,
count words and list the most repeated ones; anything that is not the subject
itself is filler.

**Do not put a number on something the number understates.** A PR count measures
how work was packaged, not how much work happened — one PR can be thirty
iterations. If the honest number reads small, describe the thing without
quantifying it. **Never substitute a larger number.** If a stakeholder asks for
the count to be dropped, drop it; if they joke about inflating it, do not.

**Completeness estimates need a declared rubric.** Never publish a bare "we went
from X% to Y%". Publish the weighted table — frente, peso, before, after — and
label it a judgement with declared weights, not a measurement. It survives
scrutiny and it shows where the remaining work is.

## Page components

All classes are in `assets/deck.css`.

| Component | Class | Use for |
|---|---|---|
| stat tiles | `.stat-grid` + `.tile` | 4–8 headline numbers; `.tile-sub` carries the before-value |
| A→B table | `.grid` + `.v-from` / `.v-to` | one row per front: what it was, what it is |
| side-by-side captures | `.side-by-side` + `.shot.shot-scroll` | before/after; each frame scrolls internally |
| triaged findings | `.grid.compact` + `.pill-bad` / `.pill-warn` / `.pill-good` | finding, severity, bucket, linked task |
| flow strip | `.flow` + `.fs` / `.fa` | a card's path through a pipeline |
| rubric table | `.grid` + `<tfoot>` | the completeness estimate |
| callout | `.callout` (good) / `.warn-banner` (bad) | the single fact the page exists to deliver |
| provenance | `.foot` | closing paragraph |

Tone helpers: `.t-good` `.t-warn` `.t-bad` `.t-muted`. Numbers always carry
`.num` (serif, tabular) — mixing proportional digits into a table reads as sloppy.

## Capture recipe

Working scripts: `assets/capture.md`. Summary of what bites:

**Before/after across releases.** Build both sides for real; do not screenshot a
dev server.

```bash
git worktree add /tmp/site-before <tag>
cd /tmp/site-before && cp .env.example .env && yarn install && yarn build
PORT=3017 yarn start          # the "after" worktree usually already has a build
```

**Same-origin pages → Cypress.** Set `Cypress.on('uncaught:exception', () =>
false)`; an older build often throws on load and would kill the spec before the
screenshot — you want the broken state captured, not a red test. Symlink
`node_modules` into the spec dir or `cypress.config.js` cannot resolve
`require('cypress')`.

**Cross-origin hops (checkout handoff) → headless Chrome.** Cypress cannot
follow a domain change; the runner dies with `Cannot destructure property
'duration'`. Use `puppeteer-core` with `executablePath` pointing at a Playwright
chromium. Subscribe to `framenavigated` and keep the URL trail — the trail is
often the actual evidence. One real case: the trail showed the handoff hitting
the storefront's own domain three times and then reaching the payment portal
without the order id, which is why the cart arrived empty.

**Pick a product that is in stock.** An out-of-stock PDP has no buy button, and
every cart/checkout capture silently returns the PDP instead. Discover one from a
category page and assert the button exists before capturing.

**Compress or the file is unusable.** A Cypress `fullPage` capture comes out
14k–26k px tall and repeats the footer where the stitch wrapped. Crop the top,
resize to ~1000px wide, save JPEG q72–80. Eight images go from ~40 MB to under
1 MB. Embed as base64 so the report is one portable file, and keep it under
~1.5 MB.

**Favicon.** Embed one, or the tab looks unfinished next to real pages. Take the
brand asset from the repo, not the 16×16 the site serves. Check what the alpha
channel actually holds: a `.ico` is often an opaque plate with the mark punched
out as transparency, so embedding it raw yields a black square. Composite the
brand colour behind it and confirm by rendering.

## Deck shell — the scroll latch

`assets/deck.js` is the lateral-scroll shell. It carries a fix worth
understanding, because the naive version is broken and the bug looks like a
design decision.

A wheel handler that only asks *"can any ancestor still scroll in this
direction?"* pages the deck the instant an inner scroller bottoms out — and
trackpad inertia from that same gesture is what triggers it. Reaching the end of
a table flips the slide.

The fix is a second check plus a time latch: if the pointer is inside a
scrollable subtree at all (`inScroller`, edge or not) and the previous wheel
event was under ~350 ms ago, swallow the event instead of paging. Inertia keeps
the latch warm; after a real pause the next scroll pages. Also reset the delta
accumulator whenever the scroll is consumed internally, or the deltas add up and
the page turns by itself seconds later.

## Checklist before handing it over

- [ ] Page count asserted; tags balanced; no leftover placeholder text
- [ ] Every number traceable to a file or a command in the provenance footer
- [ ] Every tool finding verified by hand
- [ ] Candidate measured at its deployed URL, not localhost
- [ ] Findings split into defect / content / false positive
- [ ] In-flight work labelled as not yet measured
- [ ] Dates and day counts scoped to the engagement, weekdays checked
- [ ] Read the whole thing as plain text; cut flourish and repetition
- [ ] Favicon embedded and rendered
- [ ] Regenerating from the script reproduces the file
