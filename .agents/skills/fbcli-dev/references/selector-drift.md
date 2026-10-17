# A Facebook flow stopped working

Symptoms: a read returns `(nothing to show)` / `[]` where there is clearly
content, or a write raises `FBError` — *"Could not open the post composer"*,
*"No Join button found"*, a `waitFor` timeout on a textbox or button.

Almost always Facebook renamed a button, reshuffled the DOM, or moved content
behind a different role. The code is built so this is a data fix, not a redesign.

## 1. Rule out auth first

```bash
bun run fbcli.ts whoami --json
```

`kind: auth` / "redirected to login" / "Missing essential cookie(s)" means stale
cookies or a pending checkpoint, not drift. Only the user can re-export.

## 2. Watch it happen

```bash
bun run fbcli.ts --headed --slow 300 --verbose <command> …
```

`--headed` shows the browser, `--slow` makes each action visible, `--verbose`
logs every navigation. Find the element the flow should have grabbed and check
what it actually exposes:

```js
// in the headed browser's devtools console
document.querySelectorAll('div[role="article"]').length
[...document.querySelectorAll('[role="button"]')].map(b => b.getAttribute('aria-label') || b.textContent.trim())
```

You are looking for the new **role** and **accessible name**, or a new stable
attribute. Not a class name — Facebook's classes are generated and rotate.

## 3. Prove the fix without touching code

Every selector is a key in `src/selectors.ts`. Override just the ones that moved:

```bash
echo '{ "postButton": "^(Post|Publish)$", "article": "div[data-newhook]" }' > /tmp/sel.json
FBCLI_SELECTORS=/tmp/sel.json bun run fbcli.ts --headed post "test" --dry-run
```

- CSS keys (`article`, `feed`, `editor`, `commentBox`, …) are query strings.
- Name keys (`postButton`, `likeButton`, `joinButton`, `joinedButton`,
  `leaveMenuItem`, `leaveButton`, `createButton`, `messageBox`,
  `composerOpener`, `audienceButton`) are **case-insensitive regex sources**
  fed to Playwright's `getByRole({ name })`. Anchor them (`^Post$`) so "Post"
  doesn't also match "Post to your story".
- A bad path or unparseable JSON warns and falls back to defaults — if nothing
  changed, check that warning.

This is also the answer to give a user who is blocked today: an override works
with no code change and no release.

## 4. Land it

1. Edit `DEFAULT_SELECTORS` in `src/selectors.ts`. Prefer *widening* — add the
   new name as an alternative (`"^(Post|Publish)$"`) rather than replacing the
   old one, so the fix works on both of Facebook's A/B arms.
2. A genuinely new hook needs a new key: add it to `SelectorDefs` with a doc
   comment saying what it points at, to `DEFAULT_SELECTORS`, and — if it is an
   accessible-name regex — to `NAME_KEYS` *and* the `Selectors` conditional
   type union.
3. Add the new DOM arrangement to the fixture in the relevant browser suite
   (`test/read-actions.test.ts` / `test/write-actions.test.ts`) so both shapes
   are covered, keeping the existing decoys in place.
4. `bun run typecheck && bun run test:unit`, then the one browser file:
   `bun test test/write-actions.test.ts`.
5. Note in `README.md`'s troubleshooting table only if the symptom is new.

## If widening isn't enough

Some breakages are structural (Facebook moves posts out of `role="feed"`, or
renders the composer in an iframe). Then the fix is in `src/web-actions.ts`, and
the rules are: keep the patient waits, keep a fallback path for the old
arrangement when it's cheap, and make the failure message say what was being
looked for — `FBError("Could not open the post composer")` is useful precisely
because it names the step.
