#!/usr/bin/env bun
/** Facebook group post finder - extracts actual post permalinks from page JSON data. */

import { Browser } from "./src/browser.ts";
import { Post, charLength, comment, cut } from "./src/web-actions.ts";

/**
 * Extract original post IDs from Facebook page HTML.
 *
 * Facebook embeds post data in the HTML in several ways:
 * 1. post_id in JSON data
 * 2. gm.<post_id> in photo set parameters (group media)
 * 3. p.<post_id> in photo set parameters
 * 4. story_fbid patterns
 */
export function extractPostIdsFromHtml(html: string): string[] {
  const ids = new Set<string>();

  // 1. Direct post_id from JSON
  for (const m of html.matchAll(/"post_id":"(\d+)"/g)) ids.add(m[1]!);

  // 2. group media: gm.<post_id> in photo set params
  for (const m of html.matchAll(/set=(?:gm\.|p\.|pcb\.)(\d+)/g)) ids.add(m[1]!);

  // 3. story_fbid
  for (const m of html.matchAll(/"story_fbid":"(\d+)"/g)) ids.add(m[1]!);

  // 4. node IDs (author_post format, extract the post part)
  for (const m of html.matchAll(/"id":"\d+_(\d+)"/g)) ids.add(m[1]!);

  // 5. permalink_url already in data
  for (const m of html.matchAll(/"url":"([^"]*groups\/[^"]*\/posts\/(\d+))"/g)) ids.add(m[2]!);

  // 6. comment permalink parent posts
  for (const m of html.matchAll(/\/posts\/(\d+)\/\?comment_id=/g)) ids.add(m[1]!);

  return [...ids].sort();
}

/** Extract rich post data from HTML. */
export function extractPostData(html: string): Record<string, unknown>[] {
  const postsData: Record<string, unknown>[] = [];

  // Try to find JSON nodes with post data
  // Pattern for node data with text
  for (const m of html.matchAll(/"node":\{([\s\S]*?)\}/g)) {
    try {
      let nodeStr = "{" + m[1]! + "}";
      // Clean escaped chars
      nodeStr = nodeStr.replace(/\\"/g, '"').replace(/\\\//g, "/");
      postsData.push(JSON.parse(nodeStr) as Record<string, unknown>);
    } catch {
      // not valid JSON on its own — skip
    }
  }

  return postsData;
}

/** Find original group posts by extracting data from the page HTML. */
export async function findGroupPosts(
  b: Browser,
  groupId: string,
  limit = 20,
): Promise<Post[]> {
  await b.goto(`/groups/${groupId}`);
  await b.settle(5000);

  // Scroll to load more posts
  for (let i = 0; i < 6; i++) {
    await b.page.mouse.wheel(0, 2500);
    await b.page.waitForTimeout(1200);
  }

  const html = await b.page.content();
  const postIds = extractPostIdsFromHtml(html);

  // Remove comment IDs (they look like post_ids too but we need originals)
  // Comment permalinks have :  group_id_post_id format
  // We want unique post IDs

  console.log(`Found ${postIds.length} potential post IDs`);

  // Get actual post content from the DOM
  // h3 elements contain post titles/content
  const posts: Post[] = [];
  const usedIds = new Set<string>();

  // Build permalinks and get content for each post ID
  for (const pid of postIds) {
    // Skip comment IDs (same as post IDs, they're the parent post)
    if (usedIds.has(pid)) continue;
    usedIds.add(pid);

    // The group URL slug might be different from the numeric ID
    // Use the canonical URL format
    const perma = `https://www.facebook.com/groups/${groupId}/posts/${pid}/`;

    // Try to find the post text in the DOM
    // Look for div[dir="auto"] that contains meaningful content
    // related to this post

    posts.push(new Post({ author: "", text: `(post ${pid})`, permalink: perma }));

    if (posts.length >= limit) break;
  }

  return posts;
}

/** Read each post and filter by help keywords. */
export async function readAndFilter(
  b: Browser,
  posts: Post[],
  helpOnly = true,
): Promise<Post[]> {
  const HELP_KW =
    /\b(help|assignment|homework|due|deadline|tutor|stuck|need|please|anyone|how do|essay|exam|study|project|paper|question|explain|understand|problem|advice|recommend|suggest|know|does anyone|has anyone|can someone|looking for|struggling|confused|do my|write my|pay for|paid|can you|would you|microeconomics|chemistry|biology|physics|math|calculus|statistics|psychology|sociology|history|english|literature|programming|python|java|coding|algorithm|data|analysis)\b/i;

  const filtered: Post[] = [];
  for (const p of posts) {
    try {
      const result = await readPost(b, p.permalink);
      if (result) {
        const [post] = result;
        p.author = post.author;
        p.text = post.text;

        const isHelp = HELP_KW.test(p.text);
        const tag = isHelp ? "🔴 HELP" : "   ";
        console.log(`${tag} ${cut(p.author, 40)}`);
        console.log(`  ${cut(p.text, 200)}`);
        console.log(`  → ${p.permalink}`);

        if (helpOnly && !isHelp) continue;
        filtered.push(p);
      }
    } catch {
      // a post that won't load is simply skipped
    }
  }

  return filtered;
}

/** Read a single Facebook post and return (Post, comments). */
export async function readPost(
  b: Browser,
  url: string,
): Promise<[Post, string[]] | null> {
  await b.goto(url);
  await b.settle(4000);
  await b.page.waitForTimeout(1500);

  // Get post body
  let scope = b.page.locator('[role="dialog"]').last();
  if (!(await scope.count())) {
    scope = b.page.locator('[role="main"]').first();
    if (!(await scope.count())) return null;
  }

  // Post text from div[dir="auto"]
  let text = "";
  const blocks = scope.locator('div[dir="auto"]');
  const nblocks = Math.min(await blocks.count(), 40);
  for (let i = 0; i < nblocks; i++) {
    let t: string;
    try {
      t = (await blocks.nth(i).innerText({ timeout: 800 })).trim();
    } catch {
      continue;
    }
    if (charLength(t) > charLength(text)) text = t;
  }

  // Author
  let author = "";
  try {
    author = (await scope.getByRole("link").first().innerText({ timeout: 1500 }))
      .trim()
      .split("\n")[0]!;
  } catch {
    // no heading link — leave the author blank
  }

  // Comments
  const comments: string[] = [];
  const cnodes = b.page.locator('div[aria-label*="Comment by"], div[role="article"]');
  const ncomments = Math.min(await cnodes.count(), 20);
  for (let i = 0; i < ncomments; i++) {
    let t: string;
    try {
      t = (await cnodes.nth(i).innerText({ timeout: 800 })).trim();
    } catch {
      continue;
    }
    if (t && t !== text && charLength(t) > 3) comments.push(t);
  }

  return [new Post({ author, text, permalink: b.page.url() }), comments];
}

/** Reply/comment on a Facebook post. */
export async function replyToPost(b: Browser, url: string, text: string): Promise<string> {
  return await comment(b, url, text);
}

if (import.meta.main) {
  const src = process.env.FBCLI_COOKIES;
  if (!src) {
    console.error("no FBCLI_COOKIES set");
    process.exit(1);
  }

  const argv = process.argv.slice(2);
  const action = argv[0] ?? "scan";
  const groupId = argv[1] ?? "205494628249899";

  const bar = "=".repeat(60);
  const b = await Browser.start(src, { slow: 30 });
  try {
    if (action === "scan") {
      // Find posts in the group
      const posts = await findGroupPosts(b, groupId, 25);
      console.log(`\n${bar}`);
      console.log(`Found ${posts.length} post permalinks in group, now reading each one...`);
      console.log(`\n${bar}`);

      // Read each post to get content and filter
      const helpPosts = await readAndFilter(b, posts);

      console.log(`\n${bar}`);
      console.log(`Posts asking for help: ${helpPosts.length}`);
      helpPosts.forEach((p, i) => {
        console.log(`\n[${i + 1}] ${p.author}`);
        console.log(`  ${cut(p.text, 200)}`);
        console.log(`  ${p.permalink}`);
      });
    } else if (action === "read") {
      const url = argv[1]!;
      const result = await readPost(b, url);
      if (result) {
        const [post, comments] = result;
        console.log(post.brief(4000));
        if (comments.length) {
          console.log("\n-- comments --");
          for (const cm of comments) {
            console.log(`  · ${cut(cm.split("\n")[0] ?? "", 120)}`);
          }
        }
      }
    } else if (action === "reply") {
      const url = argv[1]!;
      const text = argv[2]!;
      console.log(await replyToPost(b, url, text));
    } else if (action === "scan-all") {
      // Scan multiple groups
      const groups = groupId.split(",");
      for (const g of groups) {
        const gid = g.trim();
        console.log(`\n\n${bar}`);
        console.log(`Scanning group ${gid}...`);
        const posts = await findGroupPosts(b, gid, 10);
        const helpPosts = await readAndFilter(b, posts);
        console.log(`Found ${helpPosts.length} help requests in group ${gid}`);
      }
    }
  } finally {
    await b.close();
  }
}
