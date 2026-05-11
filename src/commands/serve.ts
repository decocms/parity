import { existsSync } from "node:fs";
import chalk from "chalk";
import { type ServerHandle, startProxyServer } from "../server/proxy-server.ts";
import { getRunPaths } from "../storage/fs.ts";

export interface ServeOptions {
  output: string;
  port?: number;
  open?: boolean;
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

  let handle: ServerHandle;
  try {
    handle = await startProxyServer(paths.runDir, { port: opts.port });
  } catch (err) {
    console.error(chalk.red(`✖ Falha ao iniciar servidor: ${(err as Error).message}`));
    return 2;
  }

  console.log(chalk.bold(`\n  parity serve · ${runId}`));
  console.log(`  ${chalk.green("●")} ${handle.url}`);
  console.log(chalk.dim(`  Servindo: ${paths.runDir}`));
  console.log(chalk.dim(`  Proxy de iframes: ${handle.url}proxy?url=<encoded>`));
  console.log(chalk.dim("  Ctrl+C pra parar.\n"));

  if (opts.open !== false) {
    const { default: open } = await import("open");
    await open(handle.url).catch(() => undefined);
  }

  // Keep alive
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(chalk.dim("\n  parando servidor…"));
      await handle.close();
      resolve();
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
  });
  return 0;
}
