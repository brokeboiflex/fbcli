# fbcli recipes

Assumes `export FBCLI_COOKIES=./cookies.json` (or `=brave`, `=chrome`, …) and
that `fbcli` means `bun run fbcli.ts` when running from a checkout.

## Reading

```bash
# Feed triage: author + first line + link, newest first.
fbcli feed --limit 20 --json |
  jq -r '.[] | "\(.author): \(.text | split("\n")[0] // "" | .[0:120])\n  \(.permalink)"'

# Only posts that mention something.
fbcli feed --limit 30 --json | jq '[.[] | select(.text | test("hiring"; "i"))]'

# A group's newest posts (--sort activity for Facebook's resurface order).
fbcli group 123456789012345 --limit 25 --json | jq -r '.[].permalink'

# One post with its comment bodies.
fbcli read "<post_url>" --json | jq '{text: .post.text, comments: .comments | length}'

# Notifications that link to a group.
fbcli notifications --limit 30 --json | jq '[.[] | select(.url | contains("/groups/"))]'

# Search, then read the most promising hit.
fbcli search "nairobi climbing" --kind groups --limit 10 --json | jq -r '.[] | "\(.text)\t\(.url)"'
```

`search --kind` is `top` (default), `posts`, `people`, `pages`, or `groups`.
`timeline` takes `me` (default), a uid, or a username.

## Watching a group without double-reporting

Permalinks are the stable id. Keep the ones already seen in a file and diff:

```bash
seen=.context/seen-posts.txt; touch "$seen"
fbcli group 123456789012345 --limit 25 --json |
  jq -r '.[] | select(.permalink != "") | @json' |
  while read -r post; do
    url=$(printf '%s' "$post" | jq -r .permalink)
    grep -qxF "$url" "$seen" || { printf '%s\n' "$post"; printf '%s\n' "$url" >> "$seen"; }
  done
```

The newest post in a group sometimes has an empty `permalink` (Facebook hasn't
rendered its own link yet) — fbcli keeps the post rather than dropping it, so
skip blank permalinks when deduping and pick it up on the next pass.

Space repeated checks minutes apart, not seconds.

## Replying to something (the full gate)

```bash
# 1. Read it, so the reply is actually informed.
fbcli read "$URL" --json | jq -r '.post.text'

# 2. Preview — nothing is sent, no browser even launches.
fbcli comment "$URL" "Great write-up — the section on cookies matches what I saw." --dry-run --json

# 3. Show the user the exact text and target, get a yes, then:
fbcli comment "$URL" "Great write-up — the section on cookies matches what I saw." --yes --json
```

Same three steps for `post`, `react`, `dm`, `creategroup`:

```bash
fbcli post "text" --group 123456789012345 --dry-run    # group post
fbcli post "text" --audience friends --dry-run         # refuses unless composer says Friends
fbcli dm 100000000000000 "text" --dry-run              # uid or username
fbcli react "$URL" --reaction love --dry-run           # like|love|care|haha|wow|sad|angry
fbcli creategroup "my sandbox" --privacy private --dry-run
```

A private group you created is the right place to test a posting flow before
aiming it at a real community.

## Multi-step flows: one session, not one browser per command

Each CLI invocation starts and tears down a browser. For anything with several
steps, drive the library directly — same functions the CLI calls:

```ts
// flow.ts — run with: bun run flow.ts
import { Browser, webActions as fb } from "fbcli";          // or "./src/index.ts" in a checkout

await using b = await Browser.start(process.env.FBCLI_COOKIES!, { verbose: true });

const me = await fb.whoami(b);
const posts = await fb.groupFeed(b, "123456789012345", 20, "new");
const interesting = posts.filter((p) => /homework|assignment/i.test(p.text));
console.log(JSON.stringify({ me, found: interesting }, null, 2));
// Writes exist here too (fb.comment, fb.postStatus, …) and are NOT gated by the
// CLI's confirmation guard — so only call them on an explicit, previewed request.
```

`Browser` implements `Symbol.asyncDispose`; without `await using`, close it in a
`finally`. `fb.postStatus(b, text, group?, audience?)` returns the new `Post`
with its permalink.

`fb-find-students.ts` in the repo root is a worked example of this pattern
(scan a group, extract permalinks, filter).

## When the environment is awkward

```bash
fbcli --cookies brave whoami              # read the login out of Brave/Chrome/Chromium/Edge/Arc
fbcli --channel chrome feed               # drive an installed Chrome instead of a download
fbcli --browser-path /path/to/chrome feed # an exact binary
fbcli --headed --slow 300 --verbose feed   # watch it happen; the debugging default
```

Env equivalents: `FBCLI_COOKIES`, `FBCLI_BROWSER_CHANNEL`, `FBCLI_BROWSER`.

If a flow fails with `kind: facebook` ("Could not open the post composer",
"No Join button found", an empty feed that shouldn't be empty), Facebook's DOM
has probably drifted. Don't retry in a loop: run once with `--headed --slow 300`
to see it, then either override the one selector that moved
(`FBCLI_SELECTORS=./sel.json`, see `src/selectors.ts`) or hand it to the
`fbcli-dev` skill for a fix.
