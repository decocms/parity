import { existsSync } from "node:fs";
import chalk from "chalk";
import { type ServerHandle, startProxyServer } from "../server/proxy-server.ts";
import { getRunPaths } from "../storage/fs.ts";

export interface ServeOptions {
  output: string;
  port?: number;
  open?: boolean;
}

export interface ServeRunOptions {
  port?: number;
  open?: boolean;
  label?: string;
}

/**
 * Start a local HTTP server serving a run directory (report.html + iframe proxy)
 * and block until SIGINT/SIGTERM. Used by both `parity serve` and `parity run --open`.
 */
export async function serveRunAndBlock(
  runDir: string,
  opts: ServeRunOptions = {},
): Promise<number> {
  let handle: ServerHandle;
  try {
    handle = await startProxyServer(runDir, { port: opts.port });
  } catch (err) {
    console.error(chalk.red(`  ✖ Falha ao iniciar servidor: ${(err as Error).message}`));
    return 2;
  }

  const label = opts.label ?? "parity serve";
  console.log("");
  console.log(chalk.bold(`  ${label}`));
  console.log(`  ${chalk.green("●")} ${handle.url}`);
  console.log(chalk.dim(`  Servindo: ${runDir}`));
  console.log(chalk.dim(`  Proxy de iframes: ${handle.url}proxy?url=<encoded>`));
  console.log(chalk.dim("  Ctrl+C pra parar (2x pra forçar saída).\n"));

  if (opts.open !== false) {
    const { default: open } = await import("open");
    await open(handle.url).catch(() => undefined);
  }

  // Keep alive; SIGINT/SIGTERM exit the process immediately.
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) {
      process.stderr.write("\n  forçando saída.\n");
      process.exit(130);
    }
    shuttingDown = true;
    process.stderr.write("\n  parando servidor…\n");
    handle.close().catch(() => undefined);
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await new Promise<never>(() => {
    /* never resolves */
  });
  return 0;
}

export async function serveCommand(runId: string, opts: ServeOptions): Promise<number> {
  const paths = getRunPaths(opts.output, runId);
  if (!existsSync(paths.runDir)) {
    console.error(chalk.red(`✖ Run não encontrado: ${runId} (em ${opts.output})`));
    return 1;
  }
  if (!existsSync(paths.reportHtml)) {
    console.error(chalk.red(`✖ report.html não existe em ${paths.runDir}`));
    return 1;
  }
  return serveRunAndBlock(paths.runDir, {
    port: opts.port,
    open: opts.open,
    label: `parity serve · ${runId}`,
  });
}
