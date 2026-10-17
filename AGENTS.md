# AGENTS.md — working on (and with) fbcli

Instructions for coding agents. Humans: see [README.md](README.md).

`fbcli` drives a **real Facebook session** from the terminal. Two separate jobs
live in this repo, and they have different rules:

| Job | Read first |
|---|---|
| **Use** fbcli to read/post on a Facebook account | [`.agents/skills/fbcli/SKILL.md`](.agents/skills/fbcli/SKILL.md) |
| **Change** fbcli's own code | [`.agents/skills/fbcli-dev/SKILL.md`](.agents/skills/fbcli-dev/SKILL.md) |

Both follow the [Agent Skills](https://agentskills.io) format, so most agents
load them on their own — see [Skills](#skills) below. They are plain Markdown
either way: if yours doesn't, just read the file.

---

## The one thing to get right

Every write command (`post`, `comment`, `react`, `dm`, `creategroup`) publishes
to a real account under the user's real name, and most of it cannot be undone
from this tool. So:

1. **Never** run a write command unless the user asked for that specific action
   in the current task. "Check my feed" is not permission to reply to anything.
2. Preview with `--dry-run` and show the user the exact text first.
3. Only then add `--yes` (required anyway — without a TTY the guard refuses).
4. Never loop a write command over a list of people, posts, or groups. That is
   spam, it gets the account locked, and it is not what anybody asked for.

Reads (`whoami`, `feed`, `timeline`, `group`, `read`, `search`,
`notifications`, `schema`) are safe to run freely.

Cookies are credentials: never echo a cookie file, never paste a `c_user=…;
xs=…` string into a commit, a log, or a test fixture. The usual export names are
gitignored (`cookies*.json`, `*cookies*.txt`, `.env`) — keep new ones inside
those patterns. Pass `FBCLI_COOKIES=<path>` rather than putting cookie values in
an argv that lands in shell history.

---

## Setup and the commands you need

```bash
bun install            # the only setup step; needs Bun 1.1+
bun run typecheck      # tsc --noEmit — run on every change
bun run test:unit      # ~2s: cookies, selectors, pure helpers, CLI surface
bun run test:browser   # ~5min: real Chromium against a fake facebook.com
bun run test           # both, in that order
bun run fbcli.ts <args> # run the CLI without installing
```

- The CLI's own shape is machine-readable: `bun run fbcli.ts schema` prints
  every command, flag, default, output shape, exit code and env var as JSON.
  Read that instead of guessing flags.
- **Run the browser suites one file per process** (`bun run test:browser` does
  this). After ~40 Chromium launches in one Bun process, Playwright protocol
  calls stall forever and unrelated tests time out. A timeout under load is
  usually contention, not a bug — re-run the single file before believing it.
- No test touches the network or a real account: `test/fake-facebook.ts`
  intercepts every request to facebook.com. Keep it that way.

## Repo map

```
src/browser.ts          Playwright engine: cookie injection, browser resolution, login guard
src/browser-cookies.ts  decrypt cookies out of a local Chromium-family browser
src/selectors.ts        THE registry of every Facebook selector (FBCLI_SELECTORS overrides it)
src/web-actions.ts      one async function per command, over an open Browser
src/cli.ts              command spec, safety guards, human + JSON output, `schema`
src/argparse.ts         the small argparse-shaped parser the CLI is declared with
test/fake-facebook.ts   request-intercepting facebook.com stand-in used by all browser tests
fb-find-students.ts     standalone example: scan a group for homework-help posts
```

## Invariants to preserve

- **Cookie-only auth.** No Graph API, no app id, no password, no token refresh.
- **Selectors live in `src/selectors.ts`**, keyed and overridable. Target ARIA
  roles and accessible names, never Facebook's obfuscated CSS classes.
- **Every command speaks twice**: prose for humans, structured JSON under
  `--json`. A new command needs an `OUTPUT_SHAPES` entry in `src/cli.ts` (and a
  `SHAPES` entry if it returns a new shape) or the schema test fails.
- **Errors are typed**: `--json` sends `{"ok":false,"error":{kind,message}}` to
  stderr with exit 1; usage errors exit 2 with argparse prose. Don't add a
  third convention.
- **Write commands stay gated** by `--dry-run` / confirmation / `--yes`.
- **Runtime deps stay at `playwright-core`.** Don't add dependencies; `test/`
  may use the dev `playwright` package.
- Strict TypeScript (`noUncheckedIndexedAccess` included), ESM, `.ts` imports.
- Comments explain *why* — especially why a wait, a fallback, or a selector
  exists. Match the surrounding density; don't narrate the obvious.

## Skills

The two skills live in `.agents/skills/`, the cross-agent location that Codex,
Cursor, Copilot/VS Code and Gemini CLI all scan. `.claude/skills/fbcli` and
`.claude/skills/fbcli-dev` are **symlinks** to them, because Claude Code scans
only `.claude/skills/` (it follows a symlinked skill directory and loads the
skill once). Any other client: point it at `.agents/skills/<name>/SKILL.md`, or
symlink that directory into whatever path it does scan.

Edit the real files under `.agents/skills/`, never the symlinks, and keep
`name:` equal to the directory name — the format requires it.

## Git

- Commit subjects are imperative and specific: *"Read group feeds from the feed
  column, not the comments inside it"*. The body says why.
- Don't push, open, or merge anything unless the user asked in this task.
