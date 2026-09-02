# Responsive & Device — CSS first, JS last

Load when: mobile layout on desktop (or vice-versa), a header/banner that is wrong
for ~5 minutes and then right, React #418/#419 on a section that renders two
layouts, or any port that reaches for `useDevice` / `isMobile` to pick markup.

## The rule

**Responsive layout is CSS.** Render both variants and let Tailwind decide:

```tsx
<nav className="md:hidden">…mobile…</nav>
<nav className="hidden md:flex">…desktop…</nav>
```

Two image sources = `<picture>`, not a JS branch:

```tsx
<picture>
  <source media="(min-width: 768px)" srcSet={desktop} width={1440} height={480} />
  <img src={mobile} width={390} height={520} loading="eager" fetchpriority="high" />
</picture>
```

## Why (each one is a real incident, not a style opinion)

1. **Edge cache.** UA-derived HTML varies but the cache key does not. One mobile
   visitor poisons the cached HTML for every desktop visitor until it expires —
   observed as "mobile header on desktop, intermittently, ~5min windows", because
   `registerLayoutSections` caches by component name with no UA variation.
2. **Hydration.** `useDevice` reads `RequestContext` (server-only, AsyncLocalStorage).
   The client re-render has no request, falls back to the default, and produces
   different markup → React #418/#419 + layout shift. On casaevideo this single class
   of bug was CLS `1.04 → ~0.3`. A `Device.Provider` hardcoded to
   `value={{ isMobile: true }}` in `__root.tsx` is the same bug with the volume up:
   every visitor gets mobile.
3. **It never re-evaluates.** A UA branch is decided once, server-side. Rotate the
   device, resize the window, or navigate client-side in the SPA and it stays wrong.
   A media query re-evaluates for free, forever.
4. **Cost.** The CSS branch ships 0 KB of JS and is measurable — parity's
   `visual-regression` already captures per viewport, so a CSS branch is verified by
   the score you already run. A JS branch is only visible if you happen to test with
   the right UA.

## When a device VALUE is legitimate

Only when the markup genuinely differs (not just its layout): a different number of
carousel items, a component so heavy that shipping both is worse than branching.
Then get it from the server, per request:

```ts
// setup.ts
registerSectionLoaders({
  "site/sections/Header/Header.tsx": (props, req) => ({
    ...props,
    isMobile: (req.headers.get("cf-device-type") ??
      (/android|iphone|ipad/i.test(req.headers.get("user-agent") ?? "") ? "mobile" : "desktop")) === "mobile",
  }),
});
```

```tsx
export interface Props {
  /** @hide */
  isMobile?: boolean;
}
```

Three conditions come with it, all load-bearing:
- **`/** @hide */` on the prop** — otherwise the CMS admin saves `isMobile: true` into
  the decofile and every visitor is a phone forever.
- **The section must NOT be in `registerLayoutSections`** — that cache is keyed by
  component name, so a device-varying section belongs in `registerSectionLoaders`.
- **The route's cache key must vary by device, or the route must not be cached.**
  Device-varying HTML behind a device-blind cache key is bug #1 above.

## Never

- `useDevice()` inside a section body to pick JSX. That is bug #1 and #2 at once.
- `matchMedia` or `window.innerWidth` read during render — SSR has neither. If you
  truly need the live viewport, read it in `useEffect` and accept the first paint
  without it.
- `<Device.Provider value={{ isMobile: true }}>` hardcoded anywhere.

## How it surfaces in parity

- `banner-aspect-ratio` — fires when `isMobile` came back undefined in a migrated
  section and the mobile asset rendered at desktop proportions.
- `visual-regression` — runs per viewport, so a device branch that only works for one
  UA shows up as a diff on the other.
