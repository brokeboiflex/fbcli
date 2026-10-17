---
name: fbcli-dev
description: Use when changing fbcli's own code — adding or editing a command, fixing a Facebook flow that stopped working, touching cookie loading or browser launch, or writing tests against the fake Facebook. Covers the test loop, the four touchpoints a command needs, and the invariants a change must keep.
license: MIT
compatibility: Requires Bun 1.1+ and a Chromium-family browser for the integration suites; no Facebook account needed (tests run against a fake facebook.com)
---

# Changing fbcli

fbcli automates the real Facebook web UI with nothing but session cookies.
Everything here exists to survive Facebook changing its DOM without notice.

## The loop

```bash
bun install            # once
bun run typecheck      # tsc --noEmit — after every edit
bun run test:unit      # ~2s — cookies, selectors, pure helpers, CLI surface
bun run test:browser   # ~5min — real Chromium against test/fake-facebook.ts
bun test test/selectors.test.ts            # one file
bun run fbcli.ts schema | jq '.commands[].name'   # the surface, as data
```

`typecheck` + `test:unit` is the fast gate; run it constantly. Run
`test:browser` before claiming a UI flow works.

**Never run a bare `bun test`.** It loads every browser suite into one Bun
process, and after ~40 Chromium launches Playwright's protocol calls stall
forever, so unrelated tests hit their timeouts. `bun run test:browser` runs one
file per process, which is why `bun run test` is the supported entry point.
A browser test that times out under parallel load is almost always contention —
re-run that single file in a fresh process before treating it as a bug.

No test touches the network or a real account, and none should: cookies come
from the `COOKIES` constant and every request is intercepted.

## Where things live

| File | Role |
|---|---|
| `src/browser.ts` | cookie injection, browser resolution, `goto`/`settle`, login guard, `FBError`/`NotLoggedIn` |
| `src/browser-cookies.ts` | decrypt cookies from a local Chromium-family browser |
| `src/selectors.ts` | **every** Facebook selector, overridable via `FBCLI_SELECTORS` |
| `src/web-actions.ts` | one async function per command, over an open `Browser` |
| `src/cli.ts` | parser spec, write-action guard, human + `--json` output, `schema()` |
| `src/argparse.ts` | the argparse-shaped parser (exit 2 on usage errors) |
| `test/fake-facebook.ts` | the facebook.com stand-in: `withFakeFB`, `page`, `probe`, `RECORDER` |

## Adding or changing a command

Four touchpoints, in order — miss one and either the CLI or a test fails:

1. **`src/web-actions.ts`** — the flow: `async function x(b: Browser, …)`.
   Return data (`Post`, `Item`, an interface) when there is any; return a short
   prose string when the only outcome is "it happened".
2. **`src/cli.ts` `buildParser()`** — a `subcommands` entry with positionals,
   options, `choices`, defaults, and `help` for each flag (`schema` publishes
   them; agents read that instead of `--help`).
3. **`src/cli.ts` `run()`** — a `case`: `emit(value, asJson, humanPrinter)` for
   data, `action("<cmd>", prose)` for prose outcomes. Add the command to
   `MUTATIONS` if it writes anything, and to `OUTPUT_SHAPES` (plus `SHAPES` if
   the shape is new) always.
4. **Tests** — `test/cli.test.ts` for the surface (the exact subcommand list is
   asserted, as are shapes/defaults in `schema`), and a browser suite with a
   fake page for the flow itself.

Also update `README.md`'s command reference. If the command writes, it inherits
`--dry-run`/confirmation from `MUTATIONS` — don't hand-roll a second gate.

### Fixture pattern for a flow test

```ts
await withFakeFB({ html: { "*": page(`${RECORDER}<div role="main">…</div>`) } }, async (b) => {
  expect(await A.feed(b, 3)).toHaveLength(3);
});
// Writes: have the fixture stash what happened on window.__fb, then
// expect(await probe(b, "posted")).toBe("hello");
```

Fixtures must include the decoys production dodges — a background inline
editor, a dialog with no editor, comment previews inside a story card — or the
test passes while the real flow grabs the wrong node. `html["*"]` is the
catch-all; `json` serves API responses; `redirect` exercises the login guard.

## Invariants

- **Cookie-only auth.** No Graph API, no app registration, no stored password.
- **Selectors only in `src/selectors.ts`.** Target ARIA roles and accessible
  names (`role=article`, `role=textbox`, `^Post$`), never obfuscated CSS
  classes. New hook → new registry key + doc comment; name-regex keys go in
  `NAME_KEYS` and the `Selectors` conditional type.
- **Two voices, one command**: prose for humans, structured JSON under `--json`;
  errors as `{"ok":false,"error":{kind,message}}` on stderr with exit 1, usage
  errors exit 2 in argparse prose.
- **Runtime deps stay at `playwright-core`** (dev-only `playwright` is fine).
- Strict TS including `noUncheckedIndexedAccess`; ESM with `.ts` imports.
- Waits are load-bearing. `b.settle()` and the explicit `waitForTimeout`s absorb
  Facebook's async hydration — tightening one to speed a test up reintroduces
  flake in the real UI. If you must change one, say why in a comment.
- Comments explain *why* a wait, fallback, or selector exists. Several carry the
  Python original's reasoning; keep that register.

## When a Facebook flow breaks

Facebook moved something. See
[references/selector-drift.md](references/selector-drift.md) for the
diagnose-with-`--headed`, override-with-`FBCLI_SELECTORS`, then-fix-and-test
procedure.
