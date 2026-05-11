export interface UserAgentRules {
  allow: string[];
  disallow: string[];
  crawlDelay: number | null;
}

export interface ParsedRobots {
  /** Map of user-agent (lowercased) → rules. Use "*" for the wildcard. */
  userAgents: Record<string, UserAgentRules>;
  /** Absolute Sitemap URLs declared at the top-level */
  sitemaps: string[];
  /** Raw content for diff/debug */
  raw: string;
}

export async function fetchRobots(baseUrl: string): Promise<string | null> {
  try {
    const url = new URL("/robots.txt", baseUrl).toString();
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; parity-cli/0.1; +https://github.com/decocms/parity)",
      },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const txt = await res.text();
    // Some sites return HTML for missing robots; sniff
    if (txt.trim().startsWith("<")) return null;
    return txt;
  } catch {
    return null;
  }
}

export function parseRobots(txt: string): ParsedRobots {
  const userAgents: Record<string, UserAgentRules> = {};
  const sitemaps: string[] = [];
  let currentUas: string[] = [];

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === "user-agent") {
      const ua = value.toLowerCase();
      currentUas = [ua];
      if (!userAgents[ua]) {
        userAgents[ua] = { allow: [], disallow: [], crawlDelay: null };
      }
    } else if (directive === "disallow") {
      for (const ua of currentUas) {
        userAgents[ua]?.disallow.push(value);
      }
    } else if (directive === "allow") {
      for (const ua of currentUas) {
        userAgents[ua]?.allow.push(value);
      }
    } else if (directive === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) {
        for (const ua of currentUas) {
          if (userAgents[ua]) userAgents[ua].crawlDelay = n;
        }
      }
    } else if (directive === "sitemap") {
      sitemaps.push(value);
    }
  }

  // Normalize: sort lists so set comparisons stable
  for (const ua of Object.keys(userAgents)) {
    userAgents[ua]!.allow.sort();
    userAgents[ua]!.disallow.sort();
  }
  sitemaps.sort();

  return { userAgents, sitemaps, raw: txt };
}

export interface RobotsDiff {
  bothPresent: boolean;
  prodOnly: boolean;
  candOnly: boolean;
  uaDiffs: Array<{
    userAgent: string;
    allowOnlyProd: string[];
    allowOnlyCand: string[];
    disallowOnlyProd: string[];
    disallowOnlyCand: string[];
    crawlDelayProd: number | null;
    crawlDelayCand: number | null;
  }>;
  sitemapDiff: { onlyProd: string[]; onlyCand: string[] };
  anyDivergence: boolean;
}

export function diffRobots(prod: ParsedRobots | null, cand: ParsedRobots | null): RobotsDiff {
  const out: RobotsDiff = {
    bothPresent: !!prod && !!cand,
    prodOnly: !!prod && !cand,
    candOnly: !prod && !!cand,
    uaDiffs: [],
    sitemapDiff: { onlyProd: [], onlyCand: [] },
    anyDivergence: false,
  };

  if (!prod || !cand) {
    out.anyDivergence = out.prodOnly || out.candOnly;
    return out;
  }

  const uas = new Set([...Object.keys(prod.userAgents), ...Object.keys(cand.userAgents)]);
  for (const ua of uas) {
    const p = prod.userAgents[ua] ?? { allow: [], disallow: [], crawlDelay: null };
    const c = cand.userAgents[ua] ?? { allow: [], disallow: [], crawlDelay: null };
    const allowOnlyProd = setDiff(p.allow, c.allow);
    const allowOnlyCand = setDiff(c.allow, p.allow);
    const disallowOnlyProd = setDiff(p.disallow, c.disallow);
    const disallowOnlyCand = setDiff(c.disallow, p.disallow);

    if (
      allowOnlyProd.length ||
      allowOnlyCand.length ||
      disallowOnlyProd.length ||
      disallowOnlyCand.length ||
      p.crawlDelay !== c.crawlDelay
    ) {
      out.uaDiffs.push({
        userAgent: ua,
        allowOnlyProd,
        allowOnlyCand,
        disallowOnlyProd,
        disallowOnlyCand,
        crawlDelayProd: p.crawlDelay,
        crawlDelayCand: c.crawlDelay,
      });
    }
  }

  out.sitemapDiff.onlyProd = setDiff(prod.sitemaps, cand.sitemaps);
  out.sitemapDiff.onlyCand = setDiff(cand.sitemaps, prod.sitemaps);

  out.anyDivergence =
    out.uaDiffs.length > 0 || out.sitemapDiff.onlyProd.length > 0 || out.sitemapDiff.onlyCand.length > 0;

  return out;
}

function setDiff(a: string[], b: string[]): string[] {
  const bSet = new Set(b);
  return a.filter((x) => !bSet.has(x));
}
