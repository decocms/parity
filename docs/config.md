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
    "cartCouponInput": "input[name*='coupon']"
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
  "login": { "enabled": true }
}
```

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
