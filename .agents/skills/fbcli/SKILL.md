---
name: fbcli
description: Use when a task needs Facebook from the terminal — reading a news feed, a profile timeline, a group feed, a single post with its comments, search results or notifications, or publishing a post, comment, reaction, DM or group action on the user's own account. Covers the JSON contract, the write-action safety gate, and cookie auth.
license: MIT
compatibility: Requires Bun 1.1+, a Chromium-family browser for Playwright to drive, the user's own Facebook session cookies, and network access to facebook.com
---

# Driving Facebook with fbcli

`fbcli` injects the user's own browser cookies into a headless Chromium and
drives the real Facebook web UI. There is no API key and no sandbox: a write
command posts publicly, under the user's name, usually irreversibly.

## Before anything else

```bash
bun run fbcli.ts whoami --json     # from the repo; `fbcli whoami --json` if installed
```

- Exit 0 → you have a live session; the JSON names the account you are about to
  act as. **Check it is the account the user meant.**
- `error.kind == "cookies"` → no cookie source. Ask the user to
  `export FBCLI_COOKIES=./cookies.json` (or `=brave` / `=chrome` to read their
  browser's own login). Don't invent a path, don't go hunting for cookie files
  on disk, and never print their contents.
- `error.kind == "auth"` → session expired or a checkpoint is pending. Only the
  user can fix it: they re-export cookies from a logged-in browser. Stop.

Discover the exact surface instead of guessing flags — it is machine-readable:

```bash
bun run fbcli.ts schema | jq '.commands[] | {name, mutates, output}'
```

## Rules for write commands

`post`, `comment`, `react`, `dm`, `creategroup` are the write commands
(`schema` marks them `mutates: true`).

1. **Only on an explicit request in the current task.** "Summarise my feed" is
   not permission to like or reply to anything.
2. **Preview, then confirm.** Run with `--dry-run`, show the user the exact text
   and target, and wait for a yes.
3. **Then `--yes`.** With no TTY the guard refuses without it — that is the
   point, not an obstacle to route around. Passing `--yes` on the first attempt,
   before showing the user the text, defeats the whole mechanism.
4. **Never loop a write over a list.** No batch DMs, no commenting on every
   search hit, no join-every-group. It is spam, it gets the account locked, and
   it was not what was asked.
5. `--audience public|friends|only_me` on a timeline post is a *check*, not a
   setter: fbcli refuses to publish unless the composer already matches. Use it
   when the user cares who sees it; tell them to change the default in Facebook
   itself if it refuses.
6. Reactions are toggles — running `react` twice un-reacts.

Reads (`whoami`, `feed`, `timeline`, `group`, `read`, `search`,
`notifications`, `schema`) need none of this. Run them freely.

## The JSON contract

Always pass `--json` when you are going to parse the output; the prose form is
for humans and may wrap or truncate.

| Command | stdout shape |
|---|---|
| `whoami` | `{uid, name, profile}` |
| `feed`, `timeline`, `group` | `[{author, text, permalink}]` |
| `search`, `notifications` | `[{text, url}]` |
| `read` | `{post: {author, text, permalink}, comments: ["…"]}` |
| `post` | `{author, text, permalink}` — the new post's permalink |
| `creategroup` | `{name, id, url}` |
| `join`, `leave`, `comment`, `react`, `dm` | `{ok: true, action, result}` |
| any write + `--dry-run` | `{dryRun: true, action, description, sent: false}` |

Failures put `{"ok": false, "error": {"kind", "message"}}` on **stderr** and
leave stdout empty:

| Exit | Meaning | What to do |
|---|---|---|
| 0 | success | parse stdout |
| 1 | `kind: cookies` | ask the user for a cookie source |
| 1 | `kind: auth` | session is stale — the user must re-export; stop |
| 1 | `kind: confirmation_required` | you skipped the preview; go back to the user |
| 1 | `kind: facebook` | selector drift, a missing button, a private target — read `message`, try `--headed` once if you're debugging, don't retry blindly |
| 2 | usage error (prose, never JSON) | fix the command; check `schema` |

An empty array from a read is a real answer ("nothing there"), but it is also
what selector drift looks like. If a feed that should have posts comes back
empty twice, say so rather than reporting "your feed is empty" as fact.

## Pace and etiquette

Automated access violates Facebook's ToS and aggressive use triggers
checkpoints. Keep it human: one page of results, not twenty; `--slow 300` when
a flow misbehaves; `--limit` as small as the task allows. Don't poll a feed in a
tight loop — minutes apart, not seconds. Each command launches a browser
(seconds), so for a multi-step flow use the library form in
[references/recipes.md](references/recipes.md) and keep one session open.

Decline, and say why, if asked to: operate an account whose cookies aren't the
user's, scrape at volume, mass-message or mass-comment, or build engagement
automation. This tool is for the user's own account, at human scale.

## Recipes

[references/recipes.md](references/recipes.md) has copy-paste jq pipelines
(feed triage, group monitoring with dedupe, reply-to-a-post flow), the library
API for multi-step sessions, and the browser/cookie flags for odd setups.
