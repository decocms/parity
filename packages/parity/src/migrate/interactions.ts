/**
 * Light interaction capture for `parity migrate` (Phase 3, per component).
 *
 * "Light" = NO live exercising. We list interactive elements, read their
 * DECLARED states from the CSSOM (`:hover`/`:focus` rules) and computed
 * transition/animation, and suggest an e2e selector — mapping to a known
 * `SelectorKey` (src/learned/repo.ts) when the element is a recognizable
 * commerce affordance. Clicking/hovering and recording runtime transitions
 * is deferred (see plan non-goals).
 *
 * `classifyE2eKey` is a pure heuristic (exported, unit-tested); the DOM walk
 * lives in `captureInteractions`.
 */

import type { Page } from "playwright";
import type { SelectorKey } from "../learned/repo.ts";
import type { InteractionHint } from "../types/migrate.ts";

/** Cap per component so a mega-nav doesn't blow the token budget. */
const MAX_INTERACTIONS = 40;

interface RawInteraction {
  selector: string;
  kind: string;
  label: string;
  animation: string | null;
  hasHoverRule: boolean;
  hasFocusRule: boolean;
  /** Lowercased bag of label + aria-label + name + placeholder + class + href for classification. */
  hint: string;
}

/**
 * Map an interactive element's text/attrs to a known commerce `SelectorKey`,
 * or null for a generic interactive element. Ordered most-specific first.
 */
export function classifyE2eKey(hint: string, kind: string): SelectorKey | null {
  const h = hint.toLowerCase();
  const has = (...words: string[]) => words.some((w) => h.includes(w));

  if (has("add to cart", "add-to-cart", "adicionar", "comprar", "buy")) return "buyButton";
  if (has("checkout", "finalizar compra", "fechar pedido")) return "checkoutButton";
  if (kind === "input" && has("search", "buscar", "pesquis", "q=")) return "searchInput";
  if (has("search", "buscar", "pesquis")) return "searchTrigger";
  if (has("minicart", "mini-cart", "cart", "carrinho", "sacola", "bag", "basket"))
    return "minicartTrigger";
  if (kind === "input" && has("email", "e-mail")) return "loginEmailInput";
  if (kind === "input" && has("password", "senha")) return "loginPasswordInput";
  if (has("login", "sign in", "entrar", "minha conta", "my account")) return "loginTrigger";
  if (has("load more", "ver mais", "carregar mais", "show more")) return "loadMoreButton";
  if (has("next", "próxima", "proxima", "próximo")) return "paginationNext";
  if (has("increment", "increase", "aumentar", "qty-plus", "plus")) return "quantityIncrement";
  if (has("remove", "remover", "excluir", "delete")) return "cartRemoveItem";
  if (has("coupon", "cupom", "promo code")) return "cartCouponInput";
  return null;
}

/** Capture interaction hints for the component matched by `selector`. */
export async function captureInteractions(
  page: Page,
  selector: string,
): Promise<InteractionHint[]> {
  let raw: RawInteraction[];
  try {
    raw = await page.evaluate(
      ({ sel, cap }) => {
        const root = document.querySelector(sel);
        if (!root) return [];

        // Collect selectors that carry :hover / :focus rules, best-effort
        // (cross-origin sheets throw on cssRules — skip them).
        const hoverBases: string[] = [];
        const focusBases: string[] = [];
        const splitBases = (selectorText: string, pseudo: string, out: string[]) => {
          for (const part of selectorText.split(",")) {
            if (part.includes(pseudo)) {
              const base = part.split(pseudo)[0]?.trim();
              if (base) out.push(base);
            }
          }
        };
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try {
            rules = (sheet as CSSStyleSheet).cssRules;
          } catch {
            continue;
          }
          for (const rule of Array.from(rules)) {
            const text = (rule as CSSStyleRule).selectorText;
            if (!text) continue;
            if (text.includes(":hover")) splitBases(text, ":hover", hoverBases);
            if (text.includes(":focus")) splitBases(text, ":focus", focusBases);
          }
        }
        const matchesAny = (el: Element, bases: string[]) =>
          bases.some((b) => {
            try {
              return el.matches(b);
            } catch {
              return false;
            }
          });

        const cssEscape = (s: string) =>
          (window.CSS?.escape ? window.CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
        const suggestSelector = (el: Element): string => {
          const tag = el.tagName.toLowerCase();
          if (el.id) return `#${cssEscape(el.id)}`;
          const testid = el.getAttribute("data-testid");
          if (testid) return `[data-testid="${testid}"]`;
          for (const attr of Array.from(el.attributes)) {
            if (attr.name.startsWith("data-") && attr.value) {
              return `${tag}[${attr.name}="${attr.value}"]`;
            }
          }
          const aria = el.getAttribute("aria-label");
          if (aria) return `${tag}[aria-label="${aria}"]`;
          const semantic = Array.from(el.classList).find(
            (c) => !/[:[\]/]/.test(c) && !/\d/.test(c) && c.length > 2,
          );
          return semantic ? `${tag}.${cssEscape(semantic)}` : tag;
        };

        const nodes = Array.from(
          root.querySelectorAll("a, button, input, select, [role='button'], [onclick]"),
        ).slice(0, cap);

        return nodes.map((el) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role");
          const kind =
            tag === "input"
              ? "input"
              : tag === "select"
                ? "select"
                : tag === "a"
                  ? "link"
                  : tag === "button" || role === "button"
                    ? "button"
                    : "clickable";
          const cs = getComputedStyle(el);
          const transition =
            cs.transitionProperty && cs.transitionProperty !== "all" && cs.transitionProperty !== "none"
              ? `transition: ${cs.transitionProperty} ${cs.transitionDuration}`
              : cs.animationName && cs.animationName !== "none"
                ? `animation: ${cs.animationName} ${cs.animationDuration}`
                : null;
          const label = (el.getAttribute("aria-label") || (el.textContent ?? "").trim())
            .replace(/\s+/g, " ")
            .slice(0, 80);
          const hint = [
            label,
            el.getAttribute("aria-label") ?? "",
            el.getAttribute("name") ?? "",
            el.getAttribute("placeholder") ?? "",
            el.getAttribute("type") ?? "",
            el.getAttribute("href") ?? "",
            el.className && typeof el.className === "string" ? el.className : "",
          ]
            .join(" ")
            .toLowerCase();

          return {
            selector: suggestSelector(el),
            kind,
            label,
            animation: transition,
            hasHoverRule: matchesAny(el, hoverBases),
            hasFocusRule: matchesAny(el, focusBases),
            hint,
          };
        });
      },
      { sel: selector, cap: MAX_INTERACTIONS },
    );
  } catch {
    return [];
  }

  return raw.map((r) => ({
    selector: r.selector,
    kind: r.kind,
    label: r.label,
    e2eKey: classifyE2eKey(r.hint, r.kind),
    animation: r.animation,
    hasHoverRule: r.hasHoverRule,
    hasFocusRule: r.hasFocusRule,
  }));
}
