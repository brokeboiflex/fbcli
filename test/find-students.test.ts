import { describe, expect, test } from "bun:test";

import { extractPostData, extractPostIdsFromHtml, findGroupPosts } from "../fb-find-students.ts";
import { page, RECORDER, withFakeFB } from "./fake-facebook.ts";

const HTML = `<html><body>
{"post_id":"111","story_fbid":"222"}
<a href="/photo/?set=gm.333&type=3">img</a>
<a href="/photo/?set=p.444">img</a>
<a href="/photo/?set=pcb.555">img</a>
{"id":"100_666"}
{"url":"https://www.facebook.com/groups/9/posts/777"}
<a href="/groups/9/posts/888/?comment_id=1">reply</a>
{"node":{"id":"1","name":"Alice"}}
{"node":{"id":"2","nested":{"deep":1}}}
</body></html>`;

describe("extractPostIdsFromHtml", () => {
  test("harvests ids from all six embedding shapes, sorted and deduped", () => {
    // Reference output from the Python original.
    expect(extractPostIdsFromHtml(HTML)).toEqual([
      "111", "222", "333", "444", "555", "666", "777", "888",
    ]);
  });

  test("returns nothing for HTML with no post data", () => {
    expect(extractPostIdsFromHtml("<html><body>hi</body></html>")).toEqual([]);
  });
});

describe("extractPostData", () => {
  test("parses flat node objects and skips the ones the lazy regex truncates", () => {
    // Python keeps only {"id":"1","name":"Alice"} — the nested node's capture
    // stops at the first "}" and no longer parses as JSON.
    expect(extractPostData(HTML)).toEqual([{ id: "1", name: "Alice" }]);
  });

  test("unescapes \\\" and \\/ before parsing", () => {
    expect(extractPostData('{"node":{"url":"https:\\/\\/fb\\/1"}}')).toEqual([
      { url: "https://fb/1" },
    ]);
  });
});

describe("findGroupPosts", () => {
  test(
    "turns harvested ids into canonical group permalinks, capped at the limit",
    async () => {
      await withFakeFB({ html: { "*": page(RECORDER + HTML) } }, async (b) => {
        const posts = await findGroupPosts(b, "205494628249899", 3);
        expect(posts.map((p) => [p.text, p.permalink])).toEqual([
          ["(post 111)", "https://www.facebook.com/groups/205494628249899/posts/111/"],
          ["(post 222)", "https://www.facebook.com/groups/205494628249899/posts/222/"],
          ["(post 333)", "https://www.facebook.com/groups/205494628249899/posts/333/"],
        ]);
        expect(new URL(b.page.url()).pathname).toBe("/groups/205494628249899");
      });
    },
    120_000,
  );
});
