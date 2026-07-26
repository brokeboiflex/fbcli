# fbcli

**A command-line client for your own Facebook account — authenticated with nothing but your browser session cookies.**

No Graph API app, no developer registration, no password stored in the tool. `fbcli` injects your exported cookies into a headless Chromium (via [Playwright](https://playwright.dev/python/)) and drives the **real Facebook web UI**, so it can read your feed, search, post to your timeline or a group, comment, react, and manage group membership — all from your terminal.

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
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Legal & safety](#legal--safety)
- [Project layout](#project-layout)

---

## Why a browser instead of the API

Facebook has **retired every no-JavaScript HTML interface**:

- `mbasic.facebook.com` — gone (serves *"Facebook is not available on this browser"*).
- `m.facebook.com` / `www.facebook.com` — render the feed, search, and composer entirely through **client-side GraphQL** calls whose `doc_id` values Facebook rotates every few days.

A plain `requests` + HTML-scraper can't drive that and breaks constantly. A real
browser runs Facebook's own JavaScript, so it keeps working across redesigns.
`fbcli` therefore automates a headless Chromium with your cookies loaded, and
targets the UI through **stable ARIA roles** (`article`, `dialog`, `textbox`,
`button`) rather than Facebook's obfuscated CSS classes.

---

## Install

Requires **Python 3.9+**.

```bash
git clone https://github.com/0xEnc0der/fbcli.git
cd fbcli

python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt
python -m playwright install chromium   # one-time, ~150 MB browser download
```

Optional — install the `fbcli` command onto your PATH:

```bash
pip install -e .
```

Without the editable install you run it as `python fbcli.py <command>`.

> **WSL / headless Linux:** Chromium runs with `--no-sandbox --disable-dev-shm-usage`
> automatically. If launch fails, install system libs with
> `sudo python -m playwright install-deps chromium`.

---

## Getting your cookies

`fbcli` needs the cookies from a browser where you are already logged in.

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

Every read command also accepts `--json` for scripting.

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

#### `group <id|url> [--limit N]`
Read a group's feed.
```bash
fbcli group 123456789012345 --limit 15
```

#### `notifications [--limit N]`
List recent notifications with their links.
```bash
fbcli notifications --limit 20
```

### Writing

#### `post "<text>" [--group <id|url>]`
Publish a text status to your timeline, or into a group with `--group`.
**Returns the permalink of the new post** (captured from Facebook's own
create-post response — see [How it works](#how-it-works)).
```bash
fbcli post "Just shipped a new feature 🚀"
fbcli post "Hi group 👋" --group 123456789012345
```
> If the group requires admin approval, the post is submitted to the pending
> queue (it won't appear to members until an admin approves it).

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

---

## Global flags

| Flag | Description |
|---|---|
| `--cookies <file\|string>` | Cookie source (or set `FBCLI_COOKIES`) |
| `--headed` | Show the browser window — invaluable for debugging selectors |
| `--slow <ms>` | Add `slow_mo` delay between UI actions |
| `--json` | Machine-readable JSON output (read commands) |
| `--verbose` | Log each navigation |
| `--version` | Print version |

---

## How it works

1. **Cookie injection.** Your exported cookies are normalized (any of the four
   formats above) and loaded into a fresh Playwright browser context.
2. **Login guard.** Every navigation checks for a redirect to `/login` or
   `/checkpoint` and fails fast with a clear message if your session is stale.
3. **Semantic selectors.** Reads and writes target ARIA roles and accessible
   names, which survive Facebook's frequent CSS churn far better than class names.
4. **Real permalinks.** Facebook's on-page timestamp links are JS-obfuscated, so
   after you publish, `fbcli` listens to the create-post GraphQL response and
   parses the new story's `pfbid`, returning the canonical
   `https://www.facebook.com/<uid|groups/gid>/posts/<pfbid>` URL.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `auth error: … redirected to login/checkpoint` | Cookies expired or a security check is pending — re-export fresh cookies from a logged-in browser. |
| `Missing essential cookie(s): c_user, xs` | Your export didn't include the session cookies. Re-export and make sure you're logged in. |
| A read command returns `(nothing to show)` | Could be genuinely empty (e.g. a new account with no friends), or a selector drifted — run with `--headed` to watch. |
| `Could not open the post composer` | Facebook changed the composer; run `--headed --slow 300` to observe, then adjust `fbcli/web_actions.py`. |
| Chromium won't launch (Linux) | `sudo python -m playwright install-deps chromium` |

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
fbcli/
  browser.py      Playwright engine: cookie injection, navigation, login guard
  web_actions.py  every command's UI flow (read + write)
  cli.py          argparse command surface
  __init__.py
fbcli.py          standalone launcher — `python fbcli.py ...`
pyproject.toml    packaging + `fbcli` entry point
requirements.txt  runtime dependency (playwright)
```

---

*Built as a personal-automation experiment. PRs that add media upload, event
handling, or Marketplace support are welcome.*
