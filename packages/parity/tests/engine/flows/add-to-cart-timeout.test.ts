import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADD_TO_CART_CONFIRM_MS,
  resolveAddToCartConfirmMs,
} from "../../../src/engine/flows/purchase-journey.ts";
import { ParityRc } from "../../../src/types/schema.ts";

/**
 * Issue #143 — the add-to-cart confirmation deadline is now configurable via
 * `.parityrc.json` `addToCartConfirmMs` / `--add-to-cart-timeout <ms>`.
 */
describe("resolveAddToCartConfirmMs (#143)", () => {
  it("defaults to 3000ms when unset", () => {
    expect(DEFAULT_ADD_TO_CART_CONFIRM_MS).toBe(3000);
    expect(resolveAddToCartConfirmMs({})).toBe(3000);
    expect(resolveAddToCartConfirmMs({ addToCartConfirmMs: undefined })).toBe(3000);
  });

  it("honors a valid positive override", () => {
    expect(resolveAddToCartConfirmMs({ addToCartConfirmMs: 2000 })).toBe(2000);
    expect(resolveAddToCartConfirmMs({ addToCartConfirmMs: 8000 })).toBe(8000);
  });

  it("ignores bogus values (0, negative, NaN) — never exits the poll loop instantly", () => {
    expect(resolveAddToCartConfirmMs({ addToCartConfirmMs: 0 })).toBe(3000);
    expect(resolveAddToCartConfirmMs({ addToCartConfirmMs: -500 })).toBe(3000);
    expect(resolveAddToCartConfirmMs({ addToCartConfirmMs: Number.NaN })).toBe(3000);
  });

  it("ParityRc parses addToCartConfirmMs (rc key) and leaves it optional", () => {
    expect(ParityRc.parse({ addToCartConfirmMs: 2000 }).addToCartConfirmMs).toBe(2000);
    expect(ParityRc.parse({}).addToCartConfirmMs).toBeUndefined();
  });
});
