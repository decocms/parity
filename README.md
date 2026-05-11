# @decocms/parity

E2E parity validator for Fresh → TanStack site migrations. CLI that runs comparative tests between two URLs (prod = source of truth, candidate = migrated version) and reports UI, functional, and Web Vitals deltas.

> **Status:** alpha — under active development.

## What it does

Receives two URLs and runs a rigorous battery of E2E checks comparing them:

- **HTTP status parity** across key routes
- **Console errors** (hydration mismatches, 404s)
- **HTML structural diff** (counts, sections)
- **Meta / SEO** (title, description, canonical, og:*, JSON-LD)
- **Visual regression** (pixelmatch on 3 viewports, with masking)
- **Purchase journey** (home → category → PDP → shipping calc → add to cart → minicart → shipping calc → checkout reached)
- **Network summary** (requests, bytes, cache hits)
- **Web Vitals** mobile (LCP, CLS, INP, FCP, TTFB)
- **Image loading health**
- **Lazy section presence** (Deco `/deco/render`, `/_loader/*`)

Aggregates findings via LLM (optional) into a prioritized list of issues with suggested fixes.

## Quickstart

```bash
# Install
npm install -g @decocms/parity
# or run without install
bunx @decocms/parity run --prod ... --cand ...

# Basic run
parity run \
  --prod https://oldsite.com \
  --cand https://newsite.tanstack.dev \
  --flows purchase-journey \
  --viewports mobile,desktop \
  --cep 01310-100

# Open the HTML report
parity report <runId>

# Set a baseline and compare future runs against it
parity baseline set <runId> --name stable
parity run ... --baseline stable
```

## Output

```
./parity-output/runs/<runId>/
├── report.html       # standalone HTML, open in browser
├── report.json       # CI-friendly structured output
├── screenshots/
├── har/
├── traces/           # Playwright traces (open at trace.playwright.dev)
└── console/
./parity-baselines/
└── <name>.json       # git-trackable baseline manifests
```

## Configuration

Optional `.parityrc.json` at the project root for selector overrides:

```json
{
  "cep": "01310-100",
  "selectors": {
    "category_link": "header a[href*='/c/']",
    "product_card": "[data-product-card] a",
    "buy_button": "button:has-text('Comprar')",
    "minicart_trigger": "[data-minicart-trigger]",
    "cep_input_pdp": "input[name='shipping-zipcode']",
    "cep_input_cart": "input[name='cart-zipcode']",
    "checkout_button": "a:has-text('Finalizar compra')"
  }
}
```

Optional `.parityignore` to suppress known noise:

```json
{
  "ignore_selectors_visual": [".banner-rotativo", "#trustvox-trustbar"],
  "ignore_request_patterns": ["*.gif?t=*", "**/pixel*"],
  "ignore_console_patterns": ["ERR_BLOCKED_BY_CLIENT"]
}
```

## LLM (optional)

Set `ANTHROPIC_API_KEY` to enable issue aggregation, root-cause explanation, and suggested-fix generation. Without an API key, the CLI still runs and outputs raw check results — only the smart-aggregator step is skipped.

## Development

```bash
git clone git@github.com:decocms/parity.git
cd parity
bun install
bunx playwright install chromium
bun run dev -- run --prod ... --cand ...
```

## License

MIT
