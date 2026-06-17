import { vi } from "vitest";

export type MockResponse =
  | { status: number; body: string; headers?: Record<string, string> }
  | { delayMs: number; status?: number; body?: string }
  | { error: string };

/**
 * Mock globalThis.fetch. Returns a `restore()` to put back the original.
 *
 * - To return a successful body, use `{ status: 200, body: "..." }`.
 * - To simulate a slow response (for timeout tests), use `{ delayMs: 30_000 }`.
 *   The promise will reject only via the caller's AbortController.
 * - To simulate a network failure, use `{ error: "ENETUNREACH" }`.
 *
 * Routes can match by full URL, by pathname, or via a regex/function:
 *
 *   mockFetch({ "https://x.com/robots.txt": { status: 200, body: "..." } })
 */
export function mockFetch(
  routes: Record<string, MockResponse> | ((url: string) => MockResponse | undefined),
): { restore: () => void; calls: string[] } {
  const orig = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const route = typeof routes === "function" ? routes(url) : matchRoute(routes, url);
    if (!route) {
      return new Response("", { status: 404 });
    }
    if ("error" in route) {
      throw new Error(route.error);
    }
    if ("delayMs" in route) {
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(
          () => resolve(new Response(route.body ?? "", { status: route.status ?? 200 })),
          route.delayMs,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    return new Response(route.body, { status: route.status, headers: route.headers });
  }) as typeof globalThis.fetch;

  return {
    restore: () => {
      globalThis.fetch = orig;
    },
    calls,
  };
}

function matchRoute(routes: Record<string, MockResponse>, url: string): MockResponse | undefined {
  // Exact match
  if (routes[url]) return routes[url];
  // Pathname match
  try {
    const u = new URL(url);
    if (routes[u.pathname]) return routes[u.pathname];
    if (routes[u.origin + u.pathname]) return routes[u.origin + u.pathname];
  } catch {
    /* skip */
  }
  return undefined;
}
