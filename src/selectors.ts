/**
 * Every Facebook selector fbcli depends on, in one place.
 *
 * Facebook's DOM shifts without notice. When a flow breaks because a hook moved,
 * you shouldn't have to edit code and cut a release — point `FBCLI_SELECTORS` at
 * a JSON file overriding just the entries that changed:
 *
 *   FBCLI_SELECTORS=./my-selectors.json fbcli feed
 *   // my-selectors.json: { "article": "div[data-foo]", "postButton": "^Publish$" }
 *
 * CSS entries are plain query strings. Name entries (suffix intent "…Name"/regex)
 * are regular-expression *sources* matched case-insensitively against accessible
 * names — exactly what Playwright's getByRole({ name }) consumes.
 */

import { existsSync, readFileSync } from "node:fs";

/** CSS query strings (left) and regex sources for accessible-name matches (right). */
export interface SelectorDefs {
  // -- CSS queries --
  /** A feed/timeline/group story container. */
  article: string;
  /** The feed column whose direct children are the story cards. */
  feed: string;
  /** A comment preview rendered inside a story card (never a story itself). */
  commentArticle: string;
  /** The actor link in a story's header — a link to the poster's profile. */
  storyAuthor: string;
  /** Last-resort author links, when the poster has no profile link. */
  storyAuthorAny: string;
  /** Links inside a story that point at its permalink. */
  permalinkLinks: string;
  /** A group photo link, whose `set=gm.<id>` names the post it belongs to. */
  groupPhotoLinks: string;
  /** The post-detail overlay (read view). */
  dialog: string;
  /** The main column when there is no overlay. */
  main: string;
  /** Candidate blocks holding a post's body text. */
  bodyBlock: string;
  /** Comment containers on a post-detail view. */
  commentNodes: string;
  /** Result anchors on a search page. */
  searchLinks: string;
  /** A single notification row. */
  notificationRow: string;
  /** The rich-text editor inside the composer dialog. */
  editor: string;
  /** The "write a comment" box. */
  commentBox: string;
  // -- accessible-name regex sources (case-insensitive) --
  /** Composer opener text ("What's on your mind", "Write something", …). */
  composerOpener: string;
  /** The dialog's publish button. */
  postButton: string;
  /** The reaction toggle. */
  likeButton: string;
  /** The group join button. */
  joinButton: string;
  /** The "already a member" marker. */
  joinedButton: string;
  /** The confirm item in the leave-group menu. */
  leaveMenuItem: string;
  /** The leave-group confirm button. */
  leaveButton: string;
  /** The create-group submit button. */
  createButton: string;
  /** The message composer textbox. */
  messageBox: string;
  /** The composer's current-audience button (its text names the audience). */
  audienceButton: string;
  // -- content scrape --
  /** Extracts the account display name from the Relay bootstrap JSON. */
  nameFromBootstrap: string;
}

export const DEFAULT_SELECTORS: SelectorDefs = {
  article: 'div[role="article"]',
  feed: '[role="feed"]',
  commentArticle: '[aria-label^="Comment by"], [aria-label^="Reply by"]',
  storyAuthor: 'a[href*="/user/"], a[href*="profile.php"]',
  storyAuthorAny: 'h2 a[href], h3 a[href], h4 a[href], a[href]',
  permalinkLinks:
    'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], ' +
    'a[href*="/videos/"], a[href*="/groups/"][href*="/posts/"]',
  groupPhotoLinks: 'a[href*="set=gm."]',
  dialog: '[role="dialog"]',
  main: '[role="main"]',
  bodyBlock: 'div[dir="auto"]',
  commentNodes: 'div[aria-label*="Comment by"], div[role="article"]',
  searchLinks: '[role="main"] a[role="link"][href]',
  notificationRow: '[role="listitem"]',
  editor: 'div[role="textbox"], div[contenteditable="true"]',
  commentBox:
    'div[aria-label^="Comment"], div[aria-label*="Write a comment"], ' +
    'form div[role="textbox"], div[contenteditable="true"]',
  composerOpener:
    "What'?s on your mind|Write something|Start a discussion|Discuss something|Say something",
  postButton: "^Post$",
  likeButton: "^Like$",
  joinButton: "^(Join group|Join)$",
  joinedButton: "Joined|Leave group",
  leaveMenuItem: "Leave group",
  leaveButton: "^Leave",
  createButton: "^Create",
  messageBox: "Message|Aa",
  audienceButton:
    "^(Public|Friends|Friends except|Specific friends|Only me|Custom)$",
  nameFromBootstrap: '"NAME":"([^"]{2,40})"',
};

/** Keys whose values are regex sources (compiled with the "i" flag). */
const NAME_KEYS: ReadonlySet<keyof SelectorDefs> = new Set([
  "composerOpener", "postButton", "likeButton", "joinButton", "joinedButton",
  "leaveMenuItem", "leaveButton", "createButton", "messageBox", "audienceButton",
]);

/** The resolved registry: CSS entries stay strings, name entries become RegExps. */
export type Selectors = {
  [K in keyof SelectorDefs]: K extends
    | "composerOpener" | "postButton" | "likeButton" | "joinButton" | "joinedButton"
    | "leaveMenuItem" | "leaveButton" | "createButton" | "messageBox" | "audienceButton"
    ? RegExp
    : string;
};

function readOverrides(): Partial<SelectorDefs> {
  const path = process.env.FBCLI_SELECTORS;
  if (!path) return {};
  if (!existsSync(path)) {
    console.error(`warning: FBCLI_SELECTORS=${path} not found — using defaults.`);
    return {};
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: Partial<SelectorDefs> = {};
    for (const k of Object.keys(DEFAULT_SELECTORS) as (keyof SelectorDefs)[]) {
      const v = data[k];
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (err) {
    console.error(
      `warning: could not parse FBCLI_SELECTORS (${err instanceof Error ? err.message : err}) — using defaults.`,
    );
    return {};
  }
}

/** Build the active registry from defaults plus any `FBCLI_SELECTORS` overrides. */
export function buildSelectors(defs: SelectorDefs = DEFAULT_SELECTORS): Selectors {
  const merged = { ...defs, ...readOverrides() };
  const out = {} as Record<keyof SelectorDefs, string | RegExp>;
  for (const k of Object.keys(merged) as (keyof SelectorDefs)[]) {
    out[k] = NAME_KEYS.has(k) ? new RegExp(merged[k], "i") : merged[k];
  }
  return out as Selectors;
}

/** The registry in force for this process. */
export const SEL: Selectors = buildSelectors();
