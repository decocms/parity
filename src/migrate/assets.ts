/**
 * Site-level asset + icon capture for `parity migrate`.
 *
 * The component snapshot inventories per-component image/font URLs, but a
 * migration also needs the brand assets that live at the page/site level —
 * logo, favicon, apple-touch-icon, OG image, web app manifest — and an
 * inventory of the icons the UI uses (so the agent can map them to the
 * target's icon set, e.g. FastStore's Phosphor `<Icon>`).
 *
 * `collectSiteAssets` reads references in-page; `downloadSiteAssets` fetches
 * them to `<out>/assets/`. `aggregateIcons` (pure) dedupes the icon inventory.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { IconRef, RawSiteAssets, SiteAssets } from "../types/migrate.ts";

/** Dedupe icons by kind+id, summing counts. Pure — unit-tested. */
export function aggregateIcons(icons: IconRef[]): IconRef[] {
  const byKey = new Map<string, IconRef>();
  for (const icon of icons) {
    const id = icon.id.trim();
    if (!id) continue;
    const key = `${icon.kind} ${id}`;
    const existing = byKey.get(key);
    if (existing) existing.count += icon.count;
    else byKey.set(key, { ...icon, id });
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

/** Read site-level asset references + icon inventory from a live page. */
export async function collectSiteAssets(page: Page): Promise<RawSiteAssets> {
  const raw = await page.evaluate(() => {
    const abs = (href: string | null | undefined): string | null => {
      if (!href) return null;
      try {
        return new URL(href, location.href).href;
      } catch {
        return null;
      }
    };
    const linkHref = (sel: string): string | null =>
      abs(document.querySelector(sel)?.getAttribute("href"));

    // Brand + meta assets.
    const favicon =
      linkHref("link[rel='icon']") ||
      linkHref("link[rel='shortcut icon']") ||
      abs("/favicon.ico");
    const appleTouchIcon = linkHref("link[rel='apple-touch-icon']");
    const manifest = linkHref("link[rel='manifest']");
    const ogImage = abs(
      document.querySelector("meta[property='og:image']")?.getAttribute("content"),
    );
    // Preloaded/declared web fonts.
    const fonts = Array.from(document.querySelectorAll("link[rel='preload'][as='font']"))
      .map((l) => abs(l.getAttribute("href")))
      .filter((u): u is string => Boolean(u));

    // Logo: an <img>/<svg> in the header/banner whose alt/class/href hints logo,
    // else the header's home link image, else the first header image.
    const header =
      document.querySelector("header, [role='banner']") || document.body;
    let logo: { type: "img"; url: string } | { type: "svg"; markup: string } | null = null;
    if (header) {
      const hinted = Array.from(header.querySelectorAll("img, svg")).find((el) => {
        const bag = `${el.getAttribute("alt") ?? ""} ${el.getAttribute("class") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.closest("a")?.getAttribute("href") ?? ""}`.toLowerCase();
        return bag.includes("logo") || bag.includes("brand");
      });
      const el = hinted ?? header.querySelector("a[href='/'] img, a[href='/'] svg") ?? header.querySelector("img, svg");
      if (el) {
        if (el.tagName.toLowerCase() === "img") {
          const url = abs(el.getAttribute("src"));
          if (url) logo = { type: "img", url };
        } else {
          logo = { type: "svg", markup: el.outerHTML.slice(0, 20_000) };
        }
      }
    }

    // Icon inventory.
    const icons: { kind: string; id: string; count: number }[] = [];
    for (const use of Array.from(document.querySelectorAll("use"))) {
      const href = use.getAttribute("href") || use.getAttribute("xlink:href") || "";
      const id = href.startsWith("#") ? href.slice(1) : href.split("#")[1] || "";
      if (id) icons.push({ kind: "svg-use", id, count: 1 });
    }
    // Inline SVGs without a <use> (self-contained icons) — labelled if possible.
    for (const svg of Array.from(document.querySelectorAll("svg"))) {
      if (svg.querySelector("use")) continue;
      const label =
        svg.getAttribute("aria-label") ||
        svg.querySelector("title")?.textContent?.trim() ||
        svg.getAttribute("class") ||
        "unnamed";
      icons.push({ kind: "inline-svg", id: label.slice(0, 40), count: 1 });
    }
    // Icon-font glyphs.
    const iconClassRe = /\b(icon(?![a-z])|fa-[a-z0-9-]+|material-icons|ph-[a-z0-9-]+|glyphicon-[a-z0-9-]+)\b/i;
    for (const el of Array.from(document.querySelectorAll("i, span"))) {
      const cls = el.getAttribute("class") ?? "";
      const m = cls.match(iconClassRe);
      if (m?.[1]) icons.push({ kind: "icon-font", id: m[1], count: 1 });
    }

    return { favicon, appleTouchIcon, manifest, ogImage, fonts, logo, icons };
  });

  return { ...raw, icons: aggregateIcons(raw.icons) };
}

export interface FetchedBytes {
  buf: Buffer;
  contentType: string | null;
}

/** Fetches asset bytes. Injected so downloads can go through the BROWSER
 * (which already passed the site's bot protection) with a node fallback. */
export type FetchBytes = (url: string) => Promise<FetchedBytes | null>;

/** Fetch bytes via the live page's `fetch` — bypasses Akamai/Cloudflare bot
 * blocks that 403 a bare node fetch (same TLS/UA/cookies as the real browser).
 * Works reliably for same-origin assets (favicon/logo); CORS may block reading
 * cross-origin bodies, in which case the caller falls back to node fetch. */
export async function browserFetchBytes(page: Page, url: string): Promise<FetchedBytes | null> {
  try {
    const r = await page.evaluate(async (u: string) => {
      const res = await fetch(u);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      return { b64: btoa(binary), ct: res.headers.get("content-type") };
    }, url);
    if (!r) return null;
    return { buf: Buffer.from(r.b64, "base64"), contentType: r.ct };
  } catch {
    return null;
  }
}

export async function nodeFetchBytes(url: string): Promise<FetchedBytes | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return { buf: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  } catch {
    return null;
  }
}

async function downloadTo(
  url: string,
  dir: string,
  name: string,
  fetchBytes: FetchBytes,
): Promise<string | null> {
  const got = await fetchBytes(url);
  if (!got) return null;
  const ext = extFromUrlOrType(url, got.contentType);
  const file = `${name}${ext}`;
  writeFileSync(join(dir, file), got.buf);
  return `assets/${file}`;
}

function extFromUrlOrType(url: string, contentType: string | null): string {
  try {
    const m = new URL(url).pathname.match(/\.[a-z0-9]{2,5}$/i);
    if (m) return m[0];
  } catch {
    /* ignore */
  }
  if (contentType?.includes("svg")) return ".svg";
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("json")) return ".json";
  return "";
}

/** Download brand/meta assets to `<runDir>/assets/`; return the resolved bundle. */
export async function downloadSiteAssets(
  raw: RawSiteAssets,
  runDir: string,
  fetchBytes: FetchBytes,
): Promise<SiteAssets> {
  const dir = join(runDir, "assets");
  mkdirSync(dir, { recursive: true });

  let logo: string | null = null;
  let logoSource: string | null = null;
  if (raw.logo?.type === "img") {
    logoSource = raw.logo.url;
    logo = await downloadTo(raw.logo.url, dir, "logo", fetchBytes);
  } else if (raw.logo?.type === "svg") {
    writeFileSync(join(dir, "logo.svg"), raw.logo.markup, "utf8");
    logo = "assets/logo.svg";
    logoSource = "inline-svg";
  }

  const [favicon, appleTouchIcon, ogImage] = await Promise.all([
    raw.favicon ? downloadTo(raw.favicon, dir, "favicon", fetchBytes) : Promise.resolve(null),
    raw.appleTouchIcon
      ? downloadTo(raw.appleTouchIcon, dir, "apple-touch-icon", fetchBytes)
      : Promise.resolve(null),
    raw.ogImage ? downloadTo(raw.ogImage, dir, "og-image", fetchBytes) : Promise.resolve(null),
  ]);

  return {
    logo,
    logoSource,
    favicon,
    faviconSource: raw.favicon,
    appleTouchIcon,
    ogImage,
    manifest: raw.manifest,
    fonts: raw.fonts,
    icons: raw.icons,
  };
}
