import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getPackageVersion } from "../../src/util/version.ts";

describe("getPackageVersion (issue #52: --version was hard-coded to '0.0.0')", () => {
  it("retorna a versão real do package.json (não '0.0.0')", () => {
    const pkgRaw = readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8");
    const expected = JSON.parse(pkgRaw).version as string;
    const got = getPackageVersion();
    expect(got).toBe(expected);
    expect(got).not.toBe("0.0.0");
  });

  it("retorna uma string no formato semver (X.Y.Z)", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it("nunca lança", () => {
    expect(() => getPackageVersion()).not.toThrow();
  });
});
