# Reports

Every parity command that produces HTML writes **one self-contained file** — CSS, JS and
screenshots inlined — so a report can be attached to an email or dropped on a static host
without carrying an asset folder.

| Output | Written by | Shape |
| --- | --- | --- |
| `runs/<runId>/report.html` | `parity run`, `parity audit` | Dark dashboard, sidebar + tab per module |
| `runs/<runId>/report.html` | `parity benchmark` | Light editorial page, viewport tabs, PT/EN toggle |
| `<outDir>/report.html` | `parity migrate` | Light card stack: theme, assets, block mapping, per-page inventory |
| `runs/<runId>/deck.html` | `parity report <runId> --deck` | Presentation deck: one topic per full-viewport page, advanced sideways |

Distinguish a `run` report from a `benchmark` report by the `<title>`.

## Template kits

Two copy-paste kits live in [`templates/`](../templates). Neither is imported by the CLI — they
exist so a hand-written or agent-written report can look like the generated ones instead of
inventing a fifth visual language.

### `templates/report-components.html` — the component catalogue

The design system as a normal vertical page: tokens, editorial serif numbers, stat tiles,
comparison bars, the vitals table, device-framed screenshots, the info modal and the PT/EN
toggle. Open it in a browser to see every component rendered, then view source and copy what
you need.

### `parity report <runId> --deck` — the generated deck

```bash
parity report <runId> --deck                       # writes deck.html in the run dir
parity report <runId> --deck --out /tmp/deck.html --lang pt --open
```

Built from `report.json` via `buildDeckModel` (`src/report/deck-model.ts`) and
`renderDeckHtml` (`src/report/deck-html.ts`). Pages, in order — each one omitted when it has
nothing to say, because an empty page in a deck is a dead beat:

1. **Cover** — hosts, score, verdict, date
2. **How to read this run** — `report.json.caveats` (#292), only when the run has any
3. **Executive summary** — headline tiles plus per-module scores
4. **Findings** — ranked from `topIssues`, capped at 12 with the overflow **stated**, and an
   `inconclusive` finding labelled rather than presented as a defect
5. **Visual parity** — only when the visual module ran

What it deliberately does **not** do is invent narrative. Section prose, the before/after mapping
and the "why" column are human judgment; a generator that guesses them produces a document nobody
trusts. Use the template below when you want to write those by hand.

The CSS and JS live in `src/report/deck-template.ts` and are kept byte-identical to the template
file by a drift test — editing one without the other fails CI.

### `templates/report-deck.html` — the presentation shell

The same tokens arranged as a **horizontally paged deck**: one topic per full-viewport page,
advanced sideways. Use it when the report gets *presented* rather than read alone — a migration
walkthrough with a client, a checkpoint review — and you want the narrative to have discrete
beats without exporting to slides.

It adds four components on top of the catalogue:

| Component | What it is |
| --- | --- |
| `.deck` / `.page` | The paged shell. One `<section class="page">` per topic. |
| `.cover` | First page: headline plus a row of oversized metrics. |
| `.zone` / `.cells` / `.cell` | Component heat map, grouped by page region, tone-coded per status. |
| `.side-by-side[.phones]` | Prod × cand screenshot frames. `.phones` narrows to ~340px and raises the height so a 390px mobile capture reads as a phone. |

Three mechanics in that file are worth preserving if you re-implement it:

- **Nested scroll wins.** Vertical wheel pages the deck sideways, but only after every
  scrollable element under the cursor has bottomed out. Without this, `preventDefault()` kills
  the native scroll of a screenshot frame and its content becomes unreachable.
- **Page-at-a-time paging.** Under `scroll-snap-type: x mandatory`, nudging `scrollLeft` by
  small wheel deltas gets snapped straight back and the deck never moves. The handler
  accumulates delta past a threshold and calls `scrollIntoView()` instead.
- **The index is a variable.** Deriving the current page from `scrollLeft` mid-smooth-scroll
  collapses rapid key presses into a single step.

## The i18n contract

Both kits share one language mechanism, so a report can mix components from either and keep a
single toggle:

```html
<span class="i18n" data-pt="Bloco legado" data-en="Legacy block">Legacy block</span>
<p class="i18n-html" data-pt="Com <code>markup</code>." data-en="With <code>markup</code>."></p>
```

`.i18n` swaps `textContent`; `.i18n-html` swaps `innerHTML`. The button is
`#langToggle`, the preference persists under the `report-lang` `localStorage` key, and
`<html lang>` is updated on every switch so assistive tech follows along.

## Writing a client-facing report

The generated reports are engineering artifacts: exhaustive, and honest about their own noise.
A report you present has a different job, and the same rules that make it trustworthy make it
useful:

- **Say what the number does not measure.** A score taken against a dev server, or with
  different content on each side, carries noise. Put that next to the score, not in a footnote.
- **Separate confirmed from suspected.** If a critical finding might be an artifact of how the
  run was configured, label it as needing reconfirmation rather than presenting it as a defect.
- **Give the provenance of a before/after table.** SSR DOM, platform runtime, code inspection —
  a mapping without provenance is an opinion.
- **State what was not verified.** A gap you could not reproduce is a real result; silently
  omitting it is not.
- **Order next steps by cost and dependency, not severity.** The reader wants to know what can
  start tomorrow.
