/**
 * What the published schema allows, versus what the repo thinks it allows.
 *
 * A section only shows up in the Admin — and only renders — after its schema is uploaded. A repo
 * can be a release ahead: the component exists in code and in `cms/faststore/`, the account has
 * never seen it. Committing content that uses it then succeeds and renders nothing, which is the
 * worst failure mode available: silent.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CmsContentType } from "./client.ts";

/**
 * Component keys a content type accepts, read from the published schema. Deliberately regex-free:
 * the registry hands back real JSON.
 */
export function publishedComponentKeys(contentType: CmsContentType | undefined): string[] {
  const items = (contentType?.properties?.sections as Record<string, unknown> | undefined)?.items as
    | Record<string, unknown>
    | undefined;
  const anyOf = (items?.anyOf ?? []) as Record<string, unknown>[];
  return anyOf.map((s) => String(s.$componentKey ?? "")).filter(Boolean);
}

/**
 * The same list as the repo declares it, from `cms/faststore/pages/cms_content_type__*.jsonc`.
 *
 * Those files are JSONC with trailing commas, so they are scanned rather than parsed — pulling in
 * a JSON5 dependency to read one array of `$ref` strings is not worth it.
 */
export function localComponentKeys(repoDir: string, contentType: string): string[] | null {
  const dir = join(repoDir, "cms", "faststore", "pages");
  if (!existsSync(dir)) return null;
  const wanted = `cms_content_type__${contentType.toLowerCase()}.jsonc`;
  const file = readdirSync(dir).find((f) => f.toLowerCase() === wanted);
  if (!file) return null;
  const raw = readFileSync(join(dir, file), "utf8");
  // Scoped to the sections whitelist: the `$extends` at the top of the file also points at
  // `#/components/base-page-template`, which is inheritance, not a section anyone can add.
  const start = raw.indexOf('"sections"');
  if (start < 0) return [];
  return [...raw.slice(start).matchAll(/"#\/components\/([A-Za-z0-9_-]+)"/g)]
    .map((m) => m[1] ?? "")
    .filter(Boolean);
}

export interface SchemaDrift {
  contentType: string;
  missingOnAccount: string[];
  missingInRepo: string[];
}

/**
 * `missingOnAccount` is the one that bites: the repo ships a section the account cannot render.
 * `missingInRepo` is usually a core component the repo never overrode, so it is reported but not
 * treated as a failure.
 */
export function schemaDrift(
  published: Record<string, CmsContentType>,
  repoDir: string
): SchemaDrift[] {
  const drift: SchemaDrift[] = [];
  for (const [contentType, schema] of Object.entries(published)) {
    const local = localComponentKeys(repoDir, contentType);
    if (!local) continue;
    const remote = publishedComponentKeys(schema);
    const missingOnAccount = local.filter((k) => !remote.includes(k));
    const missingInRepo = remote.filter((k) => !local.includes(k));
    if (missingOnAccount.length > 0 || missingInRepo.length > 0) {
      drift.push({ contentType, missingOnAccount, missingInRepo });
    }
  }
  return drift;
}

/** Component keys used by an entry that the account would not render. */
export function unrenderableSections(
  usedKeys: string[],
  contentType: CmsContentType | undefined
): string[] {
  const allowed = publishedComponentKeys(contentType);
  if (allowed.length === 0) return [];
  return [...new Set(usedKeys.filter((k) => !allowed.includes(k)))];
}
