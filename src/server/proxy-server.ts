import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".zip": "application/zip",
  ".har": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

/**
 * Headers stripped from proxied responses so iframes can render arbitrary sites.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding", // body is already decoded by fetch()
  "content-length", // recomputed by Node
  "transfer-encoding",
  "strict-transport-security",
  "frame-options",
]);

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  // Drop client-injected origin/referer so target site doesn't see localhost
  "referer",
  "origin",
]);

export interface ServerHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export async function startProxyServer(
  runDir: string,
  opts: { port?: number; host?: string } = {},
): Promise<ServerHandle> {
  const absRunDir = resolve(runDir);
  if (!existsSync(absRunDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }

  const server = createServer((req, res) => {
    handleRequest(req, res, absRunDir).catch((err) => {
      try {
        res.statusCode = 500;
        res.end(`internal error: ${(err as Error).message}`);
      } catch {
        /* response already sent */
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address() as AddressInfo | string | null;
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const host = opts.host ?? "127.0.0.1";
  return {
    port,
    url: `http://${host}:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        // Drop keep-alive / in-flight connections immediately so close() resolves
        // instead of waiting for browsers to release their iframe sockets.
        try {
          server.closeAllConnections?.();
          server.closeIdleConnections?.();
        } catch {
          /* older node */
        }
        server.close(() => resolve());
        // Safety net: if close() doesn't resolve within 1s, force exit anyway
        setTimeout(() => resolve(), 1000);
      }),
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, runDir: string): Promise<void> {
  const reqUrl = new URL(req.url ?? "/", "http://placeholder");
  const path = decodeURIComponent(reqUrl.pathname);

  // Proxy endpoint: /proxy?url=<encoded>&viewport=mobile|desktop
  // The viewport hint forces a mobile UA outbound + injects a 375-wide
  // viewport meta tag so the cand iframe renders in the correct breakpoint
  // even when the prod and cand origins differ. Issue #70.
  if (path === "/proxy") {
    const target = reqUrl.searchParams.get("url");
    if (!target) {
      res.statusCode = 400;
      res.end("missing ?url=");
      return;
    }
    const viewport = reqUrl.searchParams.get("viewport");
    const forceMobile = viewport === "mobile";
    return proxyRequest(req, res, target, { forceMobile });
  }

  // Health
  if (path === "/__parity/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Root → report.html (with proxy hint injected)
  if (path === "/" || path === "/index.html") {
    return serveReportHtml(res, runDir);
  }

  // Static file under the run directory
  return serveStatic(res, runDir, path);
}

function serveReportHtml(res: ServerResponse, runDir: string): void {
  const filePath = join(runDir, "report.html");
  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.end("report.html not found");
    return;
  }
  const html = readFileSync(filePath, "utf8");
  // Inject the proxy hint so the report's JS knows it's being served (not file://).
  // The SBS controller picks it up and routes iframe src through /proxy.
  const inject = `<script>window.__parity_proxy = "/proxy?url=";</script>`;
  const out = html.includes("</head>") ? html.replace("</head>", `${inject}</head>`) : `${inject}${html}`;
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(out);
}

function serveStatic(res: ServerResponse, runDir: string, path: string): void {
  // Prevent path traversal: resolved path must stay within runDir
  const safePath = normalize(path).replace(/^[/\\]+/, "");
  const filePath = resolve(runDir, safePath);
  if (!filePath.startsWith(runDir + sep) && filePath !== runDir) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  const st = statSync(filePath);
  if (st.isDirectory()) {
    res.statusCode = 403;
    res.end("directory listing forbidden");
    return;
  }
  const ext = extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.end(readFileSync(filePath));
}

async function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetUrl: string,
  opts: { forceMobile?: boolean } = {},
): Promise<void> {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    res.statusCode = 400;
    res.end("invalid url");
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    res.statusCode = 400;
    res.end("unsupported protocol");
    return;
  }

  // Build outbound headers from incoming, minus hop-by-hop and origin/referer
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!v) continue;
    if (STRIPPED_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  // Force a realistic UA so sites don't return bare error pages. When the
  // caller asked for `viewport=mobile`, send a mobile UA + the client-hint
  // header that signals mobile — most sites branch on this for SSR.
  if (opts.forceMobile) {
    headers["user-agent"] =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    headers["sec-ch-ua-mobile"] = "?1";
    headers["sec-ch-ua-platform"] = '"iOS"';
  } else {
    headers["user-agent"] =
      headers["user-agent"] ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  }
  headers.host = target.host;

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: req.method ?? "GET",
      headers,
      redirect: "follow",
    });
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain");
    res.end(`upstream fetch failed: ${(err as Error).message}`);
    return;
  }

  // Copy response status + headers minus the ones that block iframes
  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    const lk = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lk)) return;
    if (lk === "set-cookie") return; // avoid leaking cookies through proxy
    try {
      res.setHeader(key, value);
    } catch {
      /* invalid header name from upstream, skip */
    }
  });
  res.setHeader("cache-control", "no-store");

  // If HTML, inject base tag so relative URLs resolve to the target origin
  // (not our proxy). When forceMobile is set, also inject (or override) the
  // viewport meta so the layout actually renders at the mobile breakpoint.
  // Issue #70.
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const buf = await upstream.text();
    const baseTag = `<base href="${escapeAttr(target.toString())}">`;
    let html = buf;
    if (opts.forceMobile) {
      const viewportMeta = `<meta name="viewport" content="width=375, initial-scale=1">`;
      // Strip any existing viewport meta so ours wins; then inject our own.
      html = html.replace(/<meta\s+[^>]*name=["']viewport["'][^>]*>/gi, "");
      html = html.includes("<head>")
        ? html.replace("<head>", `<head>${viewportMeta}`)
        : html.includes("<html")
          ? html.replace(/<html([^>]*)>/i, `<html$1><head>${viewportMeta}</head>`)
          : `${viewportMeta}${html}`;
    }
    const out = html.includes("<head>")
      ? html.replace("<head>", `<head>${baseTag}`)
      : html.includes("<html")
        ? html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`)
        : `${baseTag}${html}`;
    res.end(out);
    return;
  }

  // Binary / non-html: stream as-is
  const body = upstream.body;
  if (!body) {
    res.end();
    return;
  }
  try {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch {
    /* tolerated */
  }
  res.end();
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}
