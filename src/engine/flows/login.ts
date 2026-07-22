import type { PageCapture, StepCapture } from "../../types/schema.ts";
import { capturePage } from "../collect.ts";
import type { FlowContext, FlowResult } from "./shared.ts";
import {
  findElement,
  firstVisibleLocator,
  makeSkipStep,
  screenshotPath,
  screenshotStable,
  selFor,
  withCap,
} from "./shared.ts";

/**
 * Login flow — gated. Only runs when:
 *  1. `ctx.rc.login?.enabled === true`
 *  2. env vars `PARITY_LOGIN_EMAIL` AND `PARITY_LOGIN_PASSWORD` are set.
 *
 * If either condition is missing, the flow returns a homepage capture and
 * all login steps marked `skipped` — so the check can distinguish "not
 * enabled" from "broken login".
 *
 * Credential handling: env vars only. NEVER read credentials from
 * `.parityrc.json` (which is committed to git). Passwords are not echoed
 * to logs, screenshots, or HTML capture — `fill()` masks the password
 * input by default, and we set `inputmask='password'` discipline by only
 * using the inputs we discovered.
 */
export async function flowLogin(ctx: FlowContext): Promise<FlowResult> {
  const pages: PageCapture[] = [];
  const steps: StepCapture[] = [];
  const total = 5;
  const reportStart = (idx: number, name: string) =>
    ctx.onStep?.({ phase: "start", name, index: idx, total });
  const reportEnd = (
    idx: number,
    name: string,
    status: StepCapture["status"],
    durationMs: number,
    note?: string,
  ) => ctx.onStep?.({ phase: "end", name, index: idx, total, status, durationMs, note });

  const enabled = ctx.rc.login?.enabled === true;
  const email = process.env.PARITY_LOGIN_EMAIL;
  const password = process.env.PARITY_LOGIN_PASSWORD;
  const credentialsPresent = !!email && !!password;
  const budget = { remaining: ctx.recoveryBudget ?? 3 };

  const page = await ctx.ctx.newPage();
  try {
    // Step 1: visit-home (always runs so we have a screenshot baseline)
    reportStart(1, "visit-home");
    const homeCap = await capturePage(page, {
      url: ctx.baseUrl,
      side: ctx.side,
      viewport: ctx.viewport,
      screenshotPath: screenshotPath(ctx, "login-1-home"),
    });
    pages.push(homeCap);
    const step1Status: StepCapture["status"] =
      homeCap.status >= 200 && homeCap.status < 400 ? "ok" : "failed";
    steps.push({
      step: 1,
      name: "visit-home",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step1Status,
      durationMs: homeCap.durationMs,
      url: homeCap.finalUrl,
      screenshotPath: homeCap.screenshotPath,
      actionDescription: `Navegou pra home \`${ctx.baseUrl}\``,
    });
    reportEnd(1, "visit-home", step1Status, homeCap.durationMs);

    if (!enabled || !credentialsPresent) {
      const reason = !enabled
        ? "login.enabled !== true in .parityrc.json"
        : "PARITY_LOGIN_EMAIL/PASSWORD not set";
      for (let i = 2; i <= 5; i++) {
        steps.push(
          makeSkipStep(
            i,
            ["open-login", "submit-invalid", "submit-valid", "verify-account-area"][i - 2]!,
            ctx,
            reason,
          ),
        );
      }
      return { pages, steps };
    }

    // Step 2: open-login — click trigger OR navigate to /login
    reportStart(2, "open-login");
    const t2 = Date.now();
    let emailHit = await findElement(page, ctx, {
      key: "loginEmailInput",
      intent:
        "Encontrar o <input> de email no formulário de login (NÃO confundir com input de newsletter ou cadastro).",
      budget,
      stepName: "login-email-input",
    });
    if (!emailHit) {
      const triggerHit = await findElement(page, ctx, {
        key: "loginTrigger",
        intent:
          "Encontrar o link/botão 'Entrar' / 'Login' / 'Minha conta' no header que abre o formulário de login.",
        budget,
        stepName: "login-trigger",
      });
      if (triggerHit) {
        await triggerHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(1_500);
        emailHit = await findElement(page, ctx, {
          key: "loginEmailInput",
          intent: "Após clicar em 'Entrar', encontrar o <input> de email no form de login.",
          budget,
          stepName: "login-email-after-trigger",
        });
      }
    }
    if (!emailHit) {
      // Last resort: navigate to /login
      await page
        .goto(new URL("/login", ctx.baseUrl).toString(), { timeout: 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1_000);
      emailHit = await findElement(page, ctx, {
        key: "loginEmailInput",
        intent: "Em /login, encontrar o <input> de email do formulário.",
        budget,
        stepName: "login-email-on-login-page",
      });
    }
    const passwordHit = emailHit
      ? await findElement(page, ctx, {
          key: "loginPasswordInput",
          intent: "Encontrar o <input> de senha (type='password') no formulário de login.",
          budget,
          stepName: "login-password-input",
        })
      : null;
    const formReady = !!(emailHit && passwordHit);
    steps.push({
      step: 2,
      name: "open-login",
      side: ctx.side,
      viewport: ctx.viewport,
      status: formReady ? "ok" : "failed",
      durationMs: Date.now() - t2,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "login-2-form"),
      selectorKey: "loginEmailInput",
      usedSelector: emailHit?.selector,
      actionDescription: formReady
        ? `Form de login carregado (\`${emailHit!.selector}\` + password)`
        : "Form de login não encontrado",
      loginValidation: { stage: "form-loaded" },
    });
    if (formReady) await screenshotStable(page, { path: screenshotPath(ctx, "login-2-form") });
    reportEnd(2, "open-login", formReady ? "ok" : "failed", Date.now() - t2);
    if (!formReady) {
      for (let i = 3; i <= 5; i++) {
        steps.push(
          makeSkipStep(
            i,
            ["submit-invalid", "submit-valid", "verify-account-area"][i - 3]!,
            ctx,
            "form-not-loaded",
          ),
        );
      }
      return { pages, steps };
    }

    // Step 3: submit-invalid — wrong credentials, expect error
    reportStart(3, "submit-invalid");
    const t3 = Date.now();
    await emailHit!.locator
      .fill(`invalid-${Date.now()}@parity-test.invalid`)
      .catch(() => undefined);
    await passwordHit!.locator.fill("wrong-password-on-purpose").catch(() => undefined);
    const submitHit = await findElement(page, ctx, {
      key: "loginSubmit",
      intent:
        "Encontrar o botão de submeter login ('Entrar', 'Login', 'Acessar') dentro do form de login.",
      budget,
      stepName: "login-submit",
    });
    if (submitHit) await submitHit.locator.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const errorHit = await findElement(page, ctx, {
      key: "loginErrorMessage",
      intent:
        "Encontrar a mensagem de erro mostrada após login falho — geralmente em [role='alert'] ou perto do form.",
      budget,
      stepName: "login-error-message",
    });
    const errorMsg = errorHit
      ? await withCap(
          errorHit.locator.innerText().catch(() => ""),
          1_500,
          "",
        )
      : "";
    const errorShown =
      !!errorHit || /invalid|inv[aá]lid|incorret|n[aã]o (existe|cadastrad)/i.test(errorMsg);
    steps.push({
      step: 3,
      name: "submit-invalid",
      side: ctx.side,
      viewport: ctx.viewport,
      status: errorShown ? "ok" : "failed",
      durationMs: Date.now() - t3,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "login-3-invalid"),
      actionDescription: errorShown
        ? `Erro de credencial inválida visível: "${errorMsg.slice(0, 80)}"`
        : "Submit de credencial inválida não mostrou erro",
      loginValidation: {
        stage: "error-shown",
        errorMessage: errorMsg.slice(0, 200) || undefined,
      },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "login-3-invalid") });
    reportEnd(3, "submit-invalid", errorShown ? "ok" : "failed", Date.now() - t3);

    // Step 4: submit-valid — real credentials, expect redirect to account area
    reportStart(4, "submit-valid");
    const t4 = Date.now();
    // Re-find inputs (form may have been re-rendered after error)
    const emailHit2 = await firstVisibleLocator(page, selFor(ctx, "loginEmailInput"));
    const passwordHit2 = await firstVisibleLocator(page, selFor(ctx, "loginPasswordInput"));
    if (emailHit2 && passwordHit2) {
      await emailHit2.locator.fill(email!).catch(() => undefined);
      await passwordHit2.locator.fill(password!).catch(() => undefined);
      const submitHit2 = await firstVisibleLocator(page, selFor(ctx, "loginSubmit"));
      if (submitHit2) {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => undefined),
          submitHit2.locator.click({ timeout: 5_000 }).catch(() => undefined),
        ]);
        await page.waitForTimeout(2_000);
      }
    }
    const accountMenuHit = await findElement(page, ctx, {
      key: "accountMenuTrigger",
      intent:
        "Após login bem-sucedido, encontrar o menu de conta logada no header (avatar, 'Olá <nome>', link 'Minha conta').",
      budget,
      stepName: "login-account-menu",
    });
    const loggedIn = !!accountMenuHit;
    steps.push({
      step: 4,
      name: "submit-valid",
      side: ctx.side,
      viewport: ctx.viewport,
      status: loggedIn ? "ok" : "failed",
      durationMs: Date.now() - t4,
      url: page.url(),
      screenshotPath: screenshotPath(ctx, "login-4-valid"),
      actionDescription: loggedIn
        ? `Login bem-sucedido — accountMenu visível (\`${accountMenuHit!.selector}\`)`
        : "Login com credenciais reais não logou — accountMenu não detectado",
      loginValidation: { stage: loggedIn ? "succeeded" : "submitted" },
    });
    await screenshotStable(page, { path: screenshotPath(ctx, "login-4-valid") });
    reportEnd(4, "submit-valid", loggedIn ? "ok" : "failed", Date.now() - t4);

    // Step 5: verify-account-area — navigate to /account and check page renders
    reportStart(5, "verify-account-area");
    const t5 = Date.now();
    const accountUrlCandidates = ["/account", "/minha-conta", "/account/orders"];
    let accountCap: PageCapture | null = null;
    for (const path of accountUrlCandidates) {
      const cap = await capturePage(page, {
        url: new URL(path, ctx.baseUrl).toString(),
        side: ctx.side,
        viewport: ctx.viewport,
        screenshotPath: screenshotPath(ctx, "login-5-account"),
      });
      if (cap.status >= 200 && cap.status < 400) {
        accountCap = cap;
        break;
      }
    }
    if (accountCap) pages.push(accountCap);
    const step5Status: StepCapture["status"] = accountCap ? "ok" : "failed";
    steps.push({
      step: 5,
      name: "verify-account-area",
      side: ctx.side,
      viewport: ctx.viewport,
      status: step5Status,
      durationMs: Date.now() - t5,
      url: accountCap?.finalUrl ?? page.url(),
      screenshotPath: accountCap?.screenshotPath ?? screenshotPath(ctx, "login-5-account"),
      actionDescription: accountCap
        ? `Área logada acessível em ${accountCap.finalUrl} (HTTP ${accountCap.status})`
        : "Nenhuma URL de account respondeu 2xx — sessão pode não ter persistido",
    });
    reportEnd(5, "verify-account-area", step5Status, Date.now() - t5);
  } finally {
    await page.close().catch(() => undefined);
  }

  return { pages, steps };
}
