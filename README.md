# fbcli

**A command-line client for your own Facebook account — authenticated with nothing but your browser session cookies.**

No Graph API app, no developer registration, no password stored in the tool. `fbcli` injects your cookies into a headless Chromium (via [Playwright](https://playwright.dev/)) and drives the **real Facebook web UI**, so it can read your feed, search, post to your timeline or a group, comment, react, and manage group membership — all from your terminal. It can even read the cookies straight out of your everyday browser (`--cookies brave`).

Written in TypeScript and run directly by [Bun](https://bun.com) — no build step, no transpile, no `node_modules` juggling beyond `bun install`. It depends on `playwright-core` and **downloads no browser of its own**: point it at a browser you already have (`--channel chrome`), one Playwright already cached, or one you install yourself.

It's also built for AI agents to drive: every command speaks JSON, `fbcli schema` describes the whole interface as data, failures come back as typed errors, write actions refuse to fire unattended without `--yes` — and the repo ships [agent instructions and skills](#for-ai-agents).

```console
$ fbcli whoami
Jane Doe  (uid 100000000000000)
https://www.facebook.com/profile.php?id=100000000000000

$ fbcli post "Posted straight from my terminal 🐧"
posted ✓
● you
  Posted straight from my terminal 🐧
  → https://www.facebook.com/100000000000000/posts/pfbid0XXXXXXXXXXXX...
```

---

## Table of contents

- [Why a browser instead of the API](#why-a-browser-instead-of-the-api)
- [Install](#install)
- [Getting your cookies](#getting-your-cookies)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [Global flags](#global-flags)
- [How it works](#how-it-works)
- [Using it as a library](#using-it-as-a-library)
- [For AI agents](#for-ai-agents)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Legal & safety](#legal--safety)
- [Project layout](#project-layout)

---

## Why a browser instead of the API

Facebook has **retired every no-JavaScript HTML interface**:

- `mbasic.facebook.com` — gone (serves *"Facebook is not available on this browser"*).
- `m.facebook.com` / `www.facebook.com` — render the feed, search, and composer entirely through **client-side GraphQL** calls whose `doc_id` values Facebook rotates every few days.

A plain `fetch` + HTML-scraper can't drive that and breaks constantly. A real
browser runs Facebook's own JavaScript, so it keeps working across redesigns.
`fbcli` therefore automates a headless Chromium with your cookies loaded, and
targets the UI through **stable ARIA roles** (`article`, `dialog`, `textbox`,
`button`) rather than Facebook's obfuscated CSS classes.

---

## Install

Requires **[Bun](https://bun.com) 1.1+**. (Install it with `curl -fsSL https://bun.com/install | bash`.)

```bash
git clone https://github.com/0xEnc0der/fbcli.git
cd fbcli

bun install    # installs playwright-core only — no ~150 MB browser download
```

`fbcli` needs *a* Chromium-family browser to drive, but it won't fetch one for
you. Pick whichever you already have:

```bash
fbcli --channel chrome whoami          # use installed Google Chrome
fbcli --channel msedge whoami          # use installed Microsoft Edge
fbcli --browser-path /path/to/chromium whoami
export FBCLI_BROWSER=/path/to/chromium # same, as an env default
```

If you'd rather have a dedicated managed Chromium (and have Playwright
installed), download one once — it lands in the shared cache fbcli also reads:

```bash
bunx playwright install chromium
```

Optional — put the `fbcli` command on your PATH:

```bash
bun link
```

Without `bun link` you run it as `bun run fbcli.ts <command>`.

> **WSL / headless Linux:** Chromium runs with `--no-sandbox --disable-dev-shm-usage`
> automatically. If launch fails, install system libs with
> `sudo bunx playwright install-deps chromium`.

---

## Getting your cookies

`fbcli` needs the cookies from a browser where you are already logged in.

### Easiest: read them straight from your browser

If you're logged into Facebook in Brave, Chrome, Chromium, Edge, or Arc, pass
the **browser's name** as the cookie source and fbcli decrypts its cookie store
for you:

```bash
fbcli --cookies brave whoami
fbcli --cookies chrome feed
fbcli --cookies "chrome:Profile 1" whoami   # a non-default profile
```

- **macOS** shows a one-time Keychain prompt the first time (the OS asking
  whether this tool may read the browser's secrets — say yes). Supported.
- **Linux** works only for "basic" (non-keyring) cookie storage; a
  gnome-keyring/kwallet profile needs the manual export below.
- **Windows** is **not** supported here (App-Bound Encryption blocks it) — use
  the manual export below.

> This decrypts your live Facebook session. Treat the convenience like the
> password it effectively is, and only use it on a machine you trust.

### Manual export (works everywhere)

1. Log into Facebook in your normal browser.
2. Export cookies with a browser extension:
   - **Cookie-Editor** → *Export → JSON* (recommended), or
   - **Get cookies.txt LOCALLY** → Netscape `cookies.txt` format.
3. Save the export to a file, e.g. `cookies.json`.

You strictly need only **`c_user`** and **`xs`**. Including `datr`, `sb`, and
`fr` reduces the chance of triggering a security checkpoint.

Point the tool at the file per-command with `--cookies`, or set it once:

```bash
export FBCLI_COOKIES=./cookies.json
```

### Accepted cookie formats (auto-detected)

| Format | Example |
|---|---|
| Extension JSON array | `[{"name":"c_user","value":"100…","domain":".facebook.com"}, …]` |
| Simple JSON object | `{"c_user":"100…","xs":"…"}` |
| Netscape `cookies.txt` | the tab-separated format from curl/wget/yt-dlp |
| Raw header string | `"c_user=100…; xs=…; datr=…"` |
| Browser name | `brave`, `chrome`, `chromium`, `edge`, `arc` (optionally `chrome:Profile 1`) |

> 🔒 **Cookies are live session credentials.** `chmod 600` the file, never commit
> it (this repo's `.gitignore` already excludes `*.env`, `cookies*.json`, etc.),
> and revoke a leaked session via *Settings → Security → Where you're logged in*.

---

## Quick start

```bash
export FBCLI_COOKIES=./cookies.json

fbcli whoami                                   # confirm you're logged in
fbcli feed --limit 15                          # read your news feed
fbcli search "trail running kenya" --kind pages
fbcli post "Hello from my terminal 🐧"          # prints the new post's URL
fbcli read "<post_url>"                         # read a post + its comments
fbcli notifications
```

---

## Command reference

**Every** command accepts `--json`: reads print their data, writes print
`{"ok":true,"action","result"}`, and failures print
`{"ok":false,"error":{"kind","message"}}` on stderr. `fbcli schema` prints the
whole surface as JSON — see [For AI agents](#for-ai-agents).

### Identity

#### `whoami`
Show the logged-in account's name, uid, and profile URL.
```bash
fbcli whoami
```

### Reading

#### `feed [--limit N]`
Read your news feed (default 10 items).
```bash
fbcli feed --limit 20
fbcli feed --json | jq '.[].permalink'
```

#### `timeline [target] [--limit N]`
Read a profile timeline. `target` is `me` (default), a numeric uid, or a username.
```bash
fbcli timeline me
fbcli timeline zuck --limit 5
fbcli timeline 4 --limit 5
```

#### `read <url>`
Read a single post with its comments. Accepts any post permalink.
```bash
fbcli read "https://www.facebook.com/<uid>/posts/<pfbid>"
```

#### `search <query> --kind <kind> [--limit N]`
Search Facebook. `--kind` is one of `top` (default), `posts`, `people`, `pages`, `groups`.
```bash
fbcli search "climbing gym" --kind pages
fbcli search "nairobi tech" --kind groups --limit 10
```

#### `group <id|url> [--limit N] [--sort new|activity]`
Read a group's feed, newest post first. `--sort activity` asks for Facebook's
own order instead, where a post resurfaces whenever somebody replies to it.
```bash
fbcli group 123456789012345 --limit 15
fbcli group my-group-slug --sort activity
```

#### `schema`
Print the entire command surface as JSON — every command, flag, default,
choice, output shape, exit code and environment variable. Needs no cookies and
launches no browser, so it's the cheapest way for a script or an agent to
discover the CLI.
```bash
fbcli schema | jq '.commands[] | {name, mutates, output}'
```

#### `notifications [--limit N]`
List recent notifications with their links.
```bash
fbcli notifications --limit 20
```

### Writing

#### `post "<text>" [--group <id|url>] [--audience public|friends|only_me]`
Publish a text status to your timeline, or into a group with `--group`.
**Returns the permalink of the new post** (captured from Facebook's own
create-post response — see [How it works](#how-it-works)).
```bash
fbcli post "Just shipped a new feature 🚀"
fbcli post "Hi group 👋" --group 123456789012345
fbcli post "friends only" --audience friends    # refuse to publish if wider
```
> If the group requires admin approval, the post is submitted to the pending
> queue (it won't appear to members until an admin approves it).

> **`--audience` is a safety check, not a setter.** The composer inherits
> whatever audience you last used (which might be *Public*). With `--audience`,
> fbcli reads the composer's current audience and **refuses to publish** unless
> it matches — failing closed if it can't read it. It never *changes* the
> audience for you; set that in Facebook, then post. (Timeline posts only — a
> group post's audience is the group.)

#### `comment <url> "<text>"`
Comment on a post.
```bash
fbcli comment "<post_url>" "great write-up!"
```

#### `react <url> [--reaction <name>]`
React to a post. `--reaction` is one of `like` (default), `love`, `care`, `haha`, `wow`, `sad`, `angry`.
```bash
fbcli react "<post_url>" --reaction love
```

#### `dm <recipient> "<text>"`
Send a direct message. `recipient` is a uid or username.
```bash
fbcli dm 100000000000000 "hey, are we still on for tomorrow?"
```

### Groups

#### `creategroup "<name>" [--privacy private|public]`
Create a group and print its id + URL. Handy as a private sandbox to test
posting without touching a public community.
```bash
fbcli creategroup "my sandbox" --privacy private
```

#### `join <id|url>` / `leave <id|url>`
Join or leave a group. For approval-required groups, `join` sends a request.
```bash
fbcli join 123456789012345
fbcli leave 123456789012345
```

### Write-action safety

Write actions — `post`, `comment`, `react`, `dm`, `creategroup` — are public and
often irreversible, and a typo publishes it. Two guards stand in front of them:

- **`--dry-run`** prints what *would* happen and exits without launching a
  browser or sending anything:
  ```bash
  $ fbcli post "wait, is this the right account?" --dry-run
  [dry-run] would publish a post to your timeline — nothing sent.
  ```
- **Confirmation.** On an interactive terminal you're asked `Continue? [y/N]`.
  In a script (no TTY) the action **refuses to run** unless you pass `--yes`, so
  a stray `fbcli post …` in a pipeline can't publish silently.
  ```bash
  fbcli dm 100000000000000 "on my way" --yes   # no prompt, send it
  ```

---

## Global flags

| Flag | Description |
|---|---|
| `--cookies <file\|string\|browser>` | Cookie source: a file, a `c_user=…; xs=…` string, or a browser name (or set `FBCLI_COOKIES`) |
| `--channel <name>` | Launch a system browser by channel — `chrome`, `msedge`, … (or `FBCLI_BROWSER_CHANNEL`) |
| `--browser-path <path>` | Launch a specific browser binary (or `FBCLI_BROWSER`) |
| `--dry-run` | Write actions: show what would happen, then exit without doing it |
| `-y`, `--yes` | Skip the confirmation prompt for write actions |
| `--headed` | Show the browser window — invaluable for debugging selectors |
| `--slow <ms>` | Add `slowMo` delay between UI actions |
| `--json` | Machine-readable JSON output (every command; errors go to stderr as JSON) |
| `--verbose` | Log each navigation |
| `--version` | Print version |

### Choosing which browser to drive

In precedence order: `--browser-path` / `FBCLI_BROWSER` → `--channel` /
`FBCLI_BROWSER_CHANNEL` → a Chromium in Playwright's shared cache. If none
resolve, fbcli prints exactly how to point it at a browser instead of a stack
trace.

### Overriding selectors without editing code

Facebook's DOM shifts. Every selector fbcli relies on lives in one registry
(`src/selectors.ts`); override just the ones that broke via a JSON file, no code
change or release needed:

```bash
echo '{ "article": "div[data-newhook]", "postButton": "^Publish$" }' > sel.json
FBCLI_SELECTORS=./sel.json fbcli feed
```

CSS entries are query strings; name entries (`postButton`, `likeButton`, …) are
case-insensitive regex sources matched against accessible names.

---

## How it works

1. **Cookie injection.** Your cookies are normalized (any of the formats above,
   or decrypted from your browser) and loaded into a fresh Playwright context.
2. **Login guard.** Every navigation checks for a redirect to `/login`,
   `/checkpoint`, two-factor, or recovery and fails fast with a clear message if
   your session is stale. Expired `c_user`/`xs` are also warned about up front.
3. **Semantic selectors.** Reads and writes target ARIA roles and accessible
   names, which survive Facebook's frequent CSS churn far better than class
   names — and all of them live in one overridable registry (`src/selectors.ts`,
   see [`FBCLI_SELECTORS`](#overriding-selectors-without-editing-code)).
4. **Feed-column reads.** Group feeds don't tag their story cards with
   `role="article"` — only the comment previews inside them are tagged — and a
   card stays unpainted until it scrolls into view. So `fbcli group` walks the
   `role="feed"` column's own children, brings each card into view, and takes
   the longest `dir="auto"` block outside any comment preview as the body,
   skipping Facebook's hidden decoy text. Older layouts fall back to articles.
5. **Real permalinks.** Facebook's on-page timestamp links are JS-obfuscated, so
   after you publish, `fbcli` listens to the create-post GraphQL response and
   parses the new story's `pfbid`, returning the canonical
   `https://www.facebook.com/<uid|groups/gid>/posts/<pfbid>` URL.

---

## Using it as a library

Every command is a plain async function over an open `Browser`, so you can
script flows Bun-side instead of shelling out:

```ts
import { Browser, webActions as fb } from "fbcli";

const b = await Browser.start(process.env.FBCLI_COOKIES!, { verbose: true });
try {
  console.log(await fb.whoami(b));
  for (const post of await fb.feed(b, 5)) console.log(post.brief());
  const published = await fb.postStatus(b, "hello from a script");
  await fb.comment(b, published.permalink, "…and a comment");
} finally {
  await b.close();
}
```

`Browser` also implements `Symbol.asyncDispose`, so with explicit resource
management you can drop the `try`/`finally`:

```ts
await using b = await Browser.start(process.env.FBCLI_COOKIES!);
console.log(await fb.whoami(b));
```

---

## For AI agents

fbcli is built to be driven by an agent as well as a human, and the repo ships
the instructions for both jobs:

- **[AGENTS.md](AGENTS.md)** — the house rules, read by Codex, Claude Code (via
  [CLAUDE.md](CLAUDE.md)), and anything else that looks for them.
- **[`.agents/skills/fbcli/`](.agents/skills/fbcli/SKILL.md)** — using fbcli on
  an account: the safety gate, the JSON contract, and
  [recipes](.agents/skills/fbcli/references/recipes.md) (feed triage, group
  monitoring with dedupe, multi-step library sessions).
- **[`.agents/skills/fbcli-dev/`](.agents/skills/fbcli-dev/SKILL.md)** —
  changing fbcli itself: the test loop, the four touchpoints a new command
  needs, and the
  [selector-drift procedure](.agents/skills/fbcli-dev/references/selector-drift.md).

Both skills follow the [Agent Skills](https://agentskills.io) format and sit in
`.agents/skills/`, the location Codex, Cursor, Copilot/VS Code and Gemini CLI
scan; `.claude/skills/` holds symlinks to them for Claude Code. Any other
agent: hand it `.agents/skills/<name>/SKILL.md` directly — it's plain Markdown.

**A self-describing interface.** `fbcli schema` reports the command surface as
data, so nothing has to parse `--help` prose or hardcode flags:

```console
$ fbcli schema | jq '.commands[] | select(.mutates) | .name'
"post"
"creategroup"
"comment"
"react"
"dm"
```

**A predictable contract.**

| Exit | Meaning | Where |
|---|---|---|
| `0` | success | data on stdout (JSON with `--json`) |
| `1` | runtime error | `{"ok":false,"error":{"kind","message"}}` on stderr |
| `2` | usage error | argparse-style message on stderr |
| `130` | interrupted | — |

`error.kind` is one of `cookies` (no cookie source), `auth` (session stale or
checkpointed — only a human can fix it), `confirmation_required` (a write
action without `--yes`), or `facebook` (the UI didn't behave — often selector
drift). Branching on `kind` beats matching English.

**Guard rails that assume an unattended caller.** Write actions refuse to run
without a TTY unless `--yes` is passed, and `--dry-run` (which also honours
`--json`) previews the exact action without launching a browser:

```console
$ fbcli post "ship it" --dry-run --json
{
  "dryRun": true,
  "action": "post",
  "description": "publish a post to your timeline",
  "sent": false
}
```

So the expected agent sequence for anything public is: `--dry-run`, show the
user the text, then `--yes`.

---

## Development

```bash
bun run typecheck      # tsc --noEmit
bun run test           # everything (~5 min)
bun run test:unit      # cookies, pure helpers, CLI surface (~1s)
bun run test:browser   # the Chromium integration suites, one file per process
bun test test/cookies.test.ts
```

The integration suites (`test/read-actions.test.ts`, `test/write-actions.test.ts`,
`test/find-students.test.ts`) drive a real Chromium against
`test/fake-facebook.ts` — a request-intercepting stand-in for facebook.com — so
every selector and UI flow is exercised without an account or a network call.

They inherit the production code's deliberate patience (it waits on Facebook's
async hydration), so they are slow — a few minutes in total.

**Run the browser suites one file at a time.** Each file passes reliably on its
own, but `bun test` loads all of them into a single Bun process, and after
roughly forty Chromium launches in one process Playwright protocol calls start
stalling indefinitely — a test whose worst case is fifteen seconds will sit
there until the per-test timeout fires. This is a Bun/Playwright interaction,
not a defect in the code under test: the same tests pass every time when the
file runs in a fresh process.

That is what `bun run test:browser` does, and why `bun run test` is the
supported entry point rather than a bare `bun test`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `auth error: … redirected to login/checkpoint` | Cookies expired or a security check is pending — re-export fresh cookies from a logged-in browser. |
| `Missing essential cookie(s): c_user, xs` | Your export didn't include the session cookies. Re-export and make sure you're logged in. |
| A read command returns `(nothing to show)` | Could be genuinely empty (e.g. a new account with no friends), or a selector drifted — run with `--headed` to watch. |
| `Could not open the post composer` | Facebook changed the composer; run `--headed --slow 300` to observe, then override via `FBCLI_SELECTORS` or edit `src/selectors.ts`. |
| `No browser found to drive Facebook` | Pass `--channel chrome` (or `--browser-path`), set `FBCLI_BROWSER`, or `bunx playwright install chromium`. |
| `Could not read "… Safe Storage" from the macOS Keychain` | Approve the Keychain prompt, or fall back to a file export with `--cookies <file>`. |
| Chromium won't launch (Linux) | `sudo bunx playwright install-deps chromium` |

Run any command with `--headed --verbose` to watch the browser and see each
navigation as it happens.

---

## FAQ

**Does this work on someone else's account?** No. It automates a session *you*
already own (your cookies). It is not a way into anyone else's account.

**Will it get my account banned?** It can. Automated access violates Facebook's
Terms of Service, and aggressive use can trigger a checkpoint or temporary lock.
Keep actions at a human pace, use `--slow`, and run from your normal IP.

**Why is posting slower than a normal API call?** Because it drives a real
browser rendering the real UI. That's the price of not depending on rotating
private `doc_id`s.

**Can it upload photos / videos?** Not yet — this is a text-first client.
Contributions welcome.

**Does it run on Node instead of Bun?** The code is standard ESM TypeScript and
Playwright works on both, but the `.ts` entry points assume Bun's built-in
TypeScript loader. On Node you'd need a loader or a build step.

---

## Legal & safety

This project is for **personal automation of your own account**. By using it you
accept that:

- Automated/non-API access **violates Facebook's Terms of Service**. You are
  responsible for how you use it.
- Facebook may flag automation and present a checkpoint or lock the account.
- Cookies are credentials — protect the file and never share or commit it.

The software is provided **as-is**, without warranty (see [LICENSE](LICENSE)).

---

## Project layout

```
src/
  browser.ts          Playwright engine: cookie injection, browser resolution, login guard
  browser-cookies.ts  decrypt Facebook cookies from a local Chromium browser
  selectors.ts        the one overridable registry of every FB selector
  web-actions.ts      every command's UI flow (read + write)
  cli.ts              command surface, safety guards, output formatting
  argparse.ts         the small argparse-shaped parser the CLI is declared with
  index.ts            public exports
  version.ts          the version string the CLI reports
test/
  cookies.test.ts         all cookie formats
  browser-cookies.test.ts the decryption pipeline + browser-keyword detection
  selectors.test.ts       the registry and its FBCLI_SELECTORS overrides
  helpers.test.ts         pure helpers, checked against Python's reference output
  read-actions.test.ts    feed/timeline/search/notifications/read in real Chromium
  write-actions.test.ts   post/comment/react/join/leave/dm/creategroup + audience guard
  cli.test.ts             the command surface, dry-run/confirm, + the fbcli executable
  find-students.test.ts   the group post-id extractors
  fake-facebook.ts        the request-intercepting facebook.com stand-in
AGENTS.md           house rules for coding agents (CLAUDE.md points here)
.agents/skills/
  fbcli/            skill: using fbcli on an account, + recipes
  fbcli-dev/        skill: changing fbcli, + the selector-drift procedure
.claude/skills/     symlinks to the above, so Claude Code discovers them
fbcli.ts            standalone launcher — `bun run fbcli.ts ...`
fb-find-students.ts group post finder (extracts permalinks from page JSON)
package.json        deps (playwright-core) + the `fbcli` bin entry
tsconfig.json       strict TypeScript config
```

---

*Built as a personal-automation experiment. PRs that add media upload, event
handling, or Marketplace support are welcome.*
