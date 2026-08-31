# `parity cms`

Read and write VTEX Content Platform entries from the terminal — the CMS behind FastStore v4.

A migration used to end here: the code ships, and someone retypes the merchant's pages into the
Admin. `parity cms` closes that last mile, and it does it on the platform's own safety model
rather than a bespoke one.

## Setup

```bash
vtex login <account>          # the toolbelt session is the credential
export PARITY_CMS_ACCOUNT=electroluxecfaststore
export PARITY_CMS_STORE=electrolux        # the store id, NOT the account
```

The token is read from `~/.config/configstore/vtex.json`. `PARITY_CMS_TOKEN` overrides it for CI.

### When it is not logged in

The toolbelt token **expires in about a day**, and being logged into the *wrong account* answers
401 exactly like an expired one. Every command tells you which of those it is before making a
request, because a raw 401 sends people looking in the wrong place:

```
$ parity cms ls --branches
Not logged into VTEX.
  vtex login electroluxecfaststore
  (opens a browser for SSO — a human has to complete it)
```

```
Logged into "acme", but this run targets "electroluxecfaststore". Wrong-account requests answer
401, which looks like a broken token.
  vtex login electroluxecfaststore
```

If the toolbelt itself is missing, it says so and gives both commands (`npm i -g vtex`, then
`vtex login`). **An agent cannot resolve any of this on its own** — `vtex login` opens a browser
for SSO. Surface the message and let the human run it.

`parity cms doctor` prints who you are and how long the session has left:

```
✓ jonas.jesus@electrolux.com on electroluxecfaststore · expires in 23h
```

## The model: content is git

Saving is a **commit on a branch**, carrying the `baseHash` the content was read at:

```
POST .../branches/<branchId>/commits   { data, baseHash, entryId, contentTypeId, ... }
```

That single fact is what makes automating this safe. A concurrent edit makes the commit fail
instead of winning. `main` is never the default. Rollback is one call. The same endpoint creates
and updates, so a brand-new route is a commit with an entry id nobody has used yet.

## Commands

| Command | What it does |
|---|---|
| `parity cms doctor` | Sections the repo declares vs. sections published on the account |
| `parity cms ls` | Entries, or branches with `--branches` |
| `parity cms pull` | One entry to a local JSON file |
| `parity cms diff` | A pulled file against the branch it came from |
| `parity cms push` | Commit it back — dry run unless `--yes` |
| `parity cms undo` | Drop an entry's changes on a branch |

### `doctor` — run this first

A section only renders after its schema is uploaded. A repo can be a release ahead: the component
exists in code, the account has never seen it. Committing content that uses it **succeeds and
renders nothing** — the worst failure available, because it is silent.

```
$ parity cms doctor --repo ../electrolux-poc
✗ landingPage: RichText — in the repo, not on the account. Upload the schema (`faststore cms-sync`) or it renders nothing.
```

Exits 1 when the repo is ahead. `push` runs the same check and refuses.

### A full round trip

```bash
parity cms ls --branches
# 4e3779e5-4065-423d-939f-aaa8675e83cb  test

parity cms pull --content-type home --entry 50434e7b-… --branch 4e3779e5-… --out home.json
# ✓ home.json
#   HeroSwiper (slides=12)
#   CategoryBlocks (categories=8)
#   …

# edit home.json, then:
parity cms diff --file home.json
# remote → local (what push would write)
#   HeroSwiper (slides=12) → HeroSwiper (slides=13)

parity cms push --file home.json            # dry run
parity cms push --file home.json --yes      # commits
parity cms undo --entry 50434e7b-… --branch 4e3779e5-… --yes   # if it went wrong
```

The pulled file carries `entryId`, `contentType`, `branchId` and `baseHash`, so `push` and `diff`
need no flags beyond the file.

## Guardrails

They live in the command, not in the caller. This is meant to be driven by an agent, and an agent
that has to remember `--dry-run` eventually will not.

1. **Dry run by default.** Writes only with `--yes`.
2. **`main` refused** without `--allow-main`.
3. **Branch names are refused.** Only ids address a branch — see below.
4. **Stale `baseHash` refused.** Pull again rather than clobber someone's edit.
5. **Unpublished sections refused**, with the `doctor` message.
6. **The remote is backed up** to `parity-output/cms-backups/<entryId>-<hash>.json` before writing.

## Three things that cost real time to find out

**`commitType` is only for restores.** Sending `"update"` on a normal save answers **500** from the
`INSERT` into the `commits` table — it looks like an outage and is a bad request. The client never
sends the field.

**A branch name is not an address.** The Admin's own URL `/branches/test/...` redirects to a
*different* branch. Only uuids resolve; `main` is the one name that works. `push` refuses anything
else rather than write somewhere surprising.

**The authoring shape is not the delivery shape.** `/data/...` (what the storefront reads) hands out
flat arrays and plain values. Authoring wraps collections as `{ $fnType, values: { "<id>": … } }`
and every leaf as a per-locale switch:

```json
{ "$fnType": "switch", "varyByKeys": ["locale"], "cases": null,
  "defaultCase": "https://…png", "configurationSourceType": "contexts" }
```

Pulling from delivery and committing that back does not work. `pull` always speaks authoring.

## Driving it from a migration

The orchestrator does not run these commands — it dispatches `cms-writer`, one entry per call.
That keeps the CMS procedure out of the main skill's context, and it puts the stop conditions
(login, stale hash, unpublished section) in an agent whose whole job is to report them rather than
work around them. See `agents/cms-writer.md`.

## Creating a page

```bash
parity cms create --content-type landingPage --slug /cuida/preguntas-frecuentes \
  --name "Preguntas Frecuentes" --branch <id> --yes
```

That makes the route and nothing else — no sections. `pull` then finds it and the normal edit loop
applies. The split is deliberate: adding a page to a live store is irreversible in a way that
editing one is not, so it is its own command with its own dry run.

### Why it works by copying

**The Content Platform has no create-entry endpoint.** Duplicating an existing entry is the only
call that brings one into existence, and the Admin's own create screen is a Next.js form that
crashes before it can save (`React #185`, a render loop) — so this is not a workaround for a broken
UI, it is the entire API. The probes that look like they should work all answer `400 Missing account
name in URL parameters`, which on this API is a routing miss dressed as a bad request:

```
POST …/entries              POST …/{contentType}/entries              PUT …/entries/{id}
```

What does exist:

```
POST   …/{account}/{store}/entries/{id}/duplicate   → 200, empty body, copy named "<source> - Copy"
PUT    …/{account}/{store}/entries/{id}/rename      → the Admin listing name
DELETE …/{account}/{store}/entries/{id}             → destroys it, every version, every branch
```

Three consequences the command has to absorb, and you should know about:

- **The copy is born on `main`**, whatever `--branch` says. Only its *content* is branched. There is
  no branch in the duplicate URL and no header carrying one.
- **The duplicate answers with an empty body**, so the new id is found by diffing the entry list
  before and after. If that diff is not exactly one new entry the command stops rather than guess.
- **It will only copy an entry with no slug.** A copy inherits the source's slug on `main`, so
  duplicating a live page would put a second entry on that same route — and `create` cannot undo
  that, because its own commit lands on the branch. Leave one routeless entry of each type around
  for this to copy from; the platform's default new-page entry (`slug: ""`, a placeholder
  `BannerText`) is exactly that, and the first commit overwrites its content anyway.
- **A store with zero entries of the type cannot bootstrap one** — there is nothing to copy. That
  first entry has to come from somewhere else.

Anything that fails after the copy exists deletes it again, because a half-made page on `main` is
worse than a failed command.

## `author` has to be an email

The commit endpoint rejects any author that is not an email address, and it does so as
`400 VALIDATION_ERROR "Invalid request data"` — naming no field. That reads like a malformed `data`
payload and sends you auditing the content, which is why `push` and `create` default the author to
the logged-in VTEX user and refuse a non-email `--author` before going near the network.

## Not here on purpose

**Merging to `main`.** The API supports it; this CLI does not expose it. Promoting content to the
live site stays a human action in the Admin, where the diff is reviewable by whoever owns the
content.

**Schema upload.** That is `faststore cms-sync`, which already exists and works.

**Media upload.** There is no API for the Media Gallery — seven endpoints were tried against a live
account with a valid token and all answered 400/404. Images go through the Admin, or stay on their
original CDN.
