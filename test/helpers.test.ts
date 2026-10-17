import { describe, expect, test } from "bun:test";

import {
  cut,
  decodeUnicodeEscape,
  groupUrl,
  Item,
  permalinkFromGraphql,
  Post,
  quotePlus,
} from "../src/web-actions.ts";

describe("quotePlus", () => {
  // Reference values come from Python's urllib.parse.quote_plus.
  test.each([
    ["climbing gyms nairobi", "climbing+gyms+nairobi"],
    ["a+b&c=d", "a%2Bb%26c%3Dd"],
    ["café ☕", "caf%C3%A9+%E2%98%95"],
    ["100% sure!", "100%25+sure%21"],
    ["a/b?c#d", "a%2Fb%3Fc%23d"],
    ["x~y-z_w.v", "x~y-z_w.v"],
    ["(paren)*star'quote", "%28paren%29%2Astar%27quote"],
  ])("%p -> %p", (input, expected) => {
    expect(quotePlus(input)).toBe(expected);
  });
});

describe("decodeUnicodeEscape", () => {
  // Reference values come from Python's `s.encode().decode("unicode_escape")`.
  test.each([
    ["Jane Doe", "Jane Doe"],
    ["Jan\\u00e9 D\\u00f6e", "Jané Döe"],
    ["a\\\\b", "a\\b"],
    ["tab\\there", "tab\there"],
    ["\\x41\\101", "AA"],
    ["\\q", "\\q"],
  ])("%p -> %p", (input, expected) => {
    expect(decodeUnicodeEscape(input)).toBe(expected);
  });
});

describe("cut", () => {
  test("truncates by code point so emoji are never split", () => {
    expect(cut("hello", 3)).toBe("hel");
    expect(cut("hello", 99)).toBe("hello");
    expect(cut("🐧🐧🐧", 2)).toBe("🐧🐧");
  });
});

describe("groupUrl", () => {
  test.each([
    ["123456789", "/groups/123456789"],
    ["/groups/123456789", "/groups/123456789"],
    ["groups/123456789/", "/groups/123456789"],
    ["my-group-slug", "/groups/my-group-slug"],
    ["https://www.facebook.com/groups/123/", "https://www.facebook.com/groups/123/"],
  ])("%p -> %p", (input, expected) => {
    expect(groupUrl(input)).toBe(expected);
  });
});

describe("permalinkFromGraphql", () => {
  test("prefers the canonical pfbid share token", () => {
    const bodies = ['{"story":{"url":"https:\\/\\/www.facebook.com\\/100\\/posts\\/pfbid0ABCdef123"}}'];
    expect(permalinkFromGraphql(bodies, "100")).toBe(
      "https://www.facebook.com/100/posts/pfbid0ABCdef123",
    );
  });

  test("falls back to story_fbid then post_id", () => {
    expect(permalinkFromGraphql(['{"story_fbid":"987"}'], "100")).toBe(
      "https://www.facebook.com/100/posts/987",
    );
    expect(permalinkFromGraphql(['{"post_id":"654"}'], "100")).toBe(
      "https://www.facebook.com/100/posts/654",
    );
  });

  test("roots group posts at /groups/<gid>", () => {
    expect(permalinkFromGraphql(['{"post_id":"654"}'], "100", "555")).toBe(
      "https://www.facebook.com/groups/555/posts/654",
    );
  });

  test("scans bodies in order and returns '' when nothing matches", () => {
    expect(permalinkFromGraphql(['{"noise":1}', '{"post_id":"7"}'], "1")).toBe(
      "https://www.facebook.com/1/posts/7",
    );
    expect(permalinkFromGraphql(['{"noise":1}'], "1")).toBe("");
    expect(permalinkFromGraphql([], "1")).toBe("");
  });
});

describe("Post.brief", () => {
  test("renders author, indented body, and permalink", () => {
    const p = new Post({ author: "Jane Doe", text: "line one\nline two", permalink: "https://fb/1" });
    expect(p.brief()).toBe("● Jane Doe\n  line one\n  line two\n  → https://fb/1");
  });

  test("falls back to '(post)' and omits empty sections", () => {
    expect(new Post().brief()).toBe("● (post)");
    expect(new Post({ text: "hi" }).brief()).toBe("● (post)\n  hi");
  });

  test("ellipsises text past the width", () => {
    expect(new Post({ author: "a", text: "abcdef" }).brief(3)).toBe("● a\n  abc…");
    expect(new Post({ author: "a", text: "abc" }).brief(3)).toBe("● a\n  abc");
  });

  test("serialises to the same JSON shape the Python dataclass did", () => {
    expect(JSON.parse(JSON.stringify(new Post({ author: "a", text: "b", permalink: "c" })))).toEqual(
      { author: "a", text: "b", permalink: "c" },
    );
    expect(JSON.parse(JSON.stringify(new Item({ text: "a", url: "b" })))).toEqual({
      text: "a",
      url: "b",
    });
  });
});
