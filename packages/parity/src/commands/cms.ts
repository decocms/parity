/**
 * `parity cms` — read and write VTEX Content Platform entries from the terminal, so migrating a
 * site's content stops being an afternoon in the Admin.
 *
 * Every write is a commit on a branch, carrying the `baseHash` the content was read at. That is
 * the platform's own model, and it is what makes this safe to automate: a concurrent edit makes
 * the commit fail instead of winning, `main` is never the default target, and `undo` is one call.
 *
 * The guardrails are here rather than in the caller on purpose. This command exists to be driven
 * by an agent, and an agent that has to remember to pass `--dry-run` will eventually not.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import {
  type CmsCaller,
  type CmsConfig,
  type CmsVersion,
  callCms,
  cmsConfigFromEnv,
  commitEntry,
  getContentTypes,
  getLastVersion,
  listBranches,
  listEntries,
  undoEntry,
} from "../cms/client.ts";
import { sectionsOf, summarizeSections } from "../cms/authoring.ts";
import { schemaDrift, unrenderableSections } from "../cms/schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function config(): CmsConfig | null {
  const cfg = cmsConfigFromEnv();
  if (!cfg) {
    console.error(
      chalk.red(
        "Missing CMS config. Set PARITY_CMS_ACCOUNT and PARITY_CMS_STORE, and run `vtex login <account>` " +
          "(or set PARITY_CMS_TOKEN)."
      )
    );
  }
  return cfg;
}

function fail(err: unknown): number {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  return 1;
}

/**
 * A branch name is not an address here: the Admin's own URLs redirect `/branches/test/...` to a
 * different branch entirely. Only ids address a branch, and `main` is the one name that resolves.
 */
function resolveBranch(branch: string | undefined, allowMain: boolean): string | Error {
  if (!branch) return new Error("--branch <id> is required. `parity cms ls --branches` lists them.");
  if (branch === "main") {
    return allowMain
      ? "main"
      : new Error("Refusing to write to main. Use a working branch, or pass --allow-main.");
  }
  if (!UUID.test(branch)) {
    return new Error(
      `"${branch}" is not a branch id. Branch names do not address a branch — pass the uuid from \`parity cms ls --branches\`.`
    );
  }
  return branch;
}

export async function cmsDoctorCommand(
  opts: { repo: string; json?: boolean },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  try {
    const types = await getContentTypes(cfg, call);
    const drift = schemaDrift(types, opts.repo);
    if (opts.json) {
      console.log(JSON.stringify({ contentTypes: Object.keys(types), drift }, null, 2));
      return drift.some((d) => d.missingOnAccount.length > 0) ? 1 : 0;
    }
    const blocking = drift.filter((d) => d.missingOnAccount.length > 0);
    if (blocking.length === 0) {
      console.log(`${chalk.green("✓")} every section the repo declares is published on the account`);
    }
    for (const d of blocking) {
      console.log(
        `${chalk.red("✗")} ${d.contentType}: ${d.missingOnAccount.join(", ")} ${chalk.dim(
          "— in the repo, not on the account. Upload the schema (`faststore cms-sync`) or it renders nothing."
        )}`
      );
    }
    for (const d of drift.filter((x) => x.missingInRepo.length > 0)) {
      console.log(
        `${chalk.gray("·")} ${d.contentType}: ${d.missingInRepo.length} section(s) published but not in the repo ${chalk.dim(
          "(usually core components the repo never overrode)"
        )}`
      );
    }
    return blocking.length > 0 ? 1 : 0;
  } catch (err) {
    return fail(err);
  }
}

export async function cmsLsCommand(
  opts: { contentType?: string; branches?: boolean; json?: boolean },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  try {
    if (opts.branches) {
      const branches = await listBranches(cfg, call);
      if (opts.json) console.log(JSON.stringify(branches, null, 2));
      else for (const b of branches) console.log(`${b.id}  ${b.name}`);
      return 0;
    }
    const entries = await listEntries(cfg, { contentType: opts.contentType }, call);
    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return 0;
    }
    for (const e of entries) {
      const slug = e.search_keywords?.find((k) => k.startsWith("/")) ?? "";
      console.log(`${e.id}  ${e.contentTypeId.padEnd(14)} ${slug.padEnd(34)} ${e.name}`);
    }
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/** The pulled file carries entryId, contentType, branch and baseHash, so `push` needs no flags. */
export async function cmsPullCommand(
  opts: { contentType: string; entry: string; branch: string; out?: string; json?: boolean },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  const branch = resolveBranch(opts.branch, true);
  if (branch instanceof Error) return fail(branch);
  try {
    const version = await getLastVersion(
      cfg,
      { contentType: opts.contentType, entryId: opts.entry, branchId: branch },
      call
    );
    const out = opts.out ?? join("parity-output", "cms", `${opts.contentType}-${opts.entry}.json`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(version, null, 2)}\n`);
    if (opts.json) {
      console.log(JSON.stringify({ out, sections: sectionsOf(version.data).length }, null, 2));
      return 0;
    }
    console.log(`${chalk.green("✓")} ${out}`);
    for (const line of summarizeSections(version.data)) console.log(`  ${line}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

function readPulled(file: string): CmsVersion | Error {
  if (!existsSync(file)) return new Error(`No such file: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CmsVersion;
  } catch (err) {
    return new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export async function cmsDiffCommand(
  opts: { file: string; branch?: string; json?: boolean },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  const local = readPulled(opts.file);
  if (local instanceof Error) return fail(local);
  try {
    const remote = await getLastVersion(
      cfg,
      {
        contentType: local.contentType,
        entryId: local.entryId,
        branchId: opts.branch ?? local.branchId,
      },
      call
    );
    const changed = JSON.stringify(local.data) !== JSON.stringify(remote.data);
    const stale = remote.baseHash !== local.baseHash;
    const result = {
      changed,
      stale,
      local: summarizeSections(local.data),
      remote: summarizeSections(remote.data),
    };
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return changed ? 1 : 0;
    }
    if (!changed) {
      console.log(`${chalk.green("✓")} no changes`);
      return 0;
    }
    console.log(chalk.yellow("remote → local (what push would write)"));
    const width = Math.max(result.local.length, result.remote.length);
    for (let i = 0; i < width; i += 1) {
      const l = result.local[i] ?? chalk.dim("—");
      const r = result.remote[i] ?? chalk.dim("—");
      console.log(`  ${l === r ? chalk.gray(l) : `${chalk.red(r)} → ${chalk.green(l)}`}`);
    }
    if (stale) {
      console.log(
        chalk.yellow(
          "! the remote moved since this was pulled — pull again before pushing, or the commit is rejected"
        )
      );
    }
    return 1;
  } catch (err) {
    return fail(err);
  }
}

export async function cmsPushCommand(
  opts: {
    file: string;
    branch?: string;
    message?: string;
    author?: string;
    yes?: boolean;
    allowMain?: boolean;
    json?: boolean;
  },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  const local = readPulled(opts.file);
  if (local instanceof Error) return fail(local);
  const branch = resolveBranch(opts.branch ?? local.branchId, Boolean(opts.allowMain));
  if (branch instanceof Error) return fail(branch);

  try {
    const types = await getContentTypes(cfg, call);
    const used = sectionsOf(local.data).map((s) => s.componentKey);
    const unrenderable = unrenderableSections(used, types[local.contentType]);
    if (unrenderable.length > 0) {
      return fail(
        new Error(
          `${unrenderable.join(", ")} not published on this account — the commit would succeed and render nothing. Upload the schema first (\`faststore cms-sync\`), or run \`parity cms doctor\`.`
        )
      );
    }

    const remote = await getLastVersion(
      cfg,
      { contentType: local.contentType, entryId: local.entryId, branchId: branch },
      call
    );
    if (remote.baseHash !== local.baseHash) {
      return fail(
        new Error(
          `Stale: pulled at ${local.baseHash.slice(0, 12)}, remote is at ${remote.baseHash.slice(0, 12)}. Pull again.`
        )
      );
    }

    if (!opts.yes) {
      console.log(chalk.yellow("dry run — nothing written. Pass --yes to commit."));
      for (const line of summarizeSections(local.data)) console.log(`  ${line}`);
      console.log(chalk.dim(`  branch ${branch} · entry ${local.entryId} · ${local.contentType}`));
      return 0;
    }

    const backup = join(
      "parity-output",
      "cms-backups",
      `${local.entryId}-${remote.baseHash.slice(0, 12)}.json`
    );
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, `${JSON.stringify(remote, null, 2)}\n`);

    const commit = await commitEntry(
      cfg,
      {
        branchId: branch,
        contentTypeId: local.contentType,
        entryId: local.entryId,
        entryName: local.entryName,
        baseHash: local.baseHash,
        data: local.data,
        message: opts.message ?? "parity cms push",
        author: opts.author ?? "parity",
        identifierKeys: local.identifierKeys,
        searchKeywords: local.searchKeywords,
      },
      call
    );
    if (opts.json) {
      console.log(JSON.stringify({ commit, backup }, null, 2));
      return 0;
    }
    console.log(`${chalk.green("✓")} commit ${commit.id} on ${branch}`);
    console.log(chalk.dim(`  rollback: parity cms undo --entry ${local.entryId} --branch ${branch}`));
    console.log(chalk.dim(`  backup:   ${backup}`));
    return 0;
  } catch (err) {
    return fail(err);
  }
}

export async function cmsUndoCommand(
  opts: { entry: string; branch?: string; yes?: boolean; allowMain?: boolean },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  const branch = resolveBranch(opts.branch, Boolean(opts.allowMain));
  if (branch instanceof Error) return fail(branch);
  if (!opts.yes) {
    console.log(chalk.yellow(`dry run — would drop ${opts.entry} changes on ${branch}. Pass --yes.`));
    return 0;
  }
  try {
    await undoEntry(cfg, { branchId: branch, entryId: opts.entry }, call);
    console.log(`${chalk.green("✓")} ${opts.entry} reverted on ${branch}`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}
