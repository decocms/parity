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
  }
}
```

`coupon.invalidCode` overrides the default code used by the `apply-invalid-coupon`
step. `coupon.validCode` is opt-in: when set, the cart-interactions flow also
runs `apply-valid-coupon` (asserts the total drops or a discount indicator
appears); when absent, that step is skipped — parity has no way to know a real
discount code on its own.

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
