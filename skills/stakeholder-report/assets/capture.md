# Capture recipe

Working scripts for before/after captures. Each one exists because the obvious
approach failed in a specific way — the notes say how.

## 1. Stand up both sides

```bash
git worktree add /tmp/site-before <tag>
cd /tmp/site-before && cp .env.example .env
yarn install --frozen-lockfile && yarn build
PORT=3017 yarn start          # "after" worktree usually already has a build → PORT=3019
```

Wait on readiness rather than sleeping blind:

```bash
until curl -sf -o /dev/null http://localhost:3017/; do sleep 2; done
```

> `nohup cmd &` inside a backgrounded shell gets killed when the wrapper exits.
> Run the command in the foreground of the background task instead.

## 2. Find a product that is in stock

An out-of-stock PDP has no buy button, so every cart and checkout capture
silently returns the PDP. Discover one and assert the button exists:

```js
// cypress/e2e/find.cy.js
Cypress.on('uncaught:exception', () => false)
const BUY = '[data-testid="buy-button"], [data-fs-buy-button], button:contains("Comprar")'

it('finds a purchasable product', () => {
  cy.visit('/<category>', { failOnStatusCode: false })
  cy.wait(5000)
  cy.get('a[href$="/p"]', { timeout: 20000 }).then(($as) => {
    const hrefs = [...new Set([...$as].map((a) => a.getAttribute('href')))].slice(0, 8)
    const found = { href: null }
    hrefs.forEach((h) => cy.then(() => {
      if (found.href) return
      cy.visit(h, { failOnStatusCode: false })
      cy.wait(3500)
      cy.get('body').then(($b) => {
        if ($b.find(BUY).filter((i, el) => !el.disabled).length && !found.href) found.href = h
      })
    }))
    cy.then(() => cy.writeFile('/tmp/product.json', found))
  })
})
```

## 3. Same-origin pages → Cypress

```js
// cypress/e2e/shots.cy.js
// An older build often throws on load; we want the broken state captured, not a
// red test.
Cypress.on('uncaught:exception', () => false)

const SIDE = Cypress.env('side')            // 'before' | 'after'
const shot = (slug) => cy.screenshot(`${SIDE}-${slug}`, { capture: 'fullPage', overwrite: true })

it('home', () => { cy.visit('/'); cy.wait(4000); shot('home') })
```

```js
// cypress.config.js — symlink node_modules into this dir first, or
// require('cypress') cannot resolve.
const { defineConfig } = require('cypress')
module.exports = defineConfig({
  e2e: {
    specPattern: 'e2e/**/*.cy.js',
    supportFile: false,
    baseUrl: process.env.CAP_BASE,
    screenshotsFolder: process.env.CAP_OUT,
    video: false,
    viewportWidth: 1280, viewportHeight: 800,
    defaultCommandTimeout: 15000, pageLoadTimeout: 90000, retries: 0,
  },
})
```

> Keep `viewportWidth` at or below the Electron window width (1280). Set it
> higher and the layout is computed at your width while the screenshot is taken
> at the window's, so the right edge is cropped. Confirm with
> `cy.window()` → compare `innerWidth` against `documentElement.scrollWidth`.

## 4. Cross-origin hops → headless Chrome

Cypress cannot follow a domain change; the runner dies with `Cannot destructure
property 'duration' of 'props'`. The URL trail is usually the real evidence.

```js
// checkout.mjs — node checkout.mjs
import puppeteer from 'puppeteer-core'

const CHROME = process.env.CHROME_PATH   // a Playwright chromium works:
// ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, args: ['--no-sandbox'],
  defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
const trail = []
page.on('framenavigated', (f) => { if (f === page.mainFrame()) trail.push(f.url()) })

await page.goto(process.env.CAP_BASE + process.env.PDP, { waitUntil: 'domcontentloaded' })
await sleep(5000)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')]
    .find((e) => /comprar|añadir|agregar/i.test(e.textContent) && !e.disabled)
  if (b) b.click()
})
await sleep(4000)
// Resolve the selector on both sides first and use it, rather than matching text —
// text matching is flaky across builds.
await page.evaluate(() => document.querySelector('[data-testid="checkout-button"]')?.click())
await Promise.race([
  page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => null),
  sleep(25000),
])
await sleep(6000)

await page.screenshot({ path: `${process.env.CAP_OUT}/${process.env.SIDE}-checkout.png` })
console.log(JSON.stringify({ url: page.url(), trail }, null, 1))
await browser.close()
```

Before trusting a click, inventory what is actually in the DOM on both sides:

```js
const els = [...(document.querySelector('[role="dialog"]') || document.body)
  .querySelectorAll('button, a, [role="button"]')]
  .map((e) => ({ tag: e.tagName, text: e.textContent.trim().slice(0, 40),
                 testid: e.getAttribute('data-testid'), disabled: !!e.disabled }))
```

## 5. Compress, or the report is unusable

A `fullPage` capture is 14k–26k px tall and repeats the footer where the stitch
wrapped. Crop the top, downscale, JPEG.

```python
from PIL import Image
CROP = {"home": 7000, "pdp": 6400, "minicart": 2600}   # px in the original
W = 1000
for side in ("before", "after"):
    for slug, h in CROP.items():
        im = Image.open(f"/tmp/cap-{side}/{side}-{slug}.png").convert("RGB")
        im = im.crop((0, 0, im.width, min(h, im.height)))
        im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)
        im.save(f"shots/{side}-{slug}.jpg", "JPEG", quality=72,
                optimize=True, progressive=True)
```

Eight images: ~40 MB → under 1 MB.

## 6. Favicon

```python
from PIL import Image, ImageDraw
import base64, io
BRAND = (10, 35, 84)
src = Image.open("src/assets/images/favicon-brand.ico").ico.getimage((256, 256)).convert("RGBA")
# A brand .ico is often an opaque plate with the mark punched out as
# transparency — embed it raw and you get a black square. Check the alpha before
# assuming: alpha=255 is plate, alpha=0 is glyph.
alpha = src.getchannel("A")
w, h = src.size
out = Image.composite(Image.new("RGB", (w, h), BRAND),
                      Image.new("RGB", (w, h), (255, 255, 255)), alpha).convert("RGBA")
mask = Image.new("L", (w, h), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=int(w * 0.18), fill=255)
out.putalpha(mask)
buf = io.BytesIO(); out.resize((48, 48), Image.LANCZOS).save(buf, "PNG", optimize=True)
print(f'<link rel="icon" type="image/png" sizes="48x48" '
      f'href="data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"/>')
```

Render it before shipping. Prefer the repo asset at 256px over the 16×16 the
site serves.
