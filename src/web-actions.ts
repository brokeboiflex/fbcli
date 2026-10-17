/**
 * Facebook actions driven through the real web UI (Playwright).
 *
 * Selectors favour stable, semantic hooks — ARIA roles (article/dialog/textbox/
 * button) and accessible names — over Facebook's obfuscated class soup, and every
 * interaction has generous waits because the UI hydrates asynchronously.
 */

import type { Locator, Response } from "playwright-core";
import { FB, type Browser, FBError, isTimeout } from "./browser.ts";
import { SEL } from "./selectors.ts";

/** Slice by code point, like Python's `s[:n]`, so emoji survive truncation. */
export function cut(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join("");
}

/** Count code points, like Python's `len()` on a str. */
export function charLength(s: string): number {
  return Array.from(s).length;
}

/** The first line of a block of text (Python's `s.split("\n", 1)[0]`). */
function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i === -1 ? s : s.slice(0, i);
}

/** Collapse runs of whitespace, like `" ".join(s.split())`. */
function squeeze(s: string): string {
  const t = s.trim();
  return t === "" ? "" : t.split(/\s+/).join(" ");
}

/** `urllib.parse.quote_plus` — space becomes `+`, everything unsafe percent-escaped. */
export function quotePlus(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, "+");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "\n": "",
};

/**
 * Interpret Python-style backslash escapes, as `.decode("unicode_escape")` does.
 * Facebook's Relay bootstrap embeds non-ASCII names as `\uXXXX`.
 */
export function decodeUnicodeEscape(s: string): string {
  return s.replace(
    /\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[0-7]{1,3}|[\s\S])/g,
    (whole, esc: string) => {
      const head = esc[0]!;
      if (head === "u" || head === "U") {
        return String.fromCodePoint(parseInt(esc.slice(1), 16));
      }
      if (head === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
      if (/^[0-7]{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
      // Unrecognised escapes keep their backslash, exactly like Python.
      return SIMPLE_ESCAPES[esc] ?? whole;
    },
  );
}

/** A feed/timeline/group story. */
export class Post {
  author: string;
  text: string;
  permalink: string;

  constructor(fields: { author?: string; text?: string; permalink?: string } = {}) {
    this.author = fields.author ?? "";
    this.text = fields.text ?? "";
    this.permalink = fields.permalink ?? "";
  }

  brief(width = 300): string {
    const body = charLength(this.text) <= width ? this.text : cut(this.text, width) + "…";
    const out = [`● ${this.author || "(post)"}`];
    if (body) out.push("  " + body.replace(/\n/g, "\n  "));
    if (this.permalink) out.push(`  → ${this.permalink}`);
    return out.join("\n");
  }
}

/** A search result or notification row. */
export class Item {
  text: string;
  url: string;

  constructor(fields: { text?: string; url?: string } = {}) {
    this.text = fields.text ?? "";
    this.url = fields.url ?? "";
  }
}

export interface WhoAmI {
  uid: string;
  name: string;
  profile: string;
}

export interface CreatedGroup {
  name: string;
  id: string;
  url: string;
}

export function groupUrl(group: string): string {
  if (group.startsWith("http")) return group;
  const g = group.replace(/^\/+|\/+$/g, "");
  const parts = g.split("groups/");
  return `/groups/${parts[parts.length - 1]}`;
}

/** `await` a locator read, yielding null instead of throwing on timeout. */
async function tryInnerText(loc: Locator, timeout: number): Promise<string | null> {
  try {
    return (await loc.innerText({ timeout })).trim();
  } catch {
    return null;
  }
}

async function firstHref(links: Locator): Promise<string> {
  if (await links.count()) {
    return (await links.first().getAttribute("href")) ?? "";
  }
  return "";
}

// -- identity ----------------------------------------------------------------
export async function whoami(b: Browser): Promise<WhoAmI> {
  await b.goto("/");
  await b.settle(2500);
  // The account name is embedded in the page's Relay bootstrap data; this is
  // far more stable than the DOM, where the profile name isn't a plain heading.
  const m = new RegExp(SEL.nameFromBootstrap).exec(await b.page.content());
  const name = m ? decodeUnicodeEscape(m[1]!) : "(unknown)";
  return {
    uid: b.uid,
    name,
    profile: `https://www.facebook.com/profile.php?id=${b.uid}`,
  };
}

// -- reading -----------------------------------------------------------------
async function collectArticles(b: Browser, limit: number, scrolls = 6): Promise<Post[]> {
  const posts: Post[] = [];
  const seen = new Set<string>();
  for (let s = 0; s < scrolls; s++) {
    const arts = b.page.locator(SEL.article);
    const n = await arts.count();
    for (let i = 0; i < n; i++) {
      const a = arts.nth(i);
      // Facebook marks comment previews as articles too; those are not stories.
      if (await a.evaluate((el, sel) => el.matches(sel), SEL.commentArticle)) continue;
      const txt = await tryInnerText(a, 1500);
      if (txt === null) continue;
      if (!txt || charLength(txt) < 3) continue;
      const links = a.locator(SEL.permalinkLinks);
      const perma = await firstHref(links);
      const key = perma || cut(txt, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      const author = cut(firstLine(txt), 80);
      posts.push(new Post({ author, text: txt, permalink: perma }));
      if (posts.length >= limit) return posts;
    }
    await b.page.mouse.wheel(0, 3000);
    await b.page.waitForTimeout(1200);
  }
  return posts;
}

/** What one story card yields before it becomes a `Post`. */
interface RawStory {
  author: string;
  text: string;
  permalink: string;
}

/**
 * Pull a story out of a single feed card, in the page.
 *
 * Two Facebook habits make this fiddlier than reading `innerText`: the card
 * carries hidden decoy text (every other node spells "Facebook"), and the
 * comment previews under a post are themselves full text blocks. So the body is
 * the longest `dir="auto"` block that is *not* inside a comment preview — the
 * same heuristic `readPost` uses on a post page.
 */
async function readStoryCard(card: Locator): Promise<RawStory> {
  return await card.evaluate(
    (el, sel) => {
      const root = el as HTMLElement;
      const inComment = (node: Element): boolean => node.closest(sel.comment) !== null;

      let text = "";
      for (const block of Array.from(root.querySelectorAll(sel.body))) {
        if (inComment(block)) continue;
        const t = (block as HTMLElement).innerText.trim();
        if (Array.from(t).length > Array.from(text).length) text = t;
      }

      // Prefer a link to the poster's profile; a heading or any other link is
      // the fallback for posters who have none (anonymous group members).
      let author = "";
      for (const selector of [sel.author, sel.authorAny]) {
        for (const link of Array.from(root.querySelectorAll(selector))) {
          if (inComment(link)) continue;
          const name = (link as HTMLElement).innerText.trim().split("\n")[0] ?? "";
          // "Facebook" is decoy text, not a person.
          if (!name || name === "Facebook" || Array.from(name).length > 80) continue;
          author = name;
          break;
        }
        if (author) break;
      }

      // A story's own timestamp link is JS-obfuscated, so a fresh post often
      // has no link to itself anywhere in the card. Three places to look, in
      // descending order of directness — and an empty permalink is fine, a
      // post nobody has answered yet is still the post we came for.
      let permalink = "";
      let viaComment = "";
      for (const link of Array.from(root.querySelectorAll(sel.permalink))) {
        const href = (link as HTMLAnchorElement).href.split("?")[0]!;
        if (inComment(link)) {
          // A comment's link points at this very post, plus a `comment_id`.
          viaComment ||= href;
          continue;
        }
        permalink = href;
        break;
      }
      // A photo in a group post carries `set=gm.<post id>&idorvanity=<group>`.
      let viaPhoto = "";
      for (const link of Array.from(root.querySelectorAll(sel.groupPhoto))) {
        if (inComment(link)) continue;
        const q = new URL((link as HTMLAnchorElement).href).searchParams;
        const post = /^gm\.(\d+)$/.exec(q.get("set") ?? "")?.[1];
        const group = q.get("idorvanity");
        if (!post || !group) continue;
        viaPhoto = `https://www.facebook.com/groups/${group}/posts/${post}/`;
        break;
      }
      return { author, text, permalink: permalink || viaComment || viaPhoto };
    },
    {
      body: SEL.bodyBlock,
      comment: SEL.commentArticle,
      author: SEL.storyAuthor,
      authorAny: SEL.storyAuthorAny,
      permalink: SEL.permalinkLinks,
      groupPhoto: SEL.groupPhotoLinks,
    },
  );
}

/**
 * Read the stories out of a `role="feed"` column.
 *
 * Group feeds need this rather than `collectArticles`: their story cards are not
 * `role="article"` at all (only the comment previews inside them are), and
 * Facebook leaves a card's contents unrendered until it scrolls into view. Walk
 * the feed's own children instead, bringing each into view before reading it.
 */
async function collectStories(b: Browser, limit: number, scrolls = 8): Promise<Post[]> {
  const feed = b.page.locator(SEL.feed).first();
  if (!(await feed.count())) return [];
  const posts: Post[] = [];
  const seen = new Set<string>();
  for (let s = 0; s < scrolls; s++) {
    const cards = feed.locator("> div");
    const n = await cards.count();
    for (let i = 0; i < n; i++) {
      const card = cards.nth(i);
      try {
        await card.scrollIntoViewIfNeeded({ timeout: 4000 });
      } catch (err) {
        if (!isTimeout(err)) throw err;
        continue;
      }
      // Give the card Facebook just un-hid a moment to paint.
      await b.page.waitForTimeout(400);
      let story: RawStory;
      try {
        story = await readStoryCard(card);
      } catch {
        continue; // the card was recycled out of the DOM mid-read
      }
      // Every real story names its poster; the sort control, the composer and
      // the join/suggestion cards have no author. Don't ask for a permalink —
      // the newest posts, the ones nobody has replied to yet, have none.
      if (!story.author) continue;
      // Identify a story by its link when it has one, and by what it says when
      // it doesn't, so a card re-read after a scroll isn't counted twice.
      const keys = [story.permalink, `${story.author}|${cut(story.text, 80)}`].filter(Boolean);
      if (keys.some((k) => seen.has(k))) continue;
      for (const k of keys) seen.add(k);
      posts.push(new Post(story));
      if (posts.length >= limit) return posts;
    }
    await b.page.mouse.wheel(0, 3000);
    await b.page.waitForTimeout(1200);
  }
  return posts;
}

/** Prefer the feed-column walk, falling back to bare articles (older layouts). */
async function collectFeed(b: Browser, limit: number): Promise<Post[]> {
  const stories = await collectStories(b, limit);
  return stories.length ? stories : await collectArticles(b, limit);
}

export async function feed(b: Browser, limit = 10): Promise<Post[]> {
  await b.goto("/");
  await b.settle(3500);
  return await collectArticles(b, limit);
}

export async function timeline(b: Browser, target = "me", limit = 10): Promise<Post[]> {
  let path: string;
  if (target === "me" || target === "self") {
    path = "/me";
  } else if (/^\d+$/.test(target)) {
    path = `/profile.php?id=${target}`;
  } else {
    path = `/${target.replace(/^\/+/, "")}`;
  }
  await b.goto(path);
  await b.settle(3500);
  return await collectArticles(b, limit);
}

/** How Facebook should order a group's feed: by newest post, or by last reply. */
export type GroupSort = "new" | "activity";

/** Facebook's own sort keys, as the group URL's `sorting_setting` takes them. */
const GROUP_SORTING: Record<GroupSort, string> = {
  new: "CHRONOLOGICAL",
  activity: "RECENT_ACTIVITY",
};

export async function groupFeed(
  b: Browser,
  group: string,
  limit = 10,
  sort: GroupSort = "new",
): Promise<Post[]> {
  const url = new URL(groupUrl(group), FB);
  url.searchParams.set("sorting_setting", GROUP_SORTING[sort]);
  await b.goto(url.pathname + url.search);
  await b.settle(3500);
  return await collectFeed(b, limit);
}

export async function readPost(b: Browser, url: string): Promise<[Post, string[]]> {
  await b.goto(url);
  await b.settle(3500);
  await b.page.waitForTimeout(1500);
  // Body and author come out of the post's own card, the same way the feed
  // reads them — crucially skipping the comments, one of which is often longer
  // than the post it answers.
  let scope = b.page.locator(SEL.dialog).last();
  if (!(await scope.count())) {
    scope = b.page.locator(SEL.main).first();
  }
  const { author, text } = await readStoryCard(scope);
  const comments: string[] = [];
  const cnodes = b.page.locator(SEL.commentNodes);
  const ncomments = Math.min(await cnodes.count(), 30);
  for (let i = 0; i < ncomments; i++) {
    const t = await tryInnerText(cnodes.nth(i), 800);
    if (t === null) continue;
    if (t && t !== text && !comments.includes(t) && charLength(t) > 3) comments.push(t);
  }
  return [
    new Post({ author, text, permalink: b.page.url() }),
    comments.slice(0, 25),
  ];
}

export type SearchKind = "top" | "posts" | "people" | "pages" | "groups";

export async function search(
  b: Browser,
  query: string,
  kind: string = "top",
  limit = 15,
): Promise<Item[]> {
  const kinds: Record<string, string> = {
    top: "top", posts: "posts", people: "people", pages: "pages", groups: "groups",
  };
  const seg = kinds[kind] ?? "top";
  await b.goto(`/search/${seg}/?q=${quotePlus(query)}`);
  await b.settle(4000);
  for (let i = 0; i < 3; i++) {
    await b.page.mouse.wheel(0, 2500);
    await b.page.waitForTimeout(1000);
  }
  // Result names aren't in the anchor text — they're in the avatar link's
  // aria-label ("Profile photo of <Name>"). Harvest per unique href.
  const best = new Map<string, string>();
  const links = b.page.locator(SEL.searchLinks);
  const nlinks = Math.min(await links.count(), 250);
  for (let i = 0; i < nlinks; i++) {
    const a = links.nth(i);
    let href: string;
    let aria: string;
    let txt: string;
    try {
      href = (await a.getAttribute("href")) ?? "";
      aria = (await a.getAttribute("aria-label")) ?? "";
      // Trim before splitting, so a leading newline doesn't yield an empty name.
      txt = firstLine(((await a.innerText({ timeout: 250 })) || "").trim());
    } catch {
      continue;
    }
    if (!href || href.startsWith("#")) continue;
    if (["/search/", "/hashtag/", "/photo", "/reactions/"].some((k) => href.includes(k))) {
      continue;
    }
    let key = href.split("?")[0]!;
    if (href.includes("profile.php")) {
      const mid = /[?&]id=(\d+)/.exec(href);
      if (mid) key = key + "?id=" + mid[1]; // keep the numeric id
    }
    if (!(key.startsWith("http") || key.startsWith("/"))) continue;
    let name = txt;
    if (!name && aria) {
      name = aria.replace(/^(?:Profile (?:photo|picture) of |)/, "").trim();
      name = name.replace(/'s (?:profile|timeline).*$/, "").trim();
    }
    if (charLength(name) > charLength(best.get(key) ?? "")) best.set(key, name);
  }
  const results: Item[] = [];
  for (const [key, found] of best) {
    let name = found;
    if (!name) {
      const slug = key.replace(/\/+$/, "").split("/").pop()!;
      name = slug.includes("profile.php")
        ? "(profile)"
        : slug.replace(/\./g, " ").replace(/-/g, " ");
    }
    const url = key.startsWith("http") ? key : "https://www.facebook.com" + key;
    results.push(new Item({ text: cut(name, 80), url }));
    if (results.length >= limit) break;
  }
  return results;
}

export async function notifications(b: Browser, limit = 15): Promise<Item[]> {
  await b.goto("/notifications");
  await b.settle(4000);
  await b.page.waitForTimeout(2000);
  const out: Item[] = [];
  const seen = new Set<string>();
  // Notifications render as role="listitem" rows (there is no role="main" here).
  const rows = b.page.locator(SEL.notificationRow);
  const nrows = Math.min(await rows.count(), 60);
  for (let i = 0; i < nrows; i++) {
    const row = rows.nth(i);
    const t = await tryInnerText(row, 800);
    if (t === null) continue;
    if (!t || charLength(t) < 8) continue;
    const href = await firstHref(row.locator("a[href]"));
    const key = cut(t, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      new Item({
        text: cut(squeeze(t), 200),
        url: href.startsWith("http")
          ? href
          : href
            ? "https://www.facebook.com" + href
            : "",
      }),
    );
    if (out.length >= limit) break;
  }
  return out;
}

// -- writing -----------------------------------------------------------------
// Composer opener text differs by surface: timeline says "What's on your mind",
// group pages say "Write something" / "Start a discussion" / "Discuss something".
// (The pattern itself lives in the selector registry: SEL.composerOpener.)

/** Facebook's audience labels, keyed by the CLI's --audience choices. */
const AUDIENCE_LABELS: Record<string, string> = {
  public: "Public",
  friends: "Friends",
  only_me: "Only me",
};

/**
 * Refuse to publish unless the composer's current audience matches `audience`.
 * fbcli never *changes* the audience (that risks silently widening a post); it
 * only verifies, and fails closed if it can't read the selector.
 */
async function verifyAudience(dialog: Locator, audience: string): Promise<void> {
  const want = AUDIENCE_LABELS[audience.toLowerCase()];
  if (!want) throw new FBError(`Unknown audience '${audience}'.`);
  const btn = dialog.getByRole("button", { name: SEL.audienceButton }).first();
  let current: string;
  try {
    await btn.waitFor({ state: "visible", timeout: 6000 });
    current = (await btn.innerText()).trim();
  } catch {
    throw new FBError(
      `Could not read the composer audience to confirm '${want}' — refusing to ` +
        `publish. Re-run with --headed and set it yourself, or drop --audience.`,
    );
  }
  if (current.toLowerCase() !== want.toLowerCase()) {
    throw new FBError(
      `Composer audience is '${current}', not '${want}' — refusing to publish. ` +
        `Set the audience to ${want} on Facebook first (fbcli won't change it), then retry.`,
    );
  }
}

/** Open the 'Create post' dialog, type text, verify audience, and click Post. */
async function composeAndPublish(
  b: Browser,
  text: string,
  audience?: string | null,
): Promise<void> {
  // Pick the first *visible* opener (group pages have hidden/overlaid matches),
  // scroll it clear of sticky panels, then force-click through any overlay.
  const openers = b.page.getByText(SEL.composerOpener);
  let opener = openers.first();
  const nopeners = Math.min(await openers.count(), 8);
  for (let i = 0; i < nopeners; i++) {
    const el = openers.nth(i);
    try {
      if (await el.isVisible()) {
        opener = el;
        break;
      }
    } catch {
      continue;
    }
  }
  try {
    await opener.scrollIntoViewIfNeeded({ timeout: 5000 });
  } catch {
    // not scrollable / already in view
  }
  await b.page.waitForTimeout(400);
  // Open the "Create post" modal; retry until a dialog with a live editor mounts.
  // Both the timeline and group composers open the same modal — a plain inline
  // textbox exists behind it, so everything below is scoped to the dialog to
  // avoid typing into the wrong (background) editor.
  const findComposer = async (): Promise<[Locator, Locator] | [null, null]> => {
    // Among the (possibly several) open dialogs, return the one whose editor
    // is actually visible — that's the Create-post modal, not a stray dialog.
    const dialogs = b.page.locator('[role="dialog"]');
    const n = await dialogs.count();
    for (let i = 0; i < n; i++) {
      const d = dialogs.nth(i);
      const ed = d.locator(SEL.editor).first();
      try {
        if ((await ed.count()) && (await ed.isVisible())) return [d, ed];
      } catch {
        continue;
      }
    }
    return [null, null];
  };

  let dialog: Locator | null = null;
  let box: Locator | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await opener.click({ timeout: 6000 });
    } catch {
      try {
        await opener.click({ force: true, timeout: 4000 });
      } catch {
        // keep going — the retry loop re-checks for the dialog anyway
      }
    }
    await b.page.waitForTimeout(1800);
    [dialog, box] = await findComposer();
    if (box !== null) break;
  }
  if (box === null || dialog === null) {
    throw new FBError("Could not open the post composer (layout changed?).");
  }
  try {
    await box.click({ timeout: 4000 });
  } catch {
    await box.evaluate((el) => (el as HTMLElement).focus());
  }
  await b.page.keyboard.type(text, { delay: 15 });
  await b.page.waitForTimeout(1000);
  // Audience gate (timeline posts only): confirm before anything is published.
  if (audience) await verifyAudience(dialog, audience);
  // The Post button (inside the dialog) enables once the editor has content.
  const btn = dialog.getByRole("button", { name: SEL.postButton }).last();
  await btn.waitFor({ state: "visible", timeout: 8000 });
  for (let i = 0; i < 15; i++) {
    if (await btn.isEnabled()) break;
    await b.page.waitForTimeout(400);
  }
  try {
    await btn.click({ timeout: 6000 });
  } catch {
    await btn.evaluate((el) => (el as HTMLElement).click());
  }
  // Publication closes the dialog; wait for the editor to detach.
  try {
    await box.waitFor({ state: "detached", timeout: 15000 });
  } catch {
    await b.page.waitForTimeout(4000);
  }
}

/**
 * Parse a fresh post's permalink/id out of captured GraphQL responses.
 *
 * Group posts live at /groups/<gid>/posts/<id>; timeline posts at /<uid>/posts/<id>.
 */
export function permalinkFromGraphql(
  bodies: string[],
  uid: string,
  groupId?: string | null,
): string {
  const base = groupId
    ? `https://www.facebook.com/groups/${groupId}`
    : `https://www.facebook.com/${uid}`;
  for (const body of bodies) {
    const u = body.replace(/\\\//g, "/");
    const pf = /(pfbid[A-Za-z0-9]+)/.exec(u); // canonical share token
    if (pf) return `${base}/posts/${pf[1]}`;
    const sf = /"story_fbid":"?(\d+)"?/.exec(u);
    if (sf) return `${base}/posts/${sf[1]}`;
    const pid = /"post_id":"(\d+)"/.exec(u);
    if (pid) return `${base}/posts/${pid[1]}`;
  }
  return "";
}

export async function postStatus(
  b: Browser,
  text: string,
  group?: string | null,
  audience?: string | null,
): Promise<Post> {
  if (group) {
    if (audience) {
      throw new FBError(
        "--audience applies to timeline posts; a group post's audience is the group itself.",
      );
    }
    await b.goto(groupUrl(group));
  } else {
    await b.goto("/");
  }
  await b.settle(3500);

  // Capture the create-post mutation response, which carries the new post id.
  const bodies: string[] = [];
  const pending: Promise<unknown>[] = [];

  // Playwright hands us the response before its body has arrived, so reading it
  // is async — but a body Facebook never finishes sending must not wedge the
  // publish. Bound every read; a missed body just costs us the exact permalink.
  const readBody = async (resp: Response): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const text = await Promise.race([
        resp.text(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 5000);
        }),
      ]);
      if (text !== null) bodies.push(text);
    } catch {
      // body already discarded / request failed
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const onResp = (resp: Response): void => {
    try {
      const fn = resp.request().headers()["x-fb-friendly-name"] ?? "";
      if (
        resp.url().includes("/api/graphql") &&
        (fn.includes("Composer") ||
          fn.includes("StoryCreate") ||
          fn.includes("Feed") ||
          !fn)
      ) {
        pending.push(readBody(resp));
      }
    } catch {
      // a torn-down request can't be inspected — ignore it
    }
  };

  b.page.on("response", onResp);
  await composeAndPublish(b, text, audience);
  await b.page.waitForTimeout(3500);
  b.page.off("response", onResp);
  await Promise.allSettled(pending);

  let gid: string | null = null;
  if (group) {
    gid = groupUrl(group).replace(/\/+$/, "").split("/").pop()!;
  }
  let permalink = permalinkFromGraphql(bodies, b.uid, gid);
  if (!permalink) {
    // Fallback: point at the group / profile where the post now lives.
    permalink = gid
      ? `https://www.facebook.com/groups/${gid}`
      : `https://www.facebook.com/profile.php?id=${b.uid}`;
  }
  return new Post({ author: "you", text, permalink });
}

export async function comment(b: Browser, url: string, text: string): Promise<string> {
  await b.goto(url);
  await b.settle(3500);
  const box = b.page.locator(SEL.commentBox).first();
  await box.waitFor({ state: "visible", timeout: 10000 });
  await box.click();
  await box.pressSequentially(text, { delay: 15 });
  await b.page.waitForTimeout(600);
  await box.press("Enter");
  await b.page.waitForTimeout(2500);
  return "commented";
}

export type Reaction = "like" | "love" | "care" | "haha" | "wow" | "sad" | "angry";

export async function react(b: Browser, url: string, reaction = "like"): Promise<string> {
  await b.goto(url);
  await b.settle(3500);
  const like = b.page.getByRole("button", { name: SEL.likeButton }).first();
  await like.waitFor({ state: "visible", timeout: 10000 });
  if (reaction.toLowerCase() === "like" || reaction === "") {
    await like.click();
    await b.page.waitForTimeout(1500);
    return "reacted: like";
  }
  // Hover to reveal the reaction picker, then click the named reaction.
  await like.hover();
  await b.page.waitForTimeout(1200);
  const r = b.page
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(reaction)}$`, "i") })
    .first();
  try {
    await r.click({ timeout: 4000 });
    await b.page.waitForTimeout(1500);
    return `reacted: ${reaction}`;
  } catch {
    await like.click();
    return "reacted: like (fallback)";
  }
}

/**
 * Create a group and return {name, id, url}. Handy for a self-contained
 * place to test group posting without touching a public community.
 */
export async function createGroup(
  b: Browser,
  name: string,
  privacy = "private",
): Promise<CreatedGroup> {
  await b.goto("/groups/create");
  await b.settle(4000);
  await b.page.waitForTimeout(1500);
  // The Group-name field auto-focuses on load — type into the focused element
  // (locator('input').first() would wrongly grab the nav search box).
  await b.page.keyboard.type(name, { delay: 25 });
  await b.page.waitForTimeout(600);
  // Privacy combobox (force-click through FB's overlay), then pick the option.
  const cbs = b.page.getByRole("combobox");
  let target = cbs.first();
  const ncbs = await cbs.count();
  for (let i = 0; i < ncbs; i++) {
    if (((await cbs.nth(i).innerText()) || "").toLowerCase().includes("privacy")) {
      target = cbs.nth(i);
      break;
    }
  }
  await target.click({ force: true, timeout: 6000 });
  await b.page.waitForTimeout(1200);
  await b.page
    .getByRole("option", { name: new RegExp(escapeRegExp(privacy), "i") })
    .first()
    .click({ timeout: 6000 });
  await b.page.waitForTimeout(1000);
  const btn = b.page.getByRole("button", { name: SEL.createButton }).first();
  for (let i = 0; i < 15; i++) {
    if (await btn.isEnabled()) break;
    await b.page.waitForTimeout(400);
  }
  await btn.click({ force: true, timeout: 8000 });
  try {
    await b.page.waitForURL(/\/groups\/\d+/, { timeout: 25000 });
  } catch {
    await b.page.waitForTimeout(6000);
  }
  const m = /\/groups\/(\d+)/.exec(b.page.url());
  const gid = m ? m[1]! : "";
  return {
    name,
    id: gid,
    url: gid ? `https://www.facebook.com/groups/${gid}` : b.page.url(),
  };
}

export async function joinGroup(b: Browser, group: string): Promise<string> {
  await b.goto(groupUrl(group));
  await b.settle(3500);
  const btn = b.page.getByRole("button", { name: SEL.joinButton }).first();
  try {
    await btn.click({ timeout: 8000 });
    await b.page.waitForTimeout(2500);
    return "join clicked (request sent or joined)";
  } catch {
    if (await b.page.getByRole("button", { name: SEL.joinedButton }).count()) {
      return "already a member";
    }
    throw new FBError("No Join button found (group may be secret/invite-only).");
  }
}

export async function leaveGroup(b: Browser, group: string): Promise<string> {
  await b.goto(groupUrl(group));
  await b.settle(3500);
  const joined = b.page.getByRole("button", { name: SEL.joinedButton }).first();
  await joined.click({ timeout: 8000 });
  await b.page.waitForTimeout(1200);
  const confirm = b.page.getByRole("menuitem", { name: SEL.leaveMenuItem }).first();
  try {
    await confirm.click({ timeout: 4000 });
  } catch {
    // the menu item isn't always there — the dialog button below is
  }
  await b.page.getByRole("button", { name: SEL.leaveButton }).first().click({ timeout: 6000 });
  await b.page.waitForTimeout(2000);
  return "left group";
}

export async function sendMessage(b: Browser, thread: string, text: string): Promise<string> {
  const dest = /^\d+$/.test(thread) ? thread : thread.replace(/^\/+/, "");
  await b.goto(`/messages/t/${dest}`);
  await b.settle(4000);
  const box = b.page.getByRole("textbox", { name: SEL.messageBox }).first();
  await box.waitFor({ state: "visible", timeout: 12000 });
  await box.click();
  await box.pressSequentially(text, { delay: 15 });
  await b.page.waitForTimeout(500);
  await box.press("Enter");
  await b.page.waitForTimeout(2000);
  return "sent";
}
