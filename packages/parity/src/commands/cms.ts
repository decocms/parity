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
  deleteEntry,
  duplicateEntry,
  getContentTypes,
  getLastVersion,
  listBranches,
  listEntries,
  renameEntry,
  undoEntry,
} from "../cms/client.ts";
import { localeSwitch, sectionsOf, summarizeSections, unwrapValue } from "../cms/authoring.ts";
import { describeSession, readVtexSession, sessionAdvice, sessionState } from "../cms/session.ts";
import { schemaDrift, unrenderableSections } from "../cms/schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Name the reason precisely instead of letting a 401 surface. Being logged out, holding a token
 * that expired overnight and being logged into the wrong account all fail the same way over HTTP,
 * and only one of them is what the user will guess.
 */
function config(): CmsConfig | null {
  const account = process.env.PARITY_CMS_ACCOUNT;
  const store = process.env.PARITY_CMS_STORE;
  if (!account || !store) {
    console.error(
      chalk.red("Missing target. Set PARITY_CMS_ACCOUNT and PARITY_CMS_STORE (the store id, not the account).")
    );
    return null;
  }
  const state = sessionState(account);
  if (state.status !== "ok" && state.status !== "env-token") {
    console.error(chalk.red(sessionAdvice(state, account)));
    return null;
  }
  const cfg = cmsConfigFromEnv();
  if (!cfg) {
    console.error(chalk.red("Could not read a VTEX token. Run `vtex login` or set PARITY_CMS_TOKEN."));
  }
  return cfg;
}

function fail(err: unknown): number {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  return 1;
}

/**
 * The commit author, which the API insists is an email address and rejects anything else for.
 *
 * Getting this wrong costs more than it should: a non-email author answers `400 VALIDATION_ERROR
 * "Invalid request data"`, naming no field, so it reads as a malformed `data` payload and sends you
 * auditing the content. Default to whoever is logged in, since that is who the commit is really by.
 */
function resolveAuthor(explicit: string | undefined): string | Error {
  const author = explicit ?? readVtexSession()?.login;
  if (!author) {
    return new Error("Could not tell who is committing. Pass --author <email>.");
  }
  if (!author.includes("@")) {
    return new Error(`--author must be an email address — "${author}" is rejected as invalid request data.`);
  }
  return author;
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
  const session = describeSession(sessionState(process.env.PARITY_CMS_ACCOUNT));
  try {
    const types = await getContentTypes(cfg, call);
    const drift = schemaDrift(types, opts.repo);
    if (opts.json) {
      console.log(JSON.stringify({ session, contentTypes: Object.keys(types), drift }, null, 2));
      return drift.some((d) => d.missingOnAccount.length > 0) ? 1 : 0;
    }
    if (session) console.log(`${chalk.green("✓")} ${session}`);
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
    if (version.inheritedFromMain) {
      console.log(chalk.dim("  (this branch has no changes to this entry yet — content read from main)"));
    }
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
  const author = resolveAuthor(opts.author);
  if (author instanceof Error) return fail(author);

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
        author,
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

/**
 * Whether an entry answers no route on `main` — the only kind `create` may copy.
 *
 * A duplicate inherits the source's versions and is born on `main` whatever branch the new content
 * is committed to. Copy a page with a slug and the live store gains a second entry answering that
 * slug, which this command cannot undo because its own commit lands on the branch. Copy one with
 * an empty slug and the copy is unreachable until the commit gives it its own.
 *
 * Sections deliberately do not count. The platform's own new-page template ships a placeholder
 * `BannerText` and `FastStore Starter` SEO, and the first commit overwrites all of it — what would
 * make a copy dangerous is a live route, not leftover content nobody can reach.
 */
async function hasNoRoute(cfg: CmsConfig, contentType: string, entryId: string, call: CmsCaller): Promise<boolean> {
  const version = await getLastVersion(cfg, { contentType, entryId, branchId: "main" }, call).catch(() => null);
  if (!version) return true;
  return !unwrapValue(version.data?.slug);
}

/**
 * Create a page — a route the storefront will resolve — and nothing else. The sections stay empty
 * on purpose: `create` makes the address, `pull`/`push` fills it, which keeps the reviewable diff
 * of the content separate from the irreversible act of adding a page.
 *
 * There is no create-entry endpoint on the Content Platform, so this duplicates an existing entry
 * of the same content type and then overwrites it. Two consequences worth knowing before reading
 * the code: the copy is born on `main` regardless of `--branch` (only its *content* is branched),
 * and the API answers the duplicate with an empty body, so the new id has to be found by diffing
 * the entry list. Anything that fails after the copy exists deletes it again.
 */
export async function cmsCreateCommand(
  opts: {
    contentType: string;
    slug: string;
    name?: string;
    branch?: string;
    from?: string;
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
  const branch = resolveBranch(opts.branch, Boolean(opts.allowMain));
  if (branch instanceof Error) return fail(branch);
  if (!opts.slug.startsWith("/")) {
    return fail(new Error(`Slug must start with "/" — got "${opts.slug}".`));
  }
  const author = resolveAuthor(opts.author);
  if (author instanceof Error) return fail(author);
  const name = opts.name ?? opts.slug;

  try {
    const types = await getContentTypes(cfg, call);
    const type = types[opts.contentType];
    if (!type) {
      return fail(
        new Error(`No content type "${opts.contentType}" on this store. Known: ${Object.keys(types).sort().join(", ")}.`)
      );
    }
    if (type.$singleton) {
      return fail(
        new Error(`"${opts.contentType}" is a singleton — its one entry already exists. Edit it with pull/push.`)
      );
    }

    const before = await listEntries(cfg, { contentType: opts.contentType }, call);
    if (before.some((e) => e.name === name)) {
      return fail(new Error(`An entry named "${name}" already exists. Pick another --name, or edit that one.`));
    }
    let template: string | null = null;
    if (opts.from) {
      if (!(await hasNoRoute(cfg, opts.contentType, opts.from, call))) {
        return fail(
          new Error(
            `--from ${opts.from} answers a slug on main. A copy inherits it, so this would put a second entry on the live store at that same route. Point --from at an entry with no slug.`
          )
        );
      }
      template = opts.from;
    } else {
      for (const entry of before) {
        if (await hasNoRoute(cfg, opts.contentType, entry.id, call)) {
          template = entry.id;
          break;
        }
      }
    }
    if (!template) {
      return fail(
        new Error(
          `No routeless "${opts.contentType}" entry to copy. The platform can only create by duplicating, and a copy inherits the source's slug on main — so copying a live page would put a second entry on that same route. Leave one entry of this type with an empty slug for this to copy from.`
        )
      );
    }

    if (!opts.yes) {
      console.log(chalk.yellow("dry run — nothing written. Pass --yes to create."));
      console.log(`  ${opts.contentType} ${chalk.bold(opts.slug)} named "${name}"`);
      console.log(chalk.dim(`  copies entry ${template} · content committed on ${branch}`));
      return 0;
    }

    await duplicateEntry(cfg, { entryId: template }, call);
    const after = await listEntries(cfg, { contentType: opts.contentType }, call);
    const known = new Set(before.map((e) => e.id));
    const created = after.filter((e) => !known.has(e.id));
    if (created.length !== 1) {
      return fail(
        new Error(
          `Duplicated ${template} but found ${created.length} new entries instead of 1 — refusing to guess which is mine. Check the Admin listing.`
        )
      );
    }
    const entryId = created[0]!.id;

    try {
      await renameEntry(cfg, { entryId, name }, call);
      // The copy inherits the template's versions, so its own head — not the template's — is the
      // baseHash. A template that never had a version leaves the copy at null, its first commit.
      const head = await getLastVersion(cfg, { contentType: opts.contentType, entryId, branchId: branch }, call)
        .then((v) => v.baseHash)
        .catch(() => null);
      const commit = await commitEntry(
        cfg,
        {
          branchId: branch,
          contentTypeId: opts.contentType,
          entryId,
          entryName: name,
          baseHash: head,
          data: {
            slug: localeSwitch(opts.slug),
            seo: { slug: localeSwitch(opts.slug), title: localeSwitch(name), description: localeSwitch("") },
            sections: { $fnType: "array", values: {} },
          },
          message: opts.message ?? `parity cms create ${opts.slug}`,
          author,
          identifierKeys: null,
          searchKeywords: null,
        },
        call
      );
      if (opts.json) {
        console.log(JSON.stringify({ entryId, slug: opts.slug, branch, commit }, null, 2));
        return 0;
      }
      console.log(`${chalk.green("✓")} ${opts.slug} — entry ${entryId}, commit ${commit.id} on ${branch}`);
      console.log(chalk.dim(`  fill it:  parity cms pull --entry ${entryId} --content-type ${opts.contentType} --branch ${branch}`));
      console.log(chalk.dim(`  undo it:  parity cms rm --entry ${entryId} --yes`));
      return 0;
    } catch (err) {
      // The copy is real content on main the moment it exists. Leaving a half-made page behind is
      // worse than failing, so unwind before reporting.
      await deleteEntry(cfg, { entryId }, call).catch(() => {});
      return fail(err);
    }
  } catch (err) {
    return fail(err);
  }
}

/** Deletes an entry outright — every version, every branch. `undo` is the reversible one. */
export async function cmsRmCommand(
  opts: { entry: string; yes?: boolean },
  call: CmsCaller = callCms
): Promise<number> {
  const cfg = config();
  if (!cfg) return 1;
  if (!opts.yes) {
    console.log(chalk.yellow(`dry run — would destroy ${opts.entry} on every branch. Pass --yes.`));
    return 0;
  }
  try {
    await deleteEntry(cfg, { entryId: opts.entry }, call);
    console.log(`${chalk.green("✓")} ${opts.entry} deleted`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}
