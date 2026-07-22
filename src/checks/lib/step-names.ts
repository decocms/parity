/**
 * Canonical step-name constants for the scripted flows.
 *
 * These were previously duplicated across `src/checks/purchase-journey-flow.ts`,
 * `src/commands/journey.ts` and `src/checks/cart-interactions-flow.ts` — any
 * rename of a step in `src/engine/flows/` had to be mirrored in three places.
 * Import from here instead so the values can never drift.
 */

/** Human (pt-BR) labels for the purchase-journey steps — used by the check. */
export const PJ_STEP_LABELS: Record<string, string> = {
  "visit-home": "Visitar home",
  "navigate-plp": "Navegar para categoria (PLP)",
  "enter-pdp": "Entrar em PDP",
  "select-variant": "Selecionar variante (tamanho/cor/quantidade)",
  "shipping-calc-pdp": "Cálculo de frete na PDP",
  "add-to-cart": "Adicionar ao carrinho",
  "open-minicart": "Abrir minicart",
  "shipping-calc-cart": "Cálculo de frete no carrinho",
  "go-checkout": "Ir para checkout",
};

/** Numbered labels for the purchase-journey steps — used by `parity journey` output. */
export const PJ_STEP_LABELS_NUMBERED: Record<string, string> = {
  "visit-home": "1. visit-home",
  "navigate-plp": "2. navigate-plp",
  "enter-pdp": "3. enter-pdp",
  "select-variant": "4. select-variant",
  "shipping-calc-pdp": "5. shipping-calc-pdp",
  "add-to-cart": "6. add-to-cart",
  "open-minicart": "7. open-minicart",
  "shipping-calc-cart": "8. shipping-calc-cart",
  "go-checkout": "9. go-checkout",
};

/** Purchase-journey steps whose failure is critical (vs. degraded UX). */
export const PJ_CRITICAL_STEPS = new Set([
  "visit-home",
  "navigate-plp",
  "enter-pdp",
  "add-to-cart",
  "open-minicart",
  "go-checkout",
]);

/** Human labels for the cart-interactions steps. */
export const CART_INTERACTIONS_STEP_LABELS: Record<string, string> = {
  "seed-cart": "Semear carrinho (add product)",
  "read-baseline": "Ler baseline (qty/price)",
  "increment-qty": "Incrementar quantidade",
  "decrement-qty": "Decrementar quantidade",
  "apply-invalid-coupon": "Aplicar cupom inválido",
  "remove-item": "Remover item",
  "verify-empty-state": "Verificar estado vazio",
};

/** Cart-interactions steps whose failure is critical. */
export const CART_INTERACTIONS_CRITICAL_STEPS = new Set(["seed-cart", "remove-item"]);
