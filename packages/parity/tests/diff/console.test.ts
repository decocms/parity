import { describe, expect, it } from "vitest";
import { classify, diffConsole } from "../../src/diff/console.ts";
import type { ConsoleEntry } from "../../src/types/schema.ts";

const e = (text: string, type: ConsoleEntry["type"] = "error"): ConsoleEntry => ({ type, text });

describe("classify", () => {
  it("detecta hydration mismatch", () => {
    expect(classify(e("Warning: Text content did not match. server x client"))).toBe("hydration");
    expect(classify(e("Hydration failed because the server-rendered HTML did not match"))).toBe(
      "hydration",
    );
  });

  it("detecta códigos minificados de hydration do React em build de produção (issue #54)", () => {
    expect(
      classify(e("Uncaught Error: Minified React error #418; visit https://react.dev/errors/418")),
    ).toBe("hydration");
    expect(classify(e("Minified React error #423"))).toBe("hydration");
    expect(classify(e("Minified React error #425"))).toBe("hydration");
    // #310 (hooks) NÃO é hydration
    expect(classify(e("Minified React error #310"))).toBe("generic");
  });

  it("detecta CSP", () => {
    expect(
      classify(
        e(
          "Refused to load the script 'https://x' because it violates the following Content Security Policy",
        ),
      ),
    ).toBe("csp");
  });

  it("detecta 404", () => {
    expect(classify(e("Failed to load resource: the server responded with a status of 404"))).toBe(
      "not-found",
    );
  });

  it("detecta request-failed prefix", () => {
    expect(classify(e("[request-failed] https://x.com/foo — net::ERR_FAILED"))).toBe(
      "request-failed",
    );
  });

  it("classifica como generic se não reconhecer", () => {
    expect(classify(e("Some random log"))).toBe("generic");
  });
});

describe("diffConsole", () => {
  it("encontra erros novos em cand", () => {
    const d = diffConsole([e("error A")], [e("error A"), e("error B")]);
    expect(d.newInCand).toHaveLength(1);
    expect(d.newInCand[0]!.entry.text).toBe("error B");
  });

  it("dedup respeita números voláteis", () => {
    const d = diffConsole([], [e("Error at index 12345"), e("Error at index 67890")]);
    expect(d.newInCand).toHaveLength(1); // ambos viram "error at index <n>" após dedup
  });

  it("aplica ignorePatterns", () => {
    const d = diffConsole([], [e("ERR_BLOCKED_BY_CLIENT")], {
      ignorePatterns: ["ERR_BLOCKED_BY_CLIENT"],
    });
    expect(d.newInCand).toHaveLength(0);
  });

  it("anyFailed=true quando há novo erro em cand", () => {
    expect(diffConsole([], [e("new error")]).anyFailed).toBe(true);
    expect(diffConsole([e("same")], [e("same")]).anyFailed).toBe(false);
  });
});
