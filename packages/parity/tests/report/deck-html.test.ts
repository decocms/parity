import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDeckHtml } from "../../src/report/deck-html.ts";
import type { DeckModel } from "../../src/report/deck-model.ts";
import { DECK_CSS, DECK_JS } from "../../src/report/deck-template.ts";

function model(over: Partial<DeckModel> = {}): DeckModel {
  return {
    prodUrl: "https://prod.example/",
    candUrl: "https://cand.example/",
    timestamp: "2026-01-01T00:00:00.000Z",
    runId: "run-1",
    score: 57,
    status: "fail",
    caveats: [],
    headline: [{ value: "57/100", label: "score parity", sub: "5 páginas", tone: "bad" }],
    modules: [],
    findings: [],
    findingsOmitted: 0,
    visual: null,
    ...over,
  };
}

describe("renderDeckHtml (#290)", () => {
  it("emits one self-contained document with the CSS and JS inlined", () => {
    const html = renderDeckHtml(model());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain(DECK_CSS.slice(0, 60));
    expect(html).toContain(DECK_JS.slice(0, 60));
    // No external asset references — the file has to survive being emailed.
    expect(html).not.toMatch(/<link[^>]+href=["']http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it("never emits a page with no content — an empty beat in a deck is a dead slide", () => {
    const html = renderDeckHtml(model());
    const pages = html.match(/<section class="page[^"]*">/g) ?? [];
    expect(pages.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/<div class="page-inner">\s*<\/div>/);
  });

  it("leaves the dots container empty — DECK_JS owns one dot per page", () => {
    const html = renderDeckHtml(
      model({ visual: { pagesChecked: 3, pagesPassed: 3, pagesWithDiffs: 0 } }),
    );
    // Emitting dots here as well doubled them in a real browser (4 pages, 8 dots): the script
    // appends one per page at load. Counting them in the HTML string could never catch that.
    expect(html).not.toMatch(/<button class="dot"/);
    expect(html).toContain('<div class="dots">');
    expect(DECK_JS).toContain('className="dot"'.replace(/"/g, '"'));
  });

  it("omits the context page when the run had no caveats", () => {
    expect(renderDeckHtml(model())).not.toContain("How to read this run");
  });

  it("includes the context page when it has something to say", () => {
    const html = renderDeckHtml(
      model({
        caveats: [
          { id: "cand-dev-server", level: "warn", summary: "dev server", detail: "não comparável" },
        ],
      }),
    );
    expect(html).toContain("How to read this run");
    expect(html).toContain("dev server");
  });

  it("labels an inconclusive finding rather than presenting it as a defect", () => {
    const html = renderDeckHtml(
      model({
        findings: [
          { severity: "critical", category: "functional", summary: "SSR vazio", inconclusive: true },
        ],
      }),
    );
    expect(html).toContain("SSR vazio");
    expect(html).toContain('data-en="inconclusive"');
  });

  it("states how many findings the cap dropped", () => {
    const html = renderDeckHtml(
      model({
        findings: [{ severity: "high", category: "visual", summary: "x", inconclusive: false }],
        findingsOmitted: 7,
      }),
    );
    expect(html).toContain("+7 more finding(s)");
  });

  it("escapes content instead of letting it break the document", () => {
    const html = renderDeckHtml(
      model({
        findings: [
          {
            severity: "high",
            category: "visual",
            summary: '<script>alert("x")</script>',
            inconclusive: false,
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  it("honours the initial language while keeping both strings for the toggle", () => {
    const pt = renderDeckHtml(model(), "pt");
    expect(pt).toContain('<html lang="pt-BR">');
    expect(pt).toContain('data-pt="Achados"');
    expect(pt).toContain('data-en="Findings"');
    expect(renderDeckHtml(model(), "en")).toContain('<html lang="en">');
  });
});

describe("deck template drift", () => {
  /**
   * `templates/report-deck.html` is the browsable demo and `deck-template.ts` is what the renderer
   * emits. They are the same CSS and JS by hand, so this fails the moment one is edited without the
   * other — the failure mode that makes a "copy this template" promise a lie.
   */
  it("keeps the template file and the renderer constants identical", () => {
    const file = readFileSync(
      join(import.meta.dirname, "../../templates/report-deck.html"),
      "utf8",
    );
    const styleEnd = file.indexOf("</style>");
    const css = file.slice(file.lastIndexOf("<style>", styleEnd) + "<style>".length, styleEnd);
    const js = file.slice(
      file.lastIndexOf("<script>") + "<script>".length,
      file.lastIndexOf("</script>"),
    );
    expect(DECK_CSS).toBe(css);
    expect(DECK_JS).toBe(js);
  });
});
