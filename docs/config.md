# Configuration reference

Both files are **gitignored by default** — they're per-user, not per-repo.

## `.parityrc.json`

Selector overrides and run defaults. Placed at the project root.

```json
{
  "cep": "01310-100",
  "selectors": {
    "categoryLink": "header a[href*='/c/']",
    "productCard": "[data-product-card] a",
    "buyButton": "button:has-text('Comprar')",
    "minicartTrigger": "[data-minicart-trigger]",
    "cepInputPdp": "input[name='shipping-zipcode']",
    "cepInputCart": "input[name='cart-zipcode']",
    "checkoutButton": "a:has-text('Finalizar compra')",
    "searchInput": "input[type='search']",
    "cartCouponInput": "input[name*='coupon']",
    "paginationNext": "a[rel='next']",
    "loadMoreButton": "button:has-text('Carregar mais')"
  },
  "search": {
    "terms": ["camisa", "promocao"]
  },
  "footer": {
    "maxLinks": 20,
    "followExternal": false
  },
  "notFound": {
    "testUrl": "/this-page-definitely-does-not-exist"
  },
  "login": { "enabled": true },
  "coupon": {
    "invalidCode": "INVALIDCOUPON123-XYZ",
    "validCode": "PARITY10"
  },
  "serverFnFloodBudget": 10,
  "serverFnPattern": "_serverFn",
  "addToCartConfirmMs": 2000,
  "overlaySelectors": ["#NewsletterPopup", "[data-newsletter-popup]"],
  "minicartPanel": "[data-qa-minicart]"
}
```

> `selectors` has ~28 keys total (cart/PDP-gallery/login/pagination/search
> included) — the block above shows the common ones. Run `parity learned
> stats` or check `ParityRc` in `src/types/schema.ts` for the full list; any
> key you don't set falls back to defaults → learned-selectors → LLM
> discovery, in that order.

`serverFnFloodBudget` / `serverFnPattern` configure the `serverfn-hover-flood`
check (issue #54): hovering a handful of PLP product cards shouldn't fire
more than `serverFnFloodBudget` (default 10) requests matching
`serverFnPattern` (default `"_serverFn"`, TanStack Start's server-fn route
convention — override it if your framework uses a different one). The check
skips cleanly on sites where the pattern never matches (e.g. Fresh/non-SPA).

`coupon.invalidCode` overrides the default code used by the `apply-invalid-coupon`
step. `coupon.validCode` is opt-in: when set, the cart-interactions flow also
runs `apply-valid-coupon` (asserts the total drops or a discount indicator
appears); when absent, that step is skipped — parity has no way to know a real
discount code on its own.

`addToCartConfirmMs` (issue #143) sets how long — in milliseconds — the
purchase-journey / `e2e` add-to-cart step polls for a success signal (URL→cart,
minicart count increase, drawer open, or a success toast) before it gives up
and reports a failure. Default `3000`. Tune it when your site's success toast
is short-lived, or when slow TTFB / popup overlays narrow the window, to avoid
a false "no signal" failure on an add-to-cart that actually worked. Also
settable per-run with `--add-to-cart-timeout <ms>` (on `parity run` and
`parity e2e`), which overrides the rc value.

`overlaySelectors` (issue #145) lists extra CSS selectors for site-specific
blocking overlays — newsletter/discount modals, region pickers, app-install
nags — that the flow runner should close before/while interacting. It's
**merged with** the built-in defaults (cookie banners, toasts, alertdialogs),
never replacing them. You usually won't need it: unnamed overlays that
actually intercept a click are handled **structurally** (issue #146) — before
retrying a failed add-to-cart, parity checks whether the buy button is still
the topmost element at its click point (`document.elementFromPoint`) and, if
something is covering it, dismisses it least-destructive-first (Escape → a
close-like button → a backdrop click) and retries once. What was detected and
how it was dismissed is recorded in the step's `detail.overlayDismissed`, so a
report shows *why* a click was intercepted even when dismissal succeeded.
`overlaySelectors` is the explicit fast-path override for a known modal.

`minicartPanel` (issue #149) identifies the minicart drawer/panel root element
when open. It is used by `isCartUiVisible` (the fallback for reveal detection
when no product title can be found) and by `validateCartContainsTitleQuick`
(the title-scope sweep after add-to-cart). The built-in defaults cover common
`data-minicart*`, `data-testid`, and name-based class patterns — but a
`data-qa-*` or pure-Tailwind site has none of those, so the detection is
permanently blind. Override with a single selector that targets the drawer
root, e.g. `"[data-qa-minicart]"` for a DaisyUI drawer whose root carries that
test attribute. The override is tried before all hardcoded patterns.

`paginationNext` / `loadMoreButton` override the selectors the `plp` flow
uses to detect how a PLP paginates (next-page link, "load more" button, or —
when neither matches — a scroll probe for infinite scroll). The PLP
pagination check trusts whichever mode gets detected and only falls back to
fetching `?page=N` when the detected mode is a classic paginated link (or
undetected).

> **Credentials are NEVER read from `.parityrc.json`.** Set `PARITY_LOGIN_EMAIL` and `PARITY_LOGIN_PASSWORD` as environment variables (`.parityrc.json` is for non-secret config only).

## `.parityignore`

Noise suppression for visual diff, network filters, and console messages.

```json
{
  "ignoreSelectorsVisual": [".banner-rotativo", "#trustvox-trustbar"],
  "ignoreRequestPatterns": ["*.gif?t=*", "**/pixel*"],
  "ignoreConsolePatterns": ["ERR_BLOCKED_BY_CLIENT"]
}
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Use direct Anthropic API as LLM provider |
| `OPENROUTER_API_KEY` | Use OpenRouter as LLM provider |
| `PARITY_OPENROUTER_MODEL` | Override default OpenRouter model |
| `PARITY_OPENROUTER_MODEL_HAIKU` / `_OPUS` | Override per-tier OpenRouter slugs |
| `PARITY_LOGIN_EMAIL` / `_PASSWORD` | Credentials for the `login` flow |
| `GITHUB_STEP_SUMMARY` | (CI-set) When set, `parity pr --github` appends Markdown |
