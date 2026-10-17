import { describe, expect, test } from "bun:test";

import { NotLoggedIn } from "../src/browser.ts";
import * as A from "../src/web-actions.ts";
import { page, RECORDER, withFakeFB } from "./fake-facebook.ts";

// These drive a real browser through deliberately patient waits (the production
// code waits on Facebook's async hydration), so give each test room to breathe.
const TIMEOUT = 120_000;

function article(author: string, body: string, href?: string): string {
  const link = href ? `<a href="${href}">2h</a>` : "";
  return `<div role="article"><h3>${author}</h3><div dir="auto">${body}</div>${link}</div>`;
}

const FEED = page(`${RECORDER}<div role="main">
  ${article("Alice", "first post body", "/alice/posts/111")}
  ${article("Bob", "second post body", "/groups/9/posts/222")}
  ${article("Carol", "third post body", "/permalink/333")}
  ${article("Alice", "a duplicate link, different text", "/alice/posts/111")}
  ${article("Dave", "no permalink here")}
  <div role="article">x</div>
</div>`);

describe("reading the feed", () => {
  test(
    "collects articles, dedupes by permalink, and honours --limit",
    async () => {
      await withFakeFB({ html: { "*": FEED } }, async (b) => {
        const posts = await A.feed(b, 3);
        expect(posts.map((p) => p.author)).toEqual(["Alice", "Bob", "Carol"]);
        expect(posts[0]!.text).toBe("Alice\nfirst post body\n2h");
        expect(posts[0]!.permalink).toBe("/alice/posts/111");
        expect(posts[1]!.permalink).toBe("/groups/9/posts/222");
      });
    },
    TIMEOUT,
  );

  test(
    "drops the duplicate permalink and the too-short article",
    async () => {
      await withFakeFB({ html: { "*": FEED } }, async (b) => {
        const posts = await A.feed(b, 50);
        // Six articles in the DOM: one repeats /alice/posts/111 and one is "x".
        expect(posts).toHaveLength(4);
        expect(posts.map((p) => p.author)).toEqual(["Alice", "Bob", "Carol", "Dave"]);
        expect(posts[3]!.permalink).toBe("");
      });
    },
    TIMEOUT,
  );

  test(
    "measures the 3-character floor in code points, not UTF-16 units",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <div role="article">🐧🐧</div>
        <div role="article">🐧🐧🐧</div>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        // Python's len("🐧🐧") is 2, so only the three-penguin article survives.
        const posts = await A.feed(b, 50);
        expect(posts.map((p) => p.text)).toEqual(["🐧🐧🐧"]);
      });
    },
    TIMEOUT,
  );
});

describe("whoami", () => {
  test(
    "pulls the name out of the Relay bootstrap and decodes its escapes",
    async () => {
      const html = page(
        `${RECORDER}<script>window.__d={"NAME":"Jan\\u00e9 D\\u00f6e","OTHER":1}</script>`,
      );
      await withFakeFB({ html: { "/": html } }, async (b) => {
        expect(await A.whoami(b)).toEqual({
          uid: "100000000000000",
          name: "Jané Döe",
          profile: "https://www.facebook.com/profile.php?id=100000000000000",
        });
      });
    },
    TIMEOUT,
  );

  test(
    "falls back to (unknown) when the bootstrap has no name",
    async () => {
      await withFakeFB({ html: { "/": page("<p>nothing</p>") } }, async (b) => {
        expect((await A.whoami(b)).name).toBe("(unknown)");
      });
    },
    TIMEOUT,
  );
});

describe("the login guard", () => {
  test(
    "turns a redirect to /login into NotLoggedIn",
    async () => {
      await withFakeFB(
        { redirect: { "/": "/login.php?next=x" }, html: { "*": page("<p>log in</p>") } },
        async (b) => {
          await expect(A.feed(b, 1)).rejects.toThrow(NotLoggedIn);
        },
      );
    },
    TIMEOUT,
  );

  test(
    "also trips on /checkpoint",
    async () => {
      await withFakeFB(
        { redirect: { "/": "/checkpoint/123" }, html: { "*": page("<p>verify</p>") } },
        async (b) => {
          await expect(A.whoami(b)).rejects.toThrow(/security check/);
        },
      );
    },
    TIMEOUT,
  );
});

describe("timeline", () => {
  test(
    "routes 'me', a numeric uid, and a username to the right paths",
    async () => {
      const seen: string[] = [];
      const html = page(`${RECORDER}<div role="main">${article("X", "hi", "/x/posts/1")}</div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        for (const target of ["me", "4", "zuck", "/zuck"]) {
          await A.timeline(b, target, 1);
          seen.push(new URL(b.page.url()).pathname + new URL(b.page.url()).search);
        }
      });
      expect(seen).toEqual(["/me", "/profile.php?id=4", "/zuck", "/zuck"]);
    },
    TIMEOUT,
  );
});

describe("groupFeed", () => {
  test(
    "accepts a bare id, a /groups/ path, and a full URL",
    async () => {
      const seen: string[] = [];
      const html = page(`${RECORDER}<div role="main">${article("X", "hi", "/x/posts/1")}</div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        for (const g of ["123", "/groups/123/", "https://www.facebook.com/groups/123"]) {
          await A.groupFeed(b, g, 1);
          seen.push(new URL(b.page.url()).pathname);
        }
      });
      expect(seen).toEqual(["/groups/123", "/groups/123", "/groups/123"]);
    },
    TIMEOUT,
  );
});

describe("readPost", () => {
  test(
    "takes the longest dir=auto block as the body and lists comments",
    async () => {
      const html = page(`${RECORDER}<div role="main">
        <a href="/jane">Jane Doe<br>Follow</a>
        <div dir="auto">2h ago</div>
        <div dir="auto">The full body of the post, which is the longest block here.</div>
        <div dir="auto">Like · Comment</div>
        <div role="article"><div dir="auto">nice one!</div></div>
        <div aria-label="Comment by Bob"><div dir="auto">agreed, very nice</div></div>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        const [post, comments] = await A.readPost(b, "/jane/posts/1");
        expect(post.author).toBe("Jane Doe");
        expect(post.text).toBe("The full body of the post, which is the longest block here.");
        expect(post.permalink).toBe("https://www.facebook.com/jane/posts/1");
        expect(comments).toEqual(["nice one!", "agreed, very nice"]);
      });
    },
    TIMEOUT,
  );

  test(
    "prefers the dialog scope when a post opens in a modal",
    async () => {
      const html = page(`${RECORDER}
        <div role="main"><div dir="auto">background feed text that is quite long indeed</div></div>
        <div role="dialog">
          <a href="/mia">Mia Park</a>
          <div dir="auto">the modal post body</div>
        </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        const [post] = await A.readPost(b, "/mia/posts/2");
        expect(post.author).toBe("Mia Park");
        expect(post.text).toBe("the modal post body");
      });
    },
    TIMEOUT,
  );
});

describe("search", () => {
  const RESULTS = page(`${RECORDER}<div role="main">
    <a role="link" href="/climbing-gym">Climbing Gym Nairobi</a>
    <a role="link" href="/profile.php?id=4&sk=about" aria-label="Profile photo of Mark Z"><img width="40" height="40"></a>
    <a role="link" href="/profile.php?id=4&sk=photos" aria-label="Profile photo of Mark Z"><img width="40" height="40"></a>
    <a role="link" href="/search/pages/?q=gym">See more</a>
    <a role="link" href="/hashtag/gym">#gym</a>
    <a role="link" href="/photo/?fbid=1">photo</a>
    <a role="link" href="/reactions/picker/">reactions</a>
    <a role="link" href="#">anchor</a>
    <a role="link" href="/some.page-name"><img width="40" height="40"></a>
    <a role="link" href="/groups/42" aria-label="Nairobi Tech Group's timeline"><img width="40" height="40"></a>
    <a role="link" href="/multi-line"><br>Wrapped Name<br>Follow</a>
  </div>`);

  test(
    "builds the search URL, filters chrome links, and names each result",
    async () => {
      await withFakeFB({ html: { "*": RESULTS } }, async (b) => {
        const results = await A.search(b, "climbing gyms nairobi", "pages", 10);
        const url = new URL(b.page.url());
        expect(url.pathname).toBe("/search/pages/");
        expect(url.search).toBe("?q=climbing+gyms+nairobi");

        expect(results.map((r) => [r.text, r.url])).toEqual([
          ["Climbing Gym Nairobi", "https://www.facebook.com/climbing-gym"],
          // Both profile.php links collapse onto one key that keeps the uid.
          ["Mark Z", "https://www.facebook.com/profile.php?id=4"],
          // `/some.page-name` has neither link text nor an aria-label, so it is
          // dropped — the "longer name wins" rule never stores a zero-length
          // name, which is exactly how the Python original behaved.
          ["Nairobi Tech Group", "https://www.facebook.com/groups/42"],
          // Leading whitespace is stripped *before* the first line is taken.
          ["Wrapped Name", "https://www.facebook.com/multi-line"],
        ]);
      });
    },
    TIMEOUT,
  );

  test(
    "falls back to the 'top' segment for an unknown kind and honours --limit",
    async () => {
      await withFakeFB({ html: { "*": RESULTS } }, async (b) => {
        const results = await A.search(b, "x", "nonsense", 2);
        expect(new URL(b.page.url()).pathname).toBe("/search/top/");
        expect(results).toHaveLength(2);
      });
    },
    TIMEOUT,
  );
});

describe("notifications", () => {
  test(
    "reads listitem rows, squeezes whitespace, dedupes, and absolutises links",
    async () => {
      const html = page(`${RECORDER}<div>
        <div role="listitem"><a href="/alice/posts/1">Alice   commented
          on your    post</a></div>
        <div role="listitem"><a href="https://www.facebook.com/events/7">Bob invited you to an event</a></div>
        <div role="listitem">short</div>
        <div role="listitem">A notification with no link at all</div>
        <div role="listitem"><a href="/alice/posts/1">Alice commented on your post</a></div>
      </div>`);
      await withFakeFB({ html: { "*": html } }, async (b) => {
        const items = await A.notifications(b, 10);
        expect(items.map((i) => [i.text, i.url])).toEqual([
          ["Alice commented on your post", "https://www.facebook.com/alice/posts/1"],
          ["Bob invited you to an event", "https://www.facebook.com/events/7"],
          ["A notification with no link at all", ""],
        ]);
      });
    },
    TIMEOUT,
  );
});
