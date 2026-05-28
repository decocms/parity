import { describe, expect, it } from "vitest";
import { auditConsole } from "../../src/audit/console.ts";

describe("auditConsole", () => {
  it("hydration mismatch → critical", () => {
    const r = auditConsole("/::mobile", [
      {
        type: "error",
        text: "Hydration failed because the initial UI does not match what was rendered on the server.",
      },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]?.severity).toBe("critical");
    expect(r[0]?.summary).toMatch(/\[hydration\]/);
  });

  it("404 em first-party → high", () => {
    const r = auditConsole("/::mobile", [
      {
        type: "error",
        text: "Failed to load resource: the server responded with a status of 404 ()",
        location: "https://example.com/missing.js",
      },
    ]);
    expect(r[0]?.severity).toBe("high");
  });

  it("CSP violation → high", () => {
    const r = auditConsole("/::mobile", [
      {
        type: "error",
        text: "Refused to load the script 'https://x.com/y.js' because it violates the following Content Security Policy directive",
      },
    ]);
    expect(r[0]?.severity).toBe("high");
  });

  it("warnings → low", () => {
    const r = auditConsole("/::mobile", [
      { type: "warning", text: "deprecated API usage" },
    ]);
    expect(r[0]?.severity).toBe("low");
  });

  it("ignora log, info, debug (chatter de terceiros)", () => {
    const r = auditConsole("/::mobile", [
      { type: "log", text: "tracker initialized" },
      { type: "info", text: "[gtag] tag fired" },
      { type: "debug", text: "react devtools" },
    ]);
    expect(r).toHaveLength(0);
  });

  it("dedupliza repetições com mesma classificação + texto normalizado", () => {
    const r = auditConsole("/::mobile", [
      { type: "error", text: "Error 1234: connection lost" },
      { type: "error", text: "Error 5678: connection lost" },
      { type: "error", text: "Error 9999: connection lost" },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]?.summary).toMatch(/×3/);
  });

  it("entradas com classificações diferentes não são deduplicadas entre si", () => {
    const r = auditConsole("/::mobile", [
      { type: "error", text: "Hydration mismatch" },
      { type: "error", text: "Refused to load script CSP" },
    ]);
    expect(r).toHaveLength(2);
  });
});
